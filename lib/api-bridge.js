// lib/api-bridge.js - Smart Local API Bridge core
// Forwards a backend running on this PC to an Android device with `adb reverse`, tracks which
// mappings the API Bridge itself created (ownership), and keeps the mapping alive across device
// disconnects and ADB server restarts. Terminal rendering lives in lib/api-bridge-cli.js; this
// module never prints, so it can be driven by a mocked ADB in tests.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const EventEmitter = require('events');
const { loadConfig, saveConfig } = require('./config');
const { execAdbAsync, parseDeviceList } = require('./adb');

// Ports that belong to other tooling. They are never auto-detected as "your backend" and the
// API Bridge never removes their reverse mappings.
const RESERVED_PORTS = {
  5037: 'ADB server',
  8081: 'Metro bundler (Expo / React Native)',
  19000: 'Expo dev server',
  19001: 'Expo dev server',
  19002: 'Expo DevTools',
  3288: 'Dev Mode Web Dashboard',
  52882: 'Dev Mode Mobile App Bridge',
  9229: 'Node.js inspector',
  5173: 'Vite dev server (frontend)',
  4173: 'Vite preview (frontend)',
  4200: 'Angular dev server (frontend)',
  6006: 'Storybook'
};

// Ports commonly used by backend dev servers. A port number alone never decides the framework.
const COMMON_BACKEND_PORTS = [8000, 3000, 8080, 5000, 4000, 3001, 8001, 8888, 9000, 5001, 1337, 3333, 7000, 8008, 8090, 9090];
const EPHEMERAL_PORT_START = 49152;
const MAX_DETECTION_PROBES = 32;
const MAX_RESTORE_ATTEMPTS = 5;

const RUNTIMES = [
  { name: 'PHP', re: /^(php|php-cgi|php-fpm|frankenphp|herd)[0-9.]*(\.exe)?$/i },
  { name: 'Node.js', re: /^(node|nodejs|bun|deno)(\.exe)?$/i },
  { name: 'Python', re: /^(python[0-9.]*|py|pythonw|uvicorn|gunicorn|hypercorn|daphne)(\.exe)?$/i },
  { name: 'Java', re: /^(java|javaw)(\.exe)?$/i },
  { name: '.NET', re: /^(dotnet|iisexpress)(\.exe)?$/i },
  { name: 'Ruby', re: /^(ruby|puma|rails)(\.exe)?$/i }
];

// Paths sent to the device shell for the on-device HTTP test. No quotes, spaces or shell syntax.
const SAFE_HTTP_PATH = /^\/[A-Za-z0-9\-._~/?=&%+,:@]*$/;

const DEFAULT_INTERVALS = {
  verifyMs: 5000,          // re-check an active mapping (catches silent ADB restarts)
  idlePollMs: 15000,       // safety poll while waiting, when the device tracker is alive
  backendMs: 5000,         // backend liveness check while it is up
  backendMaxMs: 15000,     // backend check backoff ceiling while it is down
  trackerDebounceMs: 300,  // coalesce bursts of track-devices events
  baseBackoffMs: 1000,
  maxBackoffMs: 30000
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isValidPort(p) {
  return Number.isInteger(p) && p > 0 && p <= 65535;
}

function backoffDelay(attempt, base, max) {
  return Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function runCommand(cmd, args, timeoutMs = 5000) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    if (res.error) return { status: 1, stdout: '', stderr: res.error.message };
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  } catch (err) {
    return { status: 1, stdout: '', stderr: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

// `adb reverse --list` → [{ tag, remote, local }]. Format: "<host-transport> <remote> <local>".
// remote = device-side socket, local = PC-side socket.
function parseReverseList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const remote = parts[parts.length - 2];
    const local = parts[parts.length - 1];
    if (!/^[a-z]+:/.test(remote) || !/^[a-z]+:/.test(local)) continue;
    out.push({ tag: parts.length >= 3 ? parts[0] : null, remote, local });
  }
  return out;
}

function splitHostPort(addr) {
  const s = String(addr || '');
  const idx = s.lastIndexOf(':');
  if (idx < 0) return null;
  const port = parseInt(s.slice(idx + 1), 10);
  if (!isValidPort(port)) return null;
  const host = s.slice(0, idx).replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  return { host, port };
}

// Hosts that `adb reverse` (which connects to localhost on the PC) can reach
function isLocalReachable(host) {
  const h = String(host || '').toLowerCase();
  return h === '' || h === '*' || h === '0.0.0.0' || h === '::' || h === '::1' || h === 'localhost' ||
    h.startsWith('127.') || h === '::ffff:127.0.0.1' || h === '::ffff:0.0.0.0';
}

// Windows `netstat -ano -p TCP` / `netstat -ano`. Locale independent: a listening socket has a
// wildcard foreign address (0.0.0.0:0 or [::]:0) regardless of the translated state column.
function parseNetstatWindows(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    if (parts[2] !== '0.0.0.0:0' && parts[2] !== '[::]:0') continue;
    const hp = splitHostPort(parts[1]);
    if (!hp) continue;
    out.push({ host: hp.host, port: hp.port, pid: parseInt(parts[parts.length - 1], 10) || null, process: null });
  }
  return out;
}

// Windows `tasklist /FO CSV /NH` → Map(pid → image name)
function parseTasklistCsv(stdout) {
  const map = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) map.set(parseInt(m[2], 10), m[1]);
  }
  return map;
}

// Linux `ss -ltnpH`: "LISTEN 0 511 127.0.0.1:8000 0.0.0.0:* users:(("php",pid=123,fd=4))"
function parseSs(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== 'LISTEN') continue;
    const hp = splitHostPort(parts[3]);
    if (!hp) continue;
    const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    out.push({ host: hp.host, port: hp.port, pid: pm ? parseInt(pm[2], 10) : null, process: pm ? pm[1] : null });
  }
  return out;
}

// macOS / Linux `lsof -nP -iTCP -sTCP:LISTEN`: "node 1234 me 23u IPv6 0x.. 0t0 TCP *:3000 (LISTEN)"
function parseLsof(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!/\(LISTEN\)\s*$/.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const hp = splitHostPort(parts[parts.length - 2]);
    if (!hp) continue;
    out.push({ host: hp.host, port: hp.port, pid: parseInt(parts[1], 10) || null, process: parts[0] });
  }
  return out;
}

// Active TCP listeners on this PC, or null when they cannot be enumerated
function scanListeners(run = runCommand, platform = process.platform) {
  if (platform === 'win32') {
    const res = run('netstat', ['-ano', '-p', 'TCP']);
    const res6 = run('netstat', ['-ano', '-p', 'TCPv6']);
    if (res.status !== 0 && res6.status !== 0) return null;
    const listeners = [...parseNetstatWindows(res.stdout), ...parseNetstatWindows(res6.stdout)];
    const tasks = run('tasklist', ['/FO', 'CSV', '/NH']);
    if (tasks.status === 0) {
      const names = parseTasklistCsv(tasks.stdout);
      for (const l of listeners) l.process = names.get(l.pid) || null;
    }
    return listeners;
  }
  if (platform === 'linux') {
    const ss = run('ss', ['-ltnpH']);
    if (ss.status === 0 && ss.stdout.trim()) return parseSs(ss.stdout);
  }
  const lsof = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  if (lsof.status === 0 || lsof.stdout.trim()) return parseLsof(lsof.stdout);
  return null;
}

// ---------------------------------------------------------------------------
// Project hints (framework labels only when safely identifiable)
// ---------------------------------------------------------------------------

function detectProjectHints(cwd = process.cwd()) {
  const hints = [];
  const read = (rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch (_) { return null; } };
  const has = (rel) => { try { return fs.existsSync(path.join(cwd, rel)); } catch (_) { return false; } };
  const envPort = (text, keys) => {
    if (!text) return null;
    for (const k of keys) {
      const m = text.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?(\\d{2,5})["']?\\s*$`, 'm'));
      if (m && isValidPort(parseInt(m[1], 10))) return parseInt(m[1], 10);
    }
    return null;
  };
  const dotenv = read('.env');
  const push = (framework, runtime, configuredPorts = [], extra = {}) =>
    hints.push({ framework, runtime, configuredPorts: configuredPorts.filter(isValidPort), ...extra });

  // PHP
  const composer = read('composer.json');
  if (composer && has('artisan') && /"laravel\/framework"/.test(composer)) {
    push('Laravel', 'PHP', [envPort(dotenv, ['SERVER_PORT'])].filter(Boolean));
  } else if (composer && /"symfony\/framework-bundle"/.test(composer)) {
    push('Symfony', 'PHP');
  }

  // Python
  const managePy = read('manage.py');
  if (managePy && /django/i.test(managePy)) push('Django', 'Python');
  const pyDeps = [read('requirements.txt'), read('pyproject.toml'), read('Pipfile')].filter(Boolean).join('\n');
  if (/\bfastapi\b/i.test(pyDeps)) push('FastAPI', 'Python');
  else if (/\bflask\b/i.test(pyDeps)) push('Flask', 'Python');

  // Node.js
  const pkgText = read('package.json');
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      let fw = null;
      if (deps['@nestjs/core']) fw = 'NestJS';
      else if (deps['@apollo/server'] || deps['apollo-server'] || deps['apollo-server-express'] || deps['graphql-yoga']) fw = 'GraphQL server (Node.js)';
      else if (deps.fastify) fw = 'Fastify';
      else if (deps.express) fw = 'Express';
      else if (deps.koa) fw = 'Koa';
      else if (deps['@hapi/hapi']) fw = 'hapi';
      else if (deps.hono) fw = 'Hono';
      if (fw) push(fw, 'Node.js', [envPort(dotenv, ['PORT', 'APP_PORT', 'SERVER_PORT'])].filter(Boolean));
    } catch (_) {}
  }

  // Java / Spring Boot
  const build = [read('pom.xml'), read('build.gradle'), read('build.gradle.kts')].filter(Boolean).join('\n');
  if (/spring-boot/i.test(build)) {
    const ports = [];
    const props = read(path.join('src', 'main', 'resources', 'application.properties'));
    const pm = props && props.match(/^\s*server\.port\s*[=:]\s*(\d{2,5})\s*$/m);
    if (pm) ports.push(parseInt(pm[1], 10));
    const yml = read(path.join('src', 'main', 'resources', 'application.yml')) || read(path.join('src', 'main', 'resources', 'application.yaml'));
    const ym = yml && yml.match(/^server:\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+port:\s*(\d{2,5})/m);
    if (ym) ports.push(parseInt(ym[1], 10));
    push('Spring Boot', 'Java', ports);
  }

  // ASP.NET Core
  let csprojs = [];
  try { csprojs = fs.readdirSync(cwd).filter(f => f.toLowerCase().endsWith('.csproj')); } catch (_) {}
  const webProj = csprojs.find(f => /Microsoft\.NET\.Sdk\.Web/.test(read(f) || ''));
  if (webProj) {
    const ports = [];
    try {
      const ls = JSON.parse(read(path.join('Properties', 'launchSettings.json')) || '{}');
      for (const profile of Object.values(ls.profiles || {})) {
        for (const url of String(profile.applicationUrl || '').split(';')) {
          const m = url.trim().match(/^http:\/\/[^:/]+:(\d+)/i); // plain HTTP first; HTTPS needs a trusted dev cert on the phone
          if (m) ports.push(parseInt(m[1], 10));
        }
      }
    } catch (_) {}
    const base = webProj.replace(/\.csproj$/i, '');
    push('ASP.NET Core', '.NET', ports, { processNames: [base.toLowerCase(), `${base.toLowerCase()}.exe`] });
  }

  // Ruby on Rails
  const gemfile = read('Gemfile');
  if (gemfile && /gem\s+["']rails["']/.test(gemfile)) push('Rails', 'Ruby');

  return hints;
}

function runtimeFor(processName, hints = []) {
  if (!processName) return null;
  const r = RUNTIMES.find(rt => rt.re.test(processName));
  if (r) return r.name;
  const lower = processName.toLowerCase();
  const h = hints.find(x => (x.processNames || []).includes(lower));
  return h ? h.runtime : null;
}

// A framework label is only attached when the project config AND the listening process agree
// (or the project explicitly configures that port). Never from the port number alone.
function labelFramework(candidate, hints = []) {
  for (const h of hints) {
    if (h.configuredPorts.includes(candidate.port) && (!candidate.runtime || candidate.runtime === h.runtime)) {
      return { framework: h.framework, frameworkSource: 'project config' };
    }
  }
  for (const h of hints) {
    if (candidate.runtime && candidate.runtime === h.runtime) {
      return { framework: h.framework, frameworkSource: 'project files + running process' };
    }
  }
  return { framework: null, frameworkSource: null };
}

// ---------------------------------------------------------------------------
// HTTP / TCP probes
// ---------------------------------------------------------------------------

// GET a local URL. Only the status code is kept: no headers, cookies or body are stored or logged.
function probeHttp({ port, path: reqPath = '/', timeoutMs = 2000, hosts = ['127.0.0.1', '::1'] } = {}) {
// GET or POST a local URL. Only status code and latency are kept: no headers, cookies or body are stored or logged.
function probeHttp({ port, path: reqPath = '/', method = 'GET', body = null, timeoutMs = 2000, hosts = ['127.0.0.1', '::1'] } = {}) {
  const tryHost = (host) => new Promise((resolve) => {
    let settled = false;
    const startHr = process.hrtime.bigint();
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      const headers = { 'User-Agent': 'devmode-cli-api-bridge', Accept: '*/*', Connection: 'close' };
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      req = http.request({
        host, port, path: reqPath, method: 'GET', timeout: timeoutMs,
        headers: { 'User-Agent': 'devmode-cli-api-bridge', Accept: '*/*', Connection: 'close' }
        host, port, path: reqPath, method, timeout: timeoutMs, headers
      }, (res) => {
        const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));
        const statusCode = res.statusCode;
        res.resume();
        req.destroy();
        done({ reachable: true, statusCode, host });
        done({ reachable: true, statusCode, durationMs, host });
      });
    } catch (err) {
      done({ reachable: false, error: err.code || err.message, host });
      const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));
      done({ reachable: false, error: err.code || err.message, durationMs, host });
      return;
    }
    req.on('timeout', () => { req.destroy(); done({ reachable: false, error: 'timeout', host }); });
    req.on('error', (err) => done({ reachable: false, error: err.code || err.message, host }));
    req.on('timeout', () => {
      const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));
      req.destroy();
      done({ reachable: false, error: 'timeout', durationMs, host });
    });
    req.on('error', (err) => {
      const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));
      done({ reachable: false, error: err.code || err.message, durationMs, host });
    });
    if (body) req.write(body);
    req.end();
  });

  return (async () => {
    let last = { reachable: false, error: 'not tested' };
    for (const host of hosts) {
      last = await tryHost(host);
      if (last.reachable) return last;
    }
    return last;
  })();
}

// Plain TCP connect: used for periodic liveness so the backend's request log isn't spammed
function checkTcp(port, timeoutMs = 1000, hosts = ['127.0.0.1', '::1']) {
  const tryHost = (host) => new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const finish = (ok) => { sock.removeAllListeners(); sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
  return (async () => {
    for (const host of hosts) {
      if (await tryHost(host)) return true;
    }
    return false;
  })();
}

function describeHttpStatus(code) {
  if (!code) return 'no response';
  if (code < 300) return 'success';
  if (code < 400) return 'redirect';
  if (code === 401 || code === 403) return 'auth required (server reachable)';
  if (code === 404) return 'not found at this path (server reachable)';
  if (code < 500) return 'client error (server reachable)';
  return 'server error (server reachable)';
}

// ---------------------------------------------------------------------------
// Backend detection
// ---------------------------------------------------------------------------

async function detectBackends({ cwd = process.cwd(), deps = {} } = {}) {
  const run = deps.run || runCommand;
  const probe = deps.probe || probeHttp;
  const hints = deps.hints || detectProjectHints(cwd);
  const listeners = deps.listeners !== undefined ? deps.listeners : scanListeners(run, deps.platform || process.platform);
  const configured = new Set(hints.flatMap(h => h.configuredPorts));
  const common = new Set(COMMON_BACKEND_PORTS);
  const candidates = new Map();

  if (listeners) {
    for (const l of listeners) {
      if (!isLocalReachable(l.host) || RESERVED_PORTS[l.port]) continue;
      const runtime = runtimeFor(l.process, hints);
      const eligible = configured.has(l.port) || (l.port < EPHEMERAL_PORT_START && (common.has(l.port) || !!runtime));
      if (!eligible) continue;
      const existing = candidates.get(l.port);
      if (!existing || (!existing.process && l.process)) {
        candidates.set(l.port, { port: l.port, pid: l.pid || null, process: l.process || null, runtime });
      }
    }
  } else {
    // Listener table unavailable: fall back to probing well-known ports directly
    for (const p of [...configured, ...COMMON_BACKEND_PORTS]) {
      if (!RESERVED_PORTS[p] && !candidates.has(p)) candidates.set(p, { port: p, pid: null, process: null, runtime: null });
    }
  }

  const list = [...candidates.values()].slice(0, MAX_DETECTION_PROBES);
  const results = await Promise.all(list.map(async (c) => ({ c, r: await probe({ port: c.port, path: '/', timeoutMs: 1500 }) })));
  const commonOrder = (p) => { const i = COMMON_BACKEND_PORTS.indexOf(p); return i < 0 ? 999 : i; };

  const backends = results
    .filter(x => x.r && x.r.reachable)
    .map(({ c, r }) => ({ ...c, statusCode: r.statusCode, configured: configured.has(c.port), ...labelFramework(c, hints) }))
    .sort((a, b) =>
      (b.framework ? 1 : 0) - (a.framework ? 1 : 0) ||
      (b.configured ? 1 : 0) - (a.configured ? 1 : 0) ||
      commonOrder(a.port) - commonOrder(b.port) ||
      a.port - b.port);

  return { backends, hints, listenerScan: !!listeners };
}

// ---------------------------------------------------------------------------
// Mapping ownership (pure)
// ---------------------------------------------------------------------------

function ownershipKey(deviceKey, devicePort) {
  return `${deviceKey}|tcp:${devicePort}`;
}

// A recorded mapping is only "ours" if the exact adb transport that created it is still alive.
// Android drops reverse mappings when their transport closes, so a record from an older
// transport (unplug, Wi-Fi drop, ADB restart) can never prove ownership of a mapping seen now.
function isOwnershipValid(record, { devicePort, hostPort, devices = [], existing = null }) {
  if (!record) return false;
  const recHostPort = record.forwardHostPort || record.hostPort;
  if (record.devicePort !== devicePort || recHostPort !== hostPort) return false;
  if (!record.transportId) return false;
  const transport = devices.find(d => d.serial === record.serial && d.state === 'device');
  if (!transport || String(transport.transportId) !== String(record.transportId)) return false;
  if (record.tag && existing && existing.tag && record.tag !== existing.tag) return false;
  return true;
}

// Classifies the device-side port. Never mutates anything.
function classifyMapping({ mappings = [], devicePort, hostPort, record = null, devices = [] }) {
  const remote = `tcp:${devicePort}`;
  const local = `tcp:${hostPort}`;
  const existing = mappings.find(m => m.remote === remote) || null;
  if (!existing) {
    return { state: 'missing', owned: false, existing: null, staleRecord: !!record };
  }
  if (existing.local !== local) {
    return { state: 'conflict', owned: false, existing, staleRecord: !!record };
  }
  const owned = isOwnershipValid(record, { devicePort, hostPort, devices, existing });
  return { state: 'active', owned, existing, staleRecord: !!record && !owned };
}

function findAlternativeDevicePort(mappings = [], base) {
  const used = new Set(mappings.map(m => m.remote));
  for (let p = base + 1; p <= Math.min(65535, base + 100); p++) {
    if (!used.has(`tcp:${p}`) && !RESERVED_PORTS[p]) return p;
  }
  return null;
}

// Groups adb transports that point at the same physical phone (e.g. ip:port + mDNS name)
function groupPhysicalDevices(devices) {
  const groups = new Map();
  for (const d of devices) {
    const key = d.stableId || d.serial;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return [...groups.values()];
}

function pickTransport(group, preferredSerial = null) {
  return group.find(d => d.serial === preferredSerial) || group.find(d => d.isUsb) || group[0];
}

function matchesTarget(d, target) {
  if (!target) return false;
  if (target.serial && d.serial === target.serial) return true;
  if (target.stableId) {
    if (d.stableId && d.stableId === target.stableId) return true;
    if (d.serial === target.stableId) return true;
    if (d.serial.startsWith(`adb-${target.stableId}-`)) return true; // mDNS: adb-<serialno>-xxxx._adb-tls-connect._tcp
  }
  return false;
}

// ---------------------------------------------------------------------------
// Persistence & locking
// ---------------------------------------------------------------------------

// API Bridge preferences live under the `apiBridge` key of the existing ~/.devmode-cli.json.
// Other keys are never touched. Nothing sensitive (tokens, headers, payloads) is stored.
function createConfigStore() {
  return {
    get() {
      const cfg = loadConfig();
      return { ...(cfg.apiBridge || {}) };
    },
    update(partial) {
      const next = { ...this.get(), ...partial };
      saveConfig({ apiBridge: next });
      return next;
    },
    setOwned(key, record) {
      const owned = { ...(this.get().owned || {}) };
      if (record) owned[key] = record; else delete owned[key];
      return this.update({ owned });
    }
  };
}

function createMemoryStore(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    get() { return JSON.parse(JSON.stringify(data)); },
    update(partial) { data = { ...data, ...JSON.parse(JSON.stringify(partial)) }; return this.get(); },
    setOwned(key, record) {
      const owned = { ...(data.owned || {}) };
      if (record) owned[key] = record; else delete owned[key];
      return this.update({ owned });
    }
  };
}

// One lock file per physical device so two CLI processes never mutate the same device's bridge.
// Locks held by dead processes are treated as stale and taken over.
function createLockManager({ dir = path.join(os.homedir(), '.devmode-cli-locks'), pid = process.pid, isAlive = isPidAlive } = {}) {
  const held = new Set();
  const fileFor = (key) => path.join(dir, `api-bridge-${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  const readHolder = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
  const isFresh = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs < 2000; } catch (_) { return false; } };

  return {
    acquire(key) {
      const file = fileFor(key);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = fs.openSync(file, 'wx');
          fs.writeSync(fd, JSON.stringify({ pid, key, startedAt: new Date().toISOString() }));
          fs.closeSync(fd);
          held.add(file);
          return { ok: true };
        } catch (err) {
          if (err.code !== 'EEXIST') return { ok: true, degraded: true }; // cannot lock (read-only home): proceed
          const holder = readHolder(file);
          if (holder && holder.pid === pid) { held.add(file); return { ok: true }; }
          if (holder && isAlive(holder.pid)) return { ok: false, pid: holder.pid, startedAt: holder.startedAt };
          if (!holder && isFresh(file)) return { ok: false, pid: null }; // being written right now
          try { fs.unlinkSync(file); } catch (_) {}
        }
      }
      return { ok: false, pid: null };
    },
    holder(key) {
      const h = readHolder(fileFor(key));
      return h && h.pid !== pid && isAlive(h.pid) ? h : null;
    },
    release(key) {
      const file = fileFor(key);
      const h = readHolder(file);
      if (h && h.pid === pid) { try { fs.unlinkSync(file); } catch (_) {} }
      held.delete(file);
    },
    releaseAll() {
      for (const file of held) {
        const h = readHolder(file);
        if (h && h.pid === pid) { try { fs.unlinkSync(file); } catch (_) {} }
      }
      held.clear();
    }
  };
}

function defaultAdb() {
  return {
    exec: execAdbAsync,
    // Long-lived `adb track-devices` client of the existing ADB server. It exits when the server
    // dies, which is how ADB restarts are detected. It never starts a competing server.
    spawnTracker: () => spawn('adb', ['track-devices'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  };
}

async function readStableId(adb, device) {
  const res = await adb.exec(['shell', 'getprop', 'ro.serialno'], device.serial, 4000);
  const id = (res.stdout || '').trim();
  if (res.status === 0 && id && !/\s/.test(id)) return id;
  return device.isUsb ? device.serial : null;
}

// Extracts only the GraphQL operation type/name (e.g. "query GetUsers" or "mutation Login")
// from a JSON/GraphQL request body or URL query string. Never returns variables, headers, tokens, or raw payload values.
function extractGraphqlOperation(rawBuffer, rawPath = '') {
  if (rawPath && rawPath.includes('?')) {
    try {
      const qs = rawPath.slice(rawPath.indexOf('?') + 1);
      const params = new URLSearchParams(qs);
      const opName = params.get('operationName');
      const q = params.get('query');
      if (opName && /^[A-Za-z0-9_]+$/.test(opName)) {
        const m = q && q.match(/^\s*(query|mutation|subscription)\b/);
        return m ? `${m[1]} ${opName}` : opName;
      }
      if (q) {
        const m = q.match(/^\s*(query|mutation|subscription)(?:\s+([A-Za-z0-9_]+))?/);
        if (m) return m[2] ? `${m[1]} ${m[2]}` : m[1];
        if (/^\s*\{/.test(q)) return 'query';
      }
    } catch (_) {}
  }

  if (!rawBuffer || !rawBuffer.length) return null;
  const text = rawBuffer.slice(0, 4096).toString('utf8').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (item && typeof item === 'object') {
      const queryStr = typeof item.query === 'string' ? item.query : null;
      const opName = (typeof item.operationName === 'string' && /^[A-Za-z0-9_]+$/.test(item.operationName))
        ? item.operationName
        : null;
      if (queryStr) {
        const m = queryStr.match(/^\s*(query|mutation|subscription)(?:\s+([A-Za-z0-9_]+))?/);
        if (m) {
          const type = m[1];
          const name = opName || m[2];
          return name ? `${type} ${name}` : type;
        }
        if (/^\s*\{/.test(queryStr)) {
          return opName ? `query ${opName}` : 'query';
        }
      }
      if (opName && ('query' in item || 'extensions' in item)) {
        return opName;
      }
    }
  } catch (_) {
    const m = text.match(/^\s*(query|mutation|subscription)(?:\s+([A-Za-z0-9_]+))?/);
    if (m) return m[2] ? `${m[1]} ${m[2]}` : m[1];
  }
  return null;
}

function classifyApiRequest({ rawPath = '/', headers = {}, gqlOp = null }) {
  if (gqlOp) return 'GraphQL';
  if (/\/graphql\b|\/gql\b/i.test(rawPath)) return 'GraphQL';
  const ct = String(headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/graphql') || ct.includes('application/graphql-response+json')) {
    return 'GraphQL';
  }
  return 'REST';
}

// Lightweight local HTTP + WebSocket pass-through proxy used when Live API Request Logs (`[l]`)
// are enabled. Emits metadata-only request log events (apiType, method, path, statusCode, durationMs,
// optional GraphQL operation name) without ever logging headers, cookies, auth tokens, or bodies.
function createApiInspectorProxy({ targetPort, onRequest = () => {}, onRequestStart = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    let reqCounter = 0;

    const forwardRequest = (clientReq, clientRes, bodyChunks, startHr, hosts = ['127.0.0.1', '::1'], hostIdx = 0, reqId = null) => {
      const host = hosts[hostIdx];
      const rawPath = String(clientReq.url || '/');
      const gqlOp = extractGraphqlOperation(bodyChunks.length ? Buffer.concat(bodyChunks) : null, rawPath);
      const apiType = classifyApiRequest({ rawPath, headers: clientReq.headers || {}, gqlOp });
      const currentReqId = reqId || ++reqCounter;

      if (!reqId) {
        try {
          onRequestStart({
            id: currentReqId,
            timestamp: new Date(),
            apiType,
            method: String(clientReq.method || 'GET').toUpperCase(),
            path: rawPath,
            graphqlOperation: gqlOp
          });
        } catch (_) {}
      }

      const proxyReq = http.request({
        host,
        port: targetPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: clientReq.headers,
        timeout: 30000
      }, (proxyRes) => {
        const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));

        try {
          onRequest({
            id: currentReqId,
            timestamp: new Date(),
            apiType,
            method: String(clientReq.method || 'GET').toUpperCase(),
            path: rawPath,
            statusCode: proxyRes.statusCode || 200,
            durationMs,
            graphqlOperation: gqlOp,
            error: null
          });
        } catch (_) {}

        clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(clientRes);
      });

      proxyReq.on('error', (err) => {
        if (err && err.code === 'ECONNREFUSED' && hostIdx + 1 < hosts.length) {
          forwardRequest(clientReq, clientRes, bodyChunks, startHr, hosts, hostIdx + 1, currentReqId);
          return;
        }
        const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));
        try {
          onRequest({
            id: currentReqId,
            timestamp: new Date(),
            apiType,
            method: String(clientReq.method || 'GET').toUpperCase(),
            path: rawPath,
            statusCode: 502,
            durationMs,
            graphqlOperation: gqlOp,
            error: err.code || err.message || 'Backend unreachable'
          });
        } catch (_) {}
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        }
        clientRes.end(JSON.stringify({
          error: 'Bad Gateway',
          message: `Local backend on port ${targetPort} is not responding.`
        }));
      });

      for (const chunk of bodyChunks) {
        proxyReq.write(chunk);
      }
      if (clientReq.complete) {
        proxyReq.end();
      } else {
        clientReq.pipe(proxyReq);
      }
    };

    const server = http.createServer((clientReq, clientRes) => {
      const startHr = process.hrtime.bigint();
      const rawPath = String(clientReq.url || '/');
      const ct = String((clientReq.headers && clientReq.headers['content-type']) || '').toLowerCase();
      const contentLen = parseInt((clientReq.headers && clientReq.headers['content-length']) || '0', 10);
      const shouldInspectBody = clientReq.method === 'POST' && (
        /graphql|gql/i.test(rawPath) ||
        ct.includes('application/graphql') ||
        (ct.includes('application/json') && (!contentLen || contentLen <= 8192))
      );
      const bodyChunks = [];
      let bufferedBytes = 0;

      if (shouldInspectBody) {
        clientReq.on('data', (chunk) => {
          if (bufferedBytes < 4096) {
            bodyChunks.push(chunk);
            bufferedBytes += chunk.length;
          }
        });
        clientReq.once('end', () => {
          forwardRequest(clientReq, clientRes, bodyChunks, startHr);
        });
      } else {
        forwardRequest(clientReq, clientRes, bodyChunks, startHr);
      }
    });

    // Support WebSockets / Upgrade requests transparently
    server.on('upgrade', (req, clientSocket, head) => {
      const startHr = process.hrtime.bigint();
      const rawPath = String(req.url || '/');
      const isGqlWs = /graphql|gql/i.test(rawPath) ||
        /graphql/i.test(String((req.headers && req.headers['sec-websocket-protocol']) || ''));
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
        const durationMs = Math.max(1, Math.round(Number(process.hrtime.bigint() - startHr) / 1e6));
        try {
          onRequest({
            timestamp: new Date(),
            apiType: isGqlWs ? 'GraphQL' : 'WS',
            method: 'WS',
            path: rawPath,
            statusCode: 101,
            durationMs,
            graphqlOperation: isGqlWs ? 'subscription' : null,
            error: null
          });
        } catch (_) {}
        const reqLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          reqLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        reqLines.push('', '');
        upstream.write(reqLines.join('\r\n'));
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => { try { clientSocket.destroy(); } catch (_) {} });
      clientSocket.on('error', () => { try { upstream.destroy(); } catch (_) {} });
    });

    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        close: () => new Promise((res) => {
          for (const s of sockets) {
            try { s.destroy(); } catch (_) {}
          }
          sockets.clear();
          server.close(() => res());
        })
      });
    });
  });
}

// Auto-detects how to start the backend project in `cwd` for `devmode api start`
function detectBackendStartSpec(cwd = process.cwd(), preferredPort = null) {
  const hints = detectProjectHints(cwd);
  const read = (rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch (_) { return null; } };
  const has = (rel) => { try { return fs.existsSync(path.join(cwd, rel)); } catch (_) { return false; } };

  // 1. Laravel (composer.json + artisan)
  const composer = read('composer.json');
  if (composer && has('artisan') && /"laravel\/framework"/.test(composer)) {
    const hint = hints.find(h => h.framework === 'Laravel');
    const port = isValidPort(preferredPort) ? preferredPort : ((hint && hint.configuredPorts[0]) || 8000);
    return {
      framework: 'Laravel',
      runtime: 'PHP',
      port,
      command: 'php',
      args: ['artisan', 'serve', '--host=127.0.0.1', `--port=${port}`],
      displayCommand: `php artisan serve --host=127.0.0.1 --port=${port}`
    };
  }

  // 2. Symfony
  if (composer && /"symfony\/framework-bundle"/.test(composer)) {
    const port = isValidPort(preferredPort) ? preferredPort : 8000;
    return {
      framework: 'Symfony',
      runtime: 'PHP',
      port,
      command: 'php',
      args: ['-S', `127.0.0.1:${port}`, '-t', 'public'],
      displayCommand: `php -S 127.0.0.1:${port} -t public`
    };
  }

  // 3. Django (manage.py)
  const managePy = read('manage.py');
  if (managePy && /django/i.test(managePy)) {
    const port = isValidPort(preferredPort) ? preferredPort : 8000;
    return {
      framework: 'Django',
      runtime: 'Python',
      port,
      command: 'python',
      args: ['manage.py', 'runserver', `127.0.0.1:${port}`],
      displayCommand: `python manage.py runserver 127.0.0.1:${port}`
    };
  }

  // 4. FastAPI / Flask
  const pyDeps = [read('requirements.txt'), read('pyproject.toml'), read('Pipfile')].filter(Boolean).join('\n');
  if (/\bfastapi\b/i.test(pyDeps)) {
    const port = isValidPort(preferredPort) ? preferredPort : 8000;
    const entry = has('main.py') ? 'main:app' : (has('app.py') ? 'app:app' : 'src.main:app');
    return {
      framework: 'FastAPI',
      runtime: 'Python',
      port,
      command: 'python',
      args: ['-m', 'uvicorn', entry, '--reload', '--host', '127.0.0.1', '--port', String(port)],
      displayCommand: `python -m uvicorn ${entry} --reload --port ${port}`
    };
  }
  if (/\bflask\b/i.test(pyDeps)) {
    const port = isValidPort(preferredPort) ? preferredPort : 5000;
    return {
      framework: 'Flask',
      runtime: 'Python',
      port,
      command: 'python',
      args: ['-m', 'flask', 'run', '--host=127.0.0.1', `--port=${port}`],
      displayCommand: `python -m flask run --port=${port}`
    };
  }

  // 5. Node.js (NestJS, Express, Fastify, Apollo, Koa, Hono, or custom scripts)
  const pkgText = read('package.json');
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText);
      // Do not treat dev-mode-cli itself or pure Expo/React-Native frontend as a backend server unless it has backend deps/scripts
      if (pkg.name !== 'dev-mode-cli') {
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const scripts = pkg.scripts || {};
        const nodeHint = hints.find(h => h.runtime === 'Node.js');
        const framework = (nodeHint && nodeHint.framework) ||
          (deps.next ? 'Next.js' : null) ||
          (deps.nuxt ? 'Nuxt' : null) ||
          'Node.js';
        const port = isValidPort(preferredPort)
          ? preferredPort
          : ((nodeHint && nodeHint.configuredPorts[0]) || 3000);

        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const scriptOrder = ['start:dev', 'dev:api', 'server', 'api', 'dev', 'serve', 'start'];
        for (const sName of scriptOrder) {
          if (scripts[sName] && !/\bexpo\s+start\b|\breact-native\s+start\b/i.test(scripts[sName])) {
            const args = sName === 'start' ? ['start'] : ['run', sName];
            return {
              framework,
              runtime: 'Node.js',
              port,
              command: npmCmd,
              args,
              env: { PORT: String(port), SERVER_PORT: String(port) },
              displayCommand: `npm ${args.join(' ')}`
            };
          }
        }

        const entryCandidates = [pkg.main, 'server.js', 'app.js', 'index.js', 'src/server.js', 'src/index.js', 'src/main.js'].filter(Boolean);
        const entryFile = entryCandidates.find(f => has(f));
        if (entryFile) {
          return {
            framework,
            runtime: 'Node.js',
            port,
            command: 'node',
            args: [entryFile],
            env: { PORT: String(port), SERVER_PORT: String(port) },
            displayCommand: `node ${entryFile}`
          };
        }
      }
    } catch (_) {}
  }

  // 6. Spring Boot
  const build = [read('pom.xml'), read('build.gradle'), read('build.gradle.kts')].filter(Boolean).join('\n');
  if (/spring-boot/i.test(build)) {
    const sbHint = hints.find(h => h.framework === 'Spring Boot');
    const port = isValidPort(preferredPort) ? preferredPort : ((sbHint && sbHint.configuredPorts[0]) || 8080);
    if (has('gradlew') || has('gradlew.bat')) {
      const cmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
      return {
        framework: 'Spring Boot',
        runtime: 'Java',
        port,
        command: cmd,
        args: ['bootRun', `--args=--server.port=${port}`],
        displayCommand: `${cmd} bootRun --args="--server.port=${port}"`
      };
    }
    if (has('pom.xml')) {
      const cmd = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
      return {
        framework: 'Spring Boot',
        runtime: 'Java',
        port,
        command: cmd,
        args: ['spring-boot:run', `-Dspring-boot.run.arguments=--server.port=${port}`],
        displayCommand: `mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=${port}`
      };
    }
  }

  // 7. ASP.NET Core
  const netHint = hints.find(h => h.framework === 'ASP.NET Core');
  if (netHint) {
    const port = isValidPort(preferredPort) ? preferredPort : (netHint.configuredPorts[0] || 5000);
    return {
      framework: 'ASP.NET Core',
      runtime: '.NET',
      port,
      command: 'dotnet',
      args: ['run', '--urls', `http://127.0.0.1:${port}`],
      displayCommand: `dotnet run --urls http://127.0.0.1:${port}`
    };
  }

  // 8. Ruby on Rails
  if (hints.some(h => h.framework === 'Rails')) {
    const port = isValidPort(preferredPort) ? preferredPort : 3000;
    return {
      framework: 'Rails',
      runtime: 'Ruby',
      port,
      command: 'bundle',
      args: ['exec', 'rails', 'server', '-b', '127.0.0.1', '-p', String(port)],
      displayCommand: `bundle exec rails server -p ${port}`
    };
  }

  return null;
}

class ApiBridgeSession extends EventEmitter {
  constructor({
    hostPort,
    devicePort = hostPort,
    target = null,
    autoReconnect = true,
    healthPath = null,
    deps = {},
    intervals = {}
  } = {}) {
    super();
    if (!isValidPort(hostPort)) throw new Error(`Invalid backend port: ${hostPort}`);
    this.hostPort = hostPort;
    this.forwardHostPort = hostPort;
    this.devicePort = isValidPort(devicePort) ? devicePort : hostPort;
    this.target = target && (target.serial || target.stableId) ? { ...target } : null;
    this.autoReconnect = autoReconnect !== false;
    this.healthPath = healthPath || null;
    this.adb = deps.adb || defaultAdb();
    this.probe = deps.probe || probeHttp;
    this.tcpCheck = deps.tcpCheck || checkTcp;
    this.store = deps.store || createConfigStore();
    this.lock = deps.lock === undefined ? null : deps.lock;
    this.intervals = { ...DEFAULT_INTERVALS, ...intervals };

    this.state = {
      device: 'unknown',     // unknown | adb-down | disconnected | unauthorized | offline | ambiguous | connected
      bridge: 'unknown',     // unknown | active | missing | conflict | failed | locked | paused
      backend: 'unknown',    // unknown | listening | up | down
      backendStatus: null,
      serial: null,
      model: null,
      stableId: null,
      transportId: null,
      owned: false,
      conflict: null,
      error: null,
      lockHolder: null
    };

    this.paused = false;
    this.stopped = true;
    this.liveLogging = false;
    this._inspectorProxy = null;
    this._everConnected = false;
    this._everActive = false;
    this._restoreFailures = 0;
    this._pollFailures = 0;
    this._backendFailures = 0;
    this._trackerFailures = 0;
    this._tracker = null;
    this._trackerAlive = false;
    this._adbRestartSuspected = false;
    this._idCache = new Map();
    this._timers = { verify: null, backend: null, tracker: null, debounce: null };
    this._reconciling = null;
    this._again = false;
    this._lastBridgeSig = '';
  }

  // ---- state helpers -------------------------------------------------------

  get deviceKey() {
    if (this.state.stableId || this.state.serial) return this.state.stableId || this.state.serial;
    return this.target ? (this.target.stableId || this.target.serial) : null;
  }

  _setDevice(state, info = {}) {
    const previous = this.state.device;
    Object.assign(this.state, info);
    this.state.device = state;
    if (state === previous) return;
    const reconnected = state === 'connected' && this._everConnected &&
      ['disconnected', 'unauthorized', 'offline', 'adb-down', 'ambiguous'].includes(previous);
    if (state === 'connected') { this._everConnected = true; this._pollFailures = 0; }
    this.emit('device', { state, previous, reconnected, serial: this.state.serial, model: this.state.model });
  }

  _setBridge(state, detail = {}) {
    const previous = this.state.bridge;
    this.state.bridge = state;
    this.state.owned = !!detail.owned;
    this.state.conflict = detail.conflict || null;
    this.state.error = detail.error || null;
    this.state.lockHolder = detail.lockHolder || null;
    const sig = `${state}|${this.state.owned}|${this.state.conflict ? this.state.conflict.local : ''}|${this.devicePort}|${this.forwardHostPort}|${detail.attempt || ''}`;
    if (sig === this._lastBridgeSig && !detail.restored) return;
    this._lastBridgeSig = sig;
    this.emit('bridge', { state, previous, ...detail, devicePort: this.devicePort, hostPort: this.hostPort, forwardHostPort: this.forwardHostPort });
  }

  getSnapshot() {
    return {
      ...this.state,
      hostPort: this.hostPort,
      forwardHostPort: this.forwardHostPort,
      liveLogging: this.liveLogging,
      devicePort: this.devicePort,
      target: this.target,
      paused: this.paused,
      autoReconnect: this.autoReconnect,
      trackerAlive: this._trackerAlive,
      restoreFailures: this._restoreFailures
    };
  }

  // ---- device resolution ---------------------------------------------------

  async _stableId(d) {
    const key = `${d.serial}#${d.transportId || ''}`;
    if (this._idCache.has(key)) return this._idCache.get(key);
    const id = await readStableId(this.adb, d);
    if (id) this._idCache.set(key, id);
    return id;
  }

  async _resolveDevice(devices, { adopt = true } = {}) {
    const authorized = devices.filter(d => d.state === 'device');
    for (const d of authorized) d.stableId = await this._stableId(d);

    if (this.target) {
      const cands = authorized.filter(d => matchesTarget(d, this.target));
      if (cands.length) {
        return { state: 'connected', dev: pickTransport(cands, this.state.serial || this.target.serial) };
      }
      const other = devices.find(d => d.state !== 'device' && matchesTarget(d, this.target));
      if (other) return { state: other.state === 'unauthorized' ? 'unauthorized' : 'offline', dev: other };
      return { state: 'disconnected' };
    }

    // No saved / requested device: adopt the phone only when exactly one is attached
    const groups = groupPhysicalDevices(authorized);
    if (groups.length === 1) {
      const pick = pickTransport(groups[0]);
      if (adopt) {
        this.target = { serial: pick.serial, stableId: pick.stableId || null, model: pick.model };
        this.emit('target', this.target);
      }
      return { state: 'connected', dev: pick };
    }
    if (groups.length > 1) return { state: 'ambiguous', count: groups.length };
    if (devices.some(d => d.state === 'unauthorized')) return { state: 'unauthorized' };
    return { state: 'disconnected' };
  }

  // ---- read-only inspection (used by --status and before every action) -----

  async inspect({ adopt = false } = {}) {
    const res = await this.adb.exec(['devices', '-l'], null, 6000);
    if (res.status !== 0) return { adbOk: false, device: { state: 'adb-down' }, devices: [] };
    const devices = parseDeviceList(res.stdout);
    const resolved = await this._resolveDevice(devices, { adopt });
    if (resolved.state !== 'connected') return { adbOk: true, device: resolved, devices };

    const dev = resolved.dev;
    const key = dev.stableId || dev.serial;
    const record = (this.store.get().owned || {})[ownershipKey(key, this.devicePort)] || null;
    const list = await this.adb.exec(['reverse', '--list'], dev.serial, 6000);
    if (list.status !== 0) {
      return { adbOk: true, device: resolved, devices, mapping: { state: 'unknown', error: list.stderr || 'adb reverse --list failed' }, record };
    }
    const mappings = parseReverseList(list.stdout);
    const mapping = classifyMapping({ mappings, devicePort: this.devicePort, hostPort: this.forwardHostPort, record, devices });
    return { adbOk: true, device: resolved, devices, mappings, mapping, record, key };
  }

  // ---- reconcile: bring the real ADB state in line with the desired bridge -

  reconcile(reason = 'manual') {
    if (this._reconciling) {
      this._again = true;
      return this._reconciling;
    }
    this._reconciling = (async () => {
      try {
        do {
          this._again = false;
          await this._reconcileOnce(reason);
          reason = 'repeat';
        } while (this._again && !this._halted);
      } catch (err) {
        this.emit('error-message', err.message || String(err));
      }
    })().finally(() => {
      this._reconciling = null;
      if (!this.stopped) this._scheduleVerify();
    });
    return this._reconciling;
  }

  async _canMutate(key) {
    if (!this.lock) return true;
    const r = this.lock.acquire(key);
    if (r.ok) return true;
    this._setBridge('locked', { lockHolder: r.pid });
    return false;
  }

  async _reconcileOnce(reason) {
    const snap = await this.inspect({ adopt: true });

    if (!snap.adbOk) {
      this._setDevice('adb-down');
      if (this.state.bridge === 'active') this._setBridge('missing', { reason: 'adb-down' });
      return;
    }

    const dev = snap.device.dev || null;
    if (snap.device.state !== 'connected') {
      this._setDevice(snap.device.state, dev ? { serial: dev.serial, model: dev.model } : {});
      if (this.state.bridge === 'active') this._setBridge('missing', { reason: 'device-lost' });
      return;
    }

    this._setDevice('connected', { serial: dev.serial, model: dev.model, stableId: dev.stableId || null, transportId: dev.transportId || null });

    if (!snap.mapping || snap.mapping.state === 'unknown') {
      this._setBridge('failed', { error: snap.mapping ? snap.mapping.error : 'Could not read reverse mappings' });
      return;
    }

    const { mapping, record, key } = snap;
    const ownKey = ownershipKey(key, this.devicePort);

    if (mapping.state === 'active') {
      if (mapping.staleRecord && (await this._canMutate(key))) this.store.setOwned(ownKey, null);
      this._restoreFailures = 0;
      this._markActive(dev, { owned: mapping.owned, reason });
      return;
    }

    let isLiveLogRebind = false;
    if (mapping.state === 'conflict') {
      const prevHostPort = record ? (record.forwardHostPort || record.hostPort) : null;
      const ownedPrev = prevHostPort && isOwnershipValid(record, {
        devicePort: this.devicePort,
        hostPort: prevHostPort,
        devices: snap.devices,
        existing: mapping.existing
      });
      const pointsToDirectTarget = this.liveLogging &&
        mapping.existing &&
        mapping.existing.local === `tcp:${this.hostPort}`;

      if (ownedPrev || pointsToDirectTarget) {
        isLiveLogRebind = true;
      } else {
        if (mapping.staleRecord && (await this._canMutate(key))) this.store.setOwned(ownKey, null);
        this._setBridge('conflict', { conflict: mapping.existing });
        return;
      }
    }

    // Mapping missing (or transitioning between direct hostPort and live inspector proxy)
    if (!isLiveLogRebind && record && (await this._canMutate(key))) this.store.setOwned(ownKey, null); // stale: mapping is gone
    if (this.paused) { this._setBridge('paused'); return; }
    if (this._everActive && !this.autoReconnect && reason !== 'manual' && !isLiveLogRebind) {
      this._setBridge('missing', { reason: 'auto-reconnect-disabled' });
      return;
    }
    if (this._restoreFailures >= MAX_RESTORE_ATTEMPTS && reason !== 'manual' && !isLiveLogRebind) {
      this._setBridge('failed', { error: this.state.error, exhausted: true, attempt: this._restoreFailures });
      return;
    }
    if (!(await this._canMutate(key))) return;

    const remote = `tcp:${this.devicePort}`;
    const local = `tcp:${this.forwardHostPort}`;
    // --no-rebind: never replace a mapping another tool created in the meantime (except when switching our own proxy/direct target)
    const revArgs = isLiveLogRebind ? ['reverse', remote, local] : ['reverse', '--no-rebind', remote, local];
    const add = await this.adb.exec(revArgs, dev.serial, 6000);
    if (add.status !== 0) {
      if (/cannot rebind|already/i.test(`${add.stderr} ${add.stdout}`)) {
        this._again = true; // someone else just created it; re-classify
        return;
      }
      this._restoreFailures++;
      this._setBridge('failed', { error: (add.stderr || add.stdout || 'adb reverse failed').split(/\r?\n/)[0], attempt: this._restoreFailures, exhausted: this._restoreFailures >= MAX_RESTORE_ATTEMPTS });
      return;
    }

    // Verify the mapping really exists and points where we asked
    const verify = await this.adb.exec(['reverse', '--list'], dev.serial, 6000);
    const created = parseReverseList(verify.stdout).find(m => m.remote === remote);
    if (verify.status !== 0 || !created || created.local !== local) {
      this._restoreFailures++;
      this._setBridge('failed', { error: 'Mapping could not be verified after creation', attempt: this._restoreFailures });
      return;
    }

    this.store.setOwned(ownKey, {
      serial: dev.serial,
      deviceId: dev.stableId || null,
      devicePort: this.devicePort,
      hostPort: this.hostPort,
      forwardHostPort: this.forwardHostPort,
      transportId: dev.transportId || null,
      tag: created.tag || null,
      createdAt: new Date().toISOString(),
      pid: process.pid
    });
    this._restoreFailures = 0;
    const restored = (this._everActive || this._adbRestartSuspected || reason === 'manual-restore') && !isLiveLogRebind;
    this._adbRestartSuspected = false;
    this._markActive(dev, { owned: true, created: !isLiveLogRebind, restored, reason });
  }

  _markActive(dev, { owned, created = false, restored = false, reason }) {
    const wasActive = this.state.bridge === 'active';
    this._setBridge('active', { owned, created, restored: restored && !wasActive, reason });
    if (!wasActive) {
      this._everActive = true;
      this.store.update({
        enabled: true,
        port: this.hostPort,
        devicePort: this.devicePort,
        preferredDevice: dev.serial,
        preferredDeviceId: dev.stableId || null,
        preferredDeviceModel: dev.model || null,
        lastSuccessful: {
          serial: dev.serial,
          deviceId: dev.stableId || null,
          model: dev.model || null,
          port: this.hostPort,
          devicePort: this.devicePort,
          owned: !!owned,
          at: new Date().toISOString()
        }
      });
    }
  }

  // ---- user actions --------------------------------------------------------

  async setLiveLogging(enabled) {
    const want = !!enabled;
    if (want) {
      if (!this._inspectorProxy) {
        this._inspectorProxy = await createApiInspectorProxy({
          targetPort: this.hostPort,
          onRequestStart: (entry) => this.emit('request-start', entry),
          onRequest: (entry) => this.emit('request', entry)
        });
      }
      this.liveLogging = true;
      this.forwardHostPort = this._inspectorProxy.port;
      this.emit('live-logging', { enabled: true, proxyPort: this.forwardHostPort });
      if (!this.stopped) await this.reconcile('live-logging-on');
      return { enabled: true, proxyPort: this.forwardHostPort };
    } else {
      this.liveLogging = false;
      this.forwardHostPort = this.hostPort;
      if (!this.stopped && !this.paused) {
        await this.reconcile('live-logging-off');
      }
      if (this._inspectorProxy) {
        const proxy = this._inspectorProxy;
        this._inspectorProxy = null;
        try { await proxy.close(); } catch (_) {}
      }
      this.emit('live-logging', { enabled: false, proxyPort: null });
      return { enabled: false, proxyPort: null };
    }
  }

  async reconnectNow() {
    this.paused = false;
    this._restoreFailures = 0;
    this._lastBridgeSig = '';
    this.store.update({ enabled: true });
    await this.reconcile('manual');
    return this.getSnapshot();
  }

  // Removes the mapping only when it is verifiably owned by the API Bridge.
  async disconnect() {
    this.paused = true;
    const snap = await this.inspect();
    this.store.update({ enabled: false });
    if (!snap.adbOk) return { removed: false, reason: 'adb-down' };
    if (snap.device.state !== 'connected') {
      // Android already dropped any mapping when the transport went away; only forget our record
      const key = this.deviceKey;
      if (key && this.lock && !(this.lock.acquire(key).ok)) return { removed: false, reason: 'locked' };
      if (key) this.store.setOwned(ownershipKey(key, this.devicePort), null);
      this._setBridge('paused');
      return { removed: false, reason: snap.device.state };
    }
    const { mapping, record, key } = snap;
    if (!(await this._canMutate(key))) return { removed: false, reason: 'locked', pid: this.state.lockHolder };
    const ownKey = ownershipKey(key, this.devicePort);

    if (!mapping || mapping.state === 'unknown') return { removed: false, reason: 'unknown' };
    if (mapping.state === 'missing') {
      if (record) this.store.setOwned(ownKey, null);
      this._setBridge('paused');
      return { removed: false, reason: 'missing' };
    }
    if (mapping.state === 'conflict') {
      if (record) this.store.setOwned(ownKey, null);
      this._setBridge('paused');
      return { removed: false, reason: 'not-owned', existing: mapping.existing };
    }
    if (!mapping.owned) {
      if (record) this.store.setOwned(ownKey, null);
      this._setBridge('paused');
      return { removed: false, reason: 'not-owned', existing: mapping.existing };
    }

    const res = await this.adb.exec(['reverse', '--remove', `tcp:${this.devicePort}`], record.serial, 6000);
    if (res.status !== 0) return { removed: false, reason: 'error', error: res.stderr || res.stdout };
    this.store.setOwned(ownKey, null);
    this._setBridge('paused');
    return { removed: true };
  }

  async testConnection() {
    const reqPath = this.healthPath || '/';
    const backend = await this.probe({ port: this.hostPort, path: reqPath, timeoutMs: 4000 });
    const snap = await this.inspect();
    const result = { path: reqPath, backend, device: snap.device.state, mapping: snap.mapping ? snap.mapping.state : null, mappingOwned: snap.mapping ? snap.mapping.owned : false, conflict: snap.mapping && snap.mapping.state === 'conflict' ? snap.mapping.existing : null, deviceHttp: null };
    if (snap.device.state === 'connected' && snap.mapping && snap.mapping.state === 'active') {
      result.deviceHttp = await this._deviceHttpProbe(snap.device.dev.serial, reqPath);
    }
    return result;
  }

  // Performs the request from the phone itself through the reverse mapping (curl, then nc)
  async _deviceHttpProbe(serial, reqPath) {
    if (!SAFE_HTTP_PATH.test(reqPath)) return { available: false, reason: 'Path contains characters that are unsafe for adb shell' };
    const url = `http://127.0.0.1:${this.devicePort}${reqPath}`;
    const curl = await this.adb.exec(['shell', `curl -s -o /dev/null -m 5 -w '%{http_code}' '${url}'`], serial, 10000);
    const out = (curl.stdout || '').trim();
    if (/^\d{3}$/.test(out)) {
      const code = parseInt(out, 10);
      if (code > 0) return { available: true, tool: 'curl', reachable: true, statusCode: code };
      return { available: true, tool: 'curl', reachable: false, error: curl.status === 28 ? 'timeout' : 'connection failed' };
    }
    const req = `GET ${reqPath} HTTP/1.0`;
    const nc = await this.adb.exec(['shell', `printf '%s\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' '${req}' | nc -w 5 127.0.0.1 ${this.devicePort} 2>/dev/null | head -n 1`], serial, 10000);
    const m = (nc.stdout || '').match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/);
    if (m) return { available: true, tool: 'nc', reachable: true, statusCode: parseInt(m[1], 10) };
    return { available: false, reason: 'Neither curl nor nc produced an HTTP response on the device (tool missing or connection failed)' };
  }

  // ---- monitoring loop -----------------------------------------------------

  start({ watch = true } = {}) {
    if (!this.stopped) return; // guard against duplicate monitoring loops
    this.stopped = false;
    this._halted = false;
    if (watch) this._startTracker();
    this.reconcile('start');
    this._checkBackend();
  }

  stop() {
    this.stopped = true;
    this._halted = true;
    for (const k of Object.keys(this._timers)) {
      clearTimeout(this._timers[k]);
      this._timers[k] = null;
    }
    if (this._tracker) {
      const t = this._tracker;
      this._tracker = null;
      try { t.kill(); } catch (_) {}
    }
    if (this._inspectorProxy) {
      const p = this._inspectorProxy;
      this._inspectorProxy = null;
      try { p.close(); } catch (_) {}
    }
    this.liveLogging = false;
    this.forwardHostPort = this.hostPort;
    this._trackerAlive = false;
    if (this.lock) this.lock.releaseAll();
  }

  _startTracker() {
    if (this.stopped || this._tracker) return;
    let child = null;
    try { child = this.adb.spawnTracker ? this.adb.spawnTracker() : null; } catch (_) { child = null; }
    if (!child) { this._scheduleTrackerRestart(); return; }

    this._tracker = child;
    this._trackerAlive = true;
    const startedAt = Date.now();
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      if (this._tracker !== child) return; // killed by stop()
      this._tracker = null;
      this._trackerAlive = false;
      if (this.stopped) return;
      if (Date.now() - startedAt > 10000) this._trackerFailures = 0;
      // The ADB server went away (adb kill-server, crash, SDK update): its mappings are gone too
      const wasActive = this.state.bridge === 'active';
      this._adbRestartSuspected = true;
      if (!this._adbLostAnnounced) {
        this._adbLostAnnounced = true;
        this.emit('adb', { state: 'lost', bridgeWasActive: wasActive });
      }
      this._onDeviceEvent();
      this._scheduleTrackerRestart();
    };
    if (child.stdout) {
      child.stdout.on('data', () => {
        if (this._adbLostAnnounced) {
          this._adbLostAnnounced = false;
          this.emit('adb', { state: 'back' });
        }
        this._onDeviceEvent();
      });
    }
    child.on('exit', onEnd);
    child.on('error', onEnd);
  }

  _scheduleTrackerRestart() {
    if (this.stopped) return;
    clearTimeout(this._timers.tracker);
    const delay = backoffDelay(this._trackerFailures, this.intervals.baseBackoffMs, this.intervals.maxBackoffMs);
    this._trackerFailures++;
    this._timers.tracker = setTimeout(() => {
      this._timers.tracker = null;
      this._startTracker();
    }, delay);
  }

  _onDeviceEvent() {
    if (this.stopped) return;
    // A device (re)appearing deserves fresh restore attempts
    this._restoreFailures = Math.min(this._restoreFailures, MAX_RESTORE_ATTEMPTS - 1);
    clearTimeout(this._timers.debounce);
    this._timers.debounce = setTimeout(() => {
      this._timers.debounce = null;
      this.reconcile('device-change');
    }, this.intervals.trackerDebounceMs);
  }

  _nextVerifyDelay() {
    const { base, max } = { base: this.intervals.baseBackoffMs, max: this.intervals.maxBackoffMs };
    if (this.state.device === 'connected') {
      if (this.state.bridge === 'failed' && this._restoreFailures < MAX_RESTORE_ATTEMPTS) {
        return backoffDelay(this._restoreFailures - 1, base, max);
      }
      if (this.state.bridge === 'active') return this.intervals.verifyMs;
      return this.intervals.idlePollMs;
    }
    // Waiting for a device / ADB: rely on track-devices, poll slowly as a safety net
    if (this._trackerAlive) return this.intervals.idlePollMs;
    this._pollFailures++;
    return backoffDelay(this._pollFailures - 1, base, Math.min(max, this.intervals.idlePollMs));
  }

  _scheduleVerify() {
    if (this.stopped) return;
    clearTimeout(this._timers.verify);
    const delay = this._nextVerifyDelay();
    this._timers.verify = setTimeout(() => {
      this._timers.verify = null;
      this.reconcile('verify');
    }, delay);
  }

  async _checkBackend() {
    let state;
    let statusCode = null;
    try {
      if (this.healthPath) {
        const r = await this.probe({ port: this.hostPort, path: this.healthPath, timeoutMs: 3000 });
        state = r.reachable ? 'up' : 'down';
        statusCode = r.statusCode || null;
      } else {
        state = (await this.tcpCheck(this.hostPort, 1000)) ? 'listening' : 'down';
      }
    } catch (_) {
      state = 'down';
    }
    if (this._halted) return;
    const previous = this.state.backend;
    const prevCode = this.state.backendStatus;
    this.state.backend = state;
    this.state.backendStatus = statusCode;
    if (state !== previous || (this.healthPath && statusCode !== prevCode)) {
      this.emit('backend', { state, previous, statusCode, path: this.healthPath });
    }
    if (state === 'down') this._backendFailures++; else this._backendFailures = 0;
    if (this.stopped) return;
    const delay = state === 'down'
      ? backoffDelay(this._backendFailures - 1, this.intervals.baseBackoffMs * 2, this.intervals.backendMaxMs)
      : this.intervals.backendMs;
    clearTimeout(this._timers.backend);
    this._timers.backend = setTimeout(() => {
      this._timers.backend = null;
      if (!this.stopped) this._checkBackend();
    }, delay);
  }
}

module.exports = {
  RESERVED_PORTS,
  COMMON_BACKEND_PORTS,
  MAX_RESTORE_ATTEMPTS,
  SAFE_HTTP_PATH,
  isValidPort,
  parseReverseList,
  parseNetstatWindows,
  parseTasklistCsv,
  parseSs,
  parseLsof,
  scanListeners,
  detectProjectHints,
  runtimeFor,
  labelFramework,
  probeHttp,
  checkTcp,
  describeHttpStatus,
  detectBackends,
  ownershipKey,
  isOwnershipValid,
  classifyMapping,
  findAlternativeDevicePort,
  groupPhysicalDevices,
  pickTransport,
  matchesTarget,
  readStableId,
  createConfigStore,
  createMemoryStore,
  createLockManager,
  isPidAlive,
  extractGraphqlOperation,
  createApiInspectorProxy,
  detectBackendStartSpec,
  ApiBridgeSession
};

