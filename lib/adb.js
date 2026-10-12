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

      // ip:port (manual adb connect) or mDNS instance name (adb auto-connect): adb-<id>._adb-tls-connect._tcp
      const isWifi = serial.includes(':') || serial.includes('._adb') || serial.startsWith('adb-');
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

function getDeviceWifiPort(serial = null, retryCount = 6) {
  for (let attempt = 0; attempt < retryCount; attempt++) {
    // 1. Android 11+ TLS property
    const res = execAdb(['shell', 'getprop', 'service.adb.tls.port'], serial);
    if (res.status === 0 && res.stdout) {
      const port = parseInt(res.stdout, 10);
      if (!isNaN(port) && port > 0) {
        return port;
      }
    }

    // 2. Official ADB mDNS service discovery
    const mdnsList = discoverMdnsServices();
    if (mdnsList.length > 0) {
      const tlsService = mdnsList.find(s => s.type.includes('tls')) || mdnsList[0];
      if (tlsService && tlsService.port > 0) {
        return tlsService.port;
      }
    }

    // 3. Linux kernel network sockets (/proc/net/tcp6 and /proc/net/tcp for UID 2000 adbd)
    for (const tcpFile of ['/proc/net/tcp6', '/proc/net/tcp']) {
      const netRes = execAdb(['shell', 'cat', tcpFile], serial);
      if (netRes.status === 0 && netRes.stdout) {
        for (const line of netRes.stdout.split('\n')) {
          const parts = line.trim().split(/\s+/);
          // UID 2000 is adbd, 0A is TCP_LISTEN
          if (parts.length >= 8 && parts[7] === '2000' && parts[3] === '0A') {
            const hexPort = parts[1].split(':')[1];
            const port = parseInt(hexPort, 16);
            if (port > 0 && port !== 5555) {
              return port;
            }
          }
        }
      }
    }

    // 4. Global & Secure settings adb_wifi_port
    for (const key of ['adb_wifi_port', 'adb_port']) {
      const pRes = execAdb(['shell', 'settings', 'get', 'global', key], serial);
      if (pRes.status === 0 && pRes.stdout) {
        const p = parseInt(pRes.stdout, 10);
        if (!isNaN(p) && p > 0) return p;
      }
    }

    if (attempt < retryCount - 1) {
      const start = Date.now();
      while (Date.now() - start < 500) {}
    }
  }

  // 5. Classic legacy port (5555) ONLY as fallback if active
  const tcpRes = execAdb(['shell', 'getprop', 'service.adb.tcp.port'], serial);
  if (tcpRes.status === 0 && tcpRes.stdout) {
    const tcpPort = parseInt(tcpRes.stdout, 10);
    if (!isNaN(tcpPort) && tcpPort > 0) {
      return tcpPort;
    }
  }

  return null;
}

function sendSyncBroadcast(serial = null) {
  try {
    // Notify Dev Mode app widgets and notification to refresh in real-time (both prod and dev).
    // -f 0x10000020 = FLAG_RECEIVER_FOREGROUND | FLAG_INCLUDE_STOPPED_PACKAGES: without it the
    // broadcast sits in the background queue (seconds to minutes when the screen is off) and is
    // dropped entirely if the OEM battery manager force-stopped the app.
    for (const pkg of ['com.devmode.app', 'com.devmode.app.dev']) {
      execAdb(['shell', 'am', 'broadcast', '-a', 'expo.modules.devtoggle.ACTION_SYNC', '-p', pkg, '-f', '0x10000020'], serial);
    }
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

function connectAdbWifi(ip, port, timeoutMs = 15000) {
  const target = `${ip}:${port}`;
  const res = execAdb(['connect', target], null, timeoutMs);
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
  const prod = execAdb(['shell', 'pm', 'grant', 'com.devmode.app', 'android.permission.WRITE_SECURE_SETTINGS'], serial);
  const dev = execAdb(['shell', 'pm', 'grant', 'com.devmode.app.dev', 'android.permission.WRITE_SECURE_SETTINGS'], serial);
  return prod.status === 0 || dev.status === 0;
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

