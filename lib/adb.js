// lib/adb.js - Android Debug Bridge communication layer

const { execSync, spawnSync } = require('child_process');
const { colors, symbols } = require('./ui');
const { saveConfig, getLastDevice } = require('./config');

function checkAdbInstalled() {
  try {
    const res = spawnSync('adb', ['version'], { encoding: 'utf8' });
    if (res.status === 0) return true;
  } catch (_) {}
  return false;
}

function execAdb(args, serial = null, timeoutMs = 8000) {
  const fullArgs = [];
  if (serial) {
    fullArgs.push('-s', serial);
  }
  fullArgs.push(...args);

  try {
    const res = spawnSync('adb', fullArgs, {
      encoding: 'utf8',
      timeout: timeoutMs
    });
    if (res.error) {
      throw res.error;
    }
    return {
      status: res.status,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim()
    };
  } catch (err) {
    return {
      status: 1,
      stdout: '',
      stderr: err.message || String(err)
    };
  }
}

function getConnectedDevices() {
  const res = execAdb(['devices', '-l']);
  if (res.status !== 0) return [];

  const lines = res.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const devices = [];

  // Line 0 is usually "List of devices attached"
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const serial = parts[0];
      const state = parts[1]; // device, unauthorized, offline

      let model = 'Unknown';
      let product = 'Unknown';
      for (const p of parts) {
        if (p.startsWith('model:')) model = p.replace('model:', '');
        if (p.startsWith('product:')) product = p.replace('product:', '');
      }

      const isWifi = serial.includes(':');
      devices.push({
        serial,
        state,
        model,
        product,
        isWifi,
        isUsb: !isWifi
      });
    }
  }

  return devices;
}

function getTargetDevice(specifiedSerial = null) {
  const allDevices = getConnectedDevices();
  const authorized = allDevices.filter(d => d.state === 'device');

  if (authorized.length > 0) {
    if (specifiedSerial) {
      return authorized.find(d => d.serial === specifiedSerial) || null;
    }
    const usb = authorized.find(d => d.isUsb);
    return usb || authorized[0];
  }

  // Check if device is attached but unauthorized (needs tap on phone screen)
  const unauthorized = allDevices.find(d => d.state === 'unauthorized');
  if (unauthorized) {
    return { isUnauthorized: true, ...unauthorized };
  }

  return null;
}

function getDeviceIp(serial = null) {
  // Method 1: ip -f inet addr show wlan0
  let res = execAdb(['shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], serial);
  if (res.status === 0 && res.stdout) {
    const match = res.stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }

  // Method 2: ip route show
  res = execAdb(['shell', 'ip', 'route'], serial);
  if (res.status === 0 && res.stdout) {
    const match = res.stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }

  // Method 3: ifconfig wlan0
  res = execAdb(['shell', 'ifconfig', 'wlan0'], serial);
  if (res.status === 0 && res.stdout) {
    const match = res.stdout.match(/inet addr:(\d+\.\d+\.\d+\.\d+)/) || res.stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }

  // Method 4: getprop dhcp.wlan0.ipaddress
  res = execAdb(['shell', 'getprop', 'dhcp.wlan0.ipaddress'], serial);
  if (res.status === 0 && res.stdout && /^\d+\.\d+\.\d+\.\d+$/.test(res.stdout)) {
    return res.stdout;
  }

  return null;
}

function getDeviceWifiPort(serial = null, retryCount = 5) {
  // On Android 11+, Wireless Debugging assigns a dynamic TLS port in service.adb.tls.port
  for (let attempt = 0; attempt < retryCount; attempt++) {
    const res = execAdb(['shell', 'getprop', 'service.adb.tls.port'], serial);
    if (res.status === 0 && res.stdout) {
      const port = parseInt(res.stdout, 10);
      if (!isNaN(port) && port > 0) {
        return port;
      }
    }

    // Classic adb tcpip port
    const tcpRes = execAdb(['shell', 'getprop', 'service.adb.tcp.port'], serial);
    if (tcpRes.status === 0 && tcpRes.stdout) {
      const tcpPort = parseInt(tcpRes.stdout, 10);
      if (!isNaN(tcpPort) && tcpPort > 0) {
        return tcpPort;
      }
    }

    if (attempt < retryCount - 1) {
      // Sleep 500ms
      const start = Date.now();
      while (Date.now() - start < 500) {}
    }
  }
  return null;
}

function sendSyncBroadcast(serial = null) {
  try {
    // Notify Dev Mode app widgets and notification to refresh
    execAdb(['shell', 'am', 'broadcast', '-a', 'android.appwidget.action.APPWIDGET_UPDATE', '-p', 'com.devmode.app'], serial);
  } catch (_) {}
}

function enableDeveloperOptions(serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'development_settings_enabled', '1'], serial);
  sendSyncBroadcast(serial);
}

function disableDeveloperOptions(serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'development_settings_enabled', '0'], serial);
  sendSyncBroadcast(serial);
}

function enableUsbDebugging(serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'adb_enabled', '1'], serial);
  sendSyncBroadcast(serial);
}

function disableUsbDebugging(serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'adb_enabled', '0'], serial);
  sendSyncBroadcast(serial);
}

function enableWirelessDebugging(serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'development_settings_enabled', '1'], serial);
  execAdb(['shell', 'settings', 'put', 'global', 'adb_wifi_enabled', '1'], serial);
  sendSyncBroadcast(serial);
}

function disableWirelessDebugging(serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'adb_wifi_enabled', '0'], serial);
  sendSyncBroadcast(serial);
}

function connectAdbWifi(ip, port) {
  const target = `${ip}:${port}`;
  const res = execAdb(['connect', target], null, 10000);
  return {
    success: res.stdout.includes('connected to') || res.stdout.includes('already connected'),
    output: res.stdout || res.stderr
  };
}

function disconnectAdbWifi(ipPort = null) {
  if (ipPort) {
    return execAdb(['disconnect', ipPort]);
  }
  return execAdb(['disconnect']);
}

function discoverMdnsServices() {
  // Runs `adb mdns services` to discover active wireless ADB instances on local LAN
  const res = execAdb(['mdns', 'services']);
  if (res.status !== 0 || !res.stdout) return [];

  const found = [];
  const lines = res.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Format is usually: <instance_name> _adb-tls-connect._tcp <ip>:<port>
    const match = line.match(/(.+?)\s+(_adb-tls-connect\._tcp|_adb\._tcp)\s+([0-9.]+):([0-9]+)/);
    if (match) {
      found.push({
        name: match[1],
        type: match[2],
        ip: match[3],
        port: parseInt(match[4], 10)
      });
    }
  }
  return found;
}

function getDeviceStatus(serial = null) {
  const dev = execAdb(['shell', 'settings', 'get', 'global', 'development_settings_enabled'], serial).stdout === '1';
  const usb = execAdb(['shell', 'settings', 'get', 'global', 'adb_enabled'], serial).stdout === '1';
  const wifi = execAdb(['shell', 'settings', 'get', 'global', 'adb_wifi_enabled'], serial).stdout === '1';
  const scale = execAdb(['shell', 'settings', 'get', 'global', 'window_animation_scale'], serial).stdout || '1.0';
  const model = execAdb(['shell', 'getprop', 'ro.product.model'], serial).stdout || 'Android Device';
  const androidVersion = execAdb(['shell', 'getprop', 'ro.build.version.release'], serial).stdout || 'Unknown';
  const ip = getDeviceIp(serial);
  const port = getDeviceWifiPort(serial, 1);

  return {
    model,
    androidVersion,
    dev,
    usb,
    wifi,
    scale,
    ip,
    port
  };
}

function setAnimationScales(scaleValue, serial = null) {
  execAdb(['shell', 'settings', 'put', 'global', 'window_animation_scale', String(scaleValue)], serial);
  execAdb(['shell', 'settings', 'put', 'global', 'transition_animation_scale', String(scaleValue)], serial);
  execAdb(['shell', 'settings', 'put', 'global', 'animator_duration_scale', String(scaleValue)], serial);
}

function grantAppPermission(serial = null) {
  const res = execAdb(['shell', 'pm', 'grant', 'com.devmode.app', 'android.permission.WRITE_SECURE_SETTINGS'], serial);
  return res.status === 0;
}

module.exports = {
  checkAdbInstalled,
  execAdb,
  getConnectedDevices,
  getTargetDevice,
  getDeviceIp,
  getDeviceWifiPort,
  sendSyncBroadcast,
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
  grantAppPermission
};

