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
const { discoverBridge, callBridge } = require('./bridge');
const { colors, symbols, banner } = require('./ui');

function runInteractiveProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows,
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

function findAndroidDir() {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'android', 'build.gradle'))) {
    return path.join(cwd, 'android');
  }
  if (fs.existsSync(path.join(cwd, 'build.gradle')) && fs.existsSync(path.join(cwd, 'app'))) {
    return cwd;
  }
  return null;
}

function detectProjectDetails(cwd = process.cwd()) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { isExpo: false, isDevClient: false, appName: null, packageName: null };
  }

  let pkgJson = {};
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (_) {
    return { isExpo: false, isDevClient: false, appName: null, packageName: null };
  }

  const allDeps = {
    ...(pkgJson.dependencies || {}),
    ...(pkgJson.devDependencies || {})
  };

  const isExpo = 'expo' in allDeps;
  const hasDevClient = 'expo-dev-client' in allDeps;
  const hasAndroidDir = fs.existsSync(path.join(cwd, 'android'));
  const isDevClient = hasDevClient || hasAndroidDir;

  let appName = pkgJson.name || 'Expo App';
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

  return {
    isExpo,
    isDevClient,
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
      const wifiRes = await callBridge(bridge.ip, 'wifi/on', bridge.port, 4000);
      if (wifiRes.success && wifiRes.data?.port) {
        const connectRes = connectAdbWifi(wifiRes.data.ip || bridge.ip, wifiRes.data.port);
        if (connectRes.success) {
          targetDevice = getTargetDevice();
        }
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
      if (!status.usb) {
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

  // Auto-launch app on device shortly after Metro initializes
  if (shouldAutoLaunch && targetDevice) {
    setTimeout(() => {
      if (launchType === 'custom' && project.packageName) {
        launchAppOnDevice(project.packageName, targetDevice.serial);
        // Only grant WRITE_SECURE_SETTINGS if this is Dev Mode app
        if (project.packageName.startsWith('com.devmode.app')) {
          grantAppPermission(targetDevice.serial);
        }
      } else if (launchType === 'expogo') {
        const ip = targetDevice.ip || 'localhost';
        launchExpoGoUrl(ip, 8081, targetDevice.serial);
      }
    }, 2500);
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

async function runExpoAndroid(extraArgs = []) {
  console.log(`  ${symbols.arrow} Running Expo Android Debug Build (${colors.cyan('npx expo run:android')})...\n`);
  try {
    const code = await runInteractiveProcess('npx', ['expo', 'run:android', ...extraArgs]);
    console.log(`\n  ${symbols.check} ${colors.bold(colors.green('Expo Android build launched successfully!'))}`);

    // Automatically grant WRITE_SECURE_SETTINGS only if project is Dev Mode
    const project = detectProjectDetails(process.cwd());
    if (project.packageName && project.packageName.startsWith('com.devmode.app')) {
      console.log(`  ${symbols.arrow} Auto-granting WRITE_SECURE_SETTINGS to Dev Mode app...`);
      const granted = grantAppPermission();
      if (granted) {
        console.log(`  ${symbols.check} ${colors.green('Permissions granted automatically!')}\n`);
      }
    }
    return code;
  } catch (err) {
    throw err;
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

async function buildAndroid(isRelease = false, extraArgs = []) {
  const androidDir = findAndroidDir();
  if (!androidDir) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('Android project directory not found!'))}`);
    console.log(`  ${colors.yellow('Tip:')} Run this command from your project root containing the "android" folder.\n`);
    return;
  }

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  const taskName = isRelease ? 'assembleRelease' : 'assembleDebug';

  console.log(`  ${symbols.arrow} Building Android APK with Gradle: ${colors.cyan(taskName)}...`);
  console.log(`  ${symbols.bullet} Directory: ${colors.dim(androidDir)}\n`);

  try {
    await runInteractiveProcess(gradlewCmd, [taskName, ...extraArgs], { cwd: androidDir });

    const apkDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', isRelease ? 'release' : 'debug');
    console.log(`\n  ${symbols.check} ${colors.bold(colors.green('BUILD SUCCESSFUL!'))}`);
    console.log(`  ${symbols.bullet} Output directory: ${colors.cyan(apkDir)}`);

    if (fs.existsSync(apkDir)) {
      const files = fs.readdirSync(apkDir).filter(f => f.endsWith('.apk'));
      if (files.length > 0) {
        console.log(`  ${symbols.check} Generated APK: ${colors.bold(colors.green(path.join(apkDir, files[0])))}`);
        console.log(`  ${colors.dim(`To install: devmode install:apk ${path.join(apkDir, files[0])}`)}\n`);
      }
    }
  } catch (err) {
    console.log(`\n  ${symbols.cross} ${colors.bold(colors.red('Gradle build failed:'))} ${err.message}\n`);
  }
}

function findLatestApk(customPath = null) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const androidDir = findAndroidDir();
  if (!androidDir) return null;

  const candidateDirs = [
    path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug'),
    path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release')
  ];

  for (const dir of candidateDirs) {
    if (fs.existsSync(dir)) {
      const apks = fs.readdirSync(dir)
        .filter(f => f.endsWith('.apk'))
        .map(f => ({
          path: path.join(dir, f),
          time: fs.statSync(path.join(dir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      if (apks.length > 0) {
        return apks[0].path;
      }
    }
  }

  return null;
}

function installApk(targetPath = null) {
  const apkPath = findLatestApk(targetPath);
  if (!apkPath) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('No APK file found to install!'))}`);
    console.log(`  ${colors.yellow('Tip:')} Build first with ${colors.cyan('devmode build:android')} or specify APK path:`);
    console.log(`  ${colors.dim('devmode install:apk path/to/app.apk')}\n`);
    return;
  }

  console.log(`  ${symbols.arrow} Installing APK to device: ${colors.cyan(apkPath)}...`);
  const res = execAdb(['install', '-r', apkPath], null, 60000);

  if (res.status === 0 || (res.stdout && res.stdout.includes('Success'))) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green('APK installed successfully!'))}`);

    const project = detectProjectDetails(process.cwd());
    if (project.packageName && project.packageName.startsWith('com.devmode.app')) {
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
  const isWindows = process.platform === 'win32';
  const child = spawn('adb', ['logcat', '-v', 'time', '*:S', 'ReactNative:V', 'ReactNativeJS:V', 'Expo:V', 'devmode:V', 'AndroidRuntime:E'], {
    stdio: 'inherit',
    shell: isWindows
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
