// lib/web.js - Built-in standalone web dashboard server for Dev Mode
// Serves the full interactive web controller with zero external dependencies.

const http = require('http');
const os = require('os');
const { exec } = require('child_process');
const { colors, symbols, banner } = require('./ui');
const { checkBridgeAvailable, discoverBridgeViaUdp, discoverAllBridgesViaUdp, callBridge } = require('./bridge');
const { getTargetDevice, getDeviceIp, execAdb, getInstalledApps, launchAppOnDisplay, sendTouchToDisplay } = require('./adb');
const { getLastDevice } = require('./config');

const DEFAULT_PORT = 3288;

function getLocalNetworkIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function getDashboardHtml(port) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dev Mode — Web Controller</title>
  <style>
    :root {
      --bg: #05080E;
      --card-bg: #090D16;
      --card-elevated: #0D1322;
      --border: rgba(255, 255, 255, 0.08);
      --primary: #22C55E;
      --primary-glow: rgba(34, 197, 94, 0.15);
      --cyan: #06B6D4;
      --cyan-glow: rgba(6, 182, 212, 0.15);
      --danger: #EF4444;
      --text: #F4F4F5;
      --text-muted: #A1A1AA;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      padding: 0 1rem 3rem;
      background-image: radial-gradient(ellipse 80% 80% at 50% -20%, rgba(34, 197, 94, 0.08), transparent);
    }
    header {
      max-width: 900px;
      margin: 0 auto;
      padding: 1.25rem 0;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: var(--card-elevated);
      border: 1px solid rgba(34, 197, 94, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--primary);
    }
    .brand-title {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .badge-sub {
      font-size: 0.65rem;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--primary-glow);
      color: var(--primary);
      border: 1px solid rgba(34, 197, 94, 0.3);
      font-weight: 600;
      margin-left: 6px;
    }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75rem;
      background: var(--card-elevated);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 999px;
      font-weight: 500;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #71717A;
    }
    .dot.connected { background: var(--primary); box-shadow: 0 0 10px var(--primary); }
    .dot.scanning { background: #F59E0B; animation: pulse 1s infinite; }
    @keyframes pulse { 0% { opacity: 0.4; } 50% { opacity: 1; } 100% { opacity: 0.4; } }

    main {
      max-width: 900px;
      margin: 1.5rem auto 0;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem;
      transition: all 0.2s ease;
    }
    .card.active {
      border-color: rgba(34, 197, 94, 0.45);
      box-shadow: 0 4px 20px rgba(34, 197, 94, 0.08);
    }

    /* Master Switch Banner */
    .master-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .master-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .master-icon {
      width: 52px;
      height: 52px;
      border-radius: 14px;
      background: var(--card-elevated);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--primary);
    }

    /* Cyber Switches */
    .switch-btn {
      width: 58px;
      height: 30px;
      border-radius: 999px;
      background: #27272A;
      position: relative;
      cursor: pointer;
      border: 2px solid transparent;
      transition: background 0.2s ease;
      flex-shrink: 0;
    }
    .switch-btn.on { background: var(--primary); }
    .switch-btn.cyan-on { background: var(--cyan); }
    .switch-handle {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #FFF;
      position: absolute;
      top: 1px;
      left: 2px;
      transition: transform 0.2s ease;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }
    .switch-btn.on .switch-handle,
    .switch-btn.cyan-on .switch-handle {
      transform: translateX(28px);
    }

    .controls-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.25rem;
    }

    .control-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .control-title {
      font-size: 1rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .control-desc {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }

    /* Pill Badges */
    .pill {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 999px;
      background: #27272A;
      color: #A1A1AA;
    }
    .pill.on { background: var(--primary-glow); color: var(--primary); border: 1px solid rgba(34,197,94,0.3); }
    .pill.cyan { background: var(--cyan-glow); color: var(--cyan); border: 1px solid rgba(6,182,212,0.3); }

    /* Endpoint Badge */
    .endpoint-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--primary-glow);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: var(--primary);
      font-family: monospace;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 4px;
    }
    .endpoint-badge:hover { background: rgba(34, 197, 94, 0.25); }

    /* Waiting screen */
    .waiting-box {
      text-align: center;
      padding: 2.5rem 1.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }
    .guide-card {
      max-width: 500px;
      text-align: left;
      background: var(--bg);
      border: 1px solid rgba(34, 197, 94, 0.2);
      border-radius: 12px;
      padding: 1rem;
      font-size: 0.8rem;
      color: #D4D4D8;
      line-height: 1.6;
    }

    /* CLI Cheatsheet */
    .cheatsheet-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 0.75rem;
    }
    .cmd-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-radius: 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      cursor: pointer;
      font-family: monospace;
      font-size: 0.75rem;
      transition: all 0.15s ease;
    }
    .cmd-item:hover { border-color: rgba(34, 197, 94, 0.4); background: var(--card-elevated); }
    .cmd-desc { font-family: sans-serif; font-size: 0.68rem; color: var(--text-muted); }

    /* Toast Notification */
    #toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: #090D16;
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #FFF;
      padding: 8px 18px;
      border-radius: 999px;
      font-size: 0.8rem;
      box-shadow: 0 6px 24px rgba(0,0,0,0.6);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      opacity: 0;
      pointer-events: none;
      z-index: 999;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #toast.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
          <line x1="12" y1="18" x2="12.01" y2="18"/>
        </svg>
      </div>
      <div>
        <span class="brand-title">Dev Mode</span>
        <span class="badge-sub">Web Controller</span>
      </div>
    </div>

    <div class="status-badge" id="connStatus">
      <div class="dot scanning" id="connDot"></div>
      <span id="connText">Auto-Detecting...</span>
    </div>
  </header>

  <main>
    <!-- Waiting View -->
    <div class="card waiting-box" id="waitingView">
      <h3 style="font-size: 1.25rem;">Waiting for Dev Mode Device</h3>
      <p style="color: var(--text-muted); font-size: 0.85rem; max-width: 440px;">
        Searching your local Wi-Fi network for your Android device...
      </p>

      <div class="guide-card">
        <strong style="color: var(--primary);">One-Time Setup in Mobile App:</strong>
        <ol style="margin-top: 6px; padding-left: 1.2rem;">
          <li>Open <strong>Dev Mode</strong> app on your phone.</li>
          <li>Tap <strong>Settings</strong> (gear icon).</li>
          <li>Under <em>Extended Developer Switches</em>, enable <strong>Web Remote Dashboard</strong>.</li>
          <li>Ensure phone and PC are on the same Wi-Fi.</li>
        </ol>
      </div>
    </div>

    <!-- Connected View -->
    <div id="connectedView" style="display: none; display: flex; flex-direction: column; gap: 1.25rem;">
      <!-- Smart Device Manager Selector -->
      <div class="card" id="deviceManagerCard" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <div style="width: 36px; height: 36px; border-radius: 8px; background: rgba(34, 197, 94, 0.12); display: flex; align-items: center; justify-content: center; font-size: 1.1rem;">
            📱
          </div>
          <div>
            <div style="font-size: 0.9rem; font-weight: 600;" id="activeDeviceModel">Connected Device</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);" id="activeDeviceDetails">Targeting active Android phone</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;" id="deviceListContainer">
          <!-- Populated dynamically with discovered devices -->
        </div>
      </div>

      <!-- Master Dev Options -->
      <div class="card" id="cardDev">
        <div class="master-banner">
          <div class="master-left">
            <div class="master-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="4" width="16" height="16" rx="2"/>
                <rect x="9" y="9" width="6" height="6"/>
                <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
                <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
                <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/>
                <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/>
              </svg>
            </div>
            <div>
              <div class="control-title">
                <span>Developer Options</span>
                <span class="pill" id="pillDev">OFF</span>
              </div>
              <p class="control-desc">Master switch for system developer settings and ADB debugging.</p>
            </div>
          </div>

          <div class="switch-btn" id="btnDev" onclick="toggleSetting('dev')">
            <div class="switch-handle"></div>
          </div>
        </div>
      </div>

      <!-- Core Controls Grid -->
      <div class="controls-grid">
        <!-- USB Debugging -->
        <div class="card" id="cardUsb">
          <div class="control-row">
            <div>
              <div class="control-title">
                <span>USB Debugging</span>
                <span class="pill" id="pillUsb">OFF</span>
              </div>
              <p class="control-desc">Debugging access over USB cable.</p>
            </div>
            <div class="switch-btn" id="btnUsb" onclick="toggleSetting('usb')">
              <div class="switch-handle"></div>
            </div>
          </div>
        </div>

        <!-- Wireless Debugging -->
        <div class="card" id="cardWifi">
          <div class="control-row">
            <div>
              <div class="control-title">
                <span>Wireless Debugging</span>
                <span class="pill" id="pillWifi">OFF</span>
              </div>
              <p class="control-desc">Cable-free ADB over local Wi-Fi.</p>
              <div id="endpointContainer" style="display: none;">
                <div class="endpoint-badge" id="endpointBadge" onclick="copyAdbConnect()">
                  <span id="endpointText"></span>
                  <span style="font-size: 0.65rem; opacity: 0.8;">(copy)</span>
                </div>
              </div>
            </div>
            <div class="switch-btn" id="btnWifi" onclick="toggleSetting('wifi')">
              <div class="switch-handle"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Live Device Performance Monitor -->
      <div class="card" id="perfCard">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 1.1rem;">⚡</span>
            <strong style="font-size: 0.9rem;">Device Performance Monitor</strong>
          </div>
          <span class="pill on" id="perfBatteryPill">--% BATTERY</span>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.75rem;">
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 0.65rem;">
            <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">RAM UTILIZATION</div>
            <div style="font-size: 1.1rem; font-weight: 700; color: var(--primary); margin: 2px 0;" id="perfRamPct">--%</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);" id="perfRamGb">-- GB / -- GB</div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 0.65rem;">
            <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">BATTERY TEMP</div>
            <div style="font-size: 1.1rem; font-weight: 700; color: var(--cyan); margin: 2px 0;" id="perfBattTemp">--°C</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);" id="perfBattState">Normal</div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 0.65rem;">
            <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">CPU CORES</div>
            <div style="font-size: 1.1rem; font-weight: 700; color: var(--text); margin: 2px 0;" id="perfCpuCores">--</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);">Active Cores</div>
          </div>
          <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 0.65rem;">
            <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">THERMAL STATE</div>
            <div style="font-size: 1.1rem; font-weight: 700; color: var(--primary); margin: 2px 0;" id="perfThermal">Nominal</div>
            <div style="font-size: 0.7rem; color: var(--text-muted);">Hardware Health</div>
          </div>
        </div>
      </div>

      <!-- Live Device Screen Mirroring & Independent Virtual Display -->
      <div class="card" id="mirrorCard">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 1.1rem;">📺</span>
            <strong style="font-size: 0.9rem;">Screen & Independent Virtual Display</strong>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="pill" id="mirrorStatusPill" style="background: rgba(255,255,255,0.06); color: var(--text-muted);">OFF</span>
            <button onclick="toggleMirroring()" id="mirrorToggleBtn" style="padding: 4px 10px; border-radius: 6px; background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.3); color: var(--primary); font-size: 0.75rem; font-weight: 600; cursor: pointer; border-style: solid;">
              Start Mirror
            </button>
          </div>
        </div>

        <!-- Mode Selector: Full Phone Screen vs Independent Virtual Display (Step 2) -->
        <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem; background: rgba(255,255,255,0.03); padding: 4px; border-radius: 8px; border: 1px solid var(--border);">
          <button id="modeBtnFull" onclick="setMirrorMode('full')" style="flex: 1; padding: 6px 10px; font-size: 0.75rem; font-weight: 600; border-radius: 6px; border: none; background: var(--primary-glow); color: var(--primary); cursor: pointer;">
            📱 Full Phone Screen
          </button>
          <button id="modeBtnVirtual" onclick="setMirrorMode('virtual')" style="flex: 1; padding: 6px 10px; font-size: 0.75rem; font-weight: 600; border-radius: 6px; border: none; background: transparent; color: var(--text-muted); cursor: pointer;">
            🚀 Independent App Display (Step 2)
          </button>
        </div>

        <!-- Virtual App Launcher Bar (Visible in Virtual Mode) -->
        <div id="virtualAppControls" style="display: none; margin-bottom: 0.75rem; padding: 10px; background: rgba(6,182,212,0.05); border: 1px solid rgba(6,182,212,0.2); border-radius: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
            <span style="font-size: 0.75rem; font-weight: 700; color: var(--cyan);">TARGET APP FOR VIRTUAL DISPLAY:</span>
            <span style="font-size: 0.7rem; color: var(--text-muted);">Phone screen remains 100% free!</span>
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <select id="virtualAppSelect" style="flex: 1; padding: 7px 10px; border-radius: 6px; background: #0D1322; border: 1px solid var(--border); color: #fff; font-size: 0.75rem; outline: none;">
              <option value="">Loading installed apps...</option>
            </select>
            <button onclick="launchSelectedVirtualApp()" id="btnLaunchVirtual" style="padding: 7px 14px; border-radius: 6px; background: rgba(6,182,212,0.2); border: 1px solid rgba(6,182,212,0.4); color: var(--cyan); font-size: 0.75rem; font-weight: 700; cursor: pointer; white-space: nowrap;">
              ▶ Launch App
            </button>
          </div>
        </div>

        <div id="mirrorContainer" style="display: flex; flex-direction: column; align-items: center; justify-content: center; background: #000; border: 1px solid var(--border); border-radius: 12px; min-height: 220px; position: relative; overflow: hidden; padding: 8px;">
          <div id="mirrorPlaceholder" style="text-align: center; padding: 2rem 1rem;">
            <div style="font-size: 2.2rem; margin-bottom: 0.5rem; opacity: 0.7;">📱</div>
            <div style="font-size: 0.85rem; font-weight: 600; color: var(--text);">Screen Stream Inactive (OFF)</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); max-width: 320px; margin: 4px auto 0;">
              Press <strong>[M]</strong> or click <strong>Start Mirror</strong> to turn ON.
            </div>
          </div>
          <img id="mirrorStreamImg" onclick="onMirrorStreamClick(event)" style="display: none; max-width: 100%; max-height: 480px; border-radius: 8px; object-fit: contain; box-shadow: 0 4px 20px rgba(0,0,0,0.5); cursor: crosshair;" alt="Phone Screen Mirror" />
        </div>
      </div>

      <!-- Batch Actions -->
      <div class="card" style="display: flex; align-items: center; justify-content: space-between; flex-wrap: gap: 1rem;">
        <div>
          <strong style="font-size: 0.9rem;">Quick Batch Actions</strong>
          <p style="font-size: 0.75rem; color: var(--text-muted);">Toggle all developer settings with a single click.</p>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button onclick="batchToggle(true)" style="padding: 8px 14px; border-radius: 10px; background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.3); color: var(--primary); font-size: 0.75rem; font-weight: 600; cursor: pointer;">
            Enable All
          </button>
          <button onclick="batchToggle(false)" style="padding: 8px 14px; border-radius: 10px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: var(--danger); font-size: 0.75rem; font-weight: 600; cursor: pointer;">
            Turn Off All
          </button>
        </div>
      </div>
    </div>

    <!-- Supported CLI Commands -->
    <div class="card" style="margin-top: 0.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
        <strong style="font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--primary);">
          Supported CLI Commands (<code style="font-size: 0.85rem;">dev-mode-cli</code>)
        </strong>
        <span style="font-size: 0.7rem; color: var(--text-muted);">Click to copy</span>
      </div>

      <div class="cheatsheet-grid">
        <div class="cmd-item" onclick="copyCmd('devmode on')">
          <div><code>devmode on</code><div class="cmd-desc">Turn ON Dev Options</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode off')">
          <div><code>devmode off</code><div class="cmd-desc">Turn OFF Dev Options</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode wifi on')">
          <div><code>devmode wifi on</code><div class="cmd-desc">Auto-connect Wireless ADB</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode wifi off')">
          <div><code>devmode wifi off</code><div class="cmd-desc">Disconnect Wireless ADB</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode usb on')">
          <div><code>devmode usb on</code><div class="cmd-desc">Enable USB Debugging</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode start')">
          <div><code>devmode start</code><div class="cmd-desc">Auto-detect project & dev server</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode speed 0.5')">
          <div><code>devmode speed 0.5</code><div class="cmd-desc">Speed Booster (0.5x speed)</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode reload')">
          <div><code>devmode reload</code><div class="cmd-desc">Hot reload active app</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode logs')">
          <div><code>devmode logs</code><div class="cmd-desc">Stream filtered logcat</div></div>
        </div>
        <div class="cmd-item" onclick="copyCmd('devmode grant')">
          <div><code>devmode grant</code><div class="cmd-desc">Grant permissions to mobile app</div></div>
        </div>
      </div>
    </div>
  </main>

  <!-- Floating Toast Notification -->
  <div id="toast">
    <span style="color: var(--primary); font-weight: bold;">✔</span>
    <span id="toastMsg"></span>
  </div>

  <script>
    let activeIp = '';
    let currentStatus = null;
    let lastReportedIp = '';

    function sendLog(payload) {
      try {
        fetch('/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (_) {}
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      document.getElementById('toastMsg').textContent = msg;
      t.className = 'show';
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { t.className = ''; }, 2200);
    }

    async function checkStatus() {
      try {
        const res = await fetch('/api/status' + (activeIp ? '?ip=' + encodeURIComponent(activeIp) : ''));
        const data = await res.json();
        if (data && data.app === 'dev-mode') {
          activeIp = data.ip || activeIp;
          currentStatus = data;
          updateUi(data);
          fetchMetrics();
          checkMirrorStatus();
          return true;
        }
      } catch (_) {}

      // If not connected, trigger auto-discovery
      try {
        const discRes = await fetch('/api/discover');
        const discData = await discRes.json();
        if (discData.devices && discData.devices.length > 0) {
          updateDeviceList(discData.devices);
          activeIp = discData.devices[0].ip;
          return checkStatus();
        }
      } catch (_) {}

      showDisconnected();
      return false;
    }

    async function fetchMetrics() {
      if (!activeIp) return;
      try {
        const res = await fetch('/api/metrics?ip=' + encodeURIComponent(activeIp));
        const data = await res.json();
        if (data && data.ram && data.battery) {
          updatePerfUi(data);
        }
      } catch (_) {}
    }

    function updatePerfUi(metrics) {
      if (!metrics) return;
      const pill = document.getElementById('perfBatteryPill');
      if (pill) {
        pill.textContent = metrics.battery.level + '% BATTERY';
        document.getElementById('perfRamPct').textContent = metrics.ram.percentage + '%';
        document.getElementById('perfRamGb').textContent = (metrics.ram.usedMb / 1024).toFixed(1) + 'GB / ' + (metrics.ram.totalMb / 1024).toFixed(1) + 'GB';
        document.getElementById('perfBattTemp').textContent = metrics.battery.temperature > 0 ? (metrics.battery.temperature + '°C') : 'Normal';
        document.getElementById('perfBattState').textContent = metrics.battery.isCharging ? ('Charging (' + metrics.battery.plugged + ')') : metrics.battery.health;
        document.getElementById('perfCpuCores').textContent = (metrics.cpu.cores || 8) + ' Cores';
        document.getElementById('perfThermal').textContent = metrics.thermal.status || 'Nominal';
      }
    }

    function updateDeviceList(devices) {
      const container = document.getElementById('deviceListContainer');
      if (!container || !devices) return;
      container.innerHTML = '';
      devices.forEach(d => {
        const btn = document.createElement('button');
        btn.style.padding = '4px 10px';
        btn.style.borderRadius = '999px';
        btn.style.fontSize = '0.7rem';
        btn.style.cursor = 'pointer';
        btn.style.border = '1px solid ' + (d.ip === activeIp ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.1)');
        btn.style.background = (d.ip === activeIp ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.05)');
        btn.style.color = (d.ip === activeIp ? 'var(--primary)' : 'var(--text-muted)');
        btn.textContent = (d.model ? d.model + ' (' + d.ip + ')' : d.ip);
        btn.onclick = () => {
          activeIp = d.ip;
          checkStatus();
        };
        container.appendChild(btn);
      });
    }

    function updateUi(data) {
      document.getElementById('waitingView').style.display = 'none';
      document.getElementById('connectedView').style.display = 'flex';

      document.getElementById('connDot').className = 'dot connected';
      document.getElementById('connText').textContent = activeIp || 'Connected';

      if (data.model) {
        document.getElementById('activeDeviceModel').textContent = data.model;
        document.getElementById('activeDeviceDetails').textContent = (data.androidVersion ? ('Android ' + data.androidVersion + ' • ') : '') + activeIp;
      }

      if (activeIp && activeIp !== lastReportedIp) {
        lastReportedIp = activeIp;
        sendLog({ event: 'connect', ip: activeIp });
      }

      const devOn = data.developerOptions === 'enabled';
      const usbOn = data.usbDebugging === 'enabled';
      const wifiOn = data.wirelessDebugging === 'enabled';

      // Developer Options
      document.getElementById('cardDev').className = 'card ' + (devOn ? 'active' : '');
      document.getElementById('btnDev').className = 'switch-btn ' + (devOn ? 'on' : '');
      document.getElementById('pillDev').className = 'pill ' + (devOn ? 'on' : '');
      document.getElementById('pillDev').textContent = devOn ? 'ACTIVE' : 'OFF';

      // USB
      document.getElementById('cardUsb').className = 'card ' + (usbOn ? 'active' : '');
      document.getElementById('btnUsb').className = 'switch-btn ' + (usbOn ? 'cyan-on' : '');
      document.getElementById('pillUsb').className = 'pill ' + (usbOn ? 'cyan' : '');
      document.getElementById('pillUsb').textContent = usbOn ? 'ON' : 'OFF';

      // Wireless
      document.getElementById('cardWifi').className = 'card ' + (wifiOn ? 'active' : '');
      document.getElementById('btnWifi').className = 'switch-btn ' + (wifiOn ? 'on' : '');
      document.getElementById('pillWifi').className = 'pill ' + (wifiOn ? 'on' : '');
      document.getElementById('pillWifi').textContent = wifiOn ? 'ON' : 'OFF';

      // Endpoint
      const endpointCont = document.getElementById('endpointContainer');
      const endpointTxt = document.getElementById('endpointText');
      if (wifiOn && data.wirelessEndpoint) {
        endpointCont.style.display = 'block';
        endpointTxt.textContent = data.wirelessEndpoint;
      } else {
        endpointCont.style.display = 'none';
      }
    }

    function showDisconnected() {
      document.getElementById('waitingView').style.display = 'flex';
      document.getElementById('connectedView').style.display = 'none';
      document.getElementById('connDot').className = 'dot scanning';
      document.getElementById('connText').textContent = 'Auto-Detecting...';
    }

    async function toggleSetting(type) {
      if (!currentStatus || !activeIp) return;
      const isCurrentlyOn = type === 'dev' ? currentStatus.developerOptions === 'enabled' :
                            type === 'usb' ? currentStatus.usbDebugging === 'enabled' :
                            currentStatus.wirelessDebugging === 'enabled';
      const action = type + (isCurrentlyOn ? '_off' : '_on');

      try {
        await fetch('/api/bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: activeIp, action })
        });
        await checkStatus();
      } catch (_) {}
    }

    async function batchToggle(enable) {
      if (!activeIp) return;
      sendLog({ event: 'batch', enable: enable });
      try {
        if (enable) {
          await fetch('/api/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: activeIp, action: 'dev_on' }) });
          await fetch('/api/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: activeIp, action: 'usb_on' }) });
          await fetch('/api/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: activeIp, action: 'wifi_on' }) });
        } else {
          await fetch('/api/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: activeIp, action: 'dev_off' }) });
        }
        await checkStatus();
      } catch (_) {}
    }

    function copyCmd(cmd) {
      navigator.clipboard.writeText(cmd);
      sendLog({ event: 'copy', text: cmd });
      showToast('Copied: ' + cmd);
    }

    function copyAdbConnect() {
      if (currentStatus && currentStatus.wirelessEndpoint) {
        const cmd = 'adb connect ' + currentStatus.wirelessEndpoint;
        navigator.clipboard.writeText(cmd);
        sendLog({ event: 'copy', text: cmd });
        showToast('Copied: ' + cmd);
      }
    }

    let isStreamingMirror = false;
    let mirrorPoller = null;
    let currentMirrorMode = 'full';
    let currentVirtualDisplayId = 0;
    let installedAppsList = [];

    function setMirrorMode(mode) {
      currentMirrorMode = mode;
      const btnFull = document.getElementById('modeBtnFull');
      const btnVirt = document.getElementById('modeBtnVirtual');
      const virtControls = document.getElementById('virtualAppControls');

      if (!btnFull || !btnVirt || !virtControls) return;

      if (mode === 'virtual') {
        btnVirt.style.background = 'rgba(6,182,212,0.15)';
        btnVirt.style.color = 'var(--cyan)';
        btnFull.style.background = 'transparent';
        btnFull.style.color = 'var(--text-muted)';
        virtControls.style.display = 'block';
        loadInstalledApps();
      } else {
        btnFull.style.background = 'var(--primary-glow)';
        btnFull.style.color = 'var(--primary)';
        btnVirt.style.background = 'transparent';
        btnVirt.style.color = 'var(--text-muted)';
        virtControls.style.display = 'none';
      }
    }

    async function loadInstalledApps() {
      const select = document.getElementById('virtualAppSelect');
      if (!select || installedAppsList.length > 0) return;
      try {
        const res = await fetch('/api/apps' + (activeIp ? '?ip=' + encodeURIComponent(activeIp) : ''));
        if (res.ok) {
          const data = await res.json();
          if (data && data.apps && data.apps.length > 0) {
            installedAppsList = data.apps;
            select.innerHTML = installedAppsList.map(app =>
              '<option value="' + app.package + '">' + app.name + ' (' + app.package + ')</option>'
            ).join('');
            return;
          }
        }
      } catch (_) {}
      select.innerHTML = '<option value="com.devmode.app.dev">Developer Option Toggle</option>';
    }

    async function launchSelectedVirtualApp() {
      const select = document.getElementById('virtualAppSelect');
      const pkg = select ? select.value : '';
      if (!pkg) {
        showToast('Please select an app first');
        return;
      }

      showToast('Launching ' + pkg + ' on Virtual Display...');
      const placeholder = document.getElementById('mirrorPlaceholder');
      if (placeholder) {
        placeholder.style.display = 'block';
        placeholder.innerHTML = '<div style="font-size: 2.2rem; margin-bottom: 0.5rem;">🚀</div>' +
          '<div style="font-size: 0.85rem; font-weight: 600; color: var(--cyan);">Running on Virtual Display...</div>' +
          '<div style="font-size: 0.75rem; color: var(--text-muted); max-width: 320px; margin: 4px auto 0;">' +
          'App: <strong>' + pkg + '</strong>. Your physical phone is 100% free for other apps!</div>';
      }

      try {
        const vdStartRes = await fetch('/api/bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'vd_start', ip: activeIp })
        });
        const vdData = await vdStartRes.json();
        currentVirtualDisplayId = (vdData && vdData.displayId) ? vdData.displayId : 0;

        await fetch('/api/virtual_display/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ package: pkg, displayId: currentVirtualDisplayId, ip: activeIp })
        });

        showToast('App launched! Streaming on web...');
        if (mirrorPoller) clearInterval(mirrorPoller);
        let checks = 0;
        mirrorPoller = setInterval(async () => {
          checks++;
          await checkMirrorStatus();
          if (isStreamingMirror || checks > 12) {
            clearInterval(mirrorPoller);
            mirrorPoller = null;
          }
        }, 800);
      } catch (err) {
        showToast('Launch failed: ' + err.message);
      }
    }

    function onMirrorStreamClick(event) {
      const img = document.getElementById('mirrorStreamImg');
      if (!img || !img.naturalWidth || !img.naturalHeight) return;

      const rect = img.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const clickY = event.clientY - rect.top;

      const scaleX = (img.naturalWidth || 540) / rect.width;
      const scaleY = (img.naturalHeight || 1170) / rect.height;

      const targetX = Math.round(clickX * scaleX);
      const targetY = Math.round(clickY * scaleY);

      fetch('/api/virtual_display/touch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayId: currentVirtualDisplayId,
          x: targetX,
          y: targetY
        })
      }).catch(() => {});
    }

    async function checkMirrorStatus() {
      if (!activeIp) return;
      try {
        const res = await fetch('/api/screen/status?ip=' + encodeURIComponent(activeIp));
        if (res.ok) {
          const data = await res.json();
          if (data.displayId) currentVirtualDisplayId = data.displayId;
          updateMirrorUi(data.streaming === true, data.isAppVirtualDisplay);
        }
      } catch (_) {}
    }

    function updateMirrorUi(streaming, isVirtual = false) {
      isStreamingMirror = streaming;
      const pill = document.getElementById('mirrorStatusPill');
      const btn = document.getElementById('mirrorToggleBtn');
      const placeholder = document.getElementById('mirrorPlaceholder');
      const img = document.getElementById('mirrorStreamImg');

      if (!pill || !btn || !placeholder || !img) return;

      if (streaming) {
        pill.textContent = isVirtual ? '🚀 VIRTUAL DISPLAY' : 'LIVE STREAM';
        pill.className = isVirtual ? 'pill cyan' : 'pill on';
        btn.textContent = isVirtual ? 'Stop Display' : 'Stop Mirror [M]';
        btn.style.color = 'var(--danger)';
        btn.style.background = 'rgba(239,68,68,0.15)';
        btn.style.borderColor = 'rgba(239,68,68,0.3)';
        placeholder.style.display = 'none';
        if (img.style.display !== 'block') {
          img.src = '/api/screen/stream?ip=' + encodeURIComponent(activeIp) + '&t=' + Date.now();
          img.style.display = 'block';
        }
      } else {
        pill.textContent = 'OFF';
        pill.className = 'pill';
        btn.textContent = 'Start Mirror [M]';
        btn.style.color = 'var(--primary)';
        btn.style.background = 'rgba(34,197,94,0.15)';
        btn.style.borderColor = 'rgba(34,197,94,0.3)';
        if (!mirrorPoller) {
          placeholder.style.display = 'block';
          placeholder.innerHTML = '<div style="font-size: 2.2rem; margin-bottom: 0.5rem; opacity: 0.7;">📱</div>' +
            '<div style="font-size: 0.85rem; font-weight: 600; color: var(--text);">Screen Stream Inactive (OFF)</div>' +
            '<div style="font-size: 0.75rem; color: var(--text-muted); max-width: 320px; margin: 4px auto 0;">' +
            'Select an App or press <strong>[M]</strong> to turn ON.</div>';
        }
        img.style.display = 'none';
        img.src = '';
      }
    }

    async function toggleMirroring() {
      if (!activeIp) return;
      const willTurnOn = !isStreamingMirror;
      const action = willTurnOn ? (currentMirrorMode === 'virtual' ? 'vd_start' : 'screen_start') : (currentVirtualDisplayId > 0 ? 'vd_stop' : 'screen_stop');

      if (willTurnOn) {
        const placeholder = document.getElementById('mirrorPlaceholder');
        if (placeholder) {
          placeholder.style.display = 'block';
          placeholder.innerHTML = '<div style="font-size: 2.2rem; margin-bottom: 0.5rem;">📲</div>' +
            '<div style="font-size: 0.85rem; font-weight: 600; color: var(--primary);">Connecting to display...</div>' +
            '<div style="font-size: 0.75rem; color: var(--text-muted); max-width: 320px; margin: 4px auto 0;">' +
            'Initializing display stream. Tap "Start now" if prompted.</div>';
        }
      }

      try {
        await fetch('/api/bridge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ip: activeIp }),
        });
        showToast(willTurnOn ? 'Display started!' : 'Screen Mirroring stopped');

        if (mirrorPoller) clearInterval(mirrorPoller);
        let checks = 0;
        mirrorPoller = setInterval(async () => {
          checks++;
          await checkMirrorStatus();
          if (isStreamingMirror || checks > 18) {
            clearInterval(mirrorPoller);
            mirrorPoller = null;
            if (!isStreamingMirror) updateMirrorUi(false);
          }
        }, 800);
      } catch (_) {}
    }

    // Keyboard shortcuts in browser: press 'm' or 's' to toggle screen mirroring!
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (key === 'm' || key === 's') {
        e.preventDefault();
        toggleMirroring();
      }
    });

    // Initial check & continuous 2.5s poll
    checkStatus();
    setInterval(checkStatus, 2500);
  </script>
</body>
</html>`;
}

function startWebServer(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const host = options.host || '0.0.0.0';
  let latestActiveIp = '';

  function logTerminal(message) {
    const time = new Date().toTimeString().split(' ')[0];
    console.log(`  ${colors.gray(`[${time}]`)} ${message}`);
  }

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 1. Root / UI Dashboard
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml(port));
      return;
    }

    // 2. Discover Devices API
    if (pathname === '/api/discover') {
      try {
        const foundList = [];
        const seenIps = new Set();

        // A. Check UDP local network broadcast (all bridges)
        try {
          const udpList = await discoverAllBridgesViaUdp(1200);
          for (const udpDev of udpList) {
            if (!seenIps.has(udpDev.ip)) {
              seenIps.add(udpDev.ip);
              let model = 'Android Phone';
              try {
                const chk = await checkBridgeAvailable(udpDev.ip, udpDev.port || 52882, 800);
                if (chk.available && chk.data && chk.data.model) model = chk.data.model;
              } catch (_) {}
              foundList.push({ ip: udpDev.ip, port: udpDev.port || 52882, source: 'Wi-Fi', model });
            }
          }
        } catch (_) {}

        // B. Check cached IP from last session
        try {
          const cached = getLastDevice();
          if (cached && cached.lastIp && !seenIps.has(cached.lastIp)) {
            const chk = await checkBridgeAvailable(cached.lastIp, 52882, 800);
            if (chk && chk.available) {
              seenIps.add(cached.lastIp);
              foundList.push({ ip: cached.lastIp, port: 52882, source: 'Recent Device', model: chk.data?.model || 'Android Phone' });
            }
          }
        } catch (_) {}

        // C. Check ADB connected device (USB cable or TCP/IP)
        try {
          const targetDev = getTargetDevice();
          if (targetDev && targetDev.serial) {
            // Automatically set up reverse port forward so 127.0.0.1 always works if cable is plugged in
            try { execAdb(['reverse', 'tcp:52882', 'tcp:52882'], targetDev.serial); } catch (_) {}

            const devIp = getDeviceIp(targetDev.serial);
            if (devIp && !seenIps.has(devIp)) {
              const chk = await checkBridgeAvailable(devIp, 52882, 800);
              if (chk && chk.available) {
                seenIps.add(devIp);
                foundList.push({ ip: devIp, port: 52882, source: targetDev.model || 'ADB Device', model: targetDev.model });
              }
            }
          }
        } catch (_) {}

        // D. Check 127.0.0.1 (reverse forwarded USB cable)
        if (!seenIps.has('127.0.0.1')) {
          const localChk = await checkBridgeAvailable('127.0.0.1', 52882, 500);
          if (localChk && localChk.available) {
            foundList.unshift({ ip: '127.0.0.1', port: 52882, source: 'USB Cable', model: localChk.data?.model || 'USB Device' });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ devices: foundList }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message, devices: [] }));
      }
      return;
    }

    // 3. Performance Metrics API
    if (pathname === '/api/metrics') {
      const ip = parsedUrl.searchParams.get('ip') || '127.0.0.1';
      try {
        const bridgeRes = await callBridge(ip, 'metrics', 52882, 3000);
        if (bridgeRes && bridgeRes.success && bridgeRes.data) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(bridgeRes.data));
          return;
        }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Metrics unavailable' }));
      return;
    }

    // 4. Status API
    if (pathname === '/api/status') {
      const ip = parsedUrl.searchParams.get('ip') || '127.0.0.1';
      try {
        const bridgeRes = await callBridge(ip, 'status', 52882, 3000);
        if (bridgeRes && bridgeRes.success && bridgeRes.data) {
          const status = bridgeRes.data;
          if (status.ip) latestActiveIp = status.ip; else if (ip) latestActiveIp = ip;
          if (status.wirelessDebugging === 'enabled') {
            try {
              const portRes = await callBridge(ip, 'wifi/port', 52882, 1800);
              if (portRes && portRes.success && portRes.data && portRes.data.port > 0) {
                status.wirelessPort = portRes.data.port;
                status.wirelessEndpoint = `${portRes.data.ip || ip}:${portRes.data.port}`;
              }
            } catch (_) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(status));
          return;
        }
        res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Device unreachable', details: bridgeRes ? bridgeRes.error : 'No response' }));
      } catch (err) {
        res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Device unreachable', details: err.message }));
      }
      return;
    }

    // 4. Screen Mirroring Status API
    if (pathname === '/api/screen/status') {
      const ip = parsedUrl.searchParams.get('ip') || latestActiveIp || '127.0.0.1';
      try {
        const bridgeRes = await callBridge(ip, 'api/screen/status', 52882, 3000);
        if (bridgeRes && bridgeRes.success && bridgeRes.data) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(bridgeRes.data));
          return;
        }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ streaming: false, error: 'Screen status unavailable' }));
      return;
    }

    // 5. Screen Mirroring Live MJPEG Stream Proxy
    if (pathname === '/api/screen/stream') {
      const ip = parsedUrl.searchParams.get('ip') || latestActiveIp || '127.0.0.1';
      const bridgeReq = http.get(`http://${ip}:52882/api/screen/stream`, (bridgeRes) => {
        res.writeHead(bridgeRes.statusCode || 200, {
          'Content-Type': bridgeRes.headers['content-type'] || 'multipart/x-mixed-replace; boundary=--frame',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Connection': 'keep-alive',
          'Pragma': 'no-cache',
        });
        bridgeRes.pipe(res);
      });
      bridgeReq.on('error', (e) => {
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Screen stream unavailable', details: e.message }));
        }
      });
      req.on('close', () => {
        bridgeReq.destroy();
      });
      return;
    }

    // 5b. Get Installed Apps List
    if (pathname === '/api/apps') {
      const ip = parsedUrl.searchParams.get('ip') || latestActiveIp || '127.0.0.1';
      try {
        const bridgeRes = await callBridge(ip, 'apps', 52882, 2500);
        if (bridgeRes && bridgeRes.success && Array.isArray(bridgeRes.data) && bridgeRes.data.length > 0) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ apps: bridgeRes.data, source: 'bridge' }));
          return;
        }
      } catch (_) {}

      const adbApps = getInstalledApps();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ apps: adbApps, source: 'adb' }));
      return;
    }

    // 5c. Launch App on Virtual Display
    if (pathname === '/api/virtual_display/launch' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const pkg = payload.package;
          const displayId = parseInt(payload.displayId || 0, 10);
          const ip = payload.ip || latestActiveIp || '127.0.0.1';

          logTerminal(`🚀 Launching ${colors.bold(colors.cyan(pkg))} on Virtual Display ${colors.yellow(String(displayId))}...`);

          // 1. Launch via ADB
          let adbResult = null;
          try {
            adbResult = launchAppOnDisplay(pkg, displayId);
          } catch (_) {}

          // 2. Also notify mobile bridge
          try {
            await callBridge(ip, `virtual_display/launch?package=${encodeURIComponent(pkg)}`, 52882, 3000);
          } catch (_) {}

          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: true, package: pkg, displayId, adb: adbResult }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 5d. Send Touch Tap to Virtual Display
    if (pathname === '/api/virtual_display/touch' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const displayId = parseInt(payload.displayId || 0, 10);
          const x = payload.x;
          const y = payload.y;
          const touchRes = sendTouchToDisplay(displayId, x, y);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ success: touchRes.success }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 6. Bridge Action Proxy (POST)
    if (pathname === '/api/bridge' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const ip = payload.ip || '127.0.0.1';
          const actionMap = {
            dev_on: 'dev/on',
            dev_off: 'dev/off',
            usb_on: 'usb/on',
            usb_off: 'usb/off',
            wifi_on: 'wifi/on',
            wifi_off: 'wifi/off',
            wifi_port: 'wifi/port',
            screen_start: 'api/screen/start',
            screen_stop: 'api/screen/stop',
            vd_start: 'virtual_display/start',
            vd_stop: 'virtual_display/stop',
          };
          const target = actionMap[payload.action] || 'status';
          const bridgeRes = await callBridge(ip, target, 52882, 8000);

          if (bridgeRes && bridgeRes.success) {
            const actionLabels = {
              dev_on: `${symbols.check} ${colors.green('Developer Options')} ${colors.bold('ENABLED')}`,
              dev_off: `${symbols.warn} ${colors.yellow('Developer Options')} ${colors.bold('DISABLED')}`,
              usb_on: `${symbols.check} ${colors.cyan('USB Debugging')} ${colors.bold('ENABLED')}`,
              usb_off: `${symbols.warn} ${colors.yellow('USB Debugging')} ${colors.bold('DISABLED')}`,
              wifi_on: `${symbols.check} ${colors.green('Wireless Debugging')} ${colors.bold('ENABLED')}`,
              wifi_off: `${symbols.warn} ${colors.yellow('Wireless Debugging')} ${colors.bold('DISABLED')}`,
              screen_start: `${symbols.check} ${colors.green('Screen Mirroring')} ${colors.bold('REQUESTED')}`,
              screen_stop: `${symbols.warn} ${colors.yellow('Screen Mirroring')} ${colors.bold('STOPPED')}`,
              vd_start: `${symbols.check} ${colors.green('Virtual Display')} ${colors.bold('STARTED')}`,
              vd_stop: `${symbols.warn} ${colors.yellow('Virtual Display')} ${colors.bold('STOPPED')}`,
            };
            const label = actionLabels[payload.action];
            if (label) {
              logTerminal(`${label} ${colors.gray(`(${ip})`)}`);
            }
          } else {
            logTerminal(`${symbols.cross} ${colors.red('Action failed:')} ${payload.action} ${colors.gray(`(${bridgeRes ? bridgeRes.error : 'No response'})`)}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(bridgeRes && bridgeRes.success ? bridgeRes.data : { error: bridgeRes ? bridgeRes.error : 'Action failed' }));
        } catch (err) {
          logTerminal(`${symbols.cross} ${colors.red('Bridge error:')} ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 5. Client Event Logger (POST)
    if (pathname === '/api/log' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (payload.event === 'connect') {
            logTerminal(`${symbols.arrow} ${colors.green('Device connected:')} ${colors.bold(payload.ip)}`);
          } else if (payload.event === 'copy') {
            logTerminal(`📋 ${colors.cyan('Copied to clipboard:')} ${colors.gray(payload.text)}`);
          } else if (payload.event === 'batch') {
            if (payload.enable) {
              logTerminal(`${symbols.rocket} ${colors.bold(colors.green('Quick Action:'))} ${colors.green('Enabling all developer settings...')}`);
            } else {
              logTerminal(`${symbols.warn} ${colors.bold(colors.yellow('Quick Action:'))} ${colors.yellow('Disabling developer options...')}`);
            }
          }
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, host, () => {
    banner();
    const lanIp = getLocalNetworkIp();
    const browserHost = host === '0.0.0.0' ? 'localhost' : host;

    console.log(`  ${colors.bold('🌐 DEV MODE WEB DASHBOARD')}`);
    console.log(`  ${colors.gray('─'.repeat(51))}\n`);
    console.log(`  ${symbols.check} ${colors.green('Local PC:')}      ${colors.cyan(`http://localhost:${port}`)}`);
    if (lanIp && lanIp !== '127.0.0.1') {
      console.log(`  ${symbols.check} ${colors.green('Other Devices:')} ${colors.cyan(`http://${lanIp}:${port}`)} ${colors.dim('(Same Wi-Fi network)')}`);
    }
    console.log(`  ${symbols.info} Local Wi-Fi auto-discovery running in background\n`);
    console.log(`  ${colors.bold('⌨️  Terminal One-Key Shortcuts:')}`);
    console.log(`    Press ${colors.bold(colors.yellow('[m]'))} or ${colors.bold(colors.yellow('[s]'))} ${colors.dim('│')} ${colors.cyan('Toggle Live Screen Mirroring / Sharing')}`);
    console.log(`    Press ${colors.bold(colors.yellow('[o]'))}         ${colors.dim('│')} Toggle Developer Options (ON / OFF)`);
    console.log(`    Press ${colors.bold(colors.yellow('[u]'))}         ${colors.dim('│')} Toggle USB Debugging`);
    console.log(`    Press ${colors.bold(colors.yellow('[w]'))}         ${colors.dim('│')} Toggle Wireless Debugging`);
    console.log(`    Press ${colors.bold(colors.yellow('[b]'))}         ${colors.dim('│')} Re-open Web Dashboard in Browser`);
    console.log(`    Press ${colors.bold(colors.yellow('[q]'))}         ${colors.dim('│')} Quit Server (or Ctrl+C)\n`);

    // Interactive terminal keyboard listener (Expo / Metro style)
    const readline = require('readline');
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      try { process.stdin.setRawMode(true); } catch (_) {}
      process.stdin.resume();

      process.stdin.on('keypress', async (str, key) => {
        if (key && key.ctrl && key.name === 'c') {
          console.log(`\n  ${colors.dim('Stopping Dev Mode Web Dashboard...')}`);
          process.exit(0);
        }
        const char = (str || '').toLowerCase();
        if (char === 'm' || char === 's') {
          const targetIp = latestActiveIp || '127.0.0.1';
          logTerminal(`📺 ${colors.bold(colors.cyan(`[KEY '${char.toUpperCase()}']`))} Checking Screen Mirroring state on ${targetIp}...`);
          try {
            const statusRes = await callBridge(targetIp, 'api/screen/status', 52882, 2000);
            const isStreaming = statusRes && statusRes.success && statusRes.data && statusRes.data.streaming;
            const action = isStreaming ? 'api/screen/stop' : 'api/screen/start';
            await callBridge(targetIp, action, 52882, 3000);
            if (isStreaming) {
              logTerminal(`📺 ${colors.yellow('Screen Mirroring stopped (turned OFF).')}`);
            } else {
              logTerminal(`📺 ${colors.green('Turning ON Screen Mirroring...')} Please tap ${colors.bold('"Start now"')} on your phone screen.`);
              // Actively poll until the stream starts
              let pollCount = 0;
              const pollTimer = setInterval(async () => {
                pollCount++;
                try {
                  const check = await callBridge(targetIp, 'api/screen/status', 52882, 1200);
                  if (check && check.success && check.data && check.data.streaming) {
                    clearInterval(pollTimer);
                    logTerminal(`📺 ${colors.bold(colors.green('✔ Screen Mirroring is now LIVE and streaming!'))} ${colors.cyan(`http://${browserHost}:${port}`)}`);
                  } else if (pollCount >= 15) {
                    clearInterval(pollTimer);
                  }
                } catch (_) {
                  if (pollCount >= 15) clearInterval(pollTimer);
                }
              }, 1000);
            }
          } catch (err) {
            logTerminal(`❌ ${colors.red('Failed to toggle screen mirror:')} ${err.message}`);
          }
        } else if (char === 'o') {
          const targetIp = latestActiveIp || '127.0.0.1';
          logTerminal(`⚡ ${colors.bold('[KEY \'O\']')} Toggling Developer Options on ${targetIp}...`);
          try {
            const st = await callBridge(targetIp, 'status', 52882, 2000);
            const isOn = st && st.success && st.data && st.data.developerOptions === 'enabled';
            await callBridge(targetIp, isOn ? 'dev/off' : 'dev/on', 52882, 3000);
            logTerminal(`⚡ Developer Options: ${isOn ? colors.yellow('DISABLED') : colors.green('ENABLED')}`);
          } catch (err) {
            logTerminal(`❌ ${colors.red('Failed:')} ${err.message}`);
          }
        } else if (char === 'u') {
          const targetIp = latestActiveIp || '127.0.0.1';
          logTerminal(`🔌 ${colors.bold('[KEY \'U\']')} Toggling USB Debugging on ${targetIp}...`);
          try {
            const st = await callBridge(targetIp, 'status', 52882, 2000);
            const isOn = st && st.success && st.data && st.data.usbDebugging === 'enabled';
            await callBridge(targetIp, isOn ? 'usb/off' : 'usb/on', 52882, 3000);
            logTerminal(`🔌 USB Debugging: ${isOn ? colors.yellow('DISABLED') : colors.cyan('ENABLED')}`);
          } catch (err) {
            logTerminal(`❌ ${colors.red('Failed:')} ${err.message}`);
          }
        } else if (char === 'w') {
          const targetIp = latestActiveIp || '127.0.0.1';
          logTerminal(`📶 ${colors.bold('[KEY \'W\']')} Toggling Wireless Debugging on ${targetIp}...`);
          try {
            const st = await callBridge(targetIp, 'status', 52882, 2000);
            const isOn = st && st.success && st.data && st.data.wirelessDebugging === 'enabled';
            await callBridge(targetIp, isOn ? 'wifi/off' : 'wifi/on', 52882, 6000);
            logTerminal(`📶 Wireless Debugging: ${isOn ? colors.yellow('DISABLED') : colors.green('ENABLED')}`);
          } catch (err) {
            logTerminal(`❌ ${colors.red('Failed:')} ${err.message}`);
          }
        } else if (char === 'b') {
          logTerminal(`🌐 Opening browser dashboard at http://${browserHost}:${port}...`);
          try { exec(startCmd); } catch (_) {}
        } else if (char === 'q') {
          console.log(`\n  ${colors.dim('Stopping Dev Mode Web Dashboard...')}`);
          process.exit(0);
        }
      });
    }

    // Automatically open in default browser
    const startCmd = process.platform === 'win32' ? `start http://${browserHost}:${port}` :
                     process.platform === 'darwin' ? `open http://${browserHost}:${port}` :
                     `xdg-open http://${browserHost}:${port}`;
    try {
      exec(startCmd);
    } catch (_) {}
  });

  server.on('error', (err) => {
    console.error(`  ${symbols.cross} ${colors.red(`Failed to start web dashboard on port ${port}:`)} ${err.message}`);
  });
}

module.exports = {
  startWebServer
};

