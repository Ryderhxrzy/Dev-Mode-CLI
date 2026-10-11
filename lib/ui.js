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
  const line1 = colors.bold(colors.cyan('   ___  ______   __  __  __  ____  ___  ____'));
  const line2 = colors.bold(colors.cyan('  / _ \\/ __/\\ \\ / / /  |/  / __ \\/ _ \\/ __/'));
  const line3 = colors.bold(colors.green(' / // / _/   \\ V / / /|_/ / /_/ / // / _/  '));
  const line4 = colors.bold(colors.green('/____/___/    \\_/ /_/  /_/\\____/____/___/  '));
  const line5 = colors.bold(colors.yellow('  ⚡ Android Quick-Toggle & Wireless ADB CLI  v1.0.6'));
  const border = colors.gray('  ───────────────────────────────────────────────────');

  console.log(`\n${line1}\n${line2}\n${line3}\n${line4}\n${line5}\n${border}\n`);
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

const DEV_MODE_ICON_ASCII = [
  "                *:                    .*.",
  "               *@@.                   @@#",
  "               -@@%                  #@@*",
  "                %@@:                :@@@",
  "                .@@@.  .-*#%%#*-.   @@@:",
  "                 *@@#.#@@@@@@@@@@#.*@@#",
  "                  %@@@@@@@@@@@@@@@@@@@.",
  "                  -@@@@@@@@@@@@@@@@@@#",
  "                 :@@@@@@@@@@@@@@@@@@@@:",
  "                :@@@%*%@@@@@@@@@@%*%@@@-",
  "         #%:    %@@%  .@@@@@@@@@@.  %@@@    .%%.",
  "       .%@@#   #@@@*   #@@@@@@@@#   *@@@*   -@@%:",
  "       %@@@:   @@@@#  .%@@@@@@@@@   #@@@@   .@@@@.",
  "     .%@@@.   *@@@@@@#@@@@@@@@@@@@#%@@@@@-   .%@@%.",
  "     %@@@:    #@@@@@@@@@@@@@@@@@@@@@@@@@@#    .@@@@.",
  "   .%@@@:     %#:......................:##     .@@@@.",
  "  :@@@@.      :#@@@@@@@@@@@@@@@@@@@@@@@@#-      .%@@@:",
  " .@@@@.      .@@-..................:-:.:%@:      .@@@@.",
  " :@@@*      :@*                  :#@@@%- -@:      *@@@:",
  "  %@@@:     #%                   @@@@@@@: %%     -@@@@",
  "   #@@@*    @-                  #@@@@@@@@.-@.   -@@@#",
  "    *@@@-  .@.                 .@@@@@@@@@-.@-  -@@@%",
  "     *@@@# .@                  .@@@@@@@@@-.@- -@@@#",
  "      *@@@-.@.                  @@@@@@@@@:.@:-@@@#",
  "       #@@* @-                  *@@@@@@@% -@ *@@%",
  "        --  #@                   #@@@@@% .@*  --",
  "            .@%                   :%@%* .%%",
  "             .%@#*--------------------*#@%",
  "               -%@@@@@@@@@@@@@@@@@@@@@@%-"
];

function printDevModeIcon() {
  console.log('');
  for (const line of DEV_MODE_ICON_ASCII) {
    console.log('    ' + colors.bold(colors.green(line)));
  }
  console.log('              ' + colors.bold(colors.yellow('⚡ ')) + colors.bold(colors.white('DEV MODE : ')) + colors.bold(colors.green('ACTIVATED [ON] ')) + colors.bold(colors.yellow('⚡')));
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

