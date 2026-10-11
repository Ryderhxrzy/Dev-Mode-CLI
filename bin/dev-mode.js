#!/usr/bin/env node

// bin/dev-mode.js - Dev Mode CLI entry point
const { colors, symbols, banner, printDevModeIcon, printStatusItem, printKeyValue, printQuickActions } = require('../lib/ui');
const {
  checkAdbInstalled,
  getConnectedDevices,
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
  execAdb
} = require('../lib/adb');
const { saveConfig, getLastDevice } = require('../lib/config');
const { discoverBridge, callBridge } = require('../lib/bridge');
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

const args = process.argv.slice(2);

function showHelp() {
  banner();
  console.log(`  ${colors.bold('USAGE:')}
    ${colors.cyan('devmode')} ${colors.yellow('<command>')} [options]
    ${colors.dim('or via npx:')} ${colors.cyan('npx devmode')} ${colors.yellow('<command>')} [options]

  ${colors.bold('CORE COMMANDS:')}
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
    ${colors.yellow('install:apk [file]')}     Auto-discover and install latest debug APK to device
    ${colors.yellow('clean')}                  Clean Gradle and Metro project caches
    ${colors.yellow('logs')}                   Stream filtered React Native & Expo device logcat
    ${colors.yellow('reverse [port]')}         Set up ADB reverse port for Metro (default: 8081)

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
    console.log(`     ${colors.bold(colors.yellow('npx devmode grant'))} ${colors.dim('# Automatically grants WRITE_SECURE_SETTINGS')}`);
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

      const res = await callBridge(bridge.ip, 'wifi/on', bridge.port, 6000);
      if (res.success && res.data) {
        console.log(`  ${symbols.check} Wireless Debugging: ${colors.bold(colors.green('ENABLED'))}`);
        const resolvedIp = res.data.ip || bridge.ip;
        let resolvedPort = specifiedPort ? parseInt(specifiedPort, 10) : res.data.port;

        // If dynamic port was still initializing, give it a moment to resolve
        if (!resolvedPort) {
          console.log(`  ${symbols.arrow} Resolving dynamic Wireless ADB port...`);
          for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise(r => setTimeout(r, 600));
            const mdns = discoverMdnsServices();
            if (mdns.length > 0 && mdns[0].port) {
              resolvedPort = mdns[0].port;
              break;
            }
          }
        }

        if (resolvedPort) {
          console.log(`  ${symbols.check} Dynamic Port: ${colors.bold(colors.cyan(String(resolvedPort)))}`);
          console.log(`  ${symbols.arrow} Connecting without cable: ${colors.bold(`adb connect ${resolvedIp}:${resolvedPort}`)}...`);
          const connectResult = connectAdbWifi(resolvedIp, resolvedPort);
          if (connectResult.success) {
            saveConfig({ lastIp: resolvedIp, lastPort: resolvedPort });
            console.log(`\n  ${colors.bold(colors.green('╔════════════════════════════════════════════════════════╗'))}`);
            console.log(`  ${colors.bold(colors.green('║  ✔ WIRELESS ADB CONNECTED (WITHOUT CABLE)!             ║'))}`);
            console.log(`  ${colors.bold(colors.green('╚════════════════════════════════════════════════════════╝'))}`);
            console.log(`  ${symbols.bullet} Endpoint:  ${colors.bold(colors.cyan(`${resolvedIp}:${resolvedPort}`))}`);
            console.log(`  ${symbols.bullet} Status:    ${colors.bold(colors.green('ACTIVE & CONNECTED'))}`);
            console.log(`\n  ${colors.bold(colors.yellow('🎉 Connected completely wireless over local Wi-Fi!'))}\n`);
            return;
          } else {
            console.log(`\n  ${symbols.warn} ${colors.yellow('Connection attempt returned:')} ${colors.dim(connectResult.output)}`);
            console.log(`  ${colors.yellow('Tip:')} If this is your first time, ensure your PC is paired in phone's Wireless Debugging.\n`);
            return;
          }
        } else {
          console.log(`  ${symbols.warn} ${colors.yellow('Wireless Debugging enabled, but dynamic port could not be determined automatically.')}`);
          console.log(`  ${colors.dim('Check Settings > Wireless Debugging on your phone for the 5-digit port.')}`);
          console.log(`  ${colors.dim('Connect with: devmode wifi on <port>')}\n`);
          return;
        }
      }
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
  } else if (subCommand === 'off') {
    disableUsbDebugging(targetDevice.serial);
    console.log(`  ${symbols.check} ${colors.bold(colors.red('USB Debugging: DISABLED'))}\n`);
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

async function main() {
  if (!checkAdbInstalled()) {
    banner();
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('ADB is not found in your system PATH!'))}`);
    console.log(`  ${colors.yellow('Please ensure Android Platform Tools (adb) is installed.')}`);
    console.log(`  Download: ${colors.cyan('https://developer.android.com/tools/releases/platform-tools')}\n`);
    process.exit(1);
  }

  const mainCmd = (args[0] || '').toLowerCase();
  const subCmd = (args[1] || '').toLowerCase();
  const extraArg = args[2];

  const targetDevice = getTargetDevice();

  switch (mainCmd) {
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
      console.log(`  ${symbols.info} Searching for Dev Mode Mobile App on local Wi-Fi...`);
      const bridgeInfo = await discoverBridge();
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
        const targetApk = subCmd === 'apk' ? extraArg : (subCmd || extraArg);
        installApk(targetApk);
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
