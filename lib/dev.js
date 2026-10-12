// lib/dev.js - Developer tooling integration for Expo, React Native, and Android Gradle
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const {
  checkAdbInstalled,
  getTargetDevice,
  getConnectedDevices,
  getDeviceStatus,
  enableDeveloperOptions,
  enableUsbDebugging,
  connectAdbWifi,
  grantAppPermission,
  execAdb
} = require('./adb');
const { discoverBridge, connectViaBridge } = require('./bridge');
const { colors, symbols, banner } = require('./ui');

// On Windows, .cmd/.bat launchers (npx, gradlew.bat) need a shell. Node 24 deprecates passing an
// args array together with `shell: true` (DEP0190), so build one quoted command line instead.
function spawnShell(command, args, options = {}) {
  if (process.platform !== 'win32') {
    return spawn(command, args, options);
  }
  const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return spawn([command, ...args].map(quote).join(' '), { ...options, shell: true });
}

function runInteractiveProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnShell(command, args, {
      stdio: 'inherit',
      ...options
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        const err = new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}`);
        err.code = code;
        reject(err);
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

function promptUserWithTimeout(questionText, defaultVal = 'y', timeoutSeconds = 6) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      return resolve(defaultVal);
    }
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    let answered = false;
    const timer = setTimeout(() => {
      if (!answered) {
        answered = true;
        rl.close();
        process.stdout.write(`\n`);
        resolve(defaultVal);
      }
    }, timeoutSeconds * 1000);

    rl.question(questionText, (answer) => {
      if (!answered) {
        answered = true;
        clearTimeout(timer);
        rl.close();
        const trimmed = (answer || '').trim().toLowerCase();
        resolve(trimmed || defaultVal);
      }
    });
  });
}

function findAndroidDir(cwd = process.cwd()) {
  // 1. Android subfolder (typical in Expo prebuild or React Native)
  if (
    fs.existsSync(path.join(cwd, 'android', 'build.gradle')) ||
    fs.existsSync(path.join(cwd, 'android', 'build.gradle.kts')) ||
    fs.existsSync(path.join(cwd, 'android', 'settings.gradle')) ||
    fs.existsSync(path.join(cwd, 'android', 'settings.gradle.kts'))
  ) {
    return path.join(cwd, 'android');
  }

  // 2. Pure Native Android root (Kotlin / Java projects, e.g. Android Studio project)
  const hasAppDir = fs.existsSync(path.join(cwd, 'app'));
  const hasRootGradle =
    fs.existsSync(path.join(cwd, 'build.gradle')) ||
    fs.existsSync(path.join(cwd, 'build.gradle.kts')) ||
    fs.existsSync(path.join(cwd, 'settings.gradle')) ||
    fs.existsSync(path.join(cwd, 'settings.gradle.kts')) ||
    fs.existsSync(path.join(cwd, 'gradlew')) ||
    fs.existsSync(path.join(cwd, 'gradlew.bat'));

  if (hasAppDir && hasRootGradle) {
    return cwd;
  }

  // 3. Fallback: Gradle project files present
  if (
    fs.existsSync(path.join(cwd, 'build.gradle')) ||
    fs.existsSync(path.join(cwd, 'build.gradle.kts')) ||
    fs.existsSync(path.join(cwd, 'settings.gradle')) ||
    fs.existsSync(path.join(cwd, 'settings.gradle.kts'))
  ) {
    return cwd;
  }

  return null;
}

function detectProjectDetails(cwd = process.cwd()) {
  const pkgPath = path.join(cwd, 'package.json');
  let pkgJson = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (_) {}
  }

  const allDeps = {
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.devDependencies || {})
  };

  const isExpo = 'expo' in allDeps;
  const hasDevClient = 'expo-dev-client' in allDeps;
  const hasAndroidDir = fs.existsSync(path.join(cwd, 'android'));
  const isDevClient = hasDevClient || hasAndroidDir;

  let appName = pkgJson.name || null;
  let packageName = null;

  // 1. Read app.json
  const appJsonPath = path.join(cwd, 'app.json');
  let appJson = {};
  if (fs.existsSync(appJsonPath)) {
    try {
      appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      appName = appJson.expo?.name || appName;
      packageName = appJson.expo?.android?.package || null;
    } catch (_) {}
  }

  // 2. Read app.config.js if present (evaluates dynamic config)
  const appConfigPath = path.join(cwd, 'app.config.js');
  if (fs.existsSync(appConfigPath)) {
    try {
      delete require.cache[require.resolve(appConfigPath)];
      const cfgExport = require(appConfigPath);
      const evaluated = typeof cfgExport === 'function' ? cfgExport({ config: appJson.expo || {} }) : cfgExport;
      if (evaluated) {
        appName = evaluated.name || evaluated.expo?.name || appName;
        packageName = evaluated.android?.package || evaluated.expo?.android?.package || packageName;
      }
    } catch (_) {}
  }

  // 3. For pure native Android projects (Kotlin / Gradle) without Expo
  if (!isExpo) {
    const androidDir = findAndroidDir(cwd);
    if (androidDir) {
      // Try resolving appName from settings.gradle or settings.gradle.kts
      for (const settingsFile of ['settings.gradle.kts', 'settings.gradle']) {
        const settingsPath = path.join(androidDir, settingsFile);
        if (fs.existsSync(settingsPath)) {
          const content = fs.readFileSync(settingsPath, 'utf8');
          const nameMatch = content.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
          if (nameMatch) {
            appName = nameMatch[1];
            break;
          }
        }
      }
      if (!appName || appName === 'Expo App') {
        appName = path.basename(cwd);
      }

      // Try resolving packageName from app/build.gradle or app/build.gradle.kts
      const gradleCandidates = [
        path.join(androidDir, 'app', 'build.gradle.kts'),
        path.join(androidDir, 'app', 'build.gradle'),
        path.join(androidDir, 'build.gradle.kts'),
        path.join(androidDir, 'build.gradle')
      ];
      for (const gPath of gradleCandidates) {
        if (fs.existsSync(gPath)) {
          const content = fs.readFileSync(gPath, 'utf8');
          const appIdMatch = content.match(/applicationId\s*(?:=|\s)?\s*['"]([^'"]+)['"]/);
          if (appIdMatch) {
            packageName = appIdMatch[1];
            break;
          }
          const nsMatch = content.match(/namespace\s*(?:=|\s)?\s*['"]([^'"]+)['"]/);
          if (nsMatch) {
            packageName = nsMatch[1];
            break;
          }
        }
      }
    }
  }

  return {
    isExpo,
    isDevClient,
    isNativeAndroid: !isExpo && Boolean(findAndroidDir(cwd)),
    appName,
    packageName,
    sdkVersion: allDeps['expo']
  };
}

function isAppInstalledOnDevice(packageName, serial = null) {
  if (!packageName) return false;
  const res = execAdb(['shell', 'pm', 'list', 'packages', packageName], serial);
  if (res.status === 0 && res.stdout) {
    const lines = res.stdout.split(/\r?\n/).map(l => l.trim());
    return lines.some(line => line === `package:${packageName}`);
  }
  return false;
}

function launchAppOnDevice(packageName, serial = null) {
  if (!packageName) return false;
  const res = execAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
  return res.status === 0;
}

function launchExpoGoUrl(ip, port = 8081, serial = null) {
  const url = `exp://${ip}:${port}`;
  const res = execAdb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url], serial);
  return res.status === 0;
}

// Port Metro will listen on: --port N / -p N / --port=N, default 8081
function parseMetroPort(args = []) {
  for (let i = 0; i < args.length; i++) {
    const m = /^--port=(\d+)$/.exec(args[i]);
    if (m) return parseInt(m[1], 10);
    if ((args[i] === '--port' || args[i] === '-p') && /^\d+$/.test(args[i + 1] || '')) {
      return parseInt(args[i + 1], 10);
    }
  }
  return 8081;
}

// Resolves true once Metro's /status endpoint reports it is running, false after the timeout
function waitForMetro(port = 8081, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const probe = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body.includes('packager-status:running')));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  return (async () => {
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  })();
}

async function runExpoStart(extraArgs = []) {
  if (extraArgs.includes('--native') || extraArgs.includes('-n')) {
    const { runNativeStudio } = require('./studio');
    return runNativeStudio();
  }

  banner();
  console.log(`  ${colors.bold(colors.white('🚀 DEV MODE STARTUP PRE-FLIGHT CHECKS'))}`);
  console.log(`  ${colors.gray('───────────────────────────────────────────────────')}\n`);

  // 1. Detect Expo or Native Android project
  const project = detectProjectDetails(process.cwd());
  if (!project.isExpo) {
    const androidDir = findAndroidDir();
    if (androidDir) {
      console.log(`  ${symbols.info} ${colors.bold('Pure Native Android Project Detected')} (Gradle / Kotlin)`);
      console.log(`  ${symbols.arrow} Automatically launching Dev Mode Native Studio...\n`);
      const { runNativeStudio } = require('./studio');
      return runNativeStudio();
    }

    console.log(`  ${symbols.cross} ${colors.bold(colors.red('Not an Expo or Android project:'))} package.json does not contain "expo".`);
    console.log(`  ${colors.yellow('Tip:')} Navigate into an Expo or Android project directory to start the server.\n`);
    return;
  }

  const workflowBadge = project.isDevClient
    ? colors.bold(colors.cyan('Custom Development Build'))
    : colors.bold(colors.green('Expo Go (Managed)'));

  console.log(`  ${symbols.check} ${colors.bold('Project:')}         ${colors.bold(colors.cyan(project.appName))} ${colors.dim(`[${workflowBadge}]`)}`);

  // 2. Check Android SDK & ADB
  const adbInstalled = checkAdbInstalled();
  if (!adbInstalled) {
    console.log(`  ${symbols.warn} ${colors.yellow('Android SDK (adb) not found in PATH. Android features skipped.')}`);
  } else {
    console.log(`  ${symbols.check} ${colors.bold('Android SDK:')}     ${colors.green('ADB available & ready')}`);
  }

  // 3. Detect connected device or auto-connect over Wi-Fi bridge
  let targetDevice = adbInstalled ? getTargetDevice() : null;

  if (adbInstalled && !targetDevice) {
    console.log(`  ${symbols.info} Searching for Dev Mode Mobile App on Wi-Fi for auto-connect...`);
    const bridge = await discoverBridge();
    if (bridge) {
      console.log(`  ${symbols.check} Discovered Dev Mode App at ${colors.cyan(bridge.ip)} (Wi-Fi Bridge)`);
      const result = await connectViaBridge(bridge, { log: (msg) => console.log(`  ${symbols.arrow} ${msg}`) });
      if (result.success) {
        targetDevice = getTargetDevice();
      } else {
        console.log(`  ${symbols.warn} ${colors.yellow('Wireless connect failed:')} ${colors.dim(result.output)}`);
      }
    }
  }

  if (targetDevice) {
    const connType = targetDevice.isWifi ? colors.cyan('Wireless ADB') : colors.yellow('USB Cable');
    console.log(`  ${symbols.check} ${colors.bold('Target Device:')}   ${colors.green(targetDevice.model || targetDevice.serial)} ${colors.dim(`(${connType})`)}`);

    // Verify Developer Options & USB Debugging are ON
    try {
      const status = getDeviceStatus(targetDevice.serial);
      if (!status.dev) {
        enableDeveloperOptions(targetDevice.serial);
        console.log(`  ${symbols.check} ${colors.bold('Developer Mode:')}  ${colors.green('Auto-enabled ON')}`);
      }
      if (!targetDevice.isWifi && !status.usb) {
        enableUsbDebugging(targetDevice.serial);
      }
    } catch (_) {}

    // Reverse port 8081 for instant Metro connectivity
    execAdb(['reverse', 'tcp:8081', 'tcp:8081'], targetDevice.serial);
  } else {
    console.log(`  ${symbols.info} ${colors.bold('Target Device:')}   ${colors.dim('None connected (running in server-only mode)')}`);
  }

  // 4. App Status Detection (Development Build vs Expo Go)
  let shouldAutoLaunch = false;
  let launchType = null; // 'custom' | 'expogo'

  if (targetDevice) {
    if (project.isDevClient) {
      const pkg = project.packageName;
      if (pkg) {
        const installed = isAppInstalledOnDevice(pkg, targetDevice.serial);
        if (installed) {
          console.log(`  ${symbols.check} ${colors.bold('App Status:')}      ${colors.green('Installed on device')} ${colors.dim(`(${pkg})`)}`);
          shouldAutoLaunch = true;
          launchType = 'custom';
        } else {
          console.log(`  ${symbols.warn} ${colors.bold('App Status:')}      ${colors.yellow('Not installed on device')} ${colors.dim(`(${pkg})`)}`);
          const answer = await promptUserWithTimeout(
            `  ${symbols.arrow} Would you like to build & install now? [Y/n] (auto-proceeds in 6s): `,
            'y',
            6
          );
          if (answer === 'y' || answer === 'yes') {
            console.log(`\n  ${symbols.rocket} ${colors.bold(colors.green('Building & installing development build...'))}\n`);
            await runExpoAndroid();
            shouldAutoLaunch = false;
          } else {
            console.log(`  ${symbols.info} Continuing to Expo development server (server-only mode)...`);
          }
        }
      } else {
        console.log(`  ${symbols.info} ${colors.bold('App Status:')}      ${colors.dim('Package ID not defined in config, skipping auto-launch.')}`);
      }
    } else {
      // Pure Expo Go
      const expoGoInstalled = isAppInstalledOnDevice('host.exp.exponent', targetDevice.serial);
      if (expoGoInstalled) {
        console.log(`  ${symbols.check} ${colors.bold('App Status:')}      ${colors.green('Expo Go installed on device')}`);
        shouldAutoLaunch = true;
        launchType = 'expogo';
      } else {
        console.log(`  ${symbols.info} ${colors.bold('App Status:')}      ${colors.dim('Expo Go not installed on device (scan QR code when server starts)')}`);
      }
    }
  }

  console.log(`\n  ${symbols.rocket} ${colors.bold(colors.green('Launching Expo Development Server (Metro)...'))}\n`);

  // Auto-launch the app only once Metro is actually serving. A fixed delay opened the app while
  // Metro was still starting, so it loaded with no bundle and had to be reopened by hand.
  if (shouldAutoLaunch && targetDevice) {
    const metroPort = parseMetroPort(extraArgs);
    waitForMetro(metroPort).then((ready) => {
      if (!ready) {
        console.log(`\n  ${symbols.warn} ${colors.yellow('Metro did not become ready in time. Open the app manually once it is running.')}\n`);
        return;
      }
      if (launchType === 'custom' && project.packageName) {
        launchAppOnDevice(project.packageName, targetDevice.serial);
        // Only grant WRITE_SECURE_SETTINGS if this is Dev Mode app
        if (project.packageName.startsWith('com.devmode.app')) {
          grantAppPermission(targetDevice.serial);
        }
      } else if (launchType === 'expogo') {
        const ip = targetDevice.ip || 'localhost';
        launchExpoGoUrl(ip, metroPort, targetDevice.serial);
      }
    });
  }

  // Use local project expo binary if available, or fall back to npx
  const localExpoBin = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'expo.cmd' : 'expo'
  );
  const expoCmd = fs.existsSync(localExpoBin) ? localExpoBin : 'npx';
  const expoArgs = fs.existsSync(localExpoBin) ? ['start', ...extraArgs] : ['expo', 'start', ...extraArgs];

  return runInteractiveProcess(expoCmd, expoArgs);
}

// Expo CLI installs the APK and then tries `am start`; if that launch fails (e.g. applicationId
// differs from the namespace) the app stays closed. Watch for the (re)install and make sure the
// app is granted + running, like `npx expo run:android` is supposed to behave.
function watchInstallAndLaunch(packageName, serial = null) {
  const pmPath = () => execAdb(['shell', 'pm', 'path', packageName], serial).stdout;
  const initial = pmPath();
  const timer = setInterval(() => {
    const current = pmPath();
    if (!current || current === initial) return;
    clearInterval(timer);
    if (packageName.startsWith('com.devmode.app')) {
      grantAppPermission(serial);
    }
    setTimeout(() => {
      const running = execAdb(['shell', 'pidof', packageName], serial).stdout;
      if (!running) {
        launchAppOnDevice(packageName, serial);
      }
    }, 4000);
  }, 2000);
  return timer;
}

async function runExpoAndroid(extraArgs = []) {
  console.log(`  ${symbols.arrow} Running Expo Android Debug Build (${colors.cyan('npx expo run:android')})...\n`);
  const project = detectProjectDetails(process.cwd());
  const device = checkAdbInstalled() ? getTargetDevice() : null;
  const watcher = project.packageName && device && !device.isUnauthorized
    ? watchInstallAndLaunch(project.packageName, device.serial)
    : null;
  try {
    const code = await runInteractiveProcess('npx', ['expo', 'run:android', ...extraArgs]);
    console.log(`\n  ${symbols.check} ${colors.bold(colors.green('Expo Android build finished.'))}\n`);
    return code;
  } finally {
    if (watcher) clearInterval(watcher);
  }
}

function triggerMetroReload(port = 8081) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/reload`, { timeout: 1500 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 205);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function reloadApp() {
  console.log(`  ${symbols.arrow} Sending reload signal to active application...`);

  // 1. Try Metro Bundler reload endpoint
  const metroSuccess = await triggerMetroReload();

  // 2. Also send ADB text input "rr" to trigger fast refresh
  const adbRes = execAdb(['shell', 'input', 'text', 'rr']);

  if (metroSuccess || adbRes.status === 0) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green('App Reloaded!'))} ${colors.dim('(Sent to Metro Bundler & Device)')}\n`);
    return true;
  } else {
    console.log(`  ${symbols.warn} ${colors.yellow('Reload signal could not reach app or Metro.')}`);
    console.log(`  ${colors.dim('Make sure Expo dev server is running or device is connected.')}\n`);
    return false;
  }
}

function openDevMenu() {
  console.log(`  ${symbols.arrow} Opening React Native / Expo Dev Menu on device...`);
  const res = execAdb(['shell', 'input', 'keyevent', '82']);
  if (res.status === 0) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green('Dev Menu opened on device screen!'))}\n`);
    return true;
  } else {
    console.log(`  ${symbols.cross} ${colors.red('Failed to open Dev Menu. Is device connected?')}\n`);
    return false;
  }
}

async function buildAndroid(isRelease = false, extraArgs = [], isAab = false) {
  const androidDir = findAndroidDir();
  if (!androidDir) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('Android project directory not found!'))}`);
    console.log(`  ${colors.yellow('Tip:')} Run this command from your project root containing the "android" folder.\n`);
    return;
  }

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  const variant = isRelease ? 'release' : 'debug';
  const taskName = (isAab ? 'bundle' : 'assemble') + variant[0].toUpperCase() + variant.slice(1);
  const ext = isAab ? '.aab' : '.apk';

  console.log(`  ${symbols.arrow} Building Android ${isAab ? 'AAB' : 'APK'} with Gradle: ${colors.cyan(taskName)}...`);
  console.log(`  ${symbols.bullet} Directory: ${colors.dim(androidDir)}\n`);

  // The JS/asset embed step only ever adds files, so images and fonts removed from the app stay in
  // app/build/generated and ship in the next APK. Clear them so the build reflects the current source.
  for (const stale of ['res', 'assets']) {
    fs.rmSync(path.join(androidDir, 'app', 'build', 'generated', stale, 'react'), { recursive: true, force: true });
  }

  try {
    await runInteractiveProcess(gradlewCmd, [taskName, ...extraArgs], { cwd: androidDir });

    const outDir = path.join(androidDir, 'app', 'build', 'outputs', isAab ? 'bundle' : 'apk', variant);
    console.log(`\n  ${symbols.check} ${colors.bold(colors.green('BUILD SUCCESSFUL!'))}`);
    console.log(`  ${symbols.bullet} Output directory: ${colors.cyan(outDir)}`);

    if (fs.existsSync(outDir)) {
      const files = fs.readdirSync(outDir).filter(f => f.endsWith(ext));
      if (files.length > 0) {
        for (const f of files) console.log(`  ${symbols.check} Generated ${isAab ? 'AAB' : 'APK'}: ${colors.bold(colors.green(path.join(outDir, f)))}`);
        if (!isAab) {
          console.log(`  ${colors.dim(`To install: devmode install:apk --${variant}`)}\n`);
        }
      }
    }
  } catch (err) {
    console.log(`\n  ${symbols.cross} ${colors.bold(colors.red('Gradle build failed:'))} ${err.message}\n`);
  }
}

function findLatestApk(customPathOrOptions = null, options = {}) {
  let targetPath = null;
  let filterRelease = false;
  let filterDebug = false;

  if (typeof customPathOrOptions === 'string') {
    if (fs.existsSync(customPathOrOptions) && fs.statSync(customPathOrOptions).isFile()) {
      return { path: customPathOrOptions, type: customPathOrOptions.includes('release') ? 'release' : 'debug' };
    }
    if (customPathOrOptions === '--release' || customPathOrOptions === '-r') filterRelease = true;
    else if (customPathOrOptions === '--debug' || customPathOrOptions === '-d') filterDebug = true;
    else targetPath = customPathOrOptions;
  } else if (typeof customPathOrOptions === 'object' && customPathOrOptions !== null) {
    options = customPathOrOptions;
  }

  if (options.release) filterRelease = true;
  if (options.debug) filterDebug = true;

  if (targetPath && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
    return { path: targetPath, type: targetPath.includes('release') ? 'release' : 'debug' };
  }

  const androidDir = findAndroidDir();
  if (!androidDir) return null;

  const baseApkDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk');
  const candidateDirs = [
    { dir: path.join(baseApkDir, 'release'), type: 'release' },
    { dir: path.join(baseApkDir, 'debug'), type: 'debug' }
  ];

  if (fs.existsSync(baseApkDir)) {
    try {
      const entries = fs.readdirSync(baseApkDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'release' && entry.name !== 'debug') {
          const full = path.join(baseApkDir, entry.name);
          const isRel = entry.name.toLowerCase().includes('release');
          candidateDirs.push({ dir: full, type: isRel ? 'release' : 'debug' });
        }
      }
    } catch (_) {}
  }

  const allApks = [];
  for (const { dir, type } of candidateDirs) {
    if (fs.existsSync(dir)) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.apk')) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            allApks.push({
              path: fullPath,
              type: file.includes('release') ? 'release' : (file.includes('debug') ? 'debug' : type),
              time: stat.mtime.getTime(),
              mtime: stat.mtime
            });
          }
        }
      } catch (_) {}
    }
  }

  if (allApks.length === 0) return null;

  // An explicit --release / --debug must never silently install the other variant
  let candidates = allApks;
  if (filterRelease || filterDebug) {
    const wanted = filterRelease ? 'release' : 'debug';
    candidates = allApks.filter(a => a.type === wanted);
    if (candidates.length === 0) return { missing: wanted };
  }

  // Newest first; on a same-build tie (ABI splits) prefer the 64-bit / universal APK
  const abiRank = (p) => (/arm64|universal/i.test(path.basename(p)) ? 0 : 1);
  candidates.sort((a, b) => (b.time - a.time) || (abiRank(a.path) - abiRank(b.path)));
  return candidates[0];
}

async function installApk(targetPath = null, options = {}) {
  let result = findLatestApk(targetPath, options);

  // Nothing built for the requested variant: offer to build it right now
  const wanted = options.release ? 'release' : (options.debug ? 'debug' : null);
  if (wanted && (!result || result.missing)) {
    console.log(`  ${symbols.warn} ${colors.yellow(`No ${wanted} APK found.`)}`);
    const answer = await promptUserWithTimeout(
      `  ${symbols.arrow} Build the ${wanted} APK now? [Y/n] (auto-proceeds in 10s): `,
      'y',
      10
    );
    if (answer !== 'y' && answer !== 'yes') {
      console.log(`  ${colors.dim(`Skipped. Build later with: devmode build --${wanted}`)}\n`);
      return;
    }
    console.log('');
    await buildAndroid(wanted === 'release');
    result = findLatestApk(targetPath, options);
  }

  if (result && result.missing) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red(`No ${result.missing} APK found!`))}`);
    console.log(`  ${colors.yellow('Tip:')} Build it first with ${colors.cyan(`devmode build --${result.missing}`)}\n`);
    return;
  }
  if (!result || !result.path) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('No APK file found to install!'))}`);
    console.log(`  ${colors.yellow('Tip:')} Build first with ${colors.cyan('devmode build:android')} or specify APK path:`);
    console.log(`  ${colors.dim('devmode install:apk path/to/app.apk')}\n`);
    return;
  }

  const apkPath = result.path;
  const apkBadge = result.type === 'release' ? colors.bold(colors.green('RELEASE')) : colors.bold(colors.yellow('DEBUG'));
  console.log(`  ${symbols.arrow} Target APK [${apkBadge}]: ${colors.cyan(apkPath)}`);
  console.log(`  ${symbols.arrow} Installing APK to device...`);
  const res = execAdb(['install', '-r', apkPath], null, 60000);

  if (res.status === 0 || (res.stdout && res.stdout.includes('Success'))) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green('APK installed successfully!'))}`);

    const project = detectProjectDetails(process.cwd());
    const pkg = project.packageName || 'com.devmode.app';
    if (pkg.startsWith('com.devmode.app')) {
      console.log(`  ${symbols.arrow} Granting WRITE_SECURE_SETTINGS permissions...`);
      grantAppPermission();
    }
    console.log(`  ${symbols.check} ${colors.green('Ready to use!')}\n`);
  } else {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('APK Installation failed:'))}`);
    console.log(`  ${colors.dim(res.stdout || res.stderr || 'Unknown error')}\n`);
  }
}

async function cleanProject() {
  const androidDir = findAndroidDir();
  console.log(`  ${symbols.arrow} Cleaning project caches...`);

  if (androidDir) {
    const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
    console.log(`  ${symbols.bullet} Running ${colors.cyan('gradlew clean')} in ${androidDir}...`);
    try {
      await runInteractiveProcess(gradlewCmd, ['clean'], { cwd: androidDir });
      console.log(`  ${symbols.check} Android build cache cleaned!`);
    } catch (_) {
      console.log(`  ${symbols.warn} Gradle clean encountered an issue, skipping...`);
    }
  }

  // Remove .expo cache directory if in cwd
  const expoCacheDir = path.join(process.cwd(), '.expo');
  if (fs.existsSync(expoCacheDir)) {
    try {
      fs.rmSync(expoCacheDir, { recursive: true, force: true });
      console.log(`  ${symbols.check} Removed .expo cache directory!`);
    } catch (_) {}
  }

  console.log(`\n  ${colors.bold(colors.green('✔ Project cleaned successfully!'))}\n`);
}

function streamLogs() {
  console.log(`  ${symbols.arrow} Streaming filtered React Native & Expo device logs (${colors.dim('Ctrl+C to exit')})...\n`);
  const child = spawnShell('adb', ['logcat', '-v', 'time', '*:S', 'ReactNative:V', 'ReactNativeJS:V', 'Expo:V', 'devmode:V', 'AndroidRuntime:E'], {
    stdio: 'inherit'
  });

  process.on('SIGINT', () => {
    try { child.kill('SIGINT'); } catch (_) {}
    process.exit(0);
  });
}

function reversePort(port = 8081) {
  console.log(`  ${symbols.arrow} Reversing port ${port} -> ${port} on device...`);
  const res = execAdb(['reverse', `tcp:${port}`, `tcp:${port}`]);
  if (res.status === 0) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green(`Port reverse active: tcp:${port} -> tcp:${port}`))}\n`);
  } else {
    console.log(`  ${symbols.cross} ${colors.red('Failed to reverse port. Is device connected?')}\n`);
  }
}

module.exports = {
  spawnShell,
  findAndroidDir,
  findLatestApk,
  detectProjectDetails,
  runExpoStart,
  runExpoAndroid,
  reloadApp,
  openDevMenu,
  buildAndroid,
  installApk,
  cleanProject,
  streamLogs,
  reversePort
};
