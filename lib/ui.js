// lib/ui.js - Zero-dependency terminal styling and UI helpers

const isColorSupported = !process.env.NO_COLOR && (
  process.env.FORCE_COLOR ||
  process.platform === 'win32' ||
  (process.stdout.isTTY && process.env.TERM && process.env.TERM !== 'dumb')
);

function color(open, close) {
  return (text) => isColorSupported ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);
}

const colors = {
  reset: color(0, 0),
  bold: color(1, 22),
  dim: color(2, 22),
  italic: color(3, 23),
  underline: color(4, 24),
  red: color(31, 39),
  green: color(32, 39),
  yellow: color(33, 39),
  blue: color(34, 39),
  magenta: color(35, 39),
  cyan: color(36, 39),
  white: color(37, 39),
  gray: color(90, 39),
  bgGreen: color(42, 49),
  bgRed: color(41, 49),
  bgBlue: color(44, 49)
};

const symbols = {
  check: colors.green('✔'),
  cross: colors.red('✖'),
  info: colors.cyan('ℹ'),
  warn: colors.yellow('⚠'),
  bullet: colors.gray('•'),
  arrow: colors.cyan('→'),
  rocket: '⚡'
};

function banner() {
  const devModeText = [
    "  ██████╗ ███████╗██╗   ██╗   ███╗   ███╗ ██████╗ ██████╗ ███████╗",
    "  ██╔══██╗██╔════╝██║   ██║   ████╗ ████║██╔═══██╗██╔══██╗██╔════╝",
    "  ██║  ██║█████╗  ██║   ██║   ██╔████╔██║██║   ██║██║  ██║█████╗  ",
    "  ██║  ██║██╔══╝  ╚██╗ ██╔╝   ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ",
    "  ██████╔╝███████╗ ╚████╔╝    ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗",
    "  ╚═════╝ ╚══════╝  ╚═══╝     ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝"
  ];

  const iconText = [
    "       ▄▄           ▄▄     ",
    "       ▀██▄  ▄▄▄▄  ▄██▀     ",
    "      ▄████████████████▄   ",
    "     ████  ████████  ████  ",
    "     ████████████████████  ",
    "    (════════[● ON]═══════)"
  ];

  console.log('');
  for (let i = 0; i < 6; i++) {
    const left = colors.bold(colors.green(devModeText[i]));
    const sep = colors.gray('  │ ');
    const right = colors.bold(colors.green(iconText[i]));
    console.log(left + sep + right);
  }

  const subtitle = colors.bold(colors.green('   ⚡ Android Quick-Toggle & Wireless ADB CLI  v1.0.8'));
  const border = colors.gray('   ─────────────────────────────────────────────────────────────────────────────────────────');

  console.log(`${subtitle}\n${border}\n`);
}

function printStatusItem(label, value, isPositive) {
  const statusStr = isPositive
    ? colors.bold(colors.green('ENABLED (ON)'))
    : colors.dim(colors.red('DISABLED (OFF)'));
  console.log(`  ${symbols.bullet} ${colors.bold(label.padEnd(26))}: ${statusStr}`);
}

function printKeyValue(label, value) {
  console.log(`  ${symbols.bullet} ${colors.bold(label.padEnd(26))}: ${colors.cyan(value)}`);
}

function printQuickActions() {
  console.log(`  ${colors.bold(colors.white('AVAILABLE COMMANDS:'))}`);
  const actions = [
    { cmd: 'devmode on', desc: 'Enable Developer Options only' },
    { cmd: 'devmode wifi on', desc: 'Auto-connect Wireless ADB over Wi-Fi' },
    { cmd: 'devmode start', desc: 'Auto-detect and start development server' },
    { cmd: 'devmode start --native', desc: 'Start Native Studio (Kotlin & Live Logcat)' },
    { cmd: 'devmode debug:android', desc: 'Build and launch debug app on device' },
    { cmd: 'devmode reload', desc: 'Instant hot-reload active app' },
    { cmd: 'devmode build:aab', desc: 'Build production AAB for Google Play' },
    { cmd: 'devmode build:android', desc: 'Compile APK with Gradle' },
    { cmd: 'devmode install:apk', desc: 'Install latest APK to device' },
    { cmd: 'devmode grant', desc: 'Grant permissions to Dev Mode mobile app' },
    { cmd: 'devmode status', desc: 'Show full device diagnostics' },
    { cmd: 'devmode off', desc: 'Disable Developer Options' }
  ];

  for (const item of actions) {
    console.log(`    ${colors.cyan(item.cmd.padEnd(25))} ${colors.gray('→')} ${colors.dim(item.desc)}`);
  }
  console.log('');
}

function printDevModeIcon() {
  banner();
  console.log('              ' + colors.bold(colors.green('⚡ ')) + colors.bold(colors.white('DEV MODE : ')) + colors.bold(colors.green('ACTIVATED [ON] ')) + colors.bold(colors.green('⚡')));
  console.log('       ' + colors.dim('[ Android Developer Options & Wireless ADB ]') + '\n');
}

module.exports = {
  colors,
  symbols,
  banner,
  printDevModeIcon,
  printStatusItem,
  printKeyValue,
  printQuickActions
};

