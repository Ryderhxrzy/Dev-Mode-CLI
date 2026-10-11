<div align="center">

  <h1>⚡ Dev Mode CLI 🚀</h1>

  <p><strong>Instant Android Developer Options & Automatic Wireless ADB Connect Tool</strong></p>

  <p>
    <a href="https://www.npmjs.com/package/dev-mode-cli"><img src="https://img.shields.io/badge/npm-dev--mode--cli-CB3837?style=flat-square&logo=npm&logoColor=white" alt="NPM Package" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-16.0+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://developer.android.com/tools/adb"><img src="https://img.shields.io/badge/Protocol-ADB%20%2F%20mDNS-3DDC84?style=flat-square&logo=android&logoColor=white" alt="Android ADB" /></a>
    <a href="#-license"><img src="https://img.shields.io/badge/License-MIT-F59E0B?style=flat-square" alt="License" /></a>
  </p>
  <p>
    <a href="https://github.com/Ryderhxrzy/Developer-Option-Toggle"><img src="https://img.shields.io/badge/Release-v1.0.0-0284C7?style=flat-square&logo=github&logoColor=white" alt="Release" /></a>
    <img src="https://img.shields.io/badge/Dependencies-Zero%20(Pure%20Node)-22C55E?style=flat-square" alt="Dependencies" />
    <img src="https://img.shields.io/badge/Wireless%20ADB-Auto--Connect-7F52FF?style=flat-square" alt="Wireless ADB" />
    <img src="https://img.shields.io/badge/Telemetry-Zero-10B981?style=flat-square" alt="Telemetry" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-06B6D4?style=flat-square" alt="Cross-Platform" />
  </p>

  <p>
    The official companion CLI for <strong><a href="https://github.com/Ryderhxrzy/Developer-Option-Toggle">Dev Mode</a></strong>. Instantly toggle Android Developer Options, USB Debugging, and Wireless ADB directly from your PC terminal—eliminating the tedious chore of checking randomized ports and manually typing <code>adb connect</code>.
  </p>

</div>

---

## 🚀 Quick Start

No installation required! Run instantly using `npx`:

```bash
# Enable Developer Options & USB Debugging
npx dev-mode on

# Enable Wireless ADB and AUTO-CONNECT in one step
npx dev-mode wifi on
```

Or install globally to use bare `dev-mode` anywhere:

```bash
npm install -g dev-mode-cli
dev-mode status
```

---

## ✨ Features Overview

| Feature | Command | Description | Zero Root |
| :--- | :--- | :--- | :---: |
| ⚡ **1-Tap Developer Mode** | `dev-mode on` / `off` | Toggles `development_settings_enabled` and `adb_enabled` with instant app synchronization | `YES` |
| 🔌 **Auto Wireless ADB Connect** | `dev-mode wifi on` | Reads local Wi-Fi IP, dynamically resolves pairing port, and runs `adb connect <ip>:<port>` automatically | `YES` |
| 📡 **mDNS & Reconnect Discovery** | `dev-mode wifi connect` | Auto-discovers Android devices over LAN using mDNS (`_adb-tls-connect._tcp`) without USB | `YES` |
| 🛠️ **USB Debugging Control** | `dev-mode usb on` / `off` | Selectively turns USB debugging on or off | `YES` |
| 🏎️ **Speed Booster (Animations)** | `dev-mode speed 0.5` | Sets window, transition, and animator scales to 0.5x for ultra-fast testing | `YES` |
| 📊 **Device Diagnostics Dashboard** | `dev-mode status` | Displays live device model, connection type, IP address, active port, and status flags | `YES` |
| 🪶 **Zero Dependencies** | Built-in Node.js | Pure lightweight Node.js standard library with millisecond execution speed | `YES` |

---

## 📖 Command Reference

```bash
# Core Toggles
npx dev-mode on                   # Turn ON Developer Options & USB Debugging
npx dev-mode off                  # Turn OFF Developer Options, USB & Wireless ADB
npx dev-mode status               # Inspect live device details, IP, port, and status flags

# Wireless ADB (Auto-Connect)
npx dev-mode wifi on              # Enable Wireless Debugging and auto-connect
npx dev-mode wifi off             # Disconnect and disable Wireless Debugging
npx dev-mode wifi connect         # Reconnect to discovered or cached wireless device
npx dev-mode wifi connect <ip:port> # Connect to a specific endpoint

# Hardware & System Tools
npx dev-mode usb on               # Enable USB Debugging specifically
npx dev-mode usb off              # Disable USB Debugging specifically
npx dev-mode speed 0.5            # 2x Animation Speed Booster
npx dev-mode speed 1.0            # Reset animations to standard speed
npx dev-mode help                 # Show interactive help manual
```

---

## 🔌 How Auto Wireless Connect Works

```
┌─────────────────────────────────┐
│  Developer runs:                │
│  $ npx dev-mode wifi on         │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 1. Enable `adb_wifi_enabled 1`  │
│ 2. Query wlan0 IPv4 address     │
│ 3. Resolve dynamic TLS port     │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 4. CLI automatically executes:  │
│    adb connect 192.168.1.4:38291│
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 🎉 Connected wirelessly!        │
│ Safely unplug your USB cable!   │
└─────────────────────────────────┘
```

---

## 🛠️ Prerequisites

1. **Android Platform Tools (ADB):** Ensure `adb` is installed and added to your system `PATH`.
   - Download: [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools)
2. **Device Permission:** If using alongside the [Dev Mode Mobile App](https://github.com/Ryderhxrzy/Developer-Option-Toggle), ensure secure settings permission is granted once:
   ```bash
   adb shell pm grant com.devmode.app android.permission.WRITE_SECURE_SETTINGS
   ```

---

## 💡 Troubleshooting Wi-Fi Connection

If `dev-mode wifi on` reports a connection timeout:
1. **Same Wi-Fi Band:** Ensure your PC and phone are connected to the exact same Wi-Fi band (e.g. both on 2.4GHz or both on 5GHz).
2. **AP Isolation:** Some routers (PLDT, Converge, Globe, etc.) have **AP Isolation / Client Isolation** enabled by default, blocking direct device-to-device communication. Turn off AP Isolation in your router admin panel, or connect your phone to your PC's **Mobile Hotspot**.

---

## 📄 License & Attribution

Distributed under the **MIT License**. Created by [Ryderhxrzy](https://github.com/Ryderhxrzy).

Companion repository: [Dev Mode Android App](https://github.com/Ryderhxrzy/Developer-Option-Toggle)

