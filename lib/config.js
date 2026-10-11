// lib/config.js - Local persistence for last-known device configuration

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.devmode-cli.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (_) {}
  return {};
}

function saveConfig(updates) {
  try {
    const current = loadConfig();
    const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (_) {
    return updates;
  }
}

function getLastDevice() {
  const cfg = loadConfig();
  return {
    lastIp: cfg.lastIp || null,
    lastPort: cfg.lastPort || null,
    lastSerial: cfg.lastSerial || null,
    lastModel: cfg.lastModel || null
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  getLastDevice
};

