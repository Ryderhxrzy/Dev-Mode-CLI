// lib/bluetooth.js - Android Bluetooth Connection Duration & Media (Now Playing) Inspector

const readline = require('readline');
const { colors, symbols, banner, printCheerMessage } = require('./ui');
const { execAdb, execAdbAsync } = require('./adb');
const { loadConfig, saveConfig } = require('./config');

const KNOWN_MEDIA_APPS = {
  'com.spotify.music': 'Spotify',
  'com.spotify.lite': 'Spotify Lite',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.youtube': 'YouTube',
  'com.apple.android.music': 'Apple Music',
  'com.amazon.mp3': 'Amazon Music',
  'deezer.android.app': 'Deezer',
  'com.soundcloud.android': 'SoundCloud',
  'com.aspiro.tidal': 'TIDAL',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.ss.android.ugc.trill': 'TikTok',
  'com.facebook.katana': 'Facebook',
  'com.instagram.android': 'Instagram',
  'org.videolan.vlc': 'VLC',
  'com.maxmpz.audioplayer': 'Poweramp',
  'in.krosbits.musicolet': 'Musicolet',
  'com.miui.player': 'Mi Music',
  'com.sec.android.app.music': 'Samsung Music',
  'com.netflix.mediaclient': 'Netflix'
};

const PLAYBACK_STATES = {
  0: 'NONE',
  1: 'STOPPED',
  2: 'PAUSED',
  3: 'PLAYING',
  4: 'FAST_FORWARDING',
  5: 'REWINDING',
  6: 'BUFFERING',
  7: 'ERROR',
  8: 'CONNECTING',
  9: 'SKIPPING_TO_PREVIOUS',
  10: 'SKIPPING_TO_NEXT',
  11: 'SKIPPING_TO_QUEUE_ITEM'
};

function formatAppName(pkg) {
  if (!pkg) return 'Unknown App';
  if (KNOWN_MEDIA_APPS[pkg]) return `${KNOWN_MEDIA_APPS[pkg]} (${pkg})`;
  const parts = String(pkg).split('.');
  let last = parts[parts.length - 1] || pkg;
  if ((last === 'music' || last === 'player' || last === 'android' || last === 'app') && parts.length >= 2) {
    last = parts[parts.length - 2];
  }
  const clean = last
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${clean} (${pkg})`;
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return 'Just connected';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (days > 0) {
    return `${days}d ${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
  }
  if (hours > 0) {
    return `${hours}h ${pad(mins)}m ${pad(secs)}s`;
  }
  if (mins > 0) {
    return `${mins}m ${pad(secs)}s`;
  }
  return `${secs}s`;
}

function formatClockTime(epochMs) {
  if (!epochMs || !isFinite(epochMs)) return null;
  const d = new Date(epochMs);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Parse an Android dumpsys timestamp `MM-dd HH:mm:ss.SSS` or `YYYY-MM-DD HH:mm:ss` into epoch ms
function parseDumpsysTimestamp(tsStr, referenceNowMs = Date.now()) {
  if (!tsStr) return null;
  const ref = new Date(referenceNowMs);
  const fullMatch = String(tsStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (fullMatch) {
    const [, y, mo, d, h, mi, s, ms] = fullMatch;
    const dt = new Date(
      parseInt(y, 10),
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      parseInt(h, 10),
      parseInt(mi, 10),
      parseInt(s, 10),
      ms ? parseInt(ms.padEnd(3, '0'), 10) : 0
    );
    return dt.getTime();
  }

  const shortMatch = String(tsStr).trim().match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (shortMatch) {
    const [, mo, d, h, mi, s, ms] = shortMatch;
    let year = ref.getFullYear();
    let dt = new Date(
      year,
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      parseInt(h, 10),
      parseInt(mi, 10),
      parseInt(s, 10),
      ms ? parseInt(ms.padEnd(3, '0'), 10) : 0
    );
    // Handle year boundary (e.g. December log read in January)
    if (dt.getTime() - referenceNowMs > 86400 * 1000) {
      dt = new Date(
        year - 1,
        parseInt(mo, 10) - 1,
        parseInt(d, 10),
        parseInt(h, 10),
        parseInt(mi, 10),
        parseInt(s, 10),
        ms ? parseInt(ms.padEnd(3, '0'), 10) : 0
      );
    }
    return dt.getTime();
  }
  return null;
}

// Match potentially redacted MAC addresses (e.g. `XX:XX:XX:XX:95:66` <-> `34:09:C9:EC:95:66`)
function macMatches(macA, macB) {
  if (!macA || !macB) return false;
  const a = String(macA).toUpperCase().trim();
  const b = String(macB).toUpperCase().trim();
  if (a === b) return true;
  const suffixA = a.split(':').slice(-2).join(':');
  const suffixB = b.split(':').slice(-2).join(':');
  return Boolean(suffixA && suffixA === suffixB && (a.startsWith('XX:') || b.startsWith('XX:')));
}

function parseBluetoothDumpsys(btRaw, referenceNowMs = Date.now()) {
  const text = String(btRaw || '');
  const result = {
    enabled: false,
    adapterName: null,
    adapterAddress: null,
    connectionState: 'STATE_DISCONNECTED',
    bondedDevices: [],
    connectedDevices: []
  };

  if (!text) return result;

  // 1. Adapter header fields
  const enabledMatch = text.match(/^\s*enabled:\s*(true|false)/im);
  const stateMatch = text.match(/^\s*State:\s*(ON|OFF|TURNING_ON|TURNING_OFF)/im);
  const curStateMatch = text.match(/^\s*curState=(OnState|OffState)/im);
  result.enabled = (enabledMatch && enabledMatch[1].toLowerCase() === 'true') ||
                   (stateMatch && stateMatch[1].toUpperCase() === 'ON') ||
                   (curStateMatch && curStateMatch[1] === 'OnState');

  const nameMatch = text.match(/^\s*Name:\s*(.+)$/im);
  if (nameMatch) result.adapterName = nameMatch[1].trim();

  const addrMatch = text.match(/^\s*Address:\s*([0-9A-Fa-f:X]{17})/im);
  if (addrMatch) result.adapterAddress = addrMatch[1].trim();

  const connStateMatch = text.match(/^\s*ConnectionState:\s*(\S+)/im);
  if (connStateMatch) result.connectionState = connStateMatch[1].trim();

  // 2. Bonded devices list
  const bondedIdx = text.indexOf('Bonded devices:');
  if (bondedIdx !== -1) {
    const bondedSlice = text.slice(bondedIdx, bondedIdx + 4000);
    const lines = bondedSlice.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || (/^\S/.test(line) && !line.startsWith(' '))) break;
      if (/Scan Mode Changes:|Enabled Profile Services:|AdapterState:/i.test(line)) break;
      // Format: `    34:09:C9:EC:95:66 [ DUAL ][ 0x240404 ] soundcore R60i NC`
      // or:     `    34:09:C9:EC:95:66 soundcore R60i NC`
      const m = line.match(/^\s*([0-9A-Fa-f:X]{17})\s+(?:\[\s*([^\]]+?)\s*\]\s*\[\s*([^\]]+?)\s*\]\s*)?(.+?)\s*$/);
      if (m) {
        const address = m[1].toUpperCase();
        const type = m[2] ? m[2].trim() : null;
        const deviceClass = m[3] ? m[3].trim() : null;
        const name = m[4] ? m[4].trim() : 'Bluetooth Device';
        if (!/^\(uid\/pid=/i.test(name) && !/SCAN_MODE/i.test(name)) {
          result.bondedDevices.push({ address, name, type, deviceClass });
        }
      }
    }
  }

  // 3. Parse Metadata section (FastPair / custom metadata: battery levels, manufacturer, model, unmasked MAC)
  const metadataByKey = new Map();
  const getOrCreateMeta = (rawMac) => {
    const upper = String(rawMac).toUpperCase();
    for (const [k, v] of metadataByKey.entries()) {
      if (macMatches(k, upper)) return v;
    }
    const obj = {
      rawMac: upper,
      fullMac: upper.startsWith('XX:') ? null : upper,
      manufacturer: null,
      modelName: null,
      deviceType: null,
      leftBattery: null,
      rightBattery: null,
      caseBattery: null,
      mainBattery: null,
      isActiveHfp: false
    };
    metadataByKey.set(upper, obj);
    return obj;
  };

  const metaLines = text.match(/^\s*(?:[0-9A-Fa-f]{2}|XX):(?:[0-9A-Fa-f]{2}|XX):(?:[0-9A-Fa-f]{2}|XX):(?:[0-9A-Fa-f]{2}|XX):[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}\s+last_active_time=.+$/gm) || [];
  for (const line of metaLines) {
    const macM = line.match(/^\s*((?:[0-9A-Fa-f]{2}|XX)(?::(?:[0-9A-Fa-f]{2}|XX)){5})/i);
    if (!macM) continue;
    const meta = getOrCreateMeta(macM[1]);
    const pick = (key) => {
      const m = line.match(new RegExp(`${key}=([^|)}]+)`));
      if (!m) return null;
      const val = m[1].trim();
      return val === 'null' || val === '' ? null : val;
    };
    const mfr = pick('manufacturer_name');
    const mdl = pick('model_name');
    const dtype = pick('device_type');
    if (mfr) meta.manufacturer = mfr;
    if (mdl) meta.modelName = mdl;
    if (dtype) meta.deviceType = dtype;

    const parseBatt = (k) => {
      const v = pick(k);
      if (v === null) return null;
      const n = parseInt(v, 10);
      return !isNaN(n) && n >= 0 && n <= 100 ? n : null;
    };
    const lb = parseBatt('untethered_left_battery');
    const rb = parseBatt('untethered_right_battery');
    const cb = parseBatt('untethered_case_battery');
    const mb = parseBatt('main_battery');
    if (lb !== null) meta.leftBattery = lb;
    if (rb !== null) meta.rightBattery = rb;
    if (cb !== null) meta.caseBattery = cb;
    if (mb !== null) meta.mainBattery = mb;

    if (/isActiveHfpDevice\s*\(\s*true\s*\)/i.test(line)) {
      meta.isActiveHfp = true;
    }
    const uriMatch = line.match(/address=([0-9A-Fa-f]{2}(?:%3A[0-9A-Fa-f]{2}){5})/i);
    if (uriMatch) {
      meta.fullMac = decodeURIComponent(uriMatch[1]).toUpperCase();
    }
  }

  // 4. Parse A2dpService state machines
  const deviceMap = new Map();
  const findOrCreateDevice = (mac) => {
    const upper = String(mac).toUpperCase();
    for (const [, dev] of deviceMap.entries()) {
      if (macMatches(dev.mac, upper) || (dev.fullMac && macMatches(dev.fullMac, upper))) {
        return dev;
      }
    }
    const bonded = result.bondedDevices.find((b) => macMatches(b.address, upper));
    let meta = null;
    for (const [, m] of metadataByKey.entries()) {
      if (macMatches(m.rawMac, upper) || (m.fullMac && macMatches(m.fullMac, upper))) {
        meta = m;
        break;
      }
    }
    const fullMac = (bonded && bonded.address) || (meta && meta.fullMac) || upper;
    const name = (bonded && bonded.name) || (meta && meta.modelName) || 'Bluetooth Audio Device';
    const dev = {
      mac: fullMac,
      rawMac: upper,
      fullMac,
      name,
      manufacturer: (meta && meta.manufacturer) || null,
      deviceType: (meta && meta.deviceType) || (bonded && bonded.type) || null,
      profiles: [],
      isActiveAudio: false,
      a2dpPlaying: false,
      codec: null,
      sampleRateHz: null,
      bitsPerSample: null,
      channelMode: null,
      speakerVolume: null,
      battery: {
        main: meta ? meta.mainBattery : null,
        left: meta ? meta.leftBattery : null,
        right: meta ? meta.rightBattery : null,
        case: meta ? meta.caseBattery : null,
        hfpLevel: null
      },
      connectedAtMs: null,
      earliestConnectedLogMs: null,
      connectedTimeSource: null
    };
    deviceMap.set(fullMac, dev);
    return dev;
  };

  // Extract A2DP section
  const a2dpIdx = text.indexOf('Profile: A2dpService');
  if (a2dpIdx !== -1) {
    const nextProfileIdx = text.slice(a2dpIdx + 20).search(/^Profile:\s+/m);
    const a2dpSection = nextProfileIdx !== -1
      ? text.slice(a2dpIdx, a2dpIdx + 20 + nextProfileIdx)
      : text.slice(a2dpIdx, a2dpIdx + 25000);

    const activeA2dpMatch = a2dpSection.match(/^\s*mActiveDevice:\s*([0-9A-Fa-f:X]{17})/im);
    const activeA2dpMac = activeA2dpMatch ? activeA2dpMatch[1].toUpperCase() : null;

    const smBlocks = a2dpSection.split(/===\s*A2dpStateMachine for\s+/);
    for (let i = 1; i < smBlocks.length; i++) {
      const block = smBlocks[i];
      const headerMatch = block.match(/^([0-9A-Fa-f:X]{17})(?:\s*\((Active)\))?\s*===/i);
      if (!headerMatch) continue;
      const mac = headerMatch[1].toUpperCase();
      const isMarkedActive = Boolean(headerMatch[2]) || (activeA2dpMac && macMatches(activeA2dpMac, mac));

      const isConnected = /mConnectionState:\s*CONNECTED\b/i.test(block) ||
                          /curState=Connected\b/i.test(block) ||
                          /state=Connected\b/i.test(block);
      if (!isConnected) continue;

      const dev = findOrCreateDevice(mac);
      if (!dev.profiles.includes('A2DP (Media Audio)')) {
        dev.profiles.push('A2DP (Media Audio)');
      }
      if (isMarkedActive) dev.isActiveAudio = true;
      if (/mIsPlaying:\s*true\b/i.test(block)) {
        dev.a2dpPlaying = true;
      }

      const codecMatch = block.match(/mCodecConfig:\s*\{codecName:([^,}]+).*?mSampleRate:[^(]*\(([^)]+)\).*?mBitsPerSample:[^(]*\(([^)]+)\).*?mChannelMode:[^(]*\(([^)]+)\)/);
      if (codecMatch) {
        dev.codec = codecMatch[1].trim();
        dev.sampleRateHz = codecMatch[2].trim();
        dev.bitsPerSample = codecMatch[3].trim();
        dev.channelMode = codecMatch[4].trim();
      }

      // Inspect StateMachineLog records for connection timestamp
      const recLines = block.match(/^\s*rec\[\d+\]:\s*time=.+$/gm) || [];
      for (const rLine of recLines) {
        const tm = rLine.match(/time=(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/);
        if (!tm) continue;
        const tsMs = parseDumpsysTimestamp(tm[1], referenceNowMs);
        if (!tsMs) continue;

        if (/dest=Connected\b/i.test(rLine)) {
          if (!dev.connectedAtMs || tsMs > dev.connectedAtMs) {
            dev.connectedAtMs = tsMs;
            dev.connectedTimeSource = 'A2DP state transition';
          }
        }
        if (/processed=Connected\b|org=Connected\b/i.test(rLine)) {
          if (!dev.earliestConnectedLogMs || tsMs < dev.earliestConnectedLogMs) {
            dev.earliestConnectedLogMs = tsMs;
          }
        }
      }
    }
  }

  // 5. Extract HeadsetService (HFP) section
  const hfpIdx = text.indexOf('Profile: HeadsetService');
  if (hfpIdx !== -1) {
    const nextProfileIdx = text.slice(hfpIdx + 23).search(/^Profile:\s+/m);
    const hfpSection = nextProfileIdx !== -1
      ? text.slice(hfpIdx, hfpIdx + 23 + nextProfileIdx)
      : text.slice(hfpIdx, hfpIdx + 25000);

    const activeHfpMatch = hfpSection.match(/^\s*mActiveDevice:\s*([0-9A-Fa-f:X]{17})/im);
    const activeHfpMac = activeHfpMatch ? activeHfpMatch[1].toUpperCase() : null;

    const smBlocks = hfpSection.split(/====\s*StateMachine for\s+/);
    for (let i = 1; i < smBlocks.length; i++) {
      const block = smBlocks[i];
      const headerMatch = block.match(/^([0-9A-Fa-f:X]{17})\s*====/i);
      if (!headerMatch) continue;
      const mac = headerMatch[1].toUpperCase();

      const isConnected = /mCurrentState:\s*Connected\b/i.test(block) ||
                          /curState=Connected\b/i.test(block) ||
                          /state=Connected\b/i.test(block);
      if (!isConnected) continue;

      const dev = findOrCreateDevice(mac);
      if (!dev.profiles.includes('HFP (Calls / Headset)')) {
        dev.profiles.push('HFP (Calls / Headset)');
      }
      if (activeHfpMac && macMatches(activeHfpMac, mac)) {
        dev.isActiveAudio = true;
      }

      const volMatch = block.match(/mSpeakerVolume:\s*(\d+)/i);
      if (volMatch) {
        dev.speakerVolume = parseInt(volMatch[1], 10);
      }

      const recLines = block.match(/^\s*rec\[\d+\]:\s*time=.+$/gm) || [];
      for (const rLine of recLines) {
        const tm = rLine.match(/time=(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/);
        if (!tm) continue;
        const tsMs = parseDumpsysTimestamp(tm[1], referenceNowMs);
        if (!tsMs) continue;

        if (/dest=Connected\b/i.test(rLine)) {
          if (!dev.connectedAtMs || tsMs > dev.connectedAtMs) {
            dev.connectedAtMs = tsMs;
            dev.connectedTimeSource = 'HFP state transition';
          }
        }
        if (/processed=Connected\b|org=Connected\b/i.test(rLine)) {
          if (!dev.earliestConnectedLogMs || tsMs < dev.earliestConnectedLogMs) {
            dev.earliestConnectedLogMs = tsMs;
          }
        }
        const battChargeMatch = rLine.match(/batteryCharge=(\d+)/i);
        if (battChargeMatch) {
          const charge = parseInt(battChargeMatch[1], 10);
          if (!isNaN(charge) && charge >= 0 && charge <= 5) {
            dev.battery.hfpLevel = charge * 20;
          }
        }
      }
    }
  }

  // 6. Finalize connected timestamp for each connected device (fallback to earliestConnectedLogMs or persisted session)
  const cfg = loadConfig() || {};
  const btSessions = cfg.btSessions && typeof cfg.btSessions === 'object' ? { ...cfg.btSessions } : {};
  let sessionsDirty = false;
  const activeMacSet = new Set();

  for (const [, dev] of deviceMap.entries()) {
    activeMacSet.add(dev.mac);
    if (!dev.connectedAtMs && dev.earliestConnectedLogMs) {
      dev.connectedAtMs = dev.earliestConnectedLogMs;
      dev.connectedTimeSource = 'Bluetooth state log';
    }
    const prevSession = btSessions[dev.mac];
    if (!dev.connectedAtMs) {
      if (prevSession && prevSession.connectedAtMs && (referenceNowMs - (prevSession.lastSeenMs || referenceNowMs) < 30 * 60 * 1000)) {
        dev.connectedAtMs = prevSession.connectedAtMs;
        dev.connectedTimeSource = 'DevMode session tracker';
      } else {
        dev.connectedAtMs = referenceNowMs;
        dev.connectedTimeSource = 'Just detected';
      }
    }
    btSessions[dev.mac] = {
      name: dev.name,
      connectedAtMs: dev.connectedAtMs,
      lastSeenMs: referenceNowMs
    };
    sessionsDirty = true;

    dev.connectedDurationMs = Math.max(0, referenceNowMs - dev.connectedAtMs);
    dev.connectedDurationFormatted = formatDuration(dev.connectedDurationMs);
    dev.connectedSinceFormatted = formatClockTime(dev.connectedAtMs);
    result.connectedDevices.push(dev);
  }

  // Clean up disconnected devices from btSessions cache
  for (const savedMac of Object.keys(btSessions)) {
    if (!activeMacSet.has(savedMac)) {
      delete btSessions[savedMac];
      sessionsDirty = true;
    }
  }
  if (sessionsDirty) {
    try { saveConfig({ btSessions }); } catch (_) {}
  }

  return result;
}

function parseMediaSessionDumpsys(mediaRaw, elapsedRealtimeMs = null) {
  const text = String(mediaRaw || '');
  const result = {
    isMusicPlaying: false,
    playbackState: 'NONE',
    activeSession: null,
    sessions: []
  };

  if (!text) return result;

  // Locate `Sessions Stack - have N sessions:`
  const stackIdx = text.indexOf('Sessions Stack');
  const targetSlice = stackIdx !== -1 ? text.slice(stackIdx) : text;

  // Split into individual session blocks
  const lines = targetSlice.split(/\r?\n/);
  let current = null;

  const pushCurrent = () => {
    if (!current || !current.package) return;
    // Skip internal telecom HeadsetMediaButton placeholder when it has no metadata/state
    if (current.package === 'com.android.server.telecom' && (!current.stateName || current.stateName === 'NONE')) {
      return;
    }
    result.sessions.push(current);
  };

  for (const line of lines) {
    if (/^Audio playback|^Media session config:/i.test(line.trim())) {
      break;
    }

    // Session header inside Sessions Stack: `    spotify-media-session com.spotify.music/spotify-media-session/486 (userId=0)`
    const headerMatch = line.match(/^\s{4}(\S+)\s+([a-zA-Z0-9_.]+)\/(\S+)\s+\(userId=\d+\)/);
    if (headerMatch) {
      pushCurrent();
      current = {
        tag: headerMatch[1],
        package: headerMatch[2],
        appLabel: formatAppName(headerMatch[2]),
        active: false,
        stateCode: 0,
        stateName: 'NONE',
        positionMs: null,
        updatedElapsedMs: null,
        speed: 1.0,
        title: null,
        artist: null,
        album: null,
        rawDescription: null
      };
      continue;
    }

    if (!current) continue;

    const pkgMatch = line.match(/^\s*package=([a-zA-Z0-9_.]+)/);
    if (pkgMatch) {
      current.package = pkgMatch[1].trim();
      current.appLabel = formatAppName(current.package);
    }

    const activeMatch = line.match(/^\s*active=(true|false)/i);
    if (activeMatch) {
      current.active = activeMatch[1].toLowerCase() === 'true';
    }

    if (/^\s*state=PlaybackState\s*\{/.test(line)) {
      // Handle both `state=PLAYING(3)` and `state=3`
      const namedState = line.match(/state=([A-Z_]+)\((\d+)\)/);
      const numState = line.match(/state=(\d+)/);
      if (namedState) {
        current.stateName = namedState[1];
        current.stateCode = parseInt(namedState[2], 10);
      } else if (numState) {
        current.stateCode = parseInt(numState[1], 10);
        current.stateName = PLAYBACK_STATES[current.stateCode] || `STATE_${current.stateCode}`;
      }
      const posMatch = line.match(/position=(-?\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        if (!isNaN(pos) && pos >= 0) current.positionMs = pos;
      }
      const updMatch = line.match(/updated=(\d+)/);
      if (updMatch) {
        const upd = parseInt(updMatch[1], 10);
        if (!isNaN(upd) && upd > 0) current.updatedElapsedMs = upd;
      }
      const speedMatch = line.match(/speed=([0-9.]+)/);
      if (speedMatch) {
        current.speed = parseFloat(speedMatch[1]) || 1.0;
      }
      if (
        (current.stateCode === 3 || current.stateName === 'PLAYING') &&
        current.positionMs !== null &&
        current.updatedElapsedMs &&
        elapsedRealtimeMs &&
        elapsedRealtimeMs >= current.updatedElapsedMs
      ) {
        current.positionMs = current.positionMs + Math.round((elapsedRealtimeMs - current.updatedElapsedMs) * current.speed);
      }
    }

    const metaMatch = line.match(/^\s*metadata:\s*size=\d+,\s*description=(.+)$/);
    if (metaMatch) {
      const desc = metaMatch[1].trim();
      if (desc && desc !== 'null, null, null') {
        current.rawDescription = desc;
        // Android MediaMetadata.getDescription() formats as `title, subtitle (artist), description (album)`
        const parts = desc.split(',').map((s) => s.trim());
        if (parts.length >= 3) {
          current.title = parts[0] || null;
          current.artist = parts[1] && parts[1] !== 'null' ? parts[1] : null;
          current.album = parts.slice(2).join(', ');
          if (current.album === 'null') current.album = null;
        } else if (parts.length === 2) {
          current.title = parts[0] || null;
          current.artist = parts[1] && parts[1] !== 'null' ? parts[1] : null;
        } else {
          current.title = desc;
        }
      }
    }
  }
  pushCurrent();

  // Pick the primary session: prioritize PLAYING (3) or BUFFERING (6), then active=true with metadata, then first session
  const playingSession = result.sessions.find((s) => s.stateCode === 3 || s.stateName === 'PLAYING' || s.stateCode === 6);
  const pausedSession = result.sessions.find((s) => (s.stateCode === 2 || s.stateName === 'PAUSED') && (s.active || s.title));
  const primary = playingSession || pausedSession || result.sessions.find((s) => s.active) || result.sessions[0] || null;

  if (primary) {
    result.activeSession = primary;
    result.playbackState = primary.stateName;
    result.isMusicPlaying = primary.stateCode === 3 || primary.stateName === 'PLAYING';
  }

  return result;
}

const artworkCache = new Map();

function querySingleArt(term) {
  if (!term) return Promise.resolve(null);
  return new Promise((resolve) => {
    const https = require('https');
    const itunesUrl = 'https://itunes.apple.com/search?term=' + encodeURIComponent(term) + '&limit=1';
    const req = https.get(itunesUrl, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results && json.results[0]) {
            const art = json.results[0].artworkUrl600 || json.results[0].artworkUrl100 || null;
            if (art) return resolve(art);
          }
        } catch (_) {}

        // Fallback: Deezer public API
        const deezerUrl = 'https://api.deezer.com/search?q=' + encodeURIComponent(term) + '&limit=1';
        https.get(deezerUrl, (dRes) => {
          let dData = '';
          dRes.on('data', (c) => { dData += c; });
          dRes.on('end', () => {
            try {
              const dJson = JSON.parse(dData);
              if (dJson.data && dJson.data[0] && dJson.data[0].album) {
                const dArt = dJson.data[0].album.cover_xl || dJson.data[0].album.cover_big || dJson.data[0].album.cover_medium;
                if (dArt) return resolve(dArt);
              }
            } catch (_) {}
            resolve(null);
          });
        }).on('error', () => resolve(null));
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => {
      try { req.destroy(); } catch (_) {}
      resolve(null);
    });
  });
}

async function fetchAlbumArtUrl(title, artist, album) {
  const sanitize = (s) => String(s || '').replace(/[|•()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  const cTitle = sanitize(title);
  const cArtist = sanitize(artist);
  const cAlbum = sanitize(album);

  const cacheKey = `${cArtist}:::${cTitle}:::${cAlbum}`;
  if (artworkCache.has(cacheKey)) {
    return artworkCache.get(cacheKey);
  }

  // Generate ordered search candidates
  const candidates = [];
  if (cTitle && cArtist) {
    candidates.push(`${cArtist} ${cTitle}`);
    // If title has a subtitle before a hyphen or dash, try the main title
    const shortTitle = cTitle.split(/[-–—:]/)[0].trim();
    if (shortTitle && shortTitle !== cTitle) {
      candidates.push(`${cArtist} ${shortTitle}`);
    }
  }
  if (cArtist && cArtist !== cAlbum) {
    const shortArtist = cArtist.split(/[-–—:]/)[0].trim();
    candidates.push(shortArtist || cArtist);
  }
  if (cAlbum) {
    const shortAlbum = cAlbum.split(/[-–—:]/)[0].trim();
    candidates.push(shortAlbum || cAlbum);
  }
  if (cTitle) {
    candidates.push(cTitle);
  }

  const seen = new Set();
  for (const cand of candidates) {
    if (!cand || cand.length < 2 || seen.has(cand)) continue;
    seen.add(cand);
    try {
      const found = await querySingleArt(cand);
      if (found) {
        artworkCache.set(cacheKey, found);
        return found;
      }
    } catch (_) {}
  }

  artworkCache.set(cacheKey, null);
  return null;
}

function openInDefaultViewer(target) {
  if (!target) return;
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${target}"` :
              process.platform === 'darwin' ? `open "${target}"` :
              `xdg-open "${target}"`;
  try {
    exec(cmd);
  } catch (_) {}
}

async function dispatchMediaPlayFromSearch(query, serial = null) {
  if (!query) return false;
  // Dispatches Android MEDIA_PLAY_FROM_SEARCH intent
  const clean = String(query).replace(/"/g, '\\"');
  const cmd = ['shell', 'am', 'start', '-a', 'android.media.action.MEDIA_PLAY_FROM_SEARCH', '-e', 'query', `"${clean}"`];
  const res = await execAdbAsync(cmd, serial, 6000);
  return res.status === 0;
}

// Fetch combined Bluetooth + Media Session snapshot in a single ADB call
async function getBluetoothAndMediaSnapshotAsync(serial = null) {
  const SEP = '===DEVMODE_BT_MEDIA_SEP===';
  const cmd = `dumpsys bluetooth_manager; echo "${SEP}"; dumpsys media_session; echo "${SEP}"; date +%s%3N; cat /proc/uptime`;
  const res = await execAdbAsync(['shell', cmd], serial, 10000);
  if (res.status !== 0 && !res.stdout) {
    throw new Error(res.stderr || 'Failed to query Bluetooth and Media services via ADB');
  }

  const parts = String(res.stdout || '').split(SEP);
  const btRaw = parts[0] || '';
  const mediaRaw = parts[1] || '';
  const timeLines = (parts[2] || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dateRaw = timeLines[0] || '';
  const uptimeRaw = timeLines[1] || '';

  let referenceNowMs = Date.now();
  const parsedEpoch = parseInt(dateRaw, 10);
  if (!isNaN(parsedEpoch) && parsedEpoch > 1600000000000) {
    referenceNowMs = parsedEpoch;
  }

  let elapsedRealtimeMs = null;
  if (uptimeRaw) {
    const upSec = parseFloat(uptimeRaw.split(/\s+/)[0]);
    if (!isNaN(upSec) && upSec > 0) {
      elapsedRealtimeMs = Math.round(upSec * 1000);
    }
  }

  const bluetooth = parseBluetoothDumpsys(btRaw, referenceNowMs);
  const media = parseMediaSessionDumpsys(mediaRaw, elapsedRealtimeMs);

  if (media.activeSession && (media.activeSession.title || media.activeSession.artist)) {
    try {
      media.activeSession.artworkUrl = await fetchAlbumArtUrl(
        media.activeSession.title,
        media.activeSession.artist,
        media.activeSession.album
      );
    } catch (_) {}
  }

  // Cross-check if Bluetooth A2DP stream is actively playing even if media_session reported buffering/other
  const anyA2dpPlaying = bluetooth.connectedDevices.some((d) => d.a2dpPlaying);
  const isAudioStreaming = media.isMusicPlaying || anyA2dpPlaying;

  return {
    fetchedAtMs: Date.now(),
    deviceNowMs: referenceNowMs,
    bluetooth,
    media,
    isAudioStreaming
  };
}

function getBluetoothAndMediaSnapshotSync(serial = null) {
  const SEP = '===DEVMODE_BT_MEDIA_SEP===';
  const cmd = `dumpsys bluetooth_manager; echo "${SEP}"; dumpsys media_session; echo "${SEP}"; date +%s%3N; cat /proc/uptime`;
  const res = execAdb(['shell', cmd], serial, 10000);
  if (res.status !== 0 && !res.stdout) {
    return null;
  }
  const parts = String(res.stdout || '').split(SEP);
  const btRaw = parts[0] || '';
  const mediaRaw = parts[1] || '';
  const timeLines = (parts[2] || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dateRaw = timeLines[0] || '';
  const uptimeRaw = timeLines[1] || '';

  let referenceNowMs = Date.now();
  const parsedEpoch = parseInt(dateRaw, 10);
  if (!isNaN(parsedEpoch) && parsedEpoch > 1600000000000) {
    referenceNowMs = parsedEpoch;
  }

  let elapsedRealtimeMs = null;
  if (uptimeRaw) {
    const upSec = parseFloat(uptimeRaw.split(/\s+/)[0]);
    if (!isNaN(upSec) && upSec > 0) {
      elapsedRealtimeMs = Math.round(upSec * 1000);
    }
  }

  const bluetooth = parseBluetoothDumpsys(btRaw, referenceNowMs);
  const media = parseMediaSessionDumpsys(mediaRaw, elapsedRealtimeMs);
  const anyA2dpPlaying = bluetooth.connectedDevices.some((d) => d.a2dpPlaying);

  return {
    fetchedAtMs: Date.now(),
    deviceNowMs: referenceNowMs,
    bluetooth,
    media,
    isAudioStreaming: media.isMusicPlaying || anyA2dpPlaying
  };
}

function formatBatterySummary(batt) {
  if (!batt) return null;
  const parts = [];
  if (batt.left !== null && batt.right !== null) {
    parts.push(`L: ${batt.left}% | R: ${batt.right}%`);
  } else if (batt.left !== null) {
    parts.push(`Left: ${batt.left}%`);
  } else if (batt.right !== null) {
    parts.push(`Right: ${batt.right}%`);
  }
  if (batt.case !== null) {
    parts.push(`Case: ${batt.case}%`);
  }
  if (parts.length === 0 && batt.main !== null) {
    parts.push(`${batt.main}%`);
  }
  if (parts.length === 0 && batt.hfpLevel !== null) {
    parts.push(`~${batt.hfpLevel}%`);
  }
  return parts.length > 0 ? parts.join(' • ') : null;
}

function renderBluetoothAndMediaReport(snap, deviceInfo = null, elapsedOffsetMs = 0) {
  const { bluetooth, media, isAudioStreaming } = snap;

  console.log(`  ${colors.bold('🎧 BLUETOOTH & NOW PLAYING MONITOR')}`);
  console.log(`  ${colors.gray('─'.repeat(62))}\n`);

  if (deviceInfo) {
    const connBadge = deviceInfo.isWifi ? colors.cyan('Wireless ADB') : colors.green('USB Cable');
    console.log(`  ${symbols.bullet} ${colors.bold('Phone'.padEnd(22))}: ${colors.white(deviceInfo.model || deviceInfo.serial)} ${colors.dim(`(${connBadge})`)}`);
  }

  const btStateBadge = bluetooth.enabled
    ? colors.bold(colors.green('ENABLED (ON)'))
    : colors.bold(colors.red('DISABLED (OFF)'));
  const adapterLabel = bluetooth.adapterName ? ` — ${colors.cyan(bluetooth.adapterName)}` : '';
  console.log(`  ${symbols.bullet} ${colors.bold('Bluetooth Radio'.padEnd(22))}: ${btStateBadge}${adapterLabel}\n`);

  // Connected Bluetooth Devices Section
  console.log(`  ${colors.bold(colors.cyan('🔗 CONNECTED BLUETOOTH DEVICES:'))}`);
  if (!bluetooth.enabled) {
    console.log(`    ${symbols.warn} ${colors.yellow('Bluetooth is currently turned OFF on your phone.')}\n`);
  } else if (bluetooth.connectedDevices.length === 0) {
    console.log(`    ${symbols.info} ${colors.dim('No Bluetooth audio/headset devices are currently connected.')}`);
    if (bluetooth.bondedDevices.length > 0) {
      const pairedNames = bluetooth.bondedDevices.slice(0, 4).map((d) => d.name).join(', ');
      console.log(`    ${colors.dim(`Paired devices (${bluetooth.bondedDevices.length}): ${pairedNames}`)}`);
    }
    console.log('');
  } else {
    bluetooth.connectedDevices.forEach((dev, idx) => {
      const liveDurationMs = Math.max(0, (dev.connectedDurationMs || 0) + elapsedOffsetMs);
      const durationStr = formatDuration(liveDurationMs);
      const sinceStr = dev.connectedSinceFormatted ? ` ${colors.dim(`(connected since ${dev.connectedSinceFormatted})`)}` : '';
      const activeBadge = dev.isActiveAudio ? colors.bold(colors.green(' [ACTIVE AUDIO]')) : '';
      const streamBadge = dev.a2dpPlaying ? colors.bold(colors.magenta(' [🎵 STREAMING]')) : '';

      console.log(`    ${colors.cyan(`[${idx + 1}]`)} ${colors.bold(colors.white(dev.name))}${activeBadge}${streamBadge}`);
      console.log(`        ${symbols.bullet} ${colors.bold('MAC Address'.padEnd(18))}: ${colors.cyan(dev.mac)}${dev.manufacturer ? colors.dim(` (${dev.manufacturer})`) : ''}`);
      console.log(`        ${symbols.bullet} ${colors.bold('Connected Time'.padEnd(18))}: ${colors.bold(colors.green(`⏱  ${durationStr}`))}${sinceStr}`);

      const battText = formatBatterySummary(dev.battery);
      if (battText) {
        console.log(`        ${symbols.bullet} ${colors.bold('Battery Level'.padEnd(18))}: ${colors.yellow(`🔋 ${battText}`)}`);
      }
      if (dev.codec) {
        const audioSpec = [dev.codec, dev.sampleRateHz ? `${dev.sampleRateHz}Hz` : null, dev.bitsPerSample ? `${dev.bitsPerSample}-bit` : null, dev.channelMode]
          .filter(Boolean)
          .join(' • ');
        console.log(`        ${symbols.bullet} ${colors.bold('Audio Codec'.padEnd(18))}: ${colors.white(audioSpec)}`);
      }
      if (dev.profiles.length > 0) {
        console.log(`        ${symbols.bullet} ${colors.bold('Active Profiles'.padEnd(18))}: ${colors.dim(dev.profiles.join(', '))}`);
      }
      console.log('');
    });
  }

  // Music / Media Playback Section
  console.log(`  ${colors.bold(colors.magenta('🎵 MUSIC & MEDIA PLAYBACK STATUS:'))}`);
  const active = media.activeSession;
  if (isAudioStreaming || (active && (active.stateName === 'PLAYING' || active.stateName === 'PAUSED' || active.stateName === 'BUFFERING'))) {
    const isPlaying = media.isMusicPlaying || isAudioStreaming;
    const stateBadge = isPlaying
      ? colors.bold(colors.green('▶ PLAYING (MUSIC RUNNING)'))
      : active && active.stateName === 'PAUSED'
        ? colors.bold(colors.yellow('⏸ PAUSED'))
        : colors.bold(colors.cyan(`● ${active ? active.stateName : 'ACTIVE'}`));

    console.log(`    ${symbols.bullet} ${colors.bold('Status'.padEnd(20))}: ${stateBadge}`);
    if (active) {
      console.log(`    ${symbols.bullet} ${colors.bold('Media App'.padEnd(20))}: ${colors.cyan(active.appLabel)}`);
      if (active.title) {
        console.log(`    ${symbols.bullet} ${colors.bold('Now Playing'.padEnd(20))}: ${colors.bold(colors.white(active.title))}`);
      }
      if (active.artist) {
        console.log(`    ${symbols.bullet} ${colors.bold('Artist / Channel'.padEnd(20))}: ${colors.white(active.artist)}`);
      }
      if (active.album && active.album !== active.artist) {
        console.log(`    ${symbols.bullet} ${colors.bold('Album / Show'.padEnd(20))}: ${colors.dim(active.album)}`);
      }
      if (typeof active.positionMs === 'number') {
        const livePosMs = isPlaying ? active.positionMs + elapsedOffsetMs : active.positionMs;
        console.log(`    ${symbols.bullet} ${colors.bold('Playback Position'.padEnd(20))}: ${colors.yellow(formatDuration(livePosMs))}`);
      }
      if (active.artworkUrl) {
        console.log(`    ${symbols.bullet} ${colors.bold('Album Cover Art'.padEnd(20))}: 🖼️  ${colors.bold(colors.cyan('[Press "a" to View]'))} ${colors.dim(active.artworkUrl)}`);
      }
    }
    const btTarget = bluetooth.connectedDevices.find((d) => d.isActiveAudio || d.a2dpPlaying);
    const routeText = btTarget
      ? `Bluetooth A2DP → ${colors.bold(colors.cyan(btTarget.name))}`
      : 'Phone Speaker / Wired Audio';
    console.log(`    ${symbols.bullet} ${colors.bold('Audio Output'.padEnd(20))}: ${routeText}\n`);
  } else {
    console.log(`    ${symbols.bullet} ${colors.bold('Status'.padEnd(20))}: ${colors.dim('⏹  No music currently playing')}`);
    if (active && active.package) {
      console.log(`    ${symbols.bullet} ${colors.bold('Last Media App'.padEnd(20))}: ${colors.dim(active.appLabel)}`);
    }
    console.log('');
  }
}

// Compact summary block for `devmode status`
function printBluetoothStatusSummary(serial = null) {
  const snap = getBluetoothAndMediaSnapshotSync(serial);
  if (!snap) return;

  console.log(`\n  ${colors.bold('BLUETOOTH & MEDIA STATUS:')}`);
  const { bluetooth, media, isAudioStreaming } = snap;
  if (!bluetooth.enabled) {
    console.log(`  ${symbols.bullet} ${colors.bold('Bluetooth'.padEnd(26))}: ${colors.dim(colors.red('DISABLED (OFF)'))}`);
  } else if (bluetooth.connectedDevices.length === 0) {
    console.log(`  ${symbols.bullet} ${colors.bold('Bluetooth'.padEnd(26))}: ${colors.green('ON')} ${colors.dim('(No device connected)')}`);
  } else {
    for (const dev of bluetooth.connectedDevices) {
      const batt = formatBatterySummary(dev.battery);
      const battTag = batt ? ` • 🔋 ${batt}` : '';
      console.log(`  ${symbols.bullet} ${colors.bold('Connected Bluetooth'.padEnd(26))}: ${colors.bold(colors.cyan(dev.name))} ${colors.dim(`(${dev.mac}${battTag})`)}`);
      const sinceTag = dev.connectedSinceFormatted ? colors.dim(` (since ${dev.connectedSinceFormatted})`) : '';
      console.log(`  ${symbols.bullet} ${colors.bold('Connected Duration'.padEnd(26))}: ${colors.bold(colors.green(`⏱  ${dev.connectedDurationFormatted}`))}${sinceTag}`);
    }
  }

  const active = media.activeSession;
  if (isAudioStreaming || (active && active.stateName === 'PLAYING')) {
    const track = active && active.title
      ? `${active.title}${active.artist ? ` — ${active.artist}` : ''}`
      : 'Audio stream active';
    const app = active ? KNOWN_MEDIA_APPS[active.package] || active.package : 'Media Player';
    console.log(`  ${symbols.bullet} ${colors.bold('Music Playing'.padEnd(26))}: ${colors.bold(colors.green('▶ YES'))} ${colors.white(`(${app}: ${track})`)}`);
  } else if (active && active.stateName === 'PAUSED' && active.title) {
    const app = KNOWN_MEDIA_APPS[active.package] || active.package;
    console.log(`  ${symbols.bullet} ${colors.bold('Music Playing'.padEnd(26))}: ${colors.yellow('⏸ PAUSED')} ${colors.dim(`(${app}: ${active.title})`)}`);
  } else {
    console.log(`  ${symbols.bullet} ${colors.bold('Music Playing'.padEnd(26))}: ${colors.dim('No active music playback')}`);
  }
}

async function handleBluetoothMonitor(targetDevice, rawArgs = []) {
  const once = rawArgs.includes('--once') || rawArgs.includes('once') || rawArgs.includes('status') || !process.stdin.isTTY;
  const serial = targetDevice ? targetDevice.serial : null;

  let lastSnap = null;
  let lastFetchTime = Date.now();
  let statusNotice = '';

  const fetchLatest = async () => {
    lastSnap = await getBluetoothAndMediaSnapshotAsync(serial);
    lastFetchTime = Date.now();
  };

  try {
    await fetchLatest();
  } catch (err) {
    banner();
    console.log(`  ${symbols.cross} ${colors.red(err.message || String(err))}\n`);
    return;
  }

  if (once) {
    banner();
    renderBluetoothAndMediaReport(lastSnap, targetDevice, 0);
    return;
  }

  let shuttingDown = false;
  let pollTimer = null;
  let tickTimer = null;
  let busy = false;

  const renderFrame = () => {
    if (shuttingDown || !lastSnap) return;
    const elapsedOffsetMs = Math.max(0, Date.now() - lastFetchTime);
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    banner();
    renderBluetoothAndMediaReport(lastSnap, targetDevice, elapsedOffsetMs);

    console.log(`  ${colors.bold('Live Controls:')}`);
    console.log(`  ${colors.cyan('[space / p]')} Play / Pause Music   ${colors.cyan('[n]')} Next Track       ${colors.cyan('[b]')} Previous Track`);
    console.log(`  ${colors.cyan('[a]')}         Open Album Art Image ${colors.cyan('[+ / -]')} Volume Up / Down ${colors.cyan('[r]')} Refresh Now`);
    console.log(`  ${colors.cyan('[q / Ctrl+C]')} Quit`);
    if (statusNotice) {
      console.log(`\n  ${symbols.info} ${colors.yellow(statusNotice)}`);
    } else {
      console.log(`\n  ${colors.dim('Live timer active — refreshing Bluetooth & Media state automatically...')}`);
    }
  };

  const cleanupAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch (_) {}
    process.stdin.pause();
    console.log(`\n  ${symbols.info} ${colors.dim('Exited Bluetooth & Now Playing live monitor.')}\n`);
    printCheerMessage('auto-quit');
    process.exit(0);
  };

  process.once('SIGINT', cleanupAndExit);
  process.once('SIGTERM', cleanupAndExit);
  process.once('SIGHUP', cleanupAndExit);

  renderFrame();

  // Smooth 1-second timer tick for live connection duration & song position
  tickTimer = setInterval(() => {
    if (!busy && !shuttingDown) {
      renderFrame();
    }
  }, 1000);

  // Refresh ADB dumpsys every 4 seconds in the background
  pollTimer = setInterval(async () => {
    if (busy || shuttingDown) return;
    busy = true;
    try {
      await fetchLatest();
      statusNotice = '';
      renderFrame();
    } catch (_) {} finally {
      busy = false;
    }
  }, 4000);

  try {
    process.stdin.setRawMode(true);
  } catch (_) {}
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', async (chunk) => {
    const raw = String(chunk || '');
    const k = raw.toLowerCase();
    if (k === 'q' || raw.includes('\u0003')) {
      cleanupAndExit();
      return;
    }
    if (busy) return;
    busy = true;
    try {
      if (k === ' ' || k === 'p') {
        statusNotice = 'Toggling Play / Pause on phone...';
        renderFrame();
        await execAdbAsync(['shell', 'input', 'keyevent', '85'], serial, 4000);
        await new Promise((r) => setTimeout(r, 450));
        await fetchLatest();
        statusNotice = '';
      } else if (k === 'n') {
        statusNotice = 'Skipping to Next Track...';
        renderFrame();
        await execAdbAsync(['shell', 'input', 'keyevent', '87'], serial, 4000);
        await new Promise((r) => setTimeout(r, 550));
        await fetchLatest();
        statusNotice = '';
      } else if (k === 'b') {
        statusNotice = 'Returning to Previous Track...';
        renderFrame();
        await execAdbAsync(['shell', 'input', 'keyevent', '88'], serial, 4000);
        await new Promise((r) => setTimeout(r, 550));
        await fetchLatest();
        statusNotice = '';
      } else if (k === 'a') {
        const art = lastSnap && lastSnap.media && lastSnap.media.activeSession && lastSnap.media.activeSession.artworkUrl;
        if (art) {
          openInDefaultViewer(art);
          statusNotice = 'Opening album cover artwork in image viewer...';
        } else {
          statusNotice = 'No album artwork found for currently playing song.';
        }
      } else if (k === '+' || k === '=') {
        statusNotice = 'Increasing media volume...';
        renderFrame();
        await execAdbAsync(['shell', 'input', 'keyevent', '24'], serial, 4000);
        await fetchLatest();
        statusNotice = '';
      } else if (k === '-' || k === '_') {
        statusNotice = 'Decreasing media volume...';
        renderFrame();
        await execAdbAsync(['shell', 'input', 'keyevent', '25'], serial, 4000);
        await fetchLatest();
        statusNotice = '';
      } else if (k === 'r') {
        statusNotice = 'Refreshing Bluetooth & Media status...';
        renderFrame();
        await fetchLatest();
        statusNotice = '';
      }
      renderFrame();
    } catch (_) {} finally {
      busy = false;
    }
  });
}

module.exports = {
  formatDuration,
  parseBluetoothDumpsys,
  parseMediaSessionDumpsys,
  getBluetoothAndMediaSnapshotAsync,
  getBluetoothAndMediaSnapshotSync,
  fetchAlbumArtUrl,
  openInDefaultViewer,
  dispatchMediaPlayFromSearch,
  renderBluetoothAndMediaReport,
  printBluetoothStatusSummary,
  handleBluetoothMonitor
};

