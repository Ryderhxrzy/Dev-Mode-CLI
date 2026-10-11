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

const args = process.argv.slice(2);

function showHelp() {
  banner();
  console.log(`  ${colors.bold('USAGE:')}
    ${colors.cyan('npx dev-mode')} ${colors.yellow('<command>')} [options]

  ${colors.bold('CORE COMMANDS:')}
    ${colors.yellow('on')}                  Turn ON Developer Options (displays green ASCII icon)
    ${colors.yellow('off')}                 Turn OFF Developer Options only
    ${colors.yellow('icon')}                Display official Dev Mode green ASCII icon
    ${colors.yellow('status')}              Show current device status and IP/Port info

  ${colors.bold('MOBILE APP PERMISSION:')}
    ${colors.yellow('grant')}               Grant WRITE_SECURE_SETTINGS to Dev Mode mobile app

  ${colors.bold('WIRELESS ADB (Auto-Connect):')}
    ${colors.yellow('wifi on')}             Enable Wireless ADB and ${colors.bold(colors.green('auto-connect'))} over Wi-Fi
    ${colors.yellow('wifi off')}            Disconnect and disable Wireless ADB
    ${colors.yellow('wifi connect [ip:port]')} Connect to device over Wi-Fi (auto-detects if omitted)
    ${colors.yellow('wifi disconnect')}     Disconnect current wireless sessions

  ${colors.bold('USB & SYSTEM CONTROLS:')}
    ${colors.yellow('usb on')}              Turn ON USB Debugging
    ${colors.yellow('usb off')}             Turn OFF USB Debugging
    ${colors.yellow('speed <0.5|1.0|0.0>')}  Set UI animation speed scale (Speed Booster)

  ${colors.bold('EXAMPLES:')}
    ${colors.gray('$')} dev-mode on
    ${colors.gray('$')} dev-mode wifi on         ${colors.dim('# Auto-resolves IP & Port, then connects!')}
    ${colors.gray('$')} dev-mode grant           ${colors.dim('# Grants permissions to Dev Mode mobile app')}
    ${colors.gray('$')} dev-mode speed 0.5       ${colors.dim('# Speeds up device animations by 2x')}
    ${colors.gray('$')} dev-mode status
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
    console.log(`     ${colors.bold(colors.yellow('npx dev-mode grant'))} ${colors.dim('# Automatically grants WRITE_SECURE_SETTINGS')}`);
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
    console.log(`\n  ${colors.bold(colors.yellow('🎉 Once connected, run "dev-mode on" or "dev-mode wifi on" anytime!'))}\n`);
  }
}

async function handleWifiOn(targetDevice) {
  banner();

  let activeDevice = targetDevice;

  // 1. If no device connected via USB or ADB yet, try discovering via mDNS or cached device
  if (!activeDevice) {
    console.log(`  ${symbols.info} No active USB or ADB device detected. Checking local Wi-Fi for devices...`);
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

    // Try last known cached device
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
    console.log(`  ${colors.yellow('Tip:')} Plug in your phone via USB once, or enable Wireless Debugging in Dev Mode app.\n`);
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

  console.log(`  ${symbols.arrow} Resolving dynamic Wireless ADB port...`);
  let port = getDeviceWifiPort(activeDevice.serial, 6);

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
    console.log(`  ${colors.dim('You can check the active port on your phone screen or Dev Mode widget.')}\n`);
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
    console.log(`  3. On Android 11+, make sure you allow the "Always allow on this network" pairing prompt if shown.\n`);
  }
}

async function handleWifiOff(targetDevice) {
  banner();
  console.log(`  ${symbols.arrow} Disconnecting all Wireless ADB sessions...`);
  disconnectAdbWifi();

  if (targetDevice) {
    console.log(`  ${symbols.arrow} Disabling Wireless Debugging on device...`);
    disableWirelessDebugging(targetDevice.serial);
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
    console.log(`  ${colors.dim('Usage: npx dev-mode wifi connect 192.168.1.15:39821')}\n`);
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

async function handleStatus(targetDevice) {
  banner();
  if (!targetDevice || targetDevice.isUnauthorized) {
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
  banner();
  printDevModeIcon();
  if (!targetDevice || targetDevice.isUnauthorized) {
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
    console.log(`  ${symbols.warn} Usage: npx dev-mode usb <on|off>\n`);
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
        await handleWifiOn(targetDevice);
      } else if (subCmd === 'off') {
        await handleWifiOff(targetDevice);
      } else if (subCmd === 'connect') {
        await handleWifiConnect(targetDevice, extraArg);
      } else if (subCmd === 'disconnect') {
        await handleWifiOff(targetDevice);
      } else {
        // Default to wifi on if no subcommand specified
        await handleWifiOn(targetDevice);
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
      banner();
      printDevModeIcon();
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
