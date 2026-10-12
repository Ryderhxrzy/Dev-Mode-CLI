// lib/studio.js - Lightweight Terminal Android Studio Replacement for Kotlin & Native Android
const fs = require('fs');
const path = require('path');

const {
  checkAdbInstalled,
  getTargetDevice,
  getDeviceStatus,
  enableDeveloperOptions,
  enableUsbDebugging,
  grantAppPermission,
  execAdb
} = require('./adb');
const { discoverBridge, connectViaBridge } = require('./bridge');
const { colors, symbols, banner } = require('./ui');
const { detectProjectDetails, findAndroidDir, spawnShell } = require('./dev');

const isWindows = process.platform === 'win32';
const gradlewCmd = isWindows ? '.\\gradlew.bat' : './gradlew';

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

function runGradle(androidDir, args) {
  return new Promise((resolve) => {
    const child = spawnShell(gradlewCmd, args, { cwd: androidDir, stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function runGradleInstall(androidDir, isRelease = false) {
  const task = isRelease ? 'installRelease' : 'installDebug';
  console.log(`\n  ${symbols.arrow} Compiling & installing with Gradle: ${colors.bold(colors.cyan(task))}...`);
  return runGradle(androidDir, [task]);
}

function launchApp(packageName, serial = null) {
  if (!packageName) return false;
  // Force-stop first so we get a fresh launch
  execAdb(['shell', 'am', 'force-stop', packageName], serial);
  const res = execAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
  return res.status === 0;
}

// Crashes & errors only, and only new lines (-T 1): no history dump after a build.
function startLogcatStream(packageName, serial = null) {
  const logcatArgs = ['logcat', '-v', 'time', '-T', '1', '*:E'];
  if (serial) {
    logcatArgs.unshift('-s', serial);
  }

  const child = spawnShell('adb', logcatArgs, {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });

  child.stdout.on('data', (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const isRelevant =
        line.includes(packageName) ||
        line.includes('AndroidRuntime') ||
        line.includes('FATAL EXCEPTION') ||
        line.includes('ReactNativeJS') ||
        line.includes('System.err');
      if (!isRelevant) continue;
      const isFatal = line.includes('FATAL') || line.includes('AndroidRuntime');
      console.log(`  ${isFatal ? colors.bold(colors.red(line)) : colors.red(line)}`);
    }
  });

  return child;
}

function printStudioMenu(packageName, logcatOn) {
  const row = (key, text) => console.log(`  ${colors.dim('›')} Press ${colors.bold(key)} ${colors.dim('│')} ${text}`);
  console.log(`\n  ${colors.bold(colors.white('⚡ Native Studio ready'))} ${colors.dim(`(${packageName})`)}\n`);
  row('s', 'sync & reinstall (Gradle installDebug)');
  row('i', 'clean reinstall (uninstall app first)');
  row('r', 'restart app on device');
  row('l', `${logcatOn ? 'stop' : 'show'} logcat (crashes & errors only)`);
  row('c', 'gradle clean');
  row('m', 'open dev menu on phone');
  row('k', 'stop Gradle daemons (free RAM)');
  row('?', 'show this menu');
  row('q', 'quit');
  console.log('');
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

  const serial = targetDevice.serial;

  const installAndLaunch = async (clean = false) => {
    if (clean) {
      console.log(`\n  ${symbols.arrow} Uninstalling ${colors.bold(packageName)}...`);
      execAdb(['uninstall', packageName], serial, 30000);
    }
    const ok = await runGradleInstall(androidDir);
    if (!ok) {
      console.log(`\n  ${symbols.cross} ${colors.bold(colors.red('Build failed. Check the Gradle errors above.'))}`);
      return false;
    }
    console.log(`\n  ${symbols.check} ${colors.bold(colors.green('Build & Install SUCCESSFUL!'))}`);
    console.log(`  ${symbols.arrow} Launching ${colors.bold(packageName)} on device...`);
    launchApp(packageName, serial);
    if (packageName.startsWith('com.devmode.app')) {
      grantAppPermission(serial);
    }
    return true;
  };

  // 4. Initial Build & Install
  if (!(await installAndLaunch())) {
    console.log('');
    return;
  }

  // 5. Interactive hotkeys (Expo-style). Logcat is opt-in so the menu stays readable.
  let logcatProc = null;
  let isBusy = false;
  printStudioMenu(packageName, false);

  if (!process.stdin.isTTY) return;

  const stopLogcat = () => {
    if (logcatProc) {
      try { logcatProc.kill(); } catch (_) {}
      logcatProc = null;
    }
  };

  const cleanupAndExit = () => {
    stopLogcat();
    try { process.stdin.setRawMode(false); } catch (_) {}
    console.log(`\n  ${colors.yellow('Exiting Native Studio Session. Happy Coding!')}\n`);
    process.exit(0);
  };

  // Long tasks: pause logcat, run, resume logcat if it was on, then reprint the menu.
  const busy = async (fn) => {
    if (isBusy) return;
    isBusy = true;
    const resumeLogcat = Boolean(logcatProc);
    stopLogcat();
    try {
      await fn();
    } finally {
      if (resumeLogcat) logcatProc = startLogcatStream(packageName, serial);
      isBusy = false;
      printStudioMenu(packageName, resumeLogcat);
    }
  };

  const actions = {
    s: () => busy(() => installAndLaunch(false)),
    i: () => busy(() => installAndLaunch(true)),
    c: () => busy(async () => {
      console.log(`\n  ${symbols.arrow} Running ${colors.cyan('gradlew clean')}...`);
      await runGradle(androidDir, ['clean']);
      console.log(`  ${symbols.check} Gradle clean completed!`);
    }),
    r: () => {
      launchApp(packageName, serial);
      console.log(`  ${symbols.check} App restarted on device.`);
    },
    l: () => {
      if (logcatProc) {
        stopLogcat();
        console.log(`  ${symbols.check} Logcat stopped.`);
      } else {
        logcatProc = startLogcatStream(packageName, serial);
        console.log(`  ${symbols.check} Logcat streaming ${colors.dim('(crashes & errors only, press l to stop)')}`);
      }
    },
    m: () => {
      execAdb(['shell', 'input', 'keyevent', '82'], serial);
      console.log(`  ${symbols.check} Dev menu opened on device screen.`);
    },
    k: () => {
      spawnShell(gradlewCmd, ['--stop'], { cwd: androidDir, stdio: 'ignore' });
      console.log(`  ${symbols.check} Gradle daemons stopped.`);
    },
    '?': () => printStudioMenu(packageName, Boolean(logcatProc)),
    h: () => printStudioMenu(packageName, Boolean(logcatProc)),
    q: cleanupAndExit,
    '\u0003': cleanupAndExit
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key) => {
    const action = actions[key];
    if (!action) return;
    if (isBusy && key !== 'q' && key !== '\u0003') return;
    action();
  });
  process.on('SIGINT', cleanupAndExit);
}

module.exports = {
  runNativeStudio
};
