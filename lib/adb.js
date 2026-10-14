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

// Non-blocking variant of execAdb (same result shape). Used by long-running monitors such as
// the Smart API Bridge so the terminal stays responsive while adb is busy.
function execAdbAsync(args, serial = null, timeoutMs = 8000) {
  const { spawn } = require('child_process');
  const fullArgs = [];
  if (serial) {
    fullArgs.push('-s', serial);
  }
  fullArgs.push(...args);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn('adb', fullArgs, { windowsHide: true });
    } catch (err) {
      resolve({ status: 1, stdout: '', stderr: err.message || String(err) });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ status: 1, stdout: stdout.trim(), stderr: `adb ${fullArgs.join(' ')} timed out` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ status: 1, stdout: '', stderr: err.message || String(err) }));
    child.on('close', (code) => finish({ status: code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function getConnectedDevices() {
  const res = execAdb(['devices', '-l']);
  if (res.status !== 0) return [];
  return parseDeviceList(res.stdout);
}

// Parses `adb devices -l` output into device objects
function parseDeviceList(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
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
      let transportId = null;
      for (const p of parts) {
        if (p.startsWith('model:')) model = p.replace('model:', '');
        if (p.startsWith('product:')) product = p.replace('product:', '');
        if (p.startsWith('transport_id:')) transportId = p.replace('transport_id:', '');
      }

      // ip:port (manual adb connect) or mDNS instance name (adb auto-connect): adb-<id>._adb-tls-connect._tcp
      const isWifi = serial.includes(':') || serial.includes('._adb') || serial.startsWith('adb-');
      devices.push({
        serial,
        state,
        model,
        product,
        transportId,
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

function getDetailedDevices() {
  const basic = getConnectedDevices();
  return basic.map(dev => {
    if (dev.state !== 'device') {
      return {
        ...dev,
        androidVersion: 'Unknown',
        sdkInt: null,
        ip: dev.isWifi ? (dev.serial.split(':')[0] || null) : null,
      };
    }

    const modelRes = execAdb(['shell', 'getprop', 'ro.product.model'], dev.serial);
    const mfrRes = execAdb(['shell', 'getprop', 'ro.product.manufacturer'], dev.serial);
    const verRes = execAdb(['shell', 'getprop', 'ro.build.version.release'], dev.serial);
    const sdkRes = execAdb(['shell', 'getprop', 'ro.build.version.sdk'], dev.serial);
    const ip = getDeviceIp(dev.serial) || (dev.isWifi ? dev.serial.split(':')[0] : null);

    const modelName = (mfrRes.stdout ? mfrRes.stdout + ' ' : '') + (modelRes.stdout || dev.model);

    return {
      ...dev,
      model: modelName.trim() || dev.model,
      androidVersion: verRes.stdout || 'Unknown',
      sdkInt: parseInt(sdkRes.stdout || '0', 10) || null,
      ip: ip || null
    };
  });
}

function getAdbPerformanceMetrics(serial = null) {
  // 1. Battery
  const battRes = execAdb(['shell', 'dumpsys', 'battery'], serial);
  let battery = { level: 0, temperature: 0, voltage: 0, isCharging: false, plugged: 'Battery', health: 'Normal' };
  if (battRes.status === 0 && battRes.stdout) {
    const lines = battRes.stdout.split(/\r?\n/);
    lines.forEach(l => {
      const match = l.trim().match(/^([a-zA-Z\s]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        if (key === 'level') battery.level = parseInt(val, 10) || 0;
        if (key === 'temperature') battery.temperature = (parseInt(val, 10) || 0) / 10.0;
        if (key === 'voltage') battery.voltage = parseInt(val, 10) || 0;
        if (key === 'status') battery.isCharging = (val === '2' || val.toLowerCase().includes('charging'));
        if (key === 'AC powered' && val === 'true') battery.plugged = 'AC';
        if (key === 'USB powered' && val === 'true') battery.plugged = 'USB';
        if (key === 'Wireless powered' && val === 'true') battery.plugged = 'Wireless';
      }
    });
  }

  // 2. RAM
  const memRes = execAdb(['shell', 'cat', '/proc/meminfo'], serial);
  let ram = { totalMb: 0, usedMb: 0, availableMb: 0, percentage: 0 };
  if (memRes.status === 0 && memRes.stdout) {
    let totalKb = 0;
    let availKb = 0;
    memRes.stdout.split(/\r?\n/).forEach(l => {
      if (l.startsWith('MemTotal:')) {
        const m = l.match(/(\d+)/);
        if (m) totalKb = parseInt(m[1], 10);
      }
      if (l.startsWith('MemAvailable:') || (!availKb && l.startsWith('MemFree:'))) {
        const m = l.match(/(\d+)/);
        if (m) availKb = parseInt(m[1], 10);
      }
    });
    if (totalKb > 0) {
      ram.totalMb = Math.round(totalKb / 1024);
      ram.availableMb = Math.round(availKb / 1024);
      ram.usedMb = ram.totalMb - ram.availableMb;
      ram.percentage = Math.round((ram.usedMb / ram.totalMb) * 100);
    }
  }

  // 3. CPU
  const cpuRes = execAdb(['shell', 'cat', '/proc/cpuinfo'], serial);
  let cores = 0;
  if (cpuRes.status === 0 && cpuRes.stdout) {
    const matches = cpuRes.stdout.match(/^processor\s*:/gm);
    cores = matches ? matches.length : 1;
  }
  const cpu = { cores: cores || 8 };

  // 4. Thermal
  const thermal = { status: 'Normal' };

  return { cpu, ram, battery, thermal };
}

function getInstalledApps(serial = null) {
  const res = execAdb(['shell', 'pm', 'list', 'packages', '-3'], serial);
  if (res.status !== 0 || !res.stdout) return [];

  const rawPackages = res.stdout
    .split(/\r?\n/)
    .map(line => line.replace(/^package:/, '').trim())
    .filter(Boolean);

  const apps = rawPackages.map(pkg => {
    const parts = pkg.split('.');
    let name = parts[parts.length - 1];
    if (name.toLowerCase() === 'dev' || name.toLowerCase() === 'android' || name.toLowerCase() === 'app') {
      name = parts[parts.length - 2] || name;
    }
    const cleanName = name
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase());

    return {
      name: cleanName,
      package: pkg
    };
  });

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function launchAppOnDisplay(packageName, displayId = 0, serial = null) {
  const resolveRes = execAdb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', packageName], serial);
  let component = null;
  if (resolveRes.status === 0 && resolveRes.stdout) {
    const lines = resolveRes.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes('/') && !line.includes(' ')) {
        component = line;
        break;
      }
    }
  }

  if (component && displayId > 0) {
    const amRes = execAdb(['shell', 'am', 'start', '--display', String(displayId), '-n', component], serial);
    if (amRes.status === 0) return { success: true, method: 'am_display', component, displayId };
  }

  if (displayId > 0) {
    const monkeyRes = execAdb(['shell', 'monkey', '--display', String(displayId), '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
    if (monkeyRes.status === 0) return { success: true, method: 'monkey_display', displayId };
  }

  const launchRes = execAdb(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
  return {
    success: launchRes.status === 0,
    method: 'monkey_default',
    output: launchRes.stdout || launchRes.stderr
  };
}

function sendTouchToDisplay(displayId, x, y, serial = null) {
  const args = ['shell', 'input'];
  if (displayId > 0) {
    args.push('-d', String(displayId));
  }
  args.push('tap', String(Math.round(x)), String(Math.round(y)));
  const res = execAdb(args, serial);
  return { success: res.status === 0 };
}

module.exports = {
  checkAdbInstalled,
  execAdb,
  execAdbAsync,
  getConnectedDevices,
  parseDeviceList,
  getDetailedDevices,
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
  grantAppPermission,
  getAdbPerformanceMetrics,
  getInstalledApps,
  launchAppOnDisplay,
  sendTouchToDisplay
};

