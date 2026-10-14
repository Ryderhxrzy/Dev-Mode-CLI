// lib/api-bridge-cli.js - Interactive terminal UI and CLI entry for `devmode api bridge` & `devmode api start`

const readline = require('readline');
const { spawn } = require('child_process');
const { colors, symbols, banner, printCheerMessage } = require('./ui');
const {
  RESERVED_PORTS,
  SAFE_HTTP_PATH,
  isValidPort,
  detectBackends,
  detectProjectHints,
  detectBackendStartSpec,
  runtimeFor,
  labelFramework,
  probeHttp,
  checkTcp,
  scanListeners,
  describeHttpStatus,
  parseReverseList,
  classifyMapping,
  isOwnershipValid,
  findAlternativeDevicePort,
  groupPhysicalDevices,
  pickTransport,
  matchesTarget,
  readStableId,
  ownershipKey,
  createConfigStore,
  createLockManager,
  ApiBridgeSession
} = require('./api-bridge');
const { execAdbAsync, parseDeviceList } = require('./adb');

function parseApiBridgeArgs(argv = []) {
  const opts = {
    action: 'run', // run | status | stop | reconnect | test | help
    port: null,
    devicePort: null,
    device: null,
    restPath: null,
    graphqlPath: null,
    healthPath: null,
    autoReconnect: null,
    liveLogs: null,
    showOutput: false,
    cmd: null,
    routes: []
  };

  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '');
    const next = argv[i + 1];
    if (a === '--status' || a === 'status') {
      opts.action = 'status';
    } else if (a === '--test' || a === 'test' || a === 'check') {
      opts.action = 'test';
    } else if (a === '--stop' || a === '--disconnect' || a === 'stop' || a === 'disconnect' || a === 'off') {
      opts.action = 'stop';
    } else if (a === '--reconnect' || a === 'reconnect') {
      opts.action = 'reconnect';
    } else if (a === '--help' || a === '-h' || a === 'help') {
      opts.action = 'help';
    } else if (a === '--routes' || a === '-r') {
      if (next) {
        opts.routes.push(...next.split(',').map(s => s.trim()).filter(Boolean));
        i++;
      }
    } else if (a.startsWith('--routes=')) {
      opts.routes.push(...a.slice('--routes='.length).split(',').map(s => s.trim()).filter(Boolean));
    } else if (a.startsWith('/') && !a.startsWith('--')) {
      opts.routes.push(a);
    } else if (a === '--port' || a === '-p') {
      opts.port = parseInt(next, 10);
      i++;
    } else if (a.startsWith('--port=')) {
      opts.port = parseInt(a.split('=')[1], 10);
    } else if (a === '--device-port') {
      opts.devicePort = parseInt(next, 10);
      i++;
    } else if (a.startsWith('--device-port=')) {
      opts.devicePort = parseInt(a.split('=')[1], 10);
    } else if (a === '--device' || a === '-d' || a === '-s') {
      opts.device = next || null;
      i++;
    } else if (a.startsWith('--device=')) {
      opts.device = a.split('=')[1] || null;
    } else if (a === '--rest-path') {
      opts.restPath = next || null;
      i++;
    } else if (a.startsWith('--rest-path=')) {
      opts.restPath = a.split('=')[1] || null;
    } else if (a === '--graphql-path') {
      opts.graphqlPath = next || null;
      i++;
    } else if (a.startsWith('--graphql-path=')) {
      opts.graphqlPath = a.split('=')[1] || null;
    } else if (a === '--health' || a === '--health-path') {
      opts.healthPath = next || null;
      i++;
    } else if (a.startsWith('--health-path=') || a.startsWith('--health=')) {
      opts.healthPath = a.split('=')[1] || null;
    } else if (a === '--no-auto-reconnect') {
      opts.autoReconnect = false;
    } else if (a === '--auto-reconnect') {
      opts.autoReconnect = true;
    } else if (a === '--logs' || a === '-l' || a === '--live-logs') {
      opts.liveLogs = true;
    } else if (a === '--no-logs') {
      opts.liveLogs = false;
    } else if (a === '--show-output' || a === '--output') {
      opts.showOutput = true;
    } else if (a === '--cmd' || a === '-c') {
      opts.cmd = next || null;
      i++;
    } else if (a.startsWith('--cmd=')) {
      opts.cmd = a.slice('--cmd='.length) || null;
    } else if (/^\d{2,5}$/.test(a) && opts.port === null) {
      opts.port = parseInt(a, 10);
    }
  }

  return opts;
}

function askLine(questionText) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      return resolve('');
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      process.emit('SIGINT');
    });
    rl.question(questionText, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

function printBridgeHeader({ showBanner = true, title = 'DevMode CLI — Smart API Bridge' } = {}) {
  if (showBanner) {
    banner();
  }
  console.log(`  ${colors.bold(colors.cyan(title))}`);
  console.log(`  ${colors.gray('─'.repeat(title.length))}\n`);
}

function showApiBridgeHelp() {
  printBridgeHeader({ showBanner: true });
  console.log(`  ${colors.bold('USAGE:')}
    ${colors.cyan('devmode api bridge')} [options]
    ${colors.cyan('devmode api start')}  [options]             ${colors.dim('(All-in-One: starts backend server + Smart API Bridge + Live Logs)')}
    ${colors.cyan('devmode api test')}   [routes...] [options] ${colors.dim('(Test local API endpoints with live visual progress bar)')}

  ${colors.bold('OPTIONS:')}
    ${colors.yellow('--port, -p <port>')}          Specify local backend port (e.g. 8000, 3000, 8080)
    ${colors.yellow('--cmd, -c "<command>"')}      Custom backend start command for 'devmode api start'
    ${colors.yellow('--device, -d <serial>')}      Target a specific Android device serial
    ${colors.yellow('--device-port <port>')}       Use a different port on the phone if the host port conflicts
    ${colors.yellow('--routes, -r <routes>')}      Comma-separated additional routes to probe (e.g. /api,/health)
    ${colors.yellow('--logs, -l')}                 Start with Live API Request Logs enabled immediately
    ${colors.yellow('--show-output')}              Stream raw backend server console output in 'devmode api start'
    ${colors.yellow('--health-path <path>')}       Optional HTTP path for health checks (e.g. /api/health)
    ${colors.yellow('--rest-path <path>')}         Custom REST base path for display (default: /api example)
    ${colors.yellow('--graphql-path <path>')}      Custom GraphQL path for display
    ${colors.yellow('--status')}                   Show current API Bridge & ADB reverse status and exit
    ${colors.yellow('--reconnect')}                Verify or re-establish the saved API Bridge mapping
    ${colors.yellow('--stop')}                     Safely remove API Bridge-owned reverse mapping and exit
    ${colors.yellow('--no-auto-reconnect')}        Disable automatic recovery during monitoring
`);
}

function formatTimeBadge(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatMethodBadge(method) {
  const m = String(method || 'GET').toUpperCase();
  const padded = m.padEnd(6, ' ');
  if (m === 'GET' || m === 'HEAD') return colors.bold(colors.cyan(padded));
  if (m === 'POST') return colors.bold(colors.green(padded));
  if (m === 'PUT' || m === 'PATCH') return colors.bold(colors.yellow(padded));
  if (m === 'DELETE') return colors.bold(colors.red(padded));
  if (m === 'WS') return colors.bold(colors.magenta(padded));
  return colors.bold(colors.white(padded));
}

function formatStatusBadge(code) {
  const c = Number(code) || 0;
  const text = String(c || 'ERR');
  if (c >= 200 && c < 300) return colors.bold(colors.green(text));
  if (c >= 300 && c < 400) return colors.bold(colors.cyan(text));
  if (c >= 400 && c < 500) return colors.bold(colors.yellow(text));
  return colors.bold(colors.red(text));
}

function formatApiTypeBadge(entry) {
  const type = entry.apiType || (entry.graphqlOperation || /\/graphql\b|\/gql\b/i.test(entry.path || '') ? 'GraphQL' : (entry.method === 'WS' ? 'WS' : 'REST'));
  if (type === 'GraphQL') {
    return colors.bold(colors.magenta('[GraphQL]'));
  }
  if (type === 'WS') {
    return colors.bold(colors.yellow('[WS]     '));
  }
  return colors.bold(colors.blue('[REST]   '));
}

function printApiRequestStart(entry) {
  const time = colors.dim(`[${formatTimeBadge(entry.timestamp)}]`);
  const apiType = formatApiTypeBadge(entry);
  const method = formatMethodBadge(entry.method);
  const pathText = colors.white(entry.path || '/');
  const gqlTag = entry.graphqlOperation
    ? ` ${colors.magenta(`• ${entry.graphqlOperation}`)}`
    : '';
  console.log(`  ${time} ${apiType} ${method} ${pathText}${gqlTag} ${colors.yellow('⏳ RUNNING...')}`);
}

function printApiLogEntry(entry) {
  const time = colors.dim(`[${formatTimeBadge(entry.timestamp)}]`);
  const apiType = formatApiTypeBadge(entry);
  const method = formatMethodBadge(entry.method);
  const pathText = colors.white(entry.path || '/');
  const gqlTag = entry.graphqlOperation
    ? ` ${colors.magenta(`• ${entry.graphqlOperation}`)}`
    : '';
  const status = formatStatusBadge(entry.statusCode);
  const icon = (entry.statusCode >= 200 && entry.statusCode < 400) ? symbols.check : symbols.cross;
  const latency = colors.dim(`${entry.durationMs}ms`);
  const errNote = entry.error ? ` ${colors.red(`— ${entry.error}`)}` : '';
  console.log(`  ${time} ${apiType} ${method} ${pathText}${gqlTag} ${icon} ${status} ${latency}${errNote}`);
}

function formatBackendLabel(b) {
  const parts = [];
  if (b.framework) {
    parts.push(`${b.framework}`);
  } else if (b.runtime) {
    parts.push(`${b.runtime} HTTP server`);
  } else {
    parts.push('HTTP server');
  }
  if (b.process) {
    parts.push(`(${b.process}${b.pid ? `, PID ${b.pid}` : ''})`);
  }
  return parts.join(' ');
}

async function resolveBackendSelection({ opts, saved, cwd = process.cwd(), prompt = askLine }) {
  const detection = await detectBackends({ cwd });
  const { backends, hints } = detection;

  // 1. Explicit --port flag
  if (opts.port !== null) {
    if (!isValidPort(opts.port)) {
      throw new Error(`Invalid --port value. Expected a TCP port between 1 and 65535.`);
    }
    const match = backends.find(b => b.port === opts.port);
    if (match) {
      return {
        port: match.port,
        framework: match.framework || null,
        runtime: match.runtime || null,
        process: match.process || null,
        reachable: true,
        statusCode: match.statusCode,
        source: 'flag'
      };
    }
    const probe = await probeHttp({ port: opts.port, path: '/', timeoutMs: 1800 });
    const fw = labelFramework({ port: opts.port, runtime: null }, hints);
    return {
      port: opts.port,
      framework: fw.framework || null,
      runtime: null,
      process: null,
      reachable: probe.reachable,
      statusCode: probe.statusCode || null,
      source: 'flag'
    };
  }

  // 2. Saved port preference when still valid & running
  if (saved && isValidPort(saved.port) && !RESERVED_PORTS[saved.port]) {
    const match = backends.find(b => b.port === saved.port);
    if (match) {
      return {
        port: match.port,
        framework: match.framework || saved.framework || null,
        runtime: match.runtime || null,
        process: match.process || null,
        reachable: true,
        statusCode: match.statusCode,
        source: 'saved'
      };
    }
    const probe = await probeHttp({ port: saved.port, path: '/', timeoutMs: 1500 });
    if (probe.reachable) {
      return {
        port: saved.port,
        framework: saved.framework || null,
        runtime: null,
        process: null,
        reachable: true,
        statusCode: probe.statusCode || null,
        source: 'saved'
      };
    }
  }

  // 3. Exactly one running backend detected -> select automatically
  if (backends.length === 1) {
    const b = backends[0];
    return {
      port: b.port,
      framework: b.framework || null,
      runtime: b.runtime || null,
      process: b.process || null,
      reachable: true,
      statusCode: b.statusCode,
      source: 'auto'
    };
  }

  // 4. Multiple running backends detected -> interactive selector
  if (backends.length > 1) {
    console.log(`  ${symbols.info} ${colors.bold('Multiple local backend servers detected:')}\n`);
    backends.forEach((b, idx) => {
      const tag = b.configured ? colors.green(' [project config]') : '';
      console.log(`    ${colors.cyan(`[${idx + 1}]`)} ${colors.bold(`:${b.port}`)} — ${formatBackendLabel(b)}${tag}`);
    });
    console.log(`    ${colors.cyan(`[${backends.length + 1}]`)} Enter a custom port\n`);

    const ans = await prompt(`  Select backend [1-${backends.length + 1}] (default: 1): `);
    const choice = parseInt(ans || '1', 10);
    if (choice >= 1 && choice <= backends.length) {
      const picked = backends[choice - 1];
      return {
        port: picked.port,
        framework: picked.framework || null,
        runtime: picked.runtime || null,
        process: picked.process || null,
        reachable: true,
        statusCode: picked.statusCode,
        source: 'selected'
      };
    }
  } else {
    // 5. None detected -> explain that backend must be running & ask for port
    console.log(`  ${symbols.warn} ${colors.yellow('No active local backend server was detected.')}`);
    console.log(`  ${colors.dim('Make sure your backend server (e.g. php artisan serve, npm run dev, uvicorn, etc.) is running on your PC,')}`);
    console.log(`  ${colors.dim('or run "devmode api start" inside your backend folder to start the server & bridge together.')}`);
    if (saved && isValidPort(saved.port)) {
      console.log(`  ${colors.dim(`Previously saved port :${saved.port} is not currently responding.`)}\n`);
    } else {
      console.log('');
    }
  }

  const defaultPort = (saved && isValidPort(saved.port))
    ? saved.port
    : (hints[0] && hints[0].configuredPorts[0]) || 8000;

  if (!process.stdin.isTTY) {
    const probe = await probeHttp({ port: defaultPort, path: '/', timeoutMs: 1200 });
    return {
      port: defaultPort,
      framework: (saved && saved.framework) || (hints[0] && hints[0].framework) || null,
      runtime: null,
      process: null,
      reachable: probe.reachable,
      statusCode: probe.statusCode || null,
      source: 'default'
    };
  }

  while (true) {
    const raw = await prompt(`  Enter local backend port (default: ${defaultPort}): `);
    const port = raw ? parseInt(raw, 10) : defaultPort;
    if (!isValidPort(port)) {
      console.log(`  ${symbols.cross} ${colors.red('Please enter a valid TCP port between 1 and 65535.')}`);
      continue;
    }
    if (RESERVED_PORTS[port]) {
      console.log(`  ${symbols.warn} ${colors.yellow(`Port ${port} is reserved for ${RESERVED_PORTS[port]}.`)}`);
      const confirm = await prompt(`  Use port ${port} anyway? [y/N]: `);
      if (confirm.toLowerCase() !== 'y') continue;
    }
    const probe = await probeHttp({ port, path: '/', timeoutMs: 1500 });
    const fw = labelFramework({ port, runtime: null }, hints);
    return {
      port,
      framework: fw.framework || (saved && saved.port === port ? saved.framework : null) || null,
      runtime: null,
      process: null,
      reachable: probe.reachable,
      statusCode: probe.statusCode || null,
      source: 'prompt'
    };
  }
}

async function resolveDeviceSelection({ opts, saved, adb = { exec: execAdbAsync }, prompt = askLine }) {
  const res = await adb.exec(['devices', '-l'], null, 6000);
  if (res.status !== 0) {
    return { state: 'adb-down', target: null, device: null };
  }
  const devices = parseDeviceList(res.stdout);
  const authorized = devices.filter(d => d.state === 'device');
  for (const d of authorized) {
    d.stableId = await readStableId(adb, d);
  }

  // 1. Explicit --device flag
  if (opts.device) {
    const target = { serial: opts.device, stableId: opts.device };
    const matched = authorized.filter(d => matchesTarget(d, target));
    if (matched.length > 0) {
      const picked = pickTransport(matched, opts.device);
      return {
        state: 'connected',
        device: picked,
        target: { serial: picked.serial, stableId: picked.stableId || null, model: picked.model }
      };
    }
    const unauth = devices.find(d => d.state === 'unauthorized' && matchesTarget(d, target));
    if (unauth) {
      return { state: 'unauthorized', device: unauth, target };
    }
    return { state: 'disconnected', device: null, target };
  }

  // 2. Saved preferred device when connected
  if (saved && (saved.preferredDevice || saved.preferredDeviceId)) {
    const prefTarget = {
      serial: saved.preferredDevice || null,
      stableId: saved.preferredDeviceId || null,
      model: saved.preferredDeviceModel || null
    };
    const matched = authorized.filter(d => matchesTarget(d, prefTarget));
    if (matched.length > 0) {
      const picked = pickTransport(matched, saved.preferredDevice);
      return {
        state: 'connected',
        device: picked,
        target: { serial: picked.serial, stableId: picked.stableId || null, model: picked.model },
        restoredFromSaved: true
      };
    }
  }

  // 3. Group physical authorized devices
  const groups = groupPhysicalDevices(authorized);
  if (groups.length === 1) {
    const picked = pickTransport(groups[0]);
    return {
      state: 'connected',
      device: picked,
      target: { serial: picked.serial, stableId: picked.stableId || null, model: picked.model }
    };
  }

  if (groups.length > 1) {
    console.log(`  ${symbols.info} ${colors.bold('Multiple Android devices connected:')}\n`);
    const choices = groups.map(g => pickTransport(g));
    choices.forEach((d, idx) => {
      const conn = d.isWifi ? 'Wi-Fi ADB' : 'USB';
      console.log(`    ${colors.cyan(`[${idx + 1}]`)} ${colors.bold(d.model || d.serial)} ${colors.dim(`(${d.serial} • ${conn})`)}`);
    });
    console.log('');
    const ans = await prompt(`  Select Android device [1-${choices.length}] (default: 1): `);
    const idx = parseInt(ans || '1', 10);
    const chosen = choices[(idx >= 1 && idx <= choices.length) ? idx - 1 : 0];
    return {
      state: 'connected',
      device: chosen,
      target: { serial: chosen.serial, stableId: chosen.stableId || null, model: chosen.model }
    };
  }

  // 4. No authorized device currently attached
  const unauth = devices.find(d => d.state === 'unauthorized');
  const fallbackTarget = (saved && (saved.preferredDevice || saved.preferredDeviceId))
    ? {
        serial: saved.preferredDevice || null,
        stableId: saved.preferredDeviceId || null,
        model: saved.preferredDeviceModel || null
      }
    : null;

  if (unauth) {
    return { state: 'unauthorized', device: unauth, target: fallbackTarget };
  }
  return { state: 'disconnected', device: null, target: fallbackTarget };
}

async function resolvePortConflictIfNeeded({ hostPort, devicePort, device, store, adb = { exec: execAdbAsync }, prompt = askLine }) {
  if (!device) return { devicePort };
  const listRes = await adb.exec(['reverse', '--list'], device.serial, 6000);
  if (listRes.status !== 0) return { devicePort };

  const mappings = parseReverseList(listRes.stdout);
  const key = device.stableId || device.serial;
  const record = (store.get().owned || {})[ownershipKey(key, devicePort)] || null;
  const devices = [{ ...device, state: 'device' }];
  const check = classifyMapping({ mappings, devicePort, hostPort, record, devices });

  if (check.state !== 'conflict') {
    return { devicePort, check };
  }

  // If the existing mapping on `tcp:<devicePort>` was created by our own previous API Bridge session
  // (e.g., pointing to a previous Live Logs inspector proxy port or previous backend port we owned),
  // seamlessly rebind it to `tcp:<hostPort>` instead of flagging a false port conflict.
  const prevTargetPort = record ? (record.forwardHostPort || record.hostPort) : null;
  const ownedPrev = prevTargetPort && isOwnershipValid(record, {
    devicePort,
    hostPort: prevTargetPort,
    devices,
    existing: check.existing
  });
  const matchesRecordedProxy = record &&
    record.devicePort === devicePort &&
    check.existing &&
    (check.existing.local === `tcp:${record.forwardHostPort}` || check.existing.local === `tcp:${record.hostPort}`);

  if (ownedPrev || matchesRecordedProxy) {
    await adb.exec(['reverse', `tcp:${devicePort}`, `tcp:${hostPort}`], device.serial, 6000);
    return { devicePort, check: { state: 'active', owned: true } };
  }

  const altPort = findAlternativeDevicePort(mappings, devicePort);
  console.log(`  ${symbols.warn} ${colors.bold(colors.yellow(`Port conflict detected on device port tcp:${devicePort}`))}`);
  console.log(`  ${colors.dim(`Device tcp:${devicePort} is already mapped to host ${check.existing.local} (created outside this bridge).`)}`);
  console.log(`  ${colors.dim('To protect existing tools, the API Bridge will NOT overwrite this mapping.')}\n`);

  if (!process.stdin.isTTY || !altPort) {
    return { devicePort, check, conflictAborted: true, suggestedPort: altPort };
  }

  console.log(`  ${colors.cyan('[1]')} Use safe alternative device port ${colors.bold(`tcp:${altPort}`)} -> host ${colors.bold(`tcp:${hostPort}`)}`);
  console.log(`  ${colors.cyan('[2]')} Keep ${colors.bold(`tcp:${devicePort}`)} and wait / cancel without overwriting\n`);
  const ans = await prompt('  Select option [1-2] (default: 1): ');
  if ((ans || '1') === '1') {
    return { devicePort: altPort, switchedFrom: devicePort };
  }
  return { devicePort, check, conflictAborted: true, suggestedPort: altPort };
}

function renderStatusSummary({
  backend,
  snap,
  saved = {},
  restPath = null,
  graphqlPath = null,
  showBanner = true,
  title = 'DevMode CLI — Smart API Bridge'
}) {
  printBridgeHeader({ showBanner, title });

  // Backend section
  console.log(`  ${colors.bold('Backend')}`);
  const fwName = (backend && backend.framework) || saved.framework || null;
  if (fwName) {
    console.log(`  ${symbols.check} ${fwName} detected`);
  } else if (backend && backend.runtime) {
    console.log(`  ${symbols.check} ${backend.runtime} server detected`);
  } else {
    console.log(`  ${symbols.info} HTTP backend configured`);
  }

  const backendUp = snap.backend === 'listening' || snap.backend === 'up' || (backend && backend.reachable);
  if (backendUp) {
    console.log(`  ${symbols.check} Local server running :${snap.hostPort}`);
  } else {
    console.log(`  ${symbols.warn} ${colors.yellow(`Local server not responding on :${snap.hostPort} (start your backend server)`)}`);
  }
  console.log('');

  // Android Device section
  console.log(`  ${colors.bold('Android Device')}`);
  if (snap.device === 'connected') {
    const label = snap.model && snap.model !== 'Unknown' ? `${snap.model} (${snap.serial})` : snap.serial;
    console.log(`  ${symbols.check} ${label} connected`);
    console.log(`  ${symbols.check} ADB authorized`);
  } else if (snap.device === 'unauthorized') {
    console.log(`  ${symbols.warn} ${colors.yellow(`Device connected${snap.serial ? ` (${snap.serial})` : ''} — ADB unauthorized`)}`);
    console.log(`  ${colors.dim('  Unlock your phone and tap "Always allow from this computer".')}`);
  } else if (snap.device === 'adb-down') {
    console.log(`  ${symbols.warn} ${colors.yellow('ADB server unavailable — waiting for ADB...')}`);
  } else {
    const savedLabel = saved.preferredDeviceModel || saved.preferredDevice;
    console.log(`  ${symbols.warn} ${colors.yellow('No authorized Android device connected')}`);
    if (savedLabel) {
      console.log(`  ${colors.dim(`  Preferred device: ${savedLabel} (waiting for connection...)`)}`);
    }
  }
  console.log('');

  // API Bridge section
  console.log(`  ${colors.bold('API Bridge')}`);
  if (snap.bridge === 'active') {
    const mapText = snap.devicePort === snap.hostPort
      ? `tcp:${snap.devicePort} -> tcp:${snap.hostPort}`
      : `device tcp:${snap.devicePort} -> host tcp:${snap.hostPort}`;
    if (snap.owned) {
      console.log(`  ${symbols.check} Reverse mapping established (${mapText})`);
    } else {
      console.log(`  ${symbols.check} Compatible reverse mapping active (${mapText}, reused without claiming ownership)`);
    }
    console.log(`  ${symbols.check} Connection verified`);
  } else if (snap.bridge === 'conflict') {
    const existingLocal = snap.conflict ? snap.conflict.local : 'another port';
    console.log(`  ${symbols.cross} ${colors.red(`Port conflict: device tcp:${snap.devicePort} is already mapped to ${existingLocal}`)}`);
    console.log(`  ${colors.dim(`  Existing mapping preserved. Run with --device-port <port> to use an alternative port.`)}`);
  } else if (snap.bridge === 'locked') {
    console.log(`  ${symbols.warn} ${colors.yellow(`Another DevMode CLI process (PID ${snap.lockHolder}) is managing this device's bridge`)}`);
  } else if (snap.bridge === 'paused') {
    console.log(`  ${symbols.info} ${colors.yellow('Bridge disconnected (press [r] to reconnect)')}`);
  } else if (snap.bridge === 'failed') {
    console.log(`  ${symbols.cross} ${colors.red(`Reverse mapping failed: ${snap.error || 'unknown error'}`)}`);
  } else {
    console.log(`  ${symbols.warn} ${colors.yellow('Waiting to establish reverse mapping...')}`);
  }

  if (snap.autoReconnect) {
    console.log(`  ${symbols.check} Auto-reconnect enabled`);
  } else {
    console.log(`  ${symbols.info} Auto-reconnect disabled`);
  }
  if (snap.liveLogging) {
    console.log(`  ${symbols.check} Live API Request Logs: ${colors.green('ON')} ${colors.dim('(press [l] to toggle)')}`);
  } else {
    console.log(`  ${symbols.info} Live API Request Logs: ${colors.dim('OFF (press [l] to stream live requests)')}`);
  }
  console.log('');

  // Android API URL section
  const baseUrl = `http://127.0.0.1:${snap.devicePort}`;
  console.log(`  ${colors.bold('Android API URL:')}`);
  console.log(`  ${colors.bold(colors.green(baseUrl))}\n`);

  const restDisplay = restPath
    ? `${baseUrl}${restPath.startsWith('/') ? restPath : '/' + restPath}`
    : `${baseUrl}/api ${colors.dim('(example)')}`;
  const graphqlDisplay = graphqlPath
    ? `${baseUrl}${graphqlPath.startsWith('/') ? graphqlPath : '/' + graphqlPath}`
    : colors.dim(`Configure your actual GraphQL path (e.g. ${baseUrl}/graphql)`);

  console.log(`  ${colors.bold('REST:')}    ${restDisplay}`);
  console.log(`  ${colors.bold('GraphQL:')} ${graphqlDisplay}\n`);

  if (snap.bridge === 'active') {
    printCheerMessage('api-bridge-ready');
  }
}

function printInteractiveCommands({ liveLogs = false, hasManagedBackend = false, showServerOutput = false } = {}) {
  console.log(`  ${colors.dim('Watching for connection changes...')}\n`);
  console.log(`  ${colors.bold('Commands:')}`);
  const logBadge = liveLogs ? colors.green('ON') : colors.dim('OFF');
  console.log(`  ${colors.cyan('[l]')} Toggle Live API Request Logs (${logBadge})`);
  if (hasManagedBackend) {
    const outBadge = showServerOutput ? colors.green('ON') : colors.dim('OFF');
    console.log(`  ${colors.cyan('[o]')} Toggle Backend Server Output (${outBadge})`);
    console.log(`  ${colors.cyan('[b]')} Restart Backend Server`);
  }
  console.log(`  ${colors.cyan('[s]')} Show status`);
  console.log(`  ${colors.cyan('[r]')} Reconnect`);
  console.log(`  ${colors.cyan('[t]')} Test API endpoints & bridge (live progress)`);
  console.log(`  ${colors.cyan('[c]')} Clear screen`);
  console.log(`  ${colors.cyan('[d]')} Disconnect bridge`);
  console.log(`  ${colors.cyan('[q / Ctrl+C]')} Quit\n`);
}

function printTestReport(report, snap) {
  console.log(`\n  ${colors.bold('API Bridge Connectivity Check')}`);
  console.log(`  ${colors.gray('─────────────────────────────')}`);

  // 1. Local backend
  if (report.backend && report.backend.reachable) {
    const code = report.backend.statusCode;
    console.log(`  ${symbols.check} Local backend (:${snap.hostPort}${report.path}): HTTP ${code} — ${describeHttpStatus(code)}`);
  } else {
    const err = (report.backend && report.backend.error) || 'unreachable';
    console.log(`  ${symbols.cross} ${colors.red(`Local backend (:${snap.hostPort}) is unavailable (${err})`)}`);
  }

  // 2. Device state
  if (report.device === 'connected') {
    console.log(`  ${symbols.check} Android device: connected & authorized (${snap.serial})`);
  } else if (report.device === 'unauthorized') {
    console.log(`  ${symbols.cross} ${colors.yellow('Android device: connected but UNAUTHORIZED (allow USB/Wireless debugging on phone)')}`);
  } else if (report.device === 'adb-down') {
    console.log(`  ${symbols.cross} ${colors.red('ADB server is not responding')}`);
  } else {
    console.log(`  ${symbols.cross} ${colors.red('Android device: disconnected')}`);
  }

  // 3. Reverse mapping
  if (report.mapping === 'active') {
    const tag = report.mappingOwned ? 'owned by API Bridge' : 'pre-existing, reused safely';
    console.log(`  ${symbols.check} ADB reverse mapping: active (tcp:${snap.devicePort} -> tcp:${snap.hostPort}, ${tag})`);
  } else if (report.mapping === 'conflict') {
    const local = report.conflict ? report.conflict.local : 'another port';
    console.log(`  ${symbols.cross} ${colors.red(`ADB reverse mapping conflict: tcp:${snap.devicePort} -> ${local}`)}`);
  } else if (report.device === 'connected') {
    console.log(`  ${symbols.cross} ${colors.yellow(`ADB reverse mapping missing for tcp:${snap.devicePort}`)}`);
  }

  // 4. End-to-end probe from device
  if (report.deviceHttp) {
    if (report.deviceHttp.available && report.deviceHttp.reachable) {
      const code = report.deviceHttp.statusCode;
      console.log(`  ${symbols.check} Phone -> 127.0.0.1:${snap.devicePort}${report.path}: HTTP ${code} (${describeHttpStatus(code)})`);
      if (code >= 400) {
        console.log(`  ${colors.dim(`    Note: HTTP ${code} comes from your backend server — the ADB bridge itself is working.`)}`);
      }
    } else if (report.deviceHttp.available && !report.deviceHttp.reachable) {
      console.log(`  ${symbols.cross} ${colors.red(`Phone -> 127.0.0.1:${snap.devicePort}${report.path}: connection failed (${report.deviceHttp.error || 'no response'})`)}`);
    } else {
      console.log(`  ${symbols.info} ${colors.dim(`On-device probe skipped: ${report.deviceHttp.reason}`)}`);
    }
  }
  console.log('');
}

function renderProgressBar(current, total, width = 16) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return `${colors.green('█'.repeat(filled))}${colors.gray('░'.repeat(empty))}`;
}

async function runEndpointProgressTest({
  session = null,
  hostPort = 8000,
  devicePort = null,
  customRoutes = [],
  serial = null,
  adb = { exec: execAdbAsync }
} = {}) {
  const hPort = session ? session.hostPort : hostPort;
  const dPort = isValidPort(devicePort) ? devicePort : (session ? session.devicePort : hPort);
  const targetSerial = serial || (session && session.state.serial) || null;

  // Gather default routes + custom routes
  const defaultRoutes = ['/', '/api', '/api/health', '/health', '/graphql'];
  const allRoutes = [...(customRoutes || []), ...defaultRoutes];
  const uniquePaths = Array.from(new Set(allRoutes.filter(p => typeof p === 'string' && p.startsWith('/'))));

  console.log(`\n  ${colors.bold('API Endpoint Live Progress Tester')}`);
  console.log(`  ${colors.gray('─────────────────────────────────────────────')}`);
  console.log(`  ${symbols.bullet} Target Local API:   ${colors.bold(colors.cyan(`http://127.0.0.1:${hPort}`))}`);
  if (targetSerial) {
    console.log(`  ${symbols.bullet} Connected Phone:    ${colors.bold(colors.green(targetSerial))} ${colors.dim(`(tcp:${dPort} -> tcp:${hPort})`)}`);
  }
  console.log(`  ${symbols.bullet} Endpoints to Test:  ${colors.bold(String(uniquePaths.length))} routes\n`);

  const results = [];
  const total = uniquePaths.length;
  let activeCount = 0;

  for (let i = 0; i < total; i++) {
    const routePath = uniquePaths[i];
    const isGraphql = /\/graphql\b|\/gql\b/i.test(routePath);
    const method = isGraphql ? 'POST' : 'GET';
    const apiType = isGraphql ? 'GraphQL' : 'REST';
    const body = isGraphql ? JSON.stringify({ query: '{ __typename }' }) : null;

    const percent = Math.round(((i + 1) / total) * 100);
    const progressText = `  [${renderProgressBar(i + 1, total)}] ${percent}% (${i + 1}/${total}) Testing ${method} ${routePath}...`;

    if (process.stdout.isTTY) {
      process.stdout.write(`\r${progressText}`);
    }

    const probeRes = await probeHttp({
      port: hPort,
      path: routePath,
      method,
      body,
      timeoutMs: 3500
    });

    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[2K');
    }

    const typeBadge = isGraphql ? colors.bold(colors.magenta('[GraphQL]')) : colors.bold(colors.blue('[REST]   '));
    const methodBadge = formatMethodBadge(method);
    const paddedPath = routePath.padEnd(20, ' ');

    let statusDisplay = '';
    let isLive = false;

    if (probeRes.reachable) {
      const code = probeRes.statusCode || 200;
      const desc = describeHttpStatus(code);
      const codeBadge = formatStatusBadge(code);
      const latency = colors.dim(`${probeRes.durationMs || 1}ms`);
      if (code < 400) {
        isLive = true;
        activeCount++;
        statusDisplay = `${symbols.check} HTTP ${codeBadge} ${latency} — ${colors.green('RUNNING (OK)')}`;
      } else if (code === 404) {
        statusDisplay = `${symbols.cross} HTTP ${codeBadge} ${latency} — ${colors.yellow('Route Not Found')}`;
      } else {
        isLive = true;
        activeCount++;
        statusDisplay = `${symbols.warn} HTTP ${codeBadge} ${latency} — ${colors.yellow(desc)}`;
      }
    } else {
      const err = probeRes.error || 'unreachable';
      statusDisplay = `${symbols.cross} ${colors.red(`DOWN (${err})`)}`;
    }

    console.log(`  ${typeBadge} ${methodBadge} ${colors.white(paddedPath)} ${statusDisplay}`);

    results.push({
      path: routePath,
      method,
      apiType,
      ...probeRes,
      isLive
    });
  }

  // Optional: verify phone accessibility if connected
  let deviceCheck = null;
  if (targetSerial && (session || adb)) {
    const testRoute = results.find(r => r.isLive && r.path !== '/')?.path || results.find(r => r.isLive)?.path || uniquePaths[0] || '/';
    console.log(`\n  ${colors.bold('Android Phone Bridge Verification:')}`);
    if (process.stdout.isTTY) {
      process.stdout.write(`\r  [${renderProgressBar(1, 1)}] Phone testing 127.0.0.1:${dPort}${testRoute}...`);
    }

    let devHttp = null;
    if (session && session._deviceHttpProbe) {
      devHttp = await session._deviceHttpProbe(targetSerial, testRoute);
    } else {
      const url = `http://127.0.0.1:${dPort}${testRoute}`;
      const curl = await adb.exec(['shell', `curl -s -o /dev/null -m 5 -w '%{http_code}' '${url}'`], targetSerial, 10000);
      const out = (curl.stdout || '').trim();
      if (/^\d{3}$/.test(out)) {
        const code = parseInt(out, 10);
        devHttp = { available: true, reachable: code > 0, statusCode: code };
      } else {
        devHttp = { available: false, reason: 'curl not available on device or request failed' };
      }
    }

    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[2K');
    }

    if (devHttp && devHttp.available && devHttp.reachable) {
      console.log(`  ${symbols.check} ${colors.green(`Phone successfully reached 127.0.0.1:${dPort}${testRoute} (HTTP ${devHttp.statusCode})`)}`);
      deviceCheck = true;
    } else if (devHttp && devHttp.available && !devHttp.reachable) {
      console.log(`  ${symbols.cross} ${colors.red(`Phone could not reach 127.0.0.1:${dPort}${testRoute} (${devHttp.error || 'connection failed'})`)}`);
      deviceCheck = false;
    } else if (devHttp) {
      console.log(`  ${symbols.info} ${colors.dim(`Phone probe info: ${devHttp.reason || 'skipped'}`)}`);
    }
  }

  // Summary
  console.log(`\n  ${colors.gray('─────────────────────────────────────────────')}`);
  if (activeCount > 0) {
    console.log(`  ${symbols.check} ${colors.bold(colors.green('API Endpoints Checked:'))} ${activeCount}/${total} responding on port ${hPort}.`);
    if (deviceCheck === true) {
      console.log(`  ${symbols.check} ${colors.green('Android Reverse Bridge verified: Phone can communicate with local API.')}`);
    }
  } else {
    console.log(`  ${symbols.cross} ${colors.bold(colors.red('No responding endpoints detected.'))}`);
    console.log(`  ${colors.dim(`Check that your backend server is running on :${hPort}, or start it with "devmode api start".`)}`);
  }
  console.log('');
  return results;
}

async function handleApiTest(rawArgs = []) {
  const opts = parseApiBridgeArgs(rawArgs);
  if (opts.action === 'help') {
    showApiBridgeHelp();
    return;
  }

  const store = createConfigStore();
  const saved = store.get();

  let hostPort = opts.port;
  if (!isValidPort(hostPort)) {
    if (isValidPort(saved.port)) {
      hostPort = saved.port;
    } else {
      const detection = await detectBackends({ cwd: process.cwd() });
      if (detection.backends.length > 0) {
        hostPort = detection.backends[0].port;
      } else {
        hostPort = 8000;
      }
    }
  }

  const devicePort = isValidPort(opts.devicePort) ? opts.devicePort : (isValidPort(saved.devicePort) ? saved.devicePort : hostPort);

  const adb = { exec: execAdbAsync };
  const devRes = await adb.exec(['devices', '-l'], null, 5000);
  let serial = null;
  if (devRes.status === 0) {
    const devs = parseDeviceList(devRes.stdout).filter(d => d.state === 'device');
    if (devs.length > 0) {
      serial = devs[0].serial;
    }
  }

  banner();

  let session = null;
  if (serial) {
    session = new ApiBridgeSession({
      hostPort,
      devicePort,
      target: { serial },
      autoReconnect: false,
      deps: { store, lock: null }
    });
    await session.inspect({ adopt: false });
  }

  const customRoutes = [...(opts.routes || [])];
  if (opts.restPath) customRoutes.push(opts.restPath);
  if (opts.graphqlPath) customRoutes.push(opts.graphqlPath);
  if (opts.healthPath) customRoutes.push(opts.healthPath);
  if (saved.healthPath) customRoutes.push(saved.healthPath);
  if (saved.restPath) customRoutes.push(saved.restPath);
  if (saved.graphqlPath) customRoutes.push(saved.graphqlPath);

  await runEndpointProgressTest({
    session,
    hostPort,
    devicePort,
    customRoutes,
    serial,
    adb
  });
}

async function runStatusSubcommand(opts, store) {
  const saved = store.get();
  const hostPort = isValidPort(opts.port) ? opts.port : (isValidPort(saved.port) ? saved.port : 8000);
  const devicePort = isValidPort(opts.devicePort) ? opts.devicePort : (isValidPort(saved.devicePort) ? saved.devicePort : hostPort);
  const target = opts.device
    ? { serial: opts.device, stableId: opts.device }
    : (saved.preferredDevice || saved.preferredDeviceId)
      ? { serial: saved.preferredDevice, stableId: saved.preferredDeviceId, model: saved.preferredDeviceModel }
      : null;

  const session = new ApiBridgeSession({
    hostPort,
    devicePort,
    target,
    autoReconnect: saved.autoReconnect !== false,
    healthPath: opts.healthPath || saved.healthPath || null,
    deps: { store, lock: null }
  });

  const snapInspect = await session.inspect({ adopt: false });
  const probe = await probeHttp({ port: hostPort, path: opts.healthPath || saved.healthPath || '/', timeoutMs: 1500 });

  printBridgeHeader({ showBanner: true });
  console.log(`  ${colors.bold('Saved Configuration')}`);
  if (saved.port) {
    console.log(`  ${symbols.bullet} Preferred Backend Port: :${saved.port}${saved.framework ? ` (${saved.framework})` : ''}`);
    console.log(`  ${symbols.bullet} Preferred Device:       ${saved.preferredDeviceModel ? `${saved.preferredDeviceModel} (${saved.preferredDevice})` : (saved.preferredDevice || 'Auto')}`);
    console.log(`  ${symbols.bullet} Auto-Reconnect:         ${saved.autoReconnect !== false ? 'enabled' : 'disabled'}`);
  } else {
    console.log(`  ${symbols.info} No saved API Bridge configuration yet.`);
  }
  console.log('');

  console.log(`  ${colors.bold('Live Status')}`);
  if (probe.reachable) {
    console.log(`  ${symbols.check} Local backend on :${hostPort} is responding (HTTP ${probe.statusCode})`);
  } else {
    console.log(`  ${symbols.warn} ${colors.yellow(`No HTTP response on local port :${hostPort}`)}`);
  }

  if (!snapInspect.adbOk) {
    console.log(`  ${symbols.cross} ${colors.red('ADB is unavailable')}\n`);
    return;
  }

  if (snapInspect.device.state === 'connected') {
    const dev = snapInspect.device.dev;
    console.log(`  ${symbols.check} Android device connected: ${dev.model || dev.serial} (${dev.serial})`);
    const m = snapInspect.mapping;
    if (m && m.state === 'active') {
      const ownText = m.owned ? 'owned by API Bridge' : 'created externally (preserved)';
      console.log(`  ${symbols.check} ADB reverse active: tcp:${devicePort} -> tcp:${hostPort} (${ownText})`);
    } else if (m && m.state === 'conflict') {
      console.log(`  ${symbols.cross} ${colors.red(`ADB reverse conflict: tcp:${devicePort} is mapped to ${m.existing.local}`)}`);
    } else {
      console.log(`  ${symbols.warn} ${colors.yellow(`ADB reverse mapping tcp:${devicePort} -> tcp:${hostPort} is NOT currently active`)}`);
      console.log(`  ${colors.dim('  (Note: Saved configuration does not mean an ADB mapping is currently active. Run "devmode api bridge" to restore.)')}`);
    }
  } else if (snapInspect.device.state === 'unauthorized') {
    console.log(`  ${symbols.warn} ${colors.yellow('Android device is connected but UNAUTHORIZED')}`);
  } else {
    console.log(`  ${symbols.warn} ${colors.yellow('No matching Android device currently connected')}`);
  }
  console.log('');
}

async function runStopSubcommand(opts, store, lock) {
  const saved = store.get();
  const hostPort = isValidPort(opts.port) ? opts.port : (isValidPort(saved.port) ? saved.port : 8000);
  const devicePort = isValidPort(opts.devicePort) ? opts.devicePort : (isValidPort(saved.devicePort) ? saved.devicePort : hostPort);
  const target = opts.device
    ? { serial: opts.device, stableId: opts.device }
    : (saved.preferredDevice || saved.preferredDeviceId)
      ? { serial: saved.preferredDevice, stableId: saved.preferredDeviceId, model: saved.preferredDeviceModel }
      : null;

  printBridgeHeader({ showBanner: true });
  const session = new ApiBridgeSession({
    hostPort,
    devicePort,
    target,
    deps: { store, lock }
  });

  try {
    const res = await session.disconnect();
    if (res.removed) {
      console.log(`  ${symbols.check} ${colors.green(`Removed API Bridge reverse mapping (tcp:${devicePort} -> tcp:${hostPort}).`)}`);
      console.log(`  ${colors.dim('Other reverse mappings (e.g. Metro :8081, DevMode Bridge :52882) were left untouched.')}\n`);
      printCheerMessage('api-bridge-stop');
    } else if (res.reason === 'not-owned') {
      console.log(`  ${symbols.warn} ${colors.yellow(`Mapping on tcp:${devicePort} (${res.existing ? res.existing.local : 'active'}) was not created by this API Bridge session.`)}`);
      console.log(`  ${colors.dim('Preserving existing mapping to avoid breaking other tools.')}\n`);
    } else if (res.reason === 'missing') {
      console.log(`  ${symbols.info} No active reverse mapping on tcp:${devicePort}. API Bridge marked disabled.\n`);
      printCheerMessage('api-bridge-stop');
    } else if (res.reason === 'locked') {
      console.log(`  ${symbols.warn} ${colors.yellow(`Another DevMode CLI session is currently active for this device.`)}\n`);
    } else {
      console.log(`  ${symbols.info} Device not currently connected (${res.reason}). Saved ownership record cleared.\n`);
    }
  } finally {
    lock.releaseAll();
  }
}

// Helper to terminate a specific PID and its process tree
function killByPid(pid) {
  return new Promise((resolve) => {
    if (!pid || pid === process.pid) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('close', () => resolve());
      killer.on('error', () => {
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        resolve();
      });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        resolve();
      }, 300);
    }
  });
}

// Helper to terminate a spawned backend child process tree cleanly
function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || !child.pid) {
      return resolve();
    }
    if (process.platform === 'win32') {
      // Always run taskkill /T /F even if the shell wrapper already exited,
      // because child servers (e.g. `php -S 127.0.0.1:8000` spawned by `php artisan serve`)
      // may still be alive in the process tree.
      killByPid(child.pid).then(resolve);
    } else {
      if (child.exitCode !== null || child.killed) {
        return resolve();
      }
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, 400);
    }
  });
}

// Ensure a port that was started by `devmode api start` is actually released on exit/restart
async function freePortIfStillBound(port) {
  if (!isValidPort(port)) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    const stillBound = await checkTcp(port, 250);
    if (!stillBound) return;
    try {
      const listeners = await scanListeners();
      const matches = (listeners || []).filter(l => l.port === port && l.pid && l.pid !== process.pid);
      for (const m of matches) {
        await killByPid(m.pid);
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
}

async function waitUntilListening(port, child, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (child && child.exitCode !== null) {
      return false;
    }
    if (await checkTcp(port, 400)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 350));
  }
  return checkTcp(port, 500);
}

async function runInteractiveBridgeLoop({
  session,
  backend,
  store,
  restPath,
  graphqlPath,
  title = 'DevMode CLI — Smart API Bridge',
  managedBackend = null
}) {
  if (!process.stdin.isTTY) {
    if (session.liveLogging) await session.setLiveLogging(false);
    if (managedBackend) {
      try { await session.disconnectOwned({ clearSaved: false }); } catch (_) {}
    }
    session.stop();
    if (managedBackend && managedBackend.stop) await managedBackend.stop();
    return;
  }

  printInteractiveCommands({
    liveLogs: session.liveLogging,
    hasManagedBackend: !!managedBackend,
    showServerOutput: managedBackend ? managedBackend.showOutput : false
  });

  // Wire live API request stream (`[l]`)
  session.on('request-start', (entry) => {
    if (session.liveLogging) {
      printApiRequestStart(entry);
    }
  });

  session.on('request', (entry) => {
    if (session.liveLogging) {
      printApiLogEntry(entry);
    }
  });

  // Wire live state-change notifications (deduplicated inside ApiBridgeSession)
  session.on('device', (ev) => {
    if (ev.state === 'disconnected') {
      console.log(`  ${symbols.warn} ${colors.yellow('Android device disconnected')}`);
      console.log(`  ${colors.cyan('↻')} ${colors.dim('Waiting for reconnection...')}`);
    } else if (ev.state === 'unauthorized') {
      console.log(`  ${symbols.warn} ${colors.yellow('Android device is unauthorized — tap "Allow" on your phone screen')}`);
    } else if (ev.state === 'adb-down') {
      console.log(`  ${symbols.warn} ${colors.yellow('ADB server connection lost — waiting for ADB...')}`);
    } else if (ev.state === 'connected' && ev.reconnected) {
      console.log(`  ${symbols.check} ${colors.green('Android device reconnected')}`);
    }
  });

  session.on('bridge', (ev) => {
    if (ev.state === 'active' && ev.restored) {
      console.log(`  ${symbols.check} ${colors.green('API Bridge automatically restored')}`);
      console.log(`  ${symbols.check} ${colors.bold(colors.green('Ready for API testing'))}`);
    } else if (ev.state === 'conflict') {
      const local = ev.conflict ? ev.conflict.local : 'another port';
      console.log(`  ${symbols.cross} ${colors.red(`Port conflict on device tcp:${ev.devicePort} (mapped to ${local}) — existing mapping preserved`)}`);
    } else if (ev.state === 'locked') {
      console.log(`  ${symbols.warn} ${colors.yellow(`Another DevMode CLI process (PID ${ev.lockHolder}) owns this device's bridge session`)}`);
    } else if (ev.state === 'failed' && ev.exhausted) {
      console.log(`  ${symbols.cross} ${colors.red(`Could not restore reverse mapping after ${ev.attempt} attempts: ${ev.error || 'unknown error'}`)}`);
      console.log(`  ${colors.dim('  Press [r] to retry manually.')}`);
    }
  });

  session.on('backend', (ev) => {
    if (ev.previous === 'unknown') return;
    if (ev.state === 'down') {
      console.log(`  ${symbols.warn} ${colors.yellow(`Local backend on :${session.hostPort} stopped responding (ADB bridge kept intact)`)}`);
    } else if ((ev.state === 'listening' || ev.state === 'up') && ev.previous === 'down') {
      console.log(`  ${symbols.check} ${colors.green(`Local backend on :${session.hostPort} is available again`)}`);
    }
  });

  // Start continuous monitoring (event-driven `adb track-devices` + periodic verification)
  session.start({ watch: true });

  let busy = false;
  let shuttingDown = false;
  const cleanupAndExit = async (msg) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch (_) {}
    process.stdin.pause();

    // Always stop the live inspector proxy first so device tcp:<devicePort> is never left pointing
    // to a dead ephemeral proxy port (which would cause a port conflict on the next run).
    if (session.liveLogging && !session.paused) {
      try { await session.setLiveLogging(false); } catch (_) {}
    }

    // When `devmode api start` spawned the backend server and is now stopping it on exit,
    // also remove the owned ADB reverse rule so the port is 100% clean for the next run.
    if (managedBackend) {
      try { await session.disconnectOwned({ clearSaved: false }); } catch (_) {}
    }
    session.stop();

    if (managedBackend && managedBackend.stop) {
      await managedBackend.stop();
    }

    console.log(`\n  ${symbols.info} ${colors.dim(msg)}`);
    printCheerMessage('api-bridge-stop');
    process.exit(0);
  };

  const onSignalQuit = () => {
    cleanupAndExit(managedBackend
      ? 'Stopped backend server and API Bridge monitor.'
      : 'Monitoring stopped. Existing ADB reverse mapping left active.');
  };
  process.once('SIGINT', onSignalQuit);
  process.once('SIGTERM', onSignalQuit);
  process.once('SIGHUP', onSignalQuit);

  try {
    process.stdin.setRawMode(true);
  } catch (_) {}
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', async (key) => {
    const raw = String(key || '');
    const k = raw.toLowerCase();
    if (k === 'q' || raw.includes('\u0003')) {
      await cleanupAndExit(managedBackend
        ? 'Stopped backend server and exited All-in-One API Bridge.'
        : 'Exited Smart API Bridge monitor. Active reverse mapping preserved.');
      return;
    }
    if (busy) return;
    busy = true;
    try {
      if (k === 'l') {
        const nextState = !session.liveLogging;
        await session.setLiveLogging(nextState);
        if (nextState) {
          console.log(`\n  ${symbols.check} ${colors.bold(colors.green('Live API Request Logs: ON'))} ${colors.dim(`(streaming phone requests on :${session.devicePort} -> :${session.hostPort})`)}`);
          console.log(`  ${colors.dim('Trigger an API call from your Android app to see real-time requests below (press [l] to hide):')}\n`);
        } else {
          console.log(`\n  ${symbols.info} ${colors.yellow('Live API Request Logs: OFF')} ${colors.dim(`(direct bridge tcp:${session.devicePort} -> tcp:${session.hostPort} active)`)}\n`);
        }
      } else if (k === 'o' && managedBackend) {
        managedBackend.showOutput = !managedBackend.showOutput;
        const badge = managedBackend.showOutput ? colors.green('ON') : colors.yellow('OFF');
        console.log(`\n  ${symbols.info} Backend Server Output: ${badge}\n`);
      } else if (k === 'b' && managedBackend && managedBackend.restart) {
        console.log(`\n  ${symbols.arrow} Restarting backend server (${managedBackend.displayCommand})...`);
        await managedBackend.restart();
        await session._checkBackend();
      } else if (k === 'c') {
        console.clear();
        renderStatusSummary({
          backend,
          snap: session.getSnapshot(),
          saved: store.get(),
          restPath,
          graphqlPath,
          showBanner: true,
          title
        });
        printInteractiveCommands({
          liveLogs: session.liveLogging,
          hasManagedBackend: !!managedBackend,
          showServerOutput: managedBackend ? managedBackend.showOutput : false
        });
      } else if (k === 's') {
        renderStatusSummary({
          backend,
          snap: session.getSnapshot(),
          saved: store.get(),
          restPath,
          graphqlPath,
          showBanner: true,
          title
        });
        printInteractiveCommands({
          liveLogs: session.liveLogging,
          hasManagedBackend: !!managedBackend,
          showServerOutput: managedBackend ? managedBackend.showOutput : false
        });
      } else if (k === 'r') {
        console.log(`  ${symbols.arrow} Reconnecting API Bridge...`);
        const snap = await session.reconnectNow();
        if (snap.bridge === 'active') {
          console.log(`  ${symbols.check} ${colors.green(`API Bridge active (tcp:${snap.devicePort} -> tcp:${snap.hostPort})`)}\n`);
        } else {
          console.log(`  ${symbols.warn} ${colors.yellow(`Bridge state: ${snap.bridge} (device: ${snap.device})`)}\n`);
        }
      } else if (k === 't') {
        const candidateRoutes = [session.healthPath, restPath, graphqlPath].filter(Boolean);
        await runEndpointProgressTest({
          session,
          hostPort: session.hostPort,
          devicePort: session.devicePort,
          customRoutes: candidateRoutes,
          serial: session.state.serial
        });
      } else if (k === 'd') {
        const res = await session.disconnect();
        if (res.removed) {
          console.log(`  ${symbols.check} ${colors.yellow(`API Bridge disconnected (removed tcp:${session.devicePort}). Press [r] to reconnect.`)}\n`);
        } else if (res.reason === 'not-owned') {
          console.log(`  ${symbols.warn} ${colors.yellow('Mapping was not created by API Bridge — preserved safely.')}\n`);
        } else {
          console.log(`  ${symbols.info} ${colors.dim(`Bridge paused (${res.reason}). Press [r] to reconnect.`)}\n`);
        }
      }
    } finally {
      busy = false;
    }
  });
}

async function handleApiBridge(rawArgs = []) {
  const opts = parseApiBridgeArgs(rawArgs);
  if (opts.action === 'help') {
    showApiBridgeHelp();
    return;
  }

  if (opts.healthPath && !SAFE_HTTP_PATH.test(opts.healthPath)) {
    banner();
    console.log(`\n  ${symbols.cross} ${colors.red('Invalid --health-path. Must start with "/" and contain only URL path characters.')}\n`);
    return;
  }

  const store = createConfigStore();
  const lock = createLockManager();

  if (opts.action === 'status') {
    await runStatusSubcommand(opts, store);
    return;
  }

  if (opts.action === 'stop') {
    await runStopSubcommand(opts, store, lock);
    return;
  }

  banner();

  const saved = store.get();

  // Step 1 & 2: Detect / resolve backend port
  let backend;
  try {
    backend = await resolveBackendSelection({ opts, saved });
  } catch (err) {
    console.log(`\n  ${symbols.cross} ${colors.red(err.message || String(err))}\n`);
    return;
  }

  // Step 3 & 4: Detect / resolve Android device (restoring saved preference when valid)
  const devResolved = await resolveDeviceSelection({ opts, saved });

  const hostPort = backend.port;
  let devicePort = isValidPort(opts.devicePort) ? opts.devicePort : hostPort;

  // Step 5: Check existing reverse mappings for conflicts before starting
  if (devResolved.device) {
    const conflictRes = await resolvePortConflictIfNeeded({
      hostPort,
      devicePort,
      device: devResolved.device,
      store
    });
    devicePort = conflictRes.devicePort;
  }

  const autoReconnect = opts.autoReconnect !== null
    ? opts.autoReconnect
    : (saved.autoReconnect !== undefined ? saved.autoReconnect : true);
  const healthPath = opts.healthPath || saved.healthPath || null;
  const restPath = opts.restPath || saved.restPath || null;
  const graphqlPath = opts.graphqlPath || saved.graphqlPath || null;

  // Save selected preferences immediately (no credentials, tokens, or payloads)
  store.update({
    enabled: true,
    port: hostPort,
    devicePort,
    framework: backend.framework || saved.framework || null,
    preferredDevice: (devResolved.target && devResolved.target.serial) || saved.preferredDevice || null,
    preferredDeviceId: (devResolved.target && devResolved.target.stableId) || saved.preferredDeviceId || null,
    preferredDeviceModel: (devResolved.target && devResolved.target.model) || saved.preferredDeviceModel || null,
    autoReconnect,
    ...(healthPath ? { healthPath } : {}),
    ...(restPath ? { restPath } : {}),
    ...(graphqlPath ? { graphqlPath } : {})
  });

  const session = new ApiBridgeSession({
    hostPort,
    devicePort,
    target: devResolved.target,
    autoReconnect,
    healthPath,
    deps: { store, lock }
  });

  // One-shot `--reconnect`: establish/verify and exit without holding the terminal
  if (opts.action === 'reconnect') {
    await session.reconcile('manual');
    const snap = session.getSnapshot();
    renderStatusSummary({ backend, snap, saved: store.get(), restPath, graphqlPath, showBanner: false });
    session.stop();
    return;
  }

  if (opts.liveLogs === true) {
    await session.setLiveLogging(true);
  }

  // Initial reconcile & status render
  await session.reconcile('start');
  await session._checkBackend();

  renderStatusSummary({
    backend,
    snap: session.getSnapshot(),
    saved: store.get(),
    restPath,
    graphqlPath,
    showBanner: false
  });

  await runInteractiveBridgeLoop({
    session,
    backend,
    store,
    restPath,
    graphqlPath,
    title: 'DevMode CLI — Smart API Bridge',
    managedBackend: null
  });
}

// All-in-One command: `devmode api start`
// Automatically detects & starts the local backend server in the current directory (if not already running),
// configures the Smart API Bridge (`adb reverse`), enables Live API Request Logs, and watches for reconnections.
async function handleApiStart(rawArgs = []) {
  const opts = parseApiBridgeArgs(rawArgs);
  if (opts.action === 'help') {
    showApiBridgeHelp();
    return;
  }

  if (opts.healthPath && !SAFE_HTTP_PATH.test(opts.healthPath)) {
    banner();
    console.log(`\n  ${symbols.cross} ${colors.red('Invalid --health-path. Must start with "/" and contain only URL path characters.')}\n`);
    return;
  }

  const store = createConfigStore();
  const lock = createLockManager();
  const saved = store.get();

  banner();
  const title = 'DevMode CLI — All-in-One API Server + Smart Bridge';

  const preferredPort = isValidPort(opts.port) ? opts.port : null;
  let spec = detectBackendStartSpec(process.cwd(), preferredPort);

  if (opts.cmd) {
    const port = preferredPort || (spec && spec.port) || (isValidPort(saved.port) ? saved.port : 8000);
    spec = {
      framework: (spec && spec.framework) || saved.framework || 'Custom Backend',
      runtime: (spec && spec.runtime) || null,
      port,
      command: opts.cmd,
      args: [],
      useShellString: true,
      env: { PORT: String(port), SERVER_PORT: String(port) },
      displayCommand: opts.cmd
    };
  }

  let managedBackend = null;
  let backend = null;

  // Ensure Ctrl+C during backend startup or interactive prompts also cleans up the spawned server
  const onEarlySigint = async () => {
    if (managedBackend && managedBackend.stop) {
      try { await managedBackend.stop(); } catch (_) {}
    }
    console.log(`\n  ${symbols.info} ${colors.dim('Stopped backend server and cancelled startup.')}\n`);
    process.exit(0);
  };
  process.once('SIGINT', onEarlySigint);
  process.once('SIGTERM', onEarlySigint);

  if (spec) {
    const alreadyListening = await checkTcp(spec.port, 600);
    if (alreadyListening) {
      console.log(`  ${symbols.check} ${colors.green(`${spec.framework} server is already running on :${spec.port}`)} ${colors.dim('(attaching Smart API Bridge)')}\n`);
      const probe = await probeHttp({ port: spec.port, path: '/', timeoutMs: 1500 });
      backend = {
        port: spec.port,
        framework: spec.framework,
        runtime: spec.runtime,
        reachable: true,
        statusCode: probe.statusCode || 200,
        source: 'already-running'
      };
    } else {
      managedBackend = {
        spec,
        displayCommand: spec.displayCommand,
        showOutput: !!opts.showOutput,
        child: null,
        stopping: false,
        async start() {
          this.stopping = false;
          console.log(`  ${symbols.arrow} Starting ${colors.bold(spec.framework)} server: ${colors.cyan(spec.displayCommand)}`);
          const spawnOpts = {
            cwd: process.cwd(),
            env: { ...process.env, ...(spec.env || {}) },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          };
          let child;
          if (spec.useShellString) {
            child = spawn(spec.command, { ...spawnOpts, shell: true });
          } else if (process.platform === 'win32') {
            // Node 22+/24+ deprecates passing an args array with `shell: true` (DEP0190).
            // Build one properly quoted command string when spawning through the Windows shell.
            const quote = (a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));
            const cmdLine = [spec.command, ...(spec.args || [])].map(quote).join(' ');
            child = spawn(cmdLine, { ...spawnOpts, shell: true });
          } else {
            child = spawn(spec.command, spec.args || [], spawnOpts);
          }

          this.child = child;
          const printChunk = (chunk, isErr = false) => {
            if (!this.showOutput) return;
            const lines = String(chunk || '').split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
              let tag;
              if (/\/graphql\b|\/gql\b|\bgraphql\b/i.test(line)) {
                tag = colors.magenta('[server • GraphQL]');
              } else if (/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+\/|\s\/api\/|\s\/[A-Za-z0-9/_-]+\s+[~.]/i.test(line)) {
                tag = colors.blue('[server • REST]   ');
              } else {
                tag = isErr ? colors.yellow('[server]') : colors.dim('[server]');
              }
              console.log(`  ${tag} ${line}`);
            }
          };
          if (child.stdout) child.stdout.on('data', (d) => printChunk(d, false));
          if (child.stderr) child.stderr.on('data', (d) => printChunk(d, true));
          child.on('exit', (code) => {
            if (!this.stopping && code !== null && code !== 0) {
              console.log(`  ${symbols.warn} ${colors.yellow(`Backend server process exited (code ${code}). Press [b] to restart or [o] to inspect server output.`)}`);
            }
          });

          const ready = await waitUntilListening(spec.port, child, 10000);
          if (ready) {
            console.log(`  ${symbols.check} ${colors.green(`${spec.framework} server is listening on :${spec.port}`)}\n`);
          } else {
            console.log(`  ${symbols.warn} ${colors.yellow(`Waiting for ${spec.framework} server on :${spec.port} (press [o] to view server console output)...`)}\n`);
          }
          return ready;
        },
        async stop() {
          this.stopping = true;
          if (this.child) {
            const c = this.child;
            this.child = null;
            await killProcessTree(c);
          }
          await freePortIfStillBound(spec.port);
        },
        async restart() {
          await this.stop();
          return this.start();
        }
      };

      const ready = await managedBackend.start();
      backend = {
        port: spec.port,
        framework: spec.framework,
        runtime: spec.runtime,
        reachable: ready,
        statusCode: 200,
        source: 'spawned'
      };
    }
  } else {
    // No backend project detected in current directory — fall back to active listener detection / prompt
    console.log(`  ${symbols.info} ${colors.dim('No backend project files found in current folder — scanning active local servers...')}`);
    try {
      backend = await resolveBackendSelection({ opts, saved });
    } catch (err) {
      process.removeListener('SIGINT', onEarlySigint);
      process.removeListener('SIGTERM', onEarlySigint);
      console.log(`\n  ${symbols.cross} ${colors.red(err.message || String(err))}\n`);
      return;
    }
  }

  const devResolved = await resolveDeviceSelection({ opts, saved });
  const hostPort = backend.port;
  let devicePort = isValidPort(opts.devicePort) ? opts.devicePort : hostPort;

  if (devResolved.device) {
    const conflictRes = await resolvePortConflictIfNeeded({
      hostPort,
      devicePort,
      device: devResolved.device,
      store
    });
    devicePort = conflictRes.devicePort;
  }

  const autoReconnect = opts.autoReconnect !== null
    ? opts.autoReconnect
    : (saved.autoReconnect !== undefined ? saved.autoReconnect : true);
  const healthPath = opts.healthPath || saved.healthPath || null;
  const restPath = opts.restPath || saved.restPath || null;
  const graphqlPath = opts.graphqlPath || saved.graphqlPath || null;

  store.update({
    enabled: true,
    port: hostPort,
    devicePort,
    framework: backend.framework || saved.framework || null,
    preferredDevice: (devResolved.target && devResolved.target.serial) || saved.preferredDevice || null,
    preferredDeviceId: (devResolved.target && devResolved.target.stableId) || saved.preferredDeviceId || null,
    preferredDeviceModel: (devResolved.target && devResolved.target.model) || saved.preferredDeviceModel || null,
    autoReconnect,
    ...(healthPath ? { healthPath } : {}),
    ...(restPath ? { restPath } : {}),
    ...(graphqlPath ? { graphqlPath } : {})
  });

  const session = new ApiBridgeSession({
    hostPort,
    devicePort,
    target: devResolved.target,
    autoReconnect,
    healthPath,
    deps: { store, lock }
  });

  // In `devmode api start`, enable Live API Request Logs by default unless `--no-logs` was passed
  const enableLiveLogs = opts.liveLogs !== null ? opts.liveLogs : true;
  if (enableLiveLogs) {
    await session.setLiveLogging(true);
  }

  await session.reconcile('start');
  await session._checkBackend();

  renderStatusSummary({
    backend,
    snap: session.getSnapshot(),
    saved: store.get(),
    restPath,
    graphqlPath,
    showBanner: false,
    title
  });

  process.removeListener('SIGINT', onEarlySigint);
  process.removeListener('SIGTERM', onEarlySigint);

  await runInteractiveBridgeLoop({
    session,
    backend,
    store,
    restPath,
    graphqlPath,
    title,
    managedBackend
  });
}

module.exports = {
  parseApiBridgeArgs,
  handleApiBridge,
  handleApiStart,
  handleApiTest,
  showApiBridgeHelp,
  printApiLogEntry,
  printApiRequestStart,
  runEndpointProgressTest
};
