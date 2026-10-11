# ⚡ Dev Mode CLI

> **Instant Android Developer Options & Automatic Wireless ADB Connect Tool**

`dev-mode-cli` is the official companion CLI for the **Dev Mode** Android app. It enables developers to instantly toggle Android Developer Options, USB Debugging, and Wireless ADB directly from the PC terminal.

It eliminates the tedious manual task of reading your phone's randomized Wireless ADB port and manually typing `adb connect <ip>:<port>`.

---

## 🚀 Quick Start

Run instantly with `npx` (no installation required):

```bash
npx dev-mode on
```

Or install globally:

```bash
npm install -g dev-mode-cli
dev-mode on
```

---

## ⚡ Key Features

- 🔌 **Auto Wireless ADB Connect (`wifi on`):** Enables Wireless Debugging on your phone, detects your local Wi-Fi IP address, dynamically retrieves the active TLS pairing port, and runs `adb connect <ip>:<port>` automatically in a single command.
- 📱 **1-Tap Developer Mode (`on` / `off`):** Toggles `development_settings_enabled` and `adb_enabled` on the device without diving through nested phone settings menus.
- 📲 **App Synchronization:** Automatically sends broadcast sync intents to the [Dev Mode](https://github.com/Ryderhxrzy/Developer-Option-Toggle) Android app to update home screen widgets and the status bar notification.
- 💨 **Animation Speed Booster (`speed 0.5`):** Sets window, transition, and animator duration scales to 0.5x for snappy UI performance during development.
- 📊 **Live Device Dashboard (`status`):** Inspects connected phone model, connection type (USB vs Wi-Fi), IP address, active port, and debugging statuses.
- 🪶 **Zero Dependencies:** Pure lightweight Node.js with instant startup.

---

## 📖 Command Reference

| Command | Description |
| :--- | :--- |
| `npx dev-mode on` | Turns ON Developer Options & USB Debugging |
| `npx dev-mode off` | Turns OFF Developer Options, USB, and Wireless ADB |
| `npx dev-mode wifi on` | Turns ON Wireless ADB and **auto-connects** via Wi-Fi |
| `npx dev-mode wifi off` | Disconnects active wireless sessions & disables Wireless ADB |
| `npx dev-mode wifi connect [ip:port]` | Connects to device over Wi-Fi (auto-detects via mDNS if omitted) |
| `npx dev-mode usb on` | Turns ON USB Debugging |
| `npx dev-mode usb off` | Turns OFF USB Debugging |
| `npx dev-mode speed 0.5` | Sets system animations to 0.5x (Speed Booster) |
| `npx dev-mode speed 1.0` | Resets system animations to standard 1.0x |
| `npx dev-mode status` | Displays full device status, IP, port, and settings |
| `npx dev-mode help` | Displays help manual and examples |

---

## 📋 Prerequisites

1. **Android Platform Tools (ADB):** Ensure `adb` is installed and available in your system `PATH`.
2. **One-Time Permission (if using Dev Mode app):**
   ```bash
   adb shell pm grant com.devmode.app android.permission.WRITE_SECURE_SETTINGS
   ```

---

## 📄 License

MIT © [Ryderhxrzy](https://github.com/Ryderhxrzy)
