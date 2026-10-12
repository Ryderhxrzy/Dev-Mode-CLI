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
    <a href="https://github.com/Ryderhxrzy/Dev-Mode-CLI"><img src="https://img.shields.io/badge/Release-v1.0.10-0284C7?style=flat-square&logo=github&logoColor=white" alt="Release" /></a>
    <img src="https://img.shields.io/badge/Dependencies-Zero%20(Pure%20Node)-22C55E?style=flat-square" alt="Dependencies" />
    <img src="https://img.shields.io/badge/Wireless%20ADB-Auto--Connect-7F52FF?style=flat-square" alt="Wireless ADB" />
    <img src="https://img.shields.io/badge/Telemetry-Zero-10B981?style=flat-square" alt="Telemetry" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-06B6D4?style=flat-square" alt="Cross-Platform" />
  </p>

  <p>
    The official companion CLI for <strong><a href="https://github.com/Ryderhxrzy/Dev-Mode-Mobile">Dev Mode (Mobile)</a></strong>. Instantly toggle Android Developer Options, USB Debugging, and Wireless ADB directly from your PC terminal—eliminating the tedious chore of checking randomized ports and manually typing <code>adb connect</code>.
  </p>

</div>

---

## 🚀 Quick Start

No installation required! Run instantly using `npx`:

```text
  ██████╗ ███████╗██╗   ██╗   ███╗   ███╗ ██████╗ ██████╗ ███████╗  │        ▄▄           ▄▄
  ██╔══██╗██╔════╝██║   ██║   ████╗ ████║██╔═══██╗██╔══██╗██╔════╝  │        ▀██▄  ▄▄▄▄  ▄██▀
  ██║  ██║█████╗  ██║   ██║   ██╔████╔██║██║   ██║██║  ██║█████╗    │       ▄████████████████▄
  ██║  ██║██╔══╝  ╚██╗ ██╔╝   ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝    │      ████  ████████  ████
  ██████╔╝███████╗ ╚████╔╝    ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗  │      ████████████████████
  ╚═════╝ ╚══════╝  ╚═══╝     ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝  │     (════════[● ON]═══════)
   ⚡ Android Quick-Toggle & Wireless ADB CLI  v1.0.10
   ─────────────────────────────────────────────────────────────────────────────────────────

              ⚡ DEV MODE : ACTIVATED [ON] ⚡
       [ Android Developer Options & Wireless ADB ]
```

```bash
# Enable Developer Options only
npx dev-mode-cli on

# Enable USB Debugging specifically
npx dev-mode-cli usb on
```

Or install globally to use bare `devmode` anywhere:

```bash
npm install -g dev-mode-cli
devmode status
```

---

## 📱 Choose Your Setup Tutorial

Dev Mode supports two simple workflows depending on whether you want a standalone terminal utility or a mobile app toggle with Quick Settings tiles:

### 🔹 Option 1: Setup WITHOUT Mobile App (Pure Terminal CLI)
> **Best for developers who just want quick terminal commands on their PC to toggle settings and auto-connect ADB wirelessly.**

1. **Enable Developer Options on Phone (One-time):**
   - Open **Settings** > **About Phone**.
   - Tap **Build Number** 7 times until you see *"You are now a developer!"*.
2. **Enable USB Debugging:**
   - Go to **Settings** > **System** (or Additional Settings) > **Developer Options**.
   - Turn **USB Debugging** to **ON**.
3. **Connect Device to PC:**
   - Plug your Android device into your computer with a USB cable.
   - When the prompt *"Allow USB debugging?"* appears on your phone screen, check **"Always allow from this computer"** and tap **OK / Allow**.
4. **Run CLI Commands Directly:**
   ```bash
   # Toggle Developer Options on/off
   devmode on
   devmode off

   # Enable Wireless ADB & auto-connect over Wi-Fi without typing IPs/ports
   devmode wifi on

   # Speed up UI animations to 0.5x for ultra-fast testing
   devmode speed 0.5
   ```

---

### 🔹 Option 2: Setup WITH Dev Mode Mobile App (Android Tiles & Widgets)
> **Best for developers who want 1-tap toggles directly from their Android Quick Settings panel, homescreen widget, or phone without touching a terminal every time.**

1. **Download the Mobile App:**
   - Download the latest APK from the official [Dev Mode Mobile Releases](https://github.com/Ryderhxrzy/Dev-Mode-Mobile/releases).
2. **Install on Phone:**
   - Open and install the downloaded `.apk` file on your Android device.
3. **Connect via USB (One-time permission grant):**
   - Connect your phone to your PC via USB cable (with USB Debugging turned ON).
4. **Grant Secure Settings Permission with One Command:**
   - Run the dedicated grant command from your terminal:
     ```bash
     devmode grant
     ```
     *(Or via npx: `npx dev-mode-cli grant`)*

     > *Under the hood, this executes:*
     > ```bash
     > adb shell pm grant com.devmode.app android.permission.WRITE_SECURE_SETTINGS
     > ```
5. **Done! Unplug and Enjoy:**
   - You can now safely unplug the USB cable!
   - Add the **Dev Mode Quick Settings Tile** to your Android notification shade, or use the in-app switch to toggle Developer Options anytime directly from your phone!

---

## ✨ Features Overview

| Feature | Command | Description | Zero Root |
| :--- | :--- | :--- | :---: |
| ⚡ **1-Tap Developer Mode** | `devmode on` / `off` | Toggles `development_settings_enabled` on or off with instant app synchronization | `YES` |
| 🔑 **One-Command App Grant** | `devmode grant` | Automatically grants `WRITE_SECURE_SETTINGS` permission to Dev Mode Mobile App | `YES` |
| 🔌 **Auto Wireless ADB Connect** | `devmode wifi on` | Reads local Wi-Fi IP, dynamically resolves pairing port, and runs `adb connect <ip>:<port>` automatically | `YES` |
| 📡 **mDNS & Reconnect Discovery** | `devmode wifi connect` | Auto-discovers Android devices over LAN using mDNS (`_adb-tls-connect._tcp`) without USB | `YES` |
| 🛠️ **USB Debugging Control** | `devmode usb on` / `off` | Selectively turns USB debugging on or off | `YES` |
| 🏎️ **Speed Booster (Animations)** | `devmode speed 0.5` | Sets window, transition, and animator scales to 0.5x for ultra-fast testing | `YES` |
| 📊 **Device Diagnostics Dashboard** | `devmode status` | Displays live device model, connection type, IP address, active port, and status flags | `YES` |
| 🎨 **Official Green ASCII Icon** | `devmode icon` | Renders the official Android bugdroid + toggle switch ASCII art banner | `YES` |
| 🌉 **Rootless Wi-Fi Bridge** | `devmode bridge` | Direct LAN bridge to Dev Mode Mobile App even when USB Debugging is OFF | `YES` |
| 🚀 **Universal App Runner** | `devmode start` / `run` | Auto-detects project: starts Expo server for Expo apps or Native Studio for Kotlin/Android | `YES` |
| ⚡ **Native Android Studio** | `devmode studio` / `start --native` | Lightweight Android Studio CLI for Kotlin/Java builds with Expo-style hotkeys (s sync, i reinstall, r restart, l logcat) | `YES` |
| 📱 **Launch Debug Build** | `devmode debug:android` | Builds and launches debug app on Android device & auto-grants permissions | `YES` |
| 🔄 **Instant Fast-Refresh** | `devmode reload` | Sends hot-reload signal to Metro bundler and connected device | `YES` |
| 📋 **Open Dev Menu** | `devmode menu` | Opens React Native / Expo developer menu directly on device screen | `YES` |
| 📦 **Google Play Bundle** | `devmode build:aab` | Compiles production Android App Bundle (`bundleRelease`) | `YES` |
| 🏗️ **Native Gradle Build** | `devmode build:android` | Compiles native Android APK using Gradle (`assembleDebug`/`assembleRelease`) | `YES` |
| 📲 **One-Tap APK Installer** | `devmode install:apk` | Auto-detects latest compiled APK and installs it to connected device | `YES` |
| 🧹 **Deep Cache Cleaner** | `devmode clean` | Purges Gradle build caches and `.expo` Metro bundler caches | `YES` |
| 📜 **Live Device Logcat** | `devmode logs` | Streams filtered React Native, Expo, and AndroidRuntime crash logs | `YES` |
| 🪶 **Zero Dependencies** | Built-in Node.js | Pure lightweight Node.js standard library with millisecond execution speed | `YES` |

---

## 📖 Command Reference

```bash
# Core Toggles & Display
devmode on                     # Turn ON Developer Options (displays green ASCII icon)
devmode off                    # Turn OFF Developer Options only
devmode icon                   # Display official Dev Mode green ASCII art icon
devmode status                 # Inspect live device details, IP, port, and status flags

# Mobile App Bridge & Permissions
devmode bridge                 # Inspect direct Wi-Fi bridge to Mobile App (ADB bypassed)
devmode grant                  # Grant WRITE_SECURE_SETTINGS permission to Dev Mode Mobile App

# Wireless ADB (Auto-Connect)
devmode wifi on                # Enable Wireless Debugging and auto-connect
devmode wifi off               # Disconnect and disable Wireless Debugging
devmode wifi connect           # Reconnect to discovered or cached wireless device
devmode wifi connect <ip:port> # Connect to a specific endpoint

# Expo & Android Dev Suite
devmode auto                   # Interactive menu: press one key (o/u/w/s/a/b/i...) to run any command
devmode start                  # Auto-detects project: starts Expo server (or Native Studio for pure Android)
devmode run                    # Alias for devmode start (works identically)
devmode start --native         # Launch Native Studio for Kotlin/Gradle development (hotkeys: s sync, i reinstall, r restart, l logcat)
devmode studio                 # Alias for devmode start --native (lightweight Android Studio replacement)
devmode debug:android          # Build & launch debug app on device (npx expo run:android)
devmode reload                 # Fast-refresh active app (Metro & device)
devmode menu                   # Open React Native Dev Menu on device screen
devmode build:aab              # Compile production AAB via Gradle for Google Play (bundleRelease)
devmode build:android          # Compile debug APK via Gradle (assembleDebug)
devmode build:android --release# Compile release APK via Gradle (assembleRelease)
devmode install:apk --release  # Install latest APK of a variant (--release | --debug); never falls back to the other
devmode clean                  # Clean Gradle and Metro project caches
devmode logs                   # Stream filtered React Native / Expo logs
devmode reverse                # Set up ADB reverse port for Metro (8081)

# Hardware & System Tools
devmode usb on                 # Enable USB Debugging specifically
devmode usb off                # Disable USB Debugging specifically
devmode speed 0.5              # 2x Animation Speed Booster
devmode speed 1.0              # Reset animations to standard speed
devmode help                   # Show interactive help manual
```

---

## 🔌 How Auto Wireless Connect Works

```
┌─────────────────────────────────┐
│  Developer runs:                │
│  $ devmode wifi on              │
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
2. **Device Permission (For Mobile App):** If using alongside the [Dev Mode Mobile App](https://github.com/Ryderhxrzy/Dev-Mode-Mobile), grant secure settings permission once directly via the CLI:
   ```bash
   devmode grant
   ```
   *(Or manual ADB command: `adb shell pm grant com.devmode.app android.permission.WRITE_SECURE_SETTINGS`)*

---

## 💡 Troubleshooting Wi-Fi Connection

If `devmode wifi on` reports a connection timeout:
1. **Same Wi-Fi Band:** Ensure your PC and phone are connected to the exact same Wi-Fi band (e.g. both on 2.4GHz or both on 5GHz).
2. **AP Isolation:** Some routers (PLDT, Converge, Globe, etc.) have **AP Isolation / Client Isolation** enabled by default, blocking direct device-to-device communication. Turn off AP Isolation in your router admin panel, or connect your phone to your PC's **Mobile Hotspot**.

---

## 📄 License & Attribution

Distributed under the **MIT License**. Created by [Ryderhxrzy](https://github.com/Ryderhxrzy).

Companion repository: [Dev Mode Mobile App](https://github.com/Ryderhxrzy/Dev-Mode-Mobile)

