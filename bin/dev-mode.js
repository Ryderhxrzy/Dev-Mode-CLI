#!/usr/bin/env node

// bin/dev-mode.js - Dev Mode CLI entry point
const {
  colors,
  symbols,
  banner,
  printDevModeIcon,
  printStatusItem,
  printKeyValue,
  printQuickActions,
  printWelcomeMessage,
  printSignOffMessage,
  printCheerMessage
} = require('../lib/ui');
const {
  checkAdbInstalled,
  getConnectedDevices,
  getDetailedDevices,
  getTargetDevice,
  getDeviceIp,
  getDeviceWifiPort,
  enableDeveloperOptions,
  disableDeveloperOptions,
  enableUsbDebugging,
  disableUsbDebugging,
  enableWirelessDebugging,
  disableWirelessDebugging,
  connectAdbWifi,
  disconnectAdbWifi,
  discoverMdnsServices,
  getDeviceStatus,
  setAnimationScales,
  grantAppPermission,
  getAdbPerformanceMetrics,
  execAdb
} = require('../lib/adb');
const { saveConfig, getLastDevice } = require('../lib/config');
const { discoverBridge, discoverAllBridgesViaUdp, checkBridgeAvailable, callBridge, connectViaBridge } = require('../lib/bridge');
const {
  runExpoStart,
  runExpoAndroid,
  reloadApp,
  openDevMenu,
  buildAndroid,
  installApk,
  cleanProject,
  streamLogs,
  reversePort
} = require('../lib/dev');
const { startWebServer } = require('../lib/web');
const { handleBluetoothMonitor, printBluetoothStatusSummary } = require('../lib/bluetooth');

const args = process.argv.slice(2);

function showHelp() {
  banner();
  console.log(`  ${colors.bold('USAGE:')}
    ${colors.cyan('devmode')} ${colors.yellow('<command>')} [options]
    ${colors.dim('or via npx:')} ${colors.cyan('npx dev-mode-cli')} ${colors.yellow('<command>')} [options]

  ${colors.bold('CORE COMMANDS:')}
    ${colors.yellow('web [port]')}            Launch interactive Web Dashboard (default: http://localhost:3288)
    ${colors.yellow('auto')}                  Interactive menu: press one key to run any command below
    ${colors.yellow('on')}                  Turn ON Developer Options (displays green ASCII icon)
    ${colors.yellow('off')}                 Turn OFF Developer Options only
    ${colors.yellow('icon')}                Display official Dev Mode green ASCII icon
    ${colors.yellow('status')}              Show current device status and IP/Port info

  ${colors.bold('MOBILE APP BRIDGE & PERMISSIONS:')}
    ${colors.yellow('bridge')}              Discover and inspect direct Wi-Fi bridge to Mobile App
    ${colors.yellow('grant')}               Grant WRITE_SECURE_SETTINGS to Dev Mode mobile app

  ${colors.bold('WIRELESS ADB (Auto-Connect):')}
    ${colors.yellow('wifi on [port]')}        Enable Wireless ADB and ${colors.bold(colors.green('auto-connect'))} over Wi-Fi (dynamic or custom port)
    ${colors.yellow('wifi off')}              Disconnect and disable Wireless ADB
    ${colors.yellow('wifi connect [ip:port]')} Connect to device over Wi-Fi (auto-detects if omitted)
    ${colors.yellow('wifi disconnect')}       Disconnect current wireless sessions

  ${colors.bold('SMART DEVICE MANAGER & PERFORMANCE:')}
    ${colors.yellow('devices / list')}        Display all connected Android devices, IP, model & status
    ${colors.yellow('use <serial|ip>')}       Switch active target Android device
    ${colors.yellow('perf / stats')}          Live hardware monitor: CPU, RAM, battery % & temperature
    ${colors.yellow('bt / bluetooth / music')} Live Bluetooth connection timer, battery % & Now Playing music
    ${colors.yellow('watch / connect:auto')}  Auto-discover and reconnect paired devices over Wi-Fi
    ${colors.yellow('mirror / cast')}         Live screen mirroring to PC browser (zero 3rd-party)

  ${colors.bold('USB & SYSTEM CONTROLS:')}
    ${colors.yellow('usb on')}              Turn ON USB Debugging
    ${colors.yellow('usb off')}             Turn OFF USB Debugging
    ${colors.yellow('speed <0.5|1.0|0.0>')}  Set UI animation speed scale (Speed Booster)

  ${colors.bold('EXPO & ANDROID DEV SUITE:')}
    ${colors.yellow('start / run [--native]')}  Auto-detects project: starts Expo server or Native Studio
    ${colors.yellow('studio / native')}        Lightweight Android Studio CLI for Kotlin & live Logcat
    ${colors.yellow('debug:android')}          Build & launch debug app on device (npx expo run:android)
    ${colors.yellow('reload')}                 Fast-refresh active app (Metro endpoint & device keyevent)
    ${colors.yellow('menu')}                   Open React Native / Expo Dev Menu on device screen
    ${colors.yellow('build:aab')}              Build production AAB for Google Play (bundleRelease)
    ${colors.yellow('build:android')}          Build APK with native Gradle (assembleDebug / assembleRelease)
    ${colors.yellow('install:apk [file]')}     Install latest APK (--release | --debug to pick variant)
    ${colors.yellow('clean')}                  Clean Gradle and Metro project caches
    ${colors.yellow('logs')}                   Stream filtered React Native & Expo device logcat
    ${colors.yellow('reverse [port]')}         Set up ADB reverse port for Metro (default: 8081)
    ${colors.yellow('api bridge [options]')}   Smart Local API Bridge with auto-reconnect & live [l] logs
    ${colors.yellow('api start [options]')}    All-in-One: start local backend server + Smart API Bridge + live [l] logs
    ${colors.yellow('api test [routes]')}      Test local API endpoints with live visual progress bar

  ${colors.bold('EXAMPLES:')}
    ${colors.gray('$')} devmode on
    ${colors.gray('$')} devmode wifi on         ${colors.dim('# Auto-resolves IP & Port, then connects!')}
    ${colors.gray('$')} devmode start           ${colors.dim('# Auto-detects & starts dev server (Expo or Android)')}
    ${colors.gray('$')} devmode start --native  ${colors.dim('# Starts Native Studio for Kotlin/Gradle')}
    ${colors.gray('$')} devmode debug:android   ${colors.dim('# Builds & launches on connected Android')}
    ${colors.gray('$')} devmode reload          ${colors.dim('# Instant hot-reload active app')}
    ${colors.gray('$')} devmode build:aab       ${colors.dim('# Generates release AAB for Google Play Store')}
    ${colors.gray('$')} devmode build:android   ${colors.dim('# Compiles debug APK via Gradle')}
    ${colors.gray('$')} devmode install:apk     ${colors.dim('# Installs latest built APK to phone')}
    ${colors.gray('$')} devmode grant           ${colors.dim('# Grants permissions to Dev Mode mobile app')}
    ${colors.gray('$')} devmode status
`);
}

function promptUser(questionText) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      return resolve('1');
    }
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(questionText, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

async function handleNoDeviceGuide(device = null) {
  if (device && device.isUnauthorized) {
    console.log(`  ${symbols.warn} ${colors.bold(colors.yellow(`Device detected (${device.model || device.serial}), but it is UNAUTHORIZED.`))}`);
    console.log(`  ${colors.bold('Action required:')} Unlock your phone screen and tap ${colors.green('"Always allow from this computer"')} on the prompt.\n`);
    return;
  }

  console.log(`  ${symbols.cross} ${colors.bold(colors.red('No trusted Android device connected.'))}\n`);
  console.log(`  ${colors.bold('What would you like to do?')}`);
  console.log(`  ${colors.cyan('[1]')} Setup WITHOUT App ${colors.dim('(Enable USB Debugging on your phone for pure CLI use)')}`);
  console.log(`  ${colors.cyan('[2]')} Setup WITH Dev Mode App ${colors.dim('(For Home Screen Widgets & Notification Shade)')}`);
  console.log(`  ${colors.cyan('[3]')} Exit\n`);

  const choice = await promptUser('  Select an option [1-3] (default: 1): ');

  if (choice === '2') {
    console.log(`\n  ${colors.bold(colors.green('📱 Setup WITH Dev Mode Mobile App:'))}`);
    console.log(`  1. Download the APK: ${colors.cyan('https://github.com/Ryderhxrzy/Dev-Mode-Mobile/releases')}`);
    console.log(`  2. Install the APK on your phone.`);
    console.log(`  3. Connect your phone via USB cable and run:`);
    console.log(`     ${colors.bold(colors.yellow('npx dev-mode-cli grant'))} ${colors.dim('# Automatically grants WRITE_SECURE_SETTINGS')}`);
    console.log(`     ${colors.dim('Or manually: adb shell pm grant com.devmode.app android.permission.WRITE_SECURE_SETTINGS')}`);
    console.log(`  4. Home screen widgets (3x1 & 1x1) and status bar toggles will now work!\n`);
  } else if (choice === '3') {
    console.log('');
  } else {
    // Option 1 (default)
    console.log(`\n  ${colors.bold(colors.green('📋 Setup WITHOUT Mobile App (Pure CLI Utility):'))}`);
    console.log(`  1. Open ${colors.bold('Settings')} on your Android phone.`);
    console.log(`  2. Go to ${colors.bold('About Phone')} and tap ${colors.bold('Build Number')} 7 times.`);
    console.log(`  3. Go to ${colors.bold('Developer Options')} and turn ON ${colors.bold('USB Debugging')}.`);
    console.log(`  4. Connect your phone to this PC via USB cable.`);
    console.log(`  5. On your phone screen, check ${colors.green('"Always allow from this computer"')} and tap ${colors.green('Allow')}.`);
    console.log(`\n  ${colors.bold(colors.yellow('🎉 Once connected, run "devmode on" or "devmode wifi on" anytime!'))}\n`);
  }
}

async function handleWifiOn(targetDevice, specifiedPort = null) {
  banner();

  let activeDevice = targetDevice;

  // 1. If no device connected via USB or ADB yet, check mobile app bridge or local Wi-Fi
  if (!activeDevice) {
    console.log(`  ${symbols.info} No active USB or ADB device detected. Checking local Wi-Fi for Dev Mode app...`);

    // A. Direct communication with Dev Mode Mobile App over local Wi-Fi Bridge
    const bridge = await tryBridgeFallback();
    if (bridge) {
      console.log(`  ${symbols.check} ${colors.bold(colors.green('Connected to Dev Mode Mobile App'))} at ${colors.cyan(bridge.ip)} (Wi-Fi Bridge)`);
      console.log(`  ${symbols.arrow} Enabling Wireless Debugging via Mobile App...`);

      const result = await connectViaBridge(bridge, {
        specifiedPort,
        log: (msg) => console.log(`  ${symbols.arrow} ${msg}`)
      });

      if (result.success) {
        saveConfig({ lastIp: result.ip, lastPort: result.port });
        console.log(`\n  ${colors.bold(colors.green('╔════════════════════════════════════════════════════════╗'))}`);
        console.log(`  ${colors.bold(colors.green('║  ✔ WIRELESS ADB CONNECTED (WITHOUT CABLE)!             ║'))}`);
        console.log(`  ${colors.bold(colors.green('╚════════════════════════════════════════════════════════╝'))}`);
        console.log(`  ${symbols.bullet} Endpoint:  ${colors.bold(colors.cyan(`${result.ip}:${result.port}`))}`);
        console.log(`  ${symbols.bullet} Status:    ${colors.bold(colors.green('ACTIVE & CONNECTED'))}`);
        console.log(`\n  ${colors.bold(colors.yellow('🎉 Connected completely wireless over local Wi-Fi!'))}\n`);
        printCheerMessage('wifi-on');
        return;
      }

      console.log(`\n  ${symbols.warn} ${colors.yellow('Could not connect over Wi-Fi:')} ${colors.dim(result.output)}`);
      if (!result.port) {
        console.log(`  ${colors.dim('Check Settings > Wireless Debugging on your phone for the 5-digit port.')}`);
        console.log(`  ${colors.dim('Connect with: devmode wifi on <port>')}\n`);
      } else {
        console.log(`  ${colors.yellow('Tip:')} Make sure this PC was authorized once over USB (or paired in Wireless Debugging),`);
        console.log(`  ${colors.yellow('    ')} and that phone and PC are on the same Wi-Fi without AP isolation.\n`);
      }
      return;
    }

    // B. Check mDNS
    const mdnsList = discoverMdnsServices();
    if (mdnsList.length > 0) {
      const found = mdnsList[0];
      console.log(`  ${symbols.check} Discovered wireless device via mDNS: ${colors.cyan(found.ip + ':' + found.port)}`);
      console.log(`  ${symbols.arrow} Connecting via adb connect ${found.ip}:${found.port}...`);
      const connectResult = connectAdbWifi(found.ip, found.port);
      if (connectResult.success) {
        saveConfig({ lastIp: found.ip, lastPort: found.port });
        console.log(`\n  ${colors.bold(colors.green('✔ Successfully connected to device wirelessly!'))}`);
        console.log(`  ${colors.dim(`Connected to: ${found.ip}:${found.port}`)}\n`);
        printCheerMessage('wifi-on');
        return;
      }
    }

    // C. Try last known cached device
    const last = getLastDevice();
    if (last.lastIp && last.lastPort) {
      console.log(`  ${symbols.info} Attempting connection to last known device: ${colors.cyan(last.lastIp + ':' + last.lastPort)}...`);
      const connectResult = connectAdbWifi(last.lastIp, last.lastPort);
      if (connectResult.success) {
        console.log(`\n  ${colors.bold(colors.green('✔ Successfully reconnected to device wirelessly!'))}`);
        console.log(`  ${colors.dim(`Connected to: ${last.lastIp}:${last.lastPort}`)}\n`);
        printCheerMessage('wifi-on');
        return;
      }
    }

    console.log(`\n  ${symbols.cross} ${colors.bold(colors.red('No device found.'))}`);
    console.log(`  ${colors.yellow('Tip:')} Plug in your phone via USB once, or enable Dev Mode app on Wi-Fi.\n`);
    return;
  }

  console.log(`  ${symbols.arrow} Target device: ${colors.cyan(activeDevice.model || activeDevice.serial)} (${activeDevice.serial})`);
  console.log(`  ${symbols.arrow} Enabling Wireless Debugging on device...`);

  enableWirelessDebugging(activeDevice.serial);

  console.log(`  ${symbols.arrow} Resolving device local Wi-Fi IP address...`);
  const ip = getDeviceIp(activeDevice.serial);
  if (!ip) {
    console.log(`  ${symbols.warn} ${colors.yellow('Could not detect device Wi-Fi IP address.')}`);
    console.log(`  ${colors.dim('Make sure the device is connected to the same Wi-Fi network as this PC.')}\n`);
    return;
  }
  console.log(`  ${symbols.check} Local IP detected: ${colors.bold(colors.cyan(ip))}`);

  let port = null;
  if (specifiedPort) {
    const parsed = parseInt(specifiedPort, 10);
    if (!isNaN(parsed) && parsed > 0) {
      port = parsed;
      console.log(`  ${symbols.info} Using specified wireless port: ${colors.bold(colors.cyan(String(port)))}`);
    }
  }

  if (!port) {
    console.log(`  ${symbols.arrow} Resolving dynamic Wireless ADB port...`);
    port = getDeviceWifiPort(activeDevice.serial, 6);
  }

  // If no dynamic TLS port was found (e.g. Android 10 or classic mode), configure standard tcpip 5555
  if (!port) {
    console.log(`  ${symbols.info} Dynamic TLS port not detected. Configuring classic TCP/IP mode (port 5555)...`);
    const tcpRes = execAdb(['tcpip', '5555'], activeDevice.serial);
    if (tcpRes.status === 0) {
      port = 5555;
    }
  }

  if (!port) {
    console.log(`  ${symbols.warn} ${colors.yellow('Wireless port is still binding or unavailable.')}`);
    console.log(`  ${colors.dim('Check Developer Options > Wireless Debugging on your phone for the 5-digit port.')}`);
    console.log(`  ${colors.dim('You can connect directly with: devmode wifi on <port>')}\n`);
    return;
  }

  console.log(`  ${symbols.check} Wireless Port: ${colors.bold(colors.cyan(String(port)))}`);
  console.log(`  ${symbols.arrow} Automatically connecting: ${colors.bold(`adb connect ${ip}:${port}`)}...`);

  const connectResult = connectAdbWifi(ip, port);
  if (connectResult.success) {
    saveConfig({ lastIp: ip, lastPort: port, lastSerial: activeDevice.serial, lastModel: activeDevice.model });

    console.log(`\n  ${colors.bold(colors.green('╔════════════════════════════════════════════════════════╗'))}`);
    console.log(`  ${colors.bold(colors.green('║  ✔ WIRELESS ADB CONNECTED SUCCESSFULLY!                ║'))}`);
    console.log(`  ${colors.bold(colors.green('╚════════════════════════════════════════════════════════╝'))}`);
    console.log(`  ${symbols.bullet} Endpoint:  ${colors.bold(colors.cyan(`${ip}:${port}`))}`);
    console.log(`  ${symbols.bullet} Status:    ${colors.bold(colors.green('ACTIVE & CONNECTED'))}`);
    console.log(`\n  ${colors.bold(colors.yellow('🎉 You can now safely unplug your USB cable!'))}\n`);
    printCheerMessage('wifi-on');
  } else {
    console.log(`\n  ${symbols.warn} ${colors.yellow('Connection failed or timed out:')} ${colors.dim(connectResult.output)}`);
    console.log(`\n  ${colors.bold('Troubleshooting tips:')}`);
    console.log(`  1. Ensure PC and Phone are on the ${colors.bold('same Wi-Fi band')} (e.g. both on 2.4GHz or both on 5GHz).`);
    console.log(`  2. Some routers (PLDT/Converge/Globe) have ${colors.bold('AP Isolation / Client Isolation')} enabled.`);
    console.log(`     Try turning off AP Isolation in your router, or connect your phone to your PC's Mobile Hotspot.`);
    console.log(`  3. On Android 11+, check the 5-digit port shown in Settings > Wireless Debugging.`);
    console.log(`     Run: ${colors.cyan(`devmode wifi on <port>`)} (e.g. ${colors.cyan(`devmode wifi on 40431`)}).`);
    console.log(`  4. Make sure you allow the "Always allow on this network" pairing prompt if shown.\n`);
  }
}

async function handleWifiOff(targetDevice) {
  banner();
  console.log(`  ${symbols.arrow} Disconnecting all Wireless ADB sessions...`);
  disconnectAdbWifi();

  if (targetDevice) {
    console.log(`  ${symbols.arrow} Disabling Wireless Debugging on device...`);
    disableWirelessDebugging(targetDevice.serial);
  } else {
    const bridge = await tryBridgeFallback();
    if (bridge) {
      console.log(`  ${symbols.arrow} Disabling Wireless Debugging via Mobile App...`);
      await callBridge(bridge.ip, 'wifi/off');
    }
  }

  console.log(`  ${symbols.check} ${colors.green('Wireless ADB has been disconnected and disabled.')}\n`);
  printCheerMessage('wifi-off');
}

async function handleWifiConnect(targetDevice, specifiedTarget) {
  banner();
  let target = specifiedTarget;

  if (!target) {
    // Check mDNS first
    const mdnsList = discoverMdnsServices();
    if (mdnsList.length > 0) {
      target = `${mdnsList[0].ip}:${mdnsList[0].port}`;
      console.log(`  ${symbols.check} Auto-detected device via mDNS: ${colors.cyan(target)}`);
    } else {
      const last = getLastDevice();
      if (last.lastIp && last.lastPort) {
        target = `${last.lastIp}:${last.lastPort}`;
        console.log(`  ${symbols.info} Using last known device: ${colors.cyan(target)}`);
      }
    }
  }

  if (!target) {
    console.log(`  ${symbols.cross} ${colors.red('Please specify the IP and Port to connect:')}`);
    console.log(`  ${colors.dim('Usage: devmode wifi connect 192.168.1.15:39821')}\n`);
    return;
  }

  const [ip, port] = target.includes(':') ? target.split(':') : [target, '5555'];
  console.log(`  ${symbols.arrow} Connecting to ${colors.cyan(`${ip}:${port}`)}...`);
  const result = connectAdbWifi(ip, port);
  if (result.success) {
    saveConfig({ lastIp: ip, lastPort: parseInt(port, 10) });
    console.log(`  ${symbols.check} ${colors.bold(colors.green(`Successfully connected to ${ip}:${port}!`))}\n`);
  } else {
    console.log(`  ${symbols.cross} ${colors.red(`Failed to connect to ${ip}:${port}:`)} ${result.output}\n`);
  }
}

async function tryBridgeFallback() {
  return await discoverBridge();
}

async function handleStatus(targetDevice) {
  banner();
  if (!targetDevice || targetDevice.isUnauthorized) {
    const bridge = await tryBridgeFallback();
    if (bridge && bridge.status) {
      console.log(`  ${colors.bold(colors.green('📱 DEV MODE MOBILE APP (LOCAL WI-FI BRIDGE)'))}\n`);
      printKeyValue('Phone IP Address', bridge.ip);
      printKeyValue('Bridge Port', String(bridge.port));
      printStatusItem('Developer Options', bridge.status.developerOptions, bridge.status.developerOptions === 'enabled');
      printStatusItem('USB Debugging', bridge.status.usbDebugging, bridge.status.usbDebugging === 'enabled');
      printStatusItem('Wireless Debugging', bridge.status.wirelessDebugging, bridge.status.wirelessDebugging === 'enabled');
      console.log(`\n  ${colors.dim('Connected directly to Dev Mode Mobile App on your local network (ADB bypassed).')}\n`);
      printQuickActions();
      return;
    }
    await handleNoDeviceGuide(targetDevice);
    return;
  }

  console.log(`  ${colors.bold('DEVICE INFORMATION:')}`);
  printKeyValue('Model', targetDevice.model);
  printKeyValue('Serial / ID', targetDevice.serial);
  printKeyValue('Connection Type', targetDevice.isWifi ? 'Wi-Fi (Wireless ADB)' : 'USB Cable');

  console.log(`\n  ${colors.bold('DEVELOPER SETTINGS STATUS:')}`);
  const status = getDeviceStatus(targetDevice.serial);

  printStatusItem('Developer Options', status.dev, status.dev);
  printStatusItem('USB Debugging', status.usb, status.usb);
  printStatusItem('Wireless Debugging', status.wifi, status.wifi);

  if (status.ip) {
    printKeyValue('Device Wi-Fi IP', status.ip);
  }
  if (status.port) {
    printKeyValue('Active Wireless Port', String(status.port));
  }
  printKeyValue('Animation Scale', `${status.scale}x`);

  try {
    printBluetoothStatusSummary(targetDevice.serial);
  } catch (_) {}

  console.log('');
}

async function handleDevOn(targetDevice) {
  printDevModeIcon();
  if (!targetDevice || targetDevice.isUnauthorized) {
    const bridge = await tryBridgeFallback();
    if (bridge) {
      console.log(`  ${symbols.check} ${colors.bold(colors.green('Connected to Dev Mode Mobile App'))} at ${colors.cyan(bridge.ip)} (Wi-Fi Bridge)`);
      console.log(`  ${symbols.arrow} Enabling Developer Options via Mobile App...`);
      const res = await callBridge(bridge.ip, 'dev/on');
      if (res.success) {
        console.log(`  ${symbols.check} ${colors.bold(colors.green('Developer Options: ENABLED'))}`);
        console.log(`  ${colors.dim('Settings updated directly via Mobile App Bridge (rootless & without ADB).')}\n`);
        printWelcomeMessage();
        printQuickActions();
        return;
      }
    }
    await handleNoDeviceGuide(targetDevice);
    return;
  }

  console.log(`  ${symbols.arrow} Target: ${colors.cyan(targetDevice.model || targetDevice.serial)}`);
  console.log(`  ${symbols.arrow} Enabling Developer Options...`);
  enableDeveloperOptions(targetDevice.serial);

  console.log(`  ${symbols.check} ${colors.bold(colors.green('Developer Options: ENABLED'))}`);
  console.log(`  ${colors.dim('Dev Mode widgets and status bar notification synchronized.')}\n`);
  printWelcomeMessage();
  printQuickActions();
}

async function handleDevOff(targetDevice) {
  banner();
  if (!targetDevice || targetDevice.isUnauthorized) {
    const bridge = await tryBridgeFallback();
    if (bridge) {
      console.log(`  ${symbols.check} ${colors.bold(colors.green('Connected to Dev Mode Mobile App'))} at ${colors.cyan(bridge.ip)} (Wi-Fi Bridge)`);
      console.log(`  ${symbols.arrow} Disabling Developer Options via Mobile App...`);
      const res = await callBridge(bridge.ip, 'dev/off');
      if (res.success) {
        console.log(`  ${symbols.check} ${colors.bold(colors.red('Developer Options: DISABLED'))}`);
        console.log(`  ${colors.dim('Settings updated directly via Mobile App Bridge.')}\n`);
        printSignOffMessage();
        printQuickActions();
        return;
      }
    }
    await handleNoDeviceGuide(targetDevice);
    return;
  }

  console.log(`  ${symbols.arrow} Target: ${colors.cyan(targetDevice.model || targetDevice.serial)}`);
  console.log(`  ${symbols.arrow} Disabling Developer Options...`);
  disableDeveloperOptions(targetDevice.serial);

  console.log(`  ${symbols.check} ${colors.bold(colors.red('Developer Options: DISABLED'))}\n`);
  printSignOffMessage();
  printQuickActions();
}

async function handleUsb(targetDevice, subCommand) {
  banner();
  if (!targetDevice || targetDevice.isUnauthorized) {
    const bridge = await tryBridgeFallback();
    if (bridge) {
      console.log(`  ${symbols.check} ${colors.bold(colors.green('Connected to Dev Mode Mobile App'))} at ${colors.cyan(bridge.ip)} (Wi-Fi Bridge)`);
      if (subCommand === 'on' || subCommand === 'off') {
        console.log(`  ${symbols.arrow} Setting USB Debugging to ${subCommand.toUpperCase()} via Mobile App...`);
        const res = await callBridge(bridge.ip, subCommand === 'on' ? 'usb/on' : 'usb/off');
        if (res.success) {
          const stateStr = subCommand === 'on' ? colors.bold(colors.green('ENABLED')) : colors.bold(colors.red('DISABLED'));
          console.log(`  ${symbols.check} USB Debugging: ${stateStr}`);
          console.log(`  ${colors.dim(`USB Debugging is now ${subCommand.toUpperCase()} on your device!`)}\n`);
          printCheerMessage(subCommand === 'on' ? 'usb-on' : 'usb-off');
          printQuickActions();
          return;
        }
      }
    }
    await handleNoDeviceGuide(targetDevice);
    return;
  }

  if (subCommand === 'on') {
    enableUsbDebugging(targetDevice.serial);
    console.log(`  ${symbols.check} ${colors.bold(colors.green('USB Debugging: ENABLED'))}\n`);
    printCheerMessage('usb-on');
  } else if (subCommand === 'off') {
    disableUsbDebugging(targetDevice.serial);
    console.log(`  ${symbols.check} ${colors.bold(colors.red('USB Debugging: DISABLED'))}\n`);
    printCheerMessage('usb-off');
  } else {
    console.log(`  ${symbols.warn} Usage: devmode usb <on|off>\n`);
  }
}

async function handleSpeed(targetDevice, scaleArg) {
  banner();
  if (!targetDevice || targetDevice.isUnauthorized) {
    await handleNoDeviceGuide(targetDevice);
    return;
  }

  const scale = scaleArg ? parseFloat(scaleArg) : 0.5;
  if (isNaN(scale) || scale < 0 || scale > 10) {
    console.log(`  ${symbols.cross} ${colors.red('Invalid animation scale. Use 0.5, 1.0, or 0.0')}\n`);
    return;
  }

  console.log(`  ${symbols.arrow} Setting system animation scale to ${colors.cyan(scale + 'x')}...`);
  setAnimationScales(scale, targetDevice.serial);
  console.log(`  ${symbols.check} ${colors.bold(colors.green(`Animation scales updated to ${scale}x (Speed Booster applied)`))}\n`);
  printCheerMessage('speed');
}

async function handleGrant(targetDevice) {
  banner();
  if (!targetDevice || targetDevice.isUnauthorized) {
    await handleNoDeviceGuide(targetDevice);
    return;
  }

  console.log(`  ${symbols.arrow} Target: ${colors.cyan(targetDevice.model || targetDevice.serial)}`);
  console.log(`  ${symbols.arrow} Granting WRITE_SECURE_SETTINGS to com.devmode.app...`);
  const success = grantAppPermission(targetDevice.serial);

  if (success) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green('Permission GRANTED successfully!'))}`);
    console.log(`  ${colors.dim('Dev Mode mobile app can now toggle Developer Options, USB, and widgets rootless.')}\n`);
  } else {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('Failed to grant permission.'))}`);
    console.log(`  ${colors.yellow('Make sure the Dev Mode app is installed on the phone first.')}`);
    console.log(`  Download APK: ${colors.cyan('https://github.com/Ryderhxrzy/Dev-Mode-Mobile/releases')}\n`);
  }
}

// `devmode auto`: one-key interactive menu over the existing commands (Expo-style hotkeys)
async function handleAuto() {
  const MENU = [
    ['o', 'Toggle Developer Options'],
    ['u', 'Toggle USB Debugging'],
    ['w', 'Toggle Wireless Debugging (auto-connect over Wi-Fi)'],
    ['c', 'Reconnect Wireless ADB (last known device)'],
    ['s', 'Device status'],
    ['g', 'Grant permissions to Dev Mode app'],
    ['a', 'Start dev server (Expo / Native Studio)'],
    ['d', 'Build & launch debug app (expo run:android)'],
    ['b', 'Build debug APK'],
    ['p', 'Build release APK'],
    ['i', 'Install latest APK'],
    ['l', 'Stream device logs'],
    ['m', 'Open dev menu on phone'],
    ['k', 'Bluetooth & Music Live Monitor (connected duration & Now Playing)'],
    ['v', 'Live Screen Mirroring / Sharing (zero 3rd-party)'],
    ['?', 'Show this menu'],
    ['q', 'Quit']
  ];
  // These take over the terminal; leave the menu instead of returning to it
  const DETACH = new Set(['a', 'd', 'l', 'k']);

  const printMenu = () => {
    console.clear();
    banner();
    console.log(`  ${colors.bold(colors.white('⚡ AUTO MODE'))} ${colors.dim('press a key to run a command')}\n`);
    for (const [key, text] of MENU) {
      console.log(`  ${colors.dim('›')} Press ${colors.bold(colors.yellow(key))} ${colors.dim('│')} ${text}`);
    }
    console.log('');
  };

  // Current ON/OFF state via ADB, or via the Mobile App bridge when no ADB device is attached
  const currentState = async (device) => {
    if (device && !device.isUnauthorized) {
      const s = getDeviceStatus(device.serial);
      return { dev: s.dev, usb: s.usb, wifi: s.wifi };
    }
    const bridge = await discoverBridge();
    if (bridge && bridge.status) {
      const on = (v) => v === 'enabled';
      return { dev: on(bridge.status.developerOptions), usb: on(bridge.status.usbDebugging), wifi: on(bridge.status.wirelessDebugging) };
    }
    return null;
  };

  const actions = {
    o: async (d) => { const st = await currentState(d); return st && st.dev ? handleDevOff(d) : handleDevOn(d); },
    u: async (d) => { const st = await currentState(d); return handleUsb(d, st && st.usb ? 'off' : 'on'); },
    w: async (d) => { const st = await currentState(d); return st && st.wifi ? handleWifiOff(d) : handleWifiOn(d); },
    c: (d) => handleWifiConnect(d, null),
    s: (d) => handleStatus(d),
    g: (d) => handleGrant(d),
    a: () => runExpoStart([]),
    d: () => runExpoAndroid([]),
    b: () => buildAndroid(false),
    p: () => buildAndroid(true),
    i: () => installApk(null, {}),
    l: () => streamLogs(),
    m: () => openDevMenu(),
    k: (d) => handleBluetoothMonitor(d, []),
    v: (d) => handleMirror(d)
  };

  if (!process.stdin.isTTY) {
    showHelp();
    return;
  }

  const readKey = () => new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (k) => resolve(String(k)));
  });
  const restoreTerminal = () => {
    try { process.stdin.setRawMode(false); } catch (_) {}
    process.stdin.pause();
  };

  process.stdin.setEncoding('utf8');
  printMenu();

  while (true) {
    const key = await readKey();
    if (key === 'q' || key === '\u0003') {
      restoreTerminal();
      console.log('');
      printSignOffMessage();
      process.exit(0);
    }
    if (key === '?' || key === 'h') {
      printMenu();
      continue;
    }
    const action = actions[key];
    if (!action) continue;

    console.clear();
    restoreTerminal(); // sub-commands may prompt with readline; give them a normal terminal
    const device = getTargetDevice();
    if (DETACH.has(key)) {
      await action(device);
      return;
    }
    try {
      await action(device);
    } catch (err) {
      console.log(`\n  ${symbols.cross} ${colors.red(err.message || String(err))}\n`);
    }
    console.log(`  ${colors.dim('Press any key to return to the menu...')}`);
    await readKey();
    printMenu();
  }
}

function renderProgressBar(percentage, width = 16) {
  const p = Math.max(0, Math.min(100, Math.round(percentage)));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${p}%`;
}

async function handleDevices(subCmd, extraArg) {
  banner();
  console.log(`  ${colors.bold('📱 SMART DEVICE MANAGER')}`);
  console.log(`  ${colors.gray('─'.repeat(55))}\n`);

  if (subCmd === 'use' || subCmd === 'select') {
    const target = extraArg;
    if (!target) {
      console.log(`  ${symbols.warn} ${colors.yellow('Usage:')} devmode use <serial|ip>\n`);
      return;
    }
    saveConfig({ defaultSerial: target, lastIp: target.includes('.') ? target.split(':')[0] : undefined });
    console.log(`  ${symbols.check} ${colors.green('Target device set to:')} ${colors.bold(colors.cyan(target))}\n`);
    return;
  }

  const adbList = getDetailedDevices();
  let bridgeList = [];
  try {
    bridgeList = await discoverAllBridgesViaUdp(1200);
  } catch (_) {}

  const all = [];
  const seenIps = new Set();

  adbList.forEach(d => {
    if (d.ip) seenIps.add(d.ip);
    all.push({
      id: d.serial,
      model: d.model || 'Android Device',
      android: d.androidVersion && d.androidVersion !== 'Unknown' ? `Android ${d.androidVersion}` : 'Unknown',
      ip: d.ip || (d.isWifi ? d.serial : 'USB Only'),
      type: d.isWifi ? 'Wireless ADB' : 'USB Cable',
      status: d.state === 'device' ? 'Authorized' : d.state,
      isAdb: true
    });
  });

  for (const b of bridgeList) {
    if (!seenIps.has(b.ip)) {
      seenIps.add(b.ip);
      let model = 'Android Device (Dev Mode)';
      let androidVer = 'Unknown';
      try {
        const check = await checkBridgeAvailable(b.ip, b.port, 1000);
        if (check.available && check.data) {
          if (check.data.model) model = check.data.model;
          if (check.data.androidVersion) androidVer = `Android ${check.data.androidVersion}`;
        }
      } catch (_) {}
      all.push({
        id: `${b.ip}:${b.port}`,
        model,
        android: androidVer,
        ip: b.ip,
        type: 'Wi-Fi Bridge',
        status: 'Online',
        isAdb: false
      });
    }
  }

  if (all.length === 0) {
    console.log(`  ${symbols.cross} ${colors.red('No connected Android devices detected.')}`);
    console.log(`  ${colors.dim('Connect your device via USB cable or ensure Dev Mode app is active on local Wi-Fi.')}\n`);
    return;
  }

  console.log(`  Found ${colors.bold(colors.cyan(String(all.length)))} connected device(s):\n`);

  all.forEach((dev, idx) => {
    const isOnline = dev.status === 'Authorized' || dev.status === 'Online';
    const statusBadge = isOnline ? colors.green(`[${dev.status.toUpperCase()}]`) : colors.yellow(`[${dev.status.toUpperCase()}]`);
    console.log(`  ${colors.cyan(`[${idx + 1}]`)} ${colors.bold(dev.model)} ${colors.dim(`(${dev.android})`)}`);
    console.log(`      ${symbols.bullet} Connection: ${colors.bold(dev.type)} ${statusBadge}`);
    console.log(`      ${symbols.bullet} Serial / IP: ${colors.cyan(dev.id)}`);
    console.log('');
  });

  console.log(`  ${colors.dim('Tip: Use "devmode use <serial|ip>" to switch your active target device.')}\n`);
}

async function handlePerf(targetDevice) {
  banner();
  console.log(`  ${colors.bold('⚡ DEVICE PERFORMANCE MONITOR')}`);
  console.log(`  ${colors.gray('─'.repeat(55))}\n`);

  let metrics = null;
  const bridge = await tryBridgeFallback();
  if (bridge) {
    try {
      const res = await callBridge(bridge.ip, 'metrics', bridge.port, 3000);
      if (res.success && res.data) {
        metrics = res.data;
      }
    } catch (_) {}
  }

  if (!metrics && targetDevice && !targetDevice.isUnauthorized) {
    try {
      metrics = getAdbPerformanceMetrics(targetDevice.serial);
    } catch (_) {}
  }

  if (!metrics) {
    console.log(`  ${symbols.cross} ${colors.red('Could not fetch performance metrics.')}`);
    console.log(`  ${colors.dim('Ensure your phone is connected via USB/ADB or Dev Mode Mobile App is active on Wi-Fi.')}\n`);
    return;
  }

  console.log(`  ${colors.bold(colors.cyan('🖥️  CPU METRICS:'))}`);
  console.log(`    ${symbols.bullet} Active CPU Cores: ${colors.bold(String(metrics.cpu.cores))}`);
  console.log('');

  console.log(`  ${colors.bold(colors.green('💾 RAM UTILIZATION:'))}`);
  const ramBar = renderProgressBar(metrics.ram.percentage);
  const usedGb = (metrics.ram.usedMb / 1024).toFixed(1);
  const totalGb = (metrics.ram.totalMb / 1024).toFixed(1);
  console.log(`    ${symbols.bullet} Usage:  ${colors.green(ramBar)}`);
  console.log(`    ${symbols.bullet} Memory: ${colors.bold(`${usedGb} GB`)} / ${colors.dim(`${totalGb} GB`)} (${metrics.ram.availableMb} MB Free)`);
  console.log('');

  console.log(`  ${colors.bold(colors.yellow('🔋 BATTERY HEALTH & STATUS:'))}`);
  const battBar = renderProgressBar(metrics.battery.level);
  console.log(`    ${symbols.bullet} Charge:       ${colors.yellow(battBar)}`);
  if (metrics.battery.temperature > 0) {
    console.log(`    ${symbols.bullet} Temperature:  ${colors.bold(`${metrics.battery.temperature}°C`)}`);
  }
  if (metrics.battery.voltage > 0) {
    console.log(`    ${symbols.bullet} Voltage:      ${metrics.battery.voltage} mV`);
  }
  console.log(`    ${symbols.bullet} Power Source: ${colors.cyan(metrics.battery.plugged)} ${metrics.battery.isCharging ? colors.green('(Charging)') : ''}`);
  console.log(`    ${symbols.bullet} Health:       ${colors.bold(metrics.battery.health)}`);
  console.log('');

  console.log(`  ${colors.bold(colors.magenta('🌡️  THERMAL STATE:'))}`);
  console.log(`    ${symbols.bullet} Thermal State: ${colors.bold(colors.green(metrics.thermal.status))}`);
  console.log('');
}

async function handleAutoConnect() {
  banner();
  console.log(`  ${colors.bold('🔄 AUTO WIRELESS ADB CONNECT')}`);
  console.log(`  ${colors.gray('─'.repeat(55))}\n`);
  console.log(`  ${symbols.info} Watching for paired Android devices on local network...`);
  console.log(`  ${colors.dim('Press Ctrl+C to stop auto-reconnect service.\n')}`);

  let isConnecting = false;
  const attemptConnect = async () => {
    if (isConnecting) return;
    isConnecting = true;
    try {
      const mdnsList = discoverMdnsServices();
      if (mdnsList.length > 0) {
        const dev = mdnsList[0];
        const res = connectAdbWifi(dev.ip, dev.port, 4000);
        if (res.success) {
          console.log(`  ${symbols.check} ${colors.green('Auto-connected via mDNS:')} ${colors.bold(colors.cyan(`${dev.ip}:${dev.port}`))}`);
          return;
        }
      }

      const bridge = await discoverBridge();
      if (bridge && bridge.ip) {
        const portRes = await callBridge(bridge.ip, 'wifi/port', bridge.port, 2000);
        const port = (portRes.success && portRes.data && portRes.data.port) ? portRes.data.port : 5555;
        const res = connectAdbWifi(bridge.ip, port, 4000);
        if (res.success) {
          console.log(`  ${symbols.check} ${colors.green('Auto-connected via Mobile App Bridge:')} ${colors.bold(colors.cyan(`${bridge.ip}:${port}`))}`);
          return;
        }
      }
    } catch (_) {} finally {
      isConnecting = false;
    }
  };

  await attemptConnect();
  setInterval(attemptConnect, 4000);
}

async function handleMirror(targetDevice) {
  banner();
  console.log(`  ${colors.bold('📺 DEVICE SCREEN MIRRORING')}`);
  console.log(`  ${colors.gray('─'.repeat(55))}\n`);

  const bridge = await discoverBridge();
  if (bridge && bridge.ip) {
    console.log(`  ${symbols.check} Discovered Dev Mode Mobile App on Wi-Fi: ${colors.cyan(bridge.ip)}`);
    const streamUrl = `http://${bridge.ip}:52882/api/screen/stream`;
    console.log(`  ${symbols.arrow} Stream endpoint: ${colors.bold(colors.green(streamUrl))}`);
    console.log(`  ${symbols.info} Requesting screen capture permission on device...`);

    try {
      await callBridge(bridge.ip, 'api/screen/start', 52882, 3000);
      console.log(`  ${symbols.check} ${colors.green('Prompt dispatched!')} Tap "Start now" on your phone.`);
    } catch (_) {}

    console.log(`\n  ${colors.bold(colors.cyan('Opening live stream in your default browser...'))}`);
    const { exec } = require('child_process');
    const openCmd = process.platform === 'win32' ? `start "" "${streamUrl}"` :
                    process.platform === 'darwin' ? `open "${streamUrl}"` : `xdg-open "${streamUrl}"`;
    exec(openCmd);
    console.log(`  ${colors.dim(`If it does not open automatically, visit: ${streamUrl}\n`)}`);
    return;
  }

  console.log(`  ${symbols.warn} ${colors.yellow('No Dev Mode bridge detected on local Wi-Fi.')}`);
  console.log(`  ${symbols.arrow} Starting Web Dashboard with Screen Mirroring viewer on ${colors.cyan('http://127.0.0.1:3288')}...\n`);
  startWebServer({ open: true });
}

async function main() {
  const mainCmd = (args[0] || '').toLowerCase();
  const subCmd = (args[1] || '').toLowerCase();
  const extraArg = args[2];

  if (mainCmd === 'web' || mainCmd === 'dashboard' || mainCmd === 'ui') {
    const portArg = parseInt(subCmd || extraArg, 10);
    startWebServer({ port: !isNaN(portArg) && portArg > 0 ? portArg : undefined });
    return;
  }

  if (!checkAdbInstalled()) {
    banner();
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('ADB is not found in your system PATH!'))}`);
    console.log(`  ${colors.yellow('Please ensure Android Platform Tools (adb) is installed.')}`);
    console.log(`  Download: ${colors.cyan('https://developer.android.com/tools/releases/platform-tools')}\n`);
    process.exit(1);
  }

  const targetDevice = getTargetDevice();

  switch (mainCmd) {
    case 'auto':
    case 'menu:auto':
      await handleAuto();
      break;

    case 'on':
      await handleDevOn(targetDevice);
      break;

    case 'off':
      await handleDevOff(targetDevice);
      break;

    case 'grant':
      await handleGrant(targetDevice);
      break;

    case 'wifi':
    case 'wireless':
      if (subCmd === 'on') {
        await handleWifiOn(targetDevice, extraArg);
      } else if (subCmd === 'off') {
        await handleWifiOff(targetDevice);
      } else if (subCmd === 'connect') {
        await handleWifiConnect(targetDevice, extraArg);
      } else if (subCmd === 'disconnect') {
        await handleWifiOff(targetDevice);
      } else if (/^\d+$/.test(subCmd)) {
        await handleWifiOn(targetDevice, subCmd);
      } else if (subCmd && subCmd.includes(':')) {
        await handleWifiConnect(targetDevice, subCmd);
      } else {
        // Default to wifi on if no subcommand specified
        await handleWifiOn(targetDevice, subCmd || extraArg);
      }
      break;

    case 'usb':
      await handleUsb(targetDevice, subCmd);
      break;

    case 'devices':
    case 'list':
      await handleDevices(subCmd, extraArg);
      break;

    case 'use':
    case 'select':
      await handleDevices('use', subCmd || extraArg);
      break;

    case 'perf':
    case 'stats':
    case 'monitor':
      await handlePerf(targetDevice);
      break;

    case 'bt':
    case 'bluetooth':
    case 'media':
    case 'music':
      if (!targetDevice || targetDevice.isUnauthorized) {
        banner();
        await handleNoDeviceGuide(targetDevice);
      } else if (subCmd === 'album' || subCmd === 'cover' || subCmd === 'art') {
        const { getBluetoothAndMediaSnapshotAsync, openInDefaultViewer } = require('../lib/bluetooth');
        banner();
        console.log(`  ${symbols.arrow} Fetching album cover artwork for currently playing track...`);
        const snap = await getBluetoothAndMediaSnapshotAsync(targetDevice.serial);
        const art = snap && snap.media && snap.media.activeSession && snap.media.activeSession.artworkUrl;
        if (art) {
          console.log(`  ${symbols.check} ${colors.green('Opening album artwork:')} ${colors.cyan(art)}\n`);
          openInDefaultViewer(art);
        } else {
          console.log(`  ${symbols.warn} ${colors.yellow('No album artwork found for currently playing track.')}\n`);
        }
      } else if (subCmd === 'play') {
        const query = args.slice(2).join(' ') || extraArg;
        if (!query) {
          banner();
          console.log(`  ${symbols.warn} Usage: devmode music play <song or artist>\n`);
        } else {
          const { dispatchMediaPlayFromSearch } = require('../lib/bluetooth');
          banner();
          console.log(`  ${symbols.arrow} Requesting playback on phone: ${colors.bold(colors.cyan(query))}...`);
          const ok = await dispatchMediaPlayFromSearch(query, targetDevice.serial);
          if (ok) {
            console.log(`  ${symbols.check} ${colors.bold(colors.green('Playback command dispatched to Spotify/Media player!'))}\n`);
          } else {
            console.log(`  ${symbols.cross} ${colors.red('Failed to dispatch playback command.')}\n`);
          }
        }
      } else if (subCmd === 'next') {
        execAdb(['shell', 'input', 'keyevent', '87'], targetDevice.serial);
        console.log(`\n  ${symbols.check} ${colors.green('Skipped to Next Track on phone.')}\n`);
      } else if (subCmd === 'prev' || subCmd === 'previous') {
        execAdb(['shell', 'input', 'keyevent', '88'], targetDevice.serial);
        console.log(`\n  ${symbols.check} ${colors.green('Returned to Previous Track on phone.')}\n`);
      } else if (subCmd === 'pause' || subCmd === 'toggle') {
        execAdb(['shell', 'input', 'keyevent', '85'], targetDevice.serial);
        console.log(`\n  ${symbols.check} ${colors.green('Toggled Play / Pause on phone.')}\n`);
      } else {
        await handleBluetoothMonitor(targetDevice, args.slice(1));
      }
      break;

    case 'watch':
    case 'connect:auto':
    case 'auto-connect':
      await handleAutoConnect();
      break;

    case 'mirror':
    case 'cast':
    case 'screen':
      await handleMirror(targetDevice);
      break;

    case 'status':
    case 'info':
      await handleStatus(targetDevice);
      break;

    case 'speed':
    case 'scale':
      await handleSpeed(targetDevice, subCmd);
      break;

    case 'icon':
      printDevModeIcon();
      break;

    case 'bridge':
      banner();
      const ipParam = (/^\d+\.\d+\.\d+\.\d+$/.test(subCmd) ? subCmd :
                       subCmd === '--ip' || subCmd === '-i' ? extraArg :
                       args.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))) || null;
      if (ipParam) {
        console.log(`  ${symbols.info} Connecting to Dev Mode Mobile App at ${colors.cyan(ipParam)}...`);
      } else {
        console.log(`  ${symbols.info} Searching for Dev Mode Mobile App on local Wi-Fi...`);
      }
      const bridgeInfo = await discoverBridge(ipParam);
      if (bridgeInfo && bridgeInfo.status) {
        console.log(`  ${symbols.check} ${colors.bold(colors.green('Connected to Dev Mode Mobile App!'))}\n`);
        printKeyValue('Phone IP Address', bridgeInfo.ip);
        printKeyValue('Bridge Port', String(bridgeInfo.port));
        printStatusItem('Developer Options', bridgeInfo.status.developerOptions, bridgeInfo.status.developerOptions === 'enabled');
        printStatusItem('USB Debugging', bridgeInfo.status.usbDebugging, bridgeInfo.status.usbDebugging === 'enabled');
        printStatusItem('Wireless Debugging', bridgeInfo.status.wirelessDebugging, bridgeInfo.status.wirelessDebugging === 'enabled');
        console.log(`\n  ${colors.dim('Bridge is active! You can toggle settings from PC even if USB Debugging is OFF.')}\n`);
      } else {
        console.log(`  ${symbols.cross} ${colors.red('No Dev Mode Mobile App found on local Wi-Fi.')}`);
        console.log(`  ${colors.dim('Make sure your phone is connected to the same Wi-Fi and Dev Mode app or widget is active.')}\n`);
      }
      break;

    case 'run':
    case 'start':
      if (args.includes('--native') || args.includes('-n') || subCmd === 'native') {
        const { runNativeStudio } = require('../lib/studio');
        await runNativeStudio();
      } else {
        await runExpoStart(args.slice(1));
      }
      break;

    case 'start:native':
    case 'run:native':
    case 'studio':
    case 'native':
      {
        const { runNativeStudio } = require('../lib/studio');
        await runNativeStudio();
      }
      break;

    case 'debug:android':
    case 'run:android':
    case 'debug':
      if (subCmd === 'android') {
        await runExpoAndroid(args.slice(2));
      } else {
        await runExpoAndroid(args.slice(1));
      }
      break;

    case 'reload':
    case 'refresh':
    case 'r':
      await reloadApp();
      break;

    case 'menu':
    case 'm':
      openDevMenu();
      break;

    case 'build:aab':
    case 'bundle':
    case 'build:bundle':
      {
        const isDebug = args.includes('--debug');
        const isRelease = !isDebug;
        const extraBuildArgs = args.slice(1).filter(a => a !== 'aab' && a !== 'bundle' && a !== '--debug' && a !== '--release');
        await buildAndroid(isRelease, extraBuildArgs, true);
      }
      break;

    case 'build:android':
    case 'build':
      {
        const isAab = args.includes('--aab') || args.includes('-b') || subCmd === 'aab' || subCmd === 'bundle';
        const isDebug = args.includes('--debug');
        const isRelease = isAab ? !isDebug : args.includes('--release');
        const extraBuildArgs = args.slice(1).filter(a => a !== 'android' && a !== 'aab' && a !== 'bundle' && a !== '--release' && a !== '--debug' && a !== '--aab');
        await buildAndroid(isRelease, extraBuildArgs, isAab);
      }
      break;

    case 'install:apk':
    case 'install':
      {
        const isRelease = args.includes('--release') || args.includes('-r');
        const isDebug = args.includes('--debug') || args.includes('-d');
        const rawTarget = subCmd === 'apk' ? extraArg : (subCmd || extraArg);
        const targetApk = (rawTarget && !rawTarget.startsWith('-')) ? rawTarget : null;
        await installApk(targetApk, { release: isRelease, debug: isDebug });
      }
      break;

    case 'clean':
      await cleanProject();
      break;

    case 'logs':
    case 'logcat':
      streamLogs();
      break;

    case 'reverse':
      reversePort(subCmd ? parseInt(subCmd, 10) : 8081);
      break;

    case 'api':
    case 'api:bridge':
    case 'api:start':
    case 'api:test':
    case 'test:api':
      {
        const { handleApiBridge, handleApiStart, handleApiTest, showApiBridgeHelp } = require('../lib/api-bridge-cli');
        if (mainCmd === 'api:bridge') {
          await handleApiBridge(args.slice(1));
        } else if (mainCmd === 'api:start') {
          await handleApiStart(args.slice(1));
        } else if (mainCmd === 'api:test' || mainCmd === 'test:api' || subCmd === 'test' || subCmd === 'check') {
          const testArgs = subCmd === 'test' || subCmd === 'check' ? args.slice(2) : args.slice(1);
          await handleApiTest(testArgs);
        } else if (subCmd === 'start' || subCmd === 'run' || subCmd === 'serve') {
          await handleApiStart(args.slice(2));
        } else if (!subCmd || subCmd === 'bridge' || subCmd.startsWith('-')) {
          const rest = subCmd === 'bridge' ? args.slice(2) : args.slice(1);
          await handleApiBridge(rest);
        } else {
          showApiBridgeHelp();
        }
      }
      break;

    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    default:
      if (!mainCmd) {
        // No command provided, show status or help
        if (targetDevice) {
          await handleStatus(targetDevice);
        } else {
          showHelp();
        }
      } else {
        console.log(`\n  ${symbols.cross} Unknown command: ${colors.red(mainCmd)}`);
        showHelp();
      }
      break;
  }
}

main().catch(err => {
  console.error('\n  Unexpected error:', err.message || err);
  process.exit(1);
});
