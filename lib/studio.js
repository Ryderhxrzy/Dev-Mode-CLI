// lib/studio.js - Lightweight Terminal Android Studio Replacement for Kotlin & Native Android
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  checkAdbInstalled,
  getTargetDevice,
  getDeviceStatus,
  enableDeveloperOptions,
  enableUsbDebugging,
  connectAdbWifi,
  grantAppPermission,
  execAdb
} = require('./adb');
const { discoverBridge, callBridge } = require('./bridge');
const { colors, symbols, banner } = require('./ui');
const { detectProjectDetails, findAndroidDir } = require('./dev');

function resolveAndroidPackage(androidDir) {
  // 1. Try reading from Expo/React Native project metadata first
  const project = detectProjectDetails(process.cwd());
  if (project.packageName) {
    return project.packageName;
  }

  // 2. Read from app/build.gradle or app/build.gradle.kts
  const candidates = [
    path.join(androidDir, 'app', 'build.gradle.kts'),
    path.join(androidDir, 'app', 'build.gradle'),
    path.join(androidDir, 'build.gradle.kts'),
    path.join(androidDir, 'build.gradle')
  ];

  for (const buildGradlePath of candidates) {
    if (fs.existsSync(buildGradlePath)) {
      const content = fs.readFileSync(buildGradlePath, 'utf8');
      const appIdMatch = content.match(/applicationId\s*(?:=|\s)?\s*['"]([^'"]+)['"]/);
      if (appIdMatch) {
        // Check if debug flavor has applicationIdSuffix
        const suffixMatch = content.match(/applicationIdSuffix\s*(?:=|\s)?\s*['"]([^'"]+)['"]/);
        if (suffixMatch) {
          return appIdMatch[1] + suffixMatch[1];
        }
        return appIdMatch[1];
      }
      const namespaceMatch = content.match(/namespace\s*(?:=|\s)?\s*['"]([^'"]+)['"]/);
      if (namespaceMatch) {
        return namespaceMatch[1];
      }
    }
  }

  // 3. Fallback
  return 'com.devmode.app.dev';
}

function runGradleInstall(androidDir, isRelease = false) {
  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  const task = isRelease ? 'installRelease' : 'installDebug';

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    console.log(`\n  ${symbols.arrow} Compiling & installing with Gradle: ${colors.bold(colors.cyan(task))}...`);
    const child = spawn(gradlewCmd, [task], {
      cwd: androidDir,
      stdio: 'inherit',
      shell: isWindows
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });
    child.on('error', () => {
      resolve(false);
    });
  });
}

function launchApp(packageName, serial = null) {
  if (!packageName) return false;
  // Force-stop first so we get a fresh launch
  execAdb(['shell', 'am', 'force-stop', packageName], serial);
  const res = execAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
  return res.status === 0;
}

function startLogcatStream(packageName, serial = null) {
  const isWindows = process.platform === 'win32';
  const logcatArgs = ['logcat', '-v', 'time'];
  if (serial) {
    logcatArgs.unshift('-s', serial);
  }

  const child = spawn('adb', logcatArgs, {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: isWindows
  });

  const pkgBase = packageName ? packageName.split('.').slice(-2).join('.') : '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      // Filter logs relevant to the app, Kotlin/Java runtime, or crashes
      const isRelevant =
        (pkgBase && line.includes(pkgBase)) ||
        (packageName && line.includes(packageName)) ||
        line.includes('AndroidRuntime') ||
        line.includes('FATAL EXCEPTION') ||
        line.includes('ReactNative') ||
        line.includes('ReactNativeJS') ||
        line.includes('DevMode') ||
        line.includes('System.out') ||
        line.includes('System.err');

      if (isRelevant) {
        if (line.includes(' E ') || line.includes('FATAL') || line.includes('AndroidRuntime')) {
          console.log(`  ${colors.bold(colors.red(line))}`);
        } else if (line.includes(' W ')) {
          console.log(`  ${colors.yellow(line)}`);
        } else {
          console.log(`  ${colors.dim(line)}`);
        }
      }
    }
  });

  return child;
}

async function runNativeStudio() {
  banner();
  console.log(`  ${colors.bold(colors.white('⚡ DEV MODE NATIVE STUDIO (Android Studio Lightweight CLI)'))}`);
  console.log(`  ${colors.gray('───────────────────────────────────────────────────')}\n`);

  // 1. Locate Android Directory
  let androidDir = findAndroidDir();
  if (!androidDir) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('Android project directory not found!'))}`);
    console.log(`  ${colors.yellow('Tip:')} Make sure you are in a project directory containing "android/" or "build.gradle".\n`);
    return;
  }

  const packageName = resolveAndroidPackage(androidDir);
  console.log(`  ${symbols.check} ${colors.bold('Android Project:')}   ${colors.cyan(androidDir)}`);
  console.log(`  ${symbols.check} ${colors.bold('Package ID:')}        ${colors.bold(colors.cyan(packageName))}`);

  // 2. Check ADB
  if (!checkAdbInstalled()) {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('ADB is not found in your system PATH!'))}\n`);
    return;
  }

  // 3. Check / Auto-Connect Device
  let targetDevice = getTargetDevice();
  if (!targetDevice) {
    console.log(`  ${symbols.info} Searching for Dev Mode Mobile App on local Wi-Fi for auto-connect...`);
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
    console.log(`  ${symbols.check} ${colors.bold('Target Device:')}     ${colors.green(targetDevice.model || targetDevice.serial)} ${colors.dim(`(${connType})`)}`);

    try {
      const status = getDeviceStatus(targetDevice.serial);
      if (!status.dev) {
        enableDeveloperOptions(targetDevice.serial);
      }
      if (!targetDevice.isWifi && !status.usb) {
        enableUsbDebugging(targetDevice.serial);
      }
    } catch (_) {}

    execAdb(['reverse', 'tcp:8081', 'tcp:8081'], targetDevice.serial);
  } else {
    console.log(`  ${symbols.warn} ${colors.yellow('No Android device connected. Please connect a phone via USB or Wi-Fi.')}\n`);
    return;
  }

  // 4. Initial Build & Install
  const buildSuccess = await runGradleInstall(androidDir);
  if (!buildSuccess) {
    console.log(`\n  ${symbols.cross} ${colors.bold(colors.red('Build failed. Check the errors above.'))}\n`);
    return;
  }

  console.log(`\n  ${symbols.check} ${colors.bold(colors.green('Build & Install SUCCESSFUL!'))}`);
  console.log(`  ${symbols.arrow} Launching ${colors.bold(packageName)} on device...`);
  launchApp(packageName, targetDevice.serial);

  // Auto grant WRITE_SECURE_SETTINGS if Dev Mode
  if (packageName.startsWith('com.devmode.app')) {
    grantAppPermission(targetDevice.serial);
  }

  // 5. Display Interactive Hotkeys Dashboard
  console.log(`\n  ${colors.bold(colors.green('╔════════════════════════════════════════════════════════════╗'))}`);
  console.log(`  ${colors.bold(colors.green('║  ⚡ NATIVE STUDIO RUNNING (Listening for changes)           ║'))}`);
  console.log(`  ${colors.bold(colors.green('╚════════════════════════════════════════════════════════════╝'))}`);
  console.log(`  ${colors.bold(colors.white('SHORTCUTS:'))}`);
  console.log(`    ${colors.bold(colors.yellow('s'))} ${colors.dim('→')} Sync & Recompile Kotlin   ${colors.bold(colors.yellow('r'))} ${colors.dim('→')} Restart App Activity`);
  console.log(`    ${colors.bold(colors.yellow('c'))} ${colors.dim('→')} Clean Gradle Build        ${colors.bold(colors.yellow('l'))} ${colors.dim('→')} Clear Logcat Console`);
  console.log(`    ${colors.bold(colors.yellow('m'))} ${colors.dim('→')} Open Dev Menu on phone    ${colors.bold(colors.yellow('k'))} ${colors.dim('→')} Kill Background Daemons`);
  console.log(`    ${colors.bold(colors.yellow('q'))} ${colors.dim('→')} Quit Studio Session\n`);
  console.log(`  ${colors.bold(colors.cyan('--- LIVE LOGCAT STREAM (Filtered for ' + packageName + ') ---'))}\n`);

  // 6. Start Logcat Stream
  let logcatProc = startLogcatStream(packageName, targetDevice.serial);

  let isBusy = false;

  // 7. Interactive Keyboard Listener
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const handleKey = async (key) => {
      // Exit on 'q' or Ctrl+C (\u0003)
      if (key === 'q' || key === '\u0003') {
        cleanupAndExit();
        return;
      }

      if (isBusy) {
        return;
      }

      // 's' -> Sync / Recompile Kotlin & Re-install
      if (key === 's') {
        isBusy = true;
        try { logcatProc.kill(); } catch (_) {}
        console.log(`\n\n  ${symbols.rocket} ${colors.bold(colors.yellow('Recompiling Kotlin/Java changes...'))}`);
        const ok = await runGradleInstall(androidDir);
        if (ok) {
          console.log(`  ${symbols.check} ${colors.bold(colors.green('Compilation & Install SUCCESSFUL!'))}`);
          launchApp(packageName, targetDevice.serial);
          if (packageName.startsWith('com.devmode.app')) {
            grantAppPermission(targetDevice.serial);
          }
        } else {
          console.log(`  ${symbols.cross} ${colors.bold(colors.red('Compilation failed. See Gradle errors above.'))}`);
        }
        console.log(`\n  ${colors.bold(colors.cyan('--- RESUMING LIVE LOGCAT STREAM ---'))}\n`);
        logcatProc = startLogcatStream(packageName, targetDevice.serial);
        isBusy = false;
        return;
      }

      // 'r' -> Restart App
      if (key === 'r') {
        console.log(`\n  ${symbols.arrow} Restarting app on device...`);
        launchApp(packageName, targetDevice.serial);
        console.log(`  ${symbols.check} App restarted!\n`);
        return;
      }

      // 'c' -> Clean Gradle
      if (key === 'c') {
        isBusy = true;
        try { logcatProc.kill(); } catch (_) {}
        console.log(`\n  ${symbols.arrow} Running ${colors.cyan('gradlew clean')}...`);
        const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
        const isWindows = process.platform === 'win32';
        const cleanChild = spawn(gradlewCmd, ['clean'], { cwd: androidDir, stdio: 'inherit', shell: isWindows });
        cleanChild.on('close', () => {
          console.log(`  ${symbols.check} Gradle clean completed!\n`);
          logcatProc = startLogcatStream(packageName, targetDevice.serial);
          isBusy = false;
        });
        return;
      }

      // 'l' -> Clear Screen
      if (key === 'l') {
        console.clear();
        console.log(`\n  ${colors.bold(colors.white('SHORTCUTS:'))} [s] Sync Kotlin  [r] Restart  [c] Clean  [l] Clear  [m] Menu  [k] Kill Daemons  [q] Quit\n`);
        console.log(`  ${colors.bold(colors.cyan('--- LIVE LOGCAT STREAM (' + packageName + ') ---'))}\n`);
        return;
      }

      // 'm' -> Dev Menu
      if (key === 'm') {
        execAdb(['shell', 'input', 'keyevent', '82'], targetDevice.serial);
        console.log(`\n  ${symbols.check} Dev menu opened on device screen!\n`);
        return;
      }

      // 'k' -> Kill Gradle Daemons
      if (key === 'k') {
        console.log(`\n  ${symbols.arrow} Stopping Gradle daemons to free up RAM...`);
        const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
        const isWindows = process.platform === 'win32';
        spawn(gradlewCmd, ['--stop'], { cwd: androidDir, stdio: 'ignore', shell: isWindows });
        console.log(`  ${symbols.check} Gradle daemons stopped! RAM freed.\n`);
        return;
      }
    };

    process.stdin.on('data', handleKey);

    function cleanupAndExit() {
      try { logcatProc.kill(); } catch (_) {}
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      console.log(`\n  ${colors.yellow('Exiting Native Studio Session. Happy Coding!')}\n`);
      process.exit(0);
    }

    process.on('SIGINT', cleanupAndExit);
  }
}

module.exports = {
  runNativeStudio
};

