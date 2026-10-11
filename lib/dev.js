// lib/dev.js - Developer tooling integration for Expo, React Native, and Android Gradle
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { execAdb, grantAppPermission } = require('./adb');
const { colors, symbols } = require('./ui');

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

async function runExpoStart(extraArgs = []) {
  console.log(`  ${symbols.arrow} Starting Expo Development Server (${colors.cyan('npx expo start')})...\n`);
  return runInteractiveProcess('npx', ['expo', 'start', ...extraArgs]);
}

async function runExpoAndroid(extraArgs = []) {
  console.log(`  ${symbols.arrow} Running Expo Android Debug Build (${colors.cyan('npx expo run:android')})...\n`);
  try {
    const code = await runInteractiveProcess('npx', ['expo', 'run:android', ...extraArgs]);
    console.log(`\n  ${symbols.check} ${colors.bold(colors.green('Expo Android build launched successfully!'))}`);
    
    // Automatically grant WRITE_SECURE_SETTINGS right after install
    console.log(`  ${symbols.arrow} Auto-granting WRITE_SECURE_SETTINGS to Dev Mode app...`);
    const granted = grantAppPermission();
    if (granted) {
      console.log(`  ${symbols.check} ${colors.green('Permissions granted automatically!')}\n`);
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
    
    // Automatically grant WRITE_SECURE_SETTINGS
    console.log(`  ${symbols.arrow} Granting WRITE_SECURE_SETTINGS permissions...`);
    grantAppPermission();
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
