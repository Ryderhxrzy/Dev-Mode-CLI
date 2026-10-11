// lib/bridge.js - Direct local Wi-Fi communication with Dev Mode Mobile App
// Allows toggling Developer Options & USB Debugging even when ADB is disconnected or disabled.

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const { getLastDevice, saveConfig } = require('./config');

const BRIDGE_PORT = 52882;

function checkBridgeAvailable(ip, port = BRIDGE_PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:${port}/api/status`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.app === 'dev-mode') {
            resolve({ available: true, data: parsed, ip, port });
            return;
          }
        } catch (_) {}
        resolve({ available: false });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ available: false });
    });

    req.on('error', () => {
      resolve({ available: false });
    });
  });
}

function discoverBridgeViaUdp(timeoutMs = 1800) {
  return new Promise((resolve) => {
    let resolved = false;
    const socket = dgram.createSocket('udp4');

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { socket.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    socket.on('error', () => {
      finish(null);
    });

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString().trim();
      if (text.startsWith('DEVMODE_PONG:')) {
        const parts = text.split(':');
        const ip = parts[1] || rinfo.address;
        const port = parseInt(parts[2] || BRIDGE_PORT, 10);
        clearTimeout(timer);
        finish({ ip, port });
      }
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        const discoverMsg = Buffer.from('DEVMODE_DISCOVER');
        socket.send(discoverMsg, 0, discoverMsg.length, BRIDGE_PORT, '255.255.255.255');

        // Also broadcast to each local interface subnet
        const interfaces = os.networkInterfaces();
        for (const name in interfaces) {
          for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
              const ipParts = iface.address.split('.');
              ipParts[3] = '255';
              const subnetBroadcast = ipParts.join('.');
              try {
                socket.send(discoverMsg, 0, discoverMsg.length, BRIDGE_PORT, subnetBroadcast);
              } catch (_) {}
            }
          }
        }
      } catch (_) {
        finish(null);
      }
    });
  });
}

async function discoverBridge() {
  // 1. Try cached IP from config
  const cached = getLastDevice();
  if (cached && cached.lastIp) {
    const check = await checkBridgeAvailable(cached.lastIp, BRIDGE_PORT, 1200);
    if (check.available) {
      return { ip: cached.lastIp, port: BRIDGE_PORT, status: check.data };
    }
  }

  // 2. Try UDP broadcast discovery
  const udpResult = await discoverBridgeViaUdp(1500);
  if (udpResult) {
    const check = await checkBridgeAvailable(udpResult.ip, udpResult.port, 1200);
    if (check.available) {
      saveConfig({ lastIp: udpResult.ip });
      return { ip: udpResult.ip, port: udpResult.port, status: check.data };
    }
  }

  return null;
}

function callBridge(ip, pathCommand, port = BRIDGE_PORT, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const cleanPath = pathCommand.startsWith('/') ? pathCommand : `/api/${pathCommand}`;
    const req = http.get(`http://${ip}:${port}${cleanPath}`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ success: true, data: parsed, statusCode: res.statusCode });
        } catch (e) {
          resolve({ success: false, error: 'Invalid JSON response from Mobile App' });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Request timed out' });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

module.exports = {
  BRIDGE_PORT,
  checkBridgeAvailable,
  discoverBridge,
  callBridge
};
