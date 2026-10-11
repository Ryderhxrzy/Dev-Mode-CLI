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
  console.log(`
${colors.bold(colors.cyan('  ╔═══════════════════════════════════════════╗'))}
${colors.bold(colors.cyan('  ║'))}   ${colors.bold(colors.green('⚡ DEV MODE CLI'))}  ${colors.dim('v1.0.0')}                  ${colors.bold(colors.cyan('║'))}
${colors.bold(colors.cyan('  ║'))}   ${colors.gray('Android Quick-Toggle & Wireless ADB Tool')}  ${colors.bold(colors.cyan('║'))}
${colors.bold(colors.cyan('  ╚═══════════════════════════════════════════╝'))}
`);
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

module.exports = {
  colors,
  symbols,
  banner,
  printStatusItem,
  printKeyValue
};
