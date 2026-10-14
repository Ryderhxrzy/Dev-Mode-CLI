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

  const { version } = require('../package.json');
  const subtitle = colors.bold(colors.green(`   ⚡ Android Quick-Toggle & Wireless ADB CLI  v${version}`));
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
    { cmd: 'devmode api bridge', desc: 'Smart Local API Bridge with auto-reconnect' },
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

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  if (hour >= 18 && hour < 22) return 'Good evening';
  return 'Happy late-night coding';
}

function printWelcomeMessage() {
  const greeting = getTimeGreeting();
  const quotes = [
    'Wishing you clean builds, fast reloads, and zero bugs today!',
    'Every great app starts with one session — let’s build something great!',
    'Your workspace and device are locked in. Turn ideas into reality!',
    'Focus mode on! You have everything you need to ship awesome features.'
  ];
  const width = 72;
  const title = `${greeting}, Developer! Welcome back to Dev Mode!`.padEnd(width);
  const pick = quotes[new Date().getMinutes() % quotes.length].padEnd(width);
  const bar = '─'.repeat(width + 6);

  console.log(`  ${colors.bold(colors.green(`╭${bar}╮`))}`);
  console.log(`  ${colors.bold(colors.green('│'))}  👋 ${colors.bold(colors.white(title))} ${colors.bold(colors.green('│'))}`);
  console.log(`  ${colors.bold(colors.green('│'))}  ✨ ${colors.cyan(pick)} ${colors.bold(colors.green('│'))}`);
  console.log(`  ${colors.bold(colors.green(`╰${bar}╯`))}\n`);
}

function printSignOffMessage() {
  const quotes = [
    'Every bug squashed and feature built today is real progress. Proud of you!',
    'Hard work pays off — step away from the screen, hydrate, and recharge.',
    'You pushed things forward today. Unplug, relax, and enjoy your break!',
    'Great coding session! Rest your eyes and come back refreshed tomorrow.'
  ];
  const width = 72;
  const title = 'Great job! You did well today — rest well and recharge!'.padEnd(width);
  const pick = quotes[new Date().getMinutes() % quotes.length].padEnd(width);
  const bar = '─'.repeat(width + 6);

  console.log(`  ${colors.bold(colors.cyan(`╭${bar}╮`))}`);
  console.log(`  ${colors.bold(colors.cyan('│'))}  🌟 ${colors.bold(colors.white(title))} ${colors.bold(colors.cyan('│'))}`);
  console.log(`  ${colors.bold(colors.cyan('│'))}  ☕ ${colors.dim(pick)} ${colors.bold(colors.cyan('│'))}`);
  console.log(`  ${colors.bold(colors.cyan(`╰${bar}╯`))}\n`);
}

function printCheerMessage(context) {
  const messages = {
    'wifi-on': '🚀 Cable-free mode unlocked! Code comfortably from anywhere — you’ve got this!',
    'wifi-off': '🌙 Wireless session wrapped up cleanly. Great work today — take a well-deserved rest!',
    'usb-on': '🔌 USB Debugging is live and ready — rock-solid connection for your session!',
    'usb-off': '✨ USB Debugging turned off safely. Nice work wrapping up your tasks today!',
    'speed': '⚡ Snappy UI unlocked! Less waiting on animations, more time shipping features!',
    'api-bridge-ready': '🚀 Local API Bridge is live! Save your backend code and test on your phone right away — happy building!',
    'api-bridge-stop': '👏 Awesome API testing session! Great job today — rest well and keep shipping!',
    'auto-quit': '🌟 Great job today! You did well — rest well and see you on the next build!'
  };
  const msg = messages[context];
  if (!msg) return;
  console.log(`  ${colors.bold(colors.yellow('💡'))} ${colors.bold(colors.white(msg))}\n`);
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
  printQuickActions,
  printWelcomeMessage,
  printSignOffMessage,
  printCheerMessage
};


