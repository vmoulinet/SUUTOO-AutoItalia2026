// Video sync server + smoke machine trigger.
// No dependencies: `node server.js`
//
// Principle: the server is the master clock. The video (virtually) starts at T0.
// Each phone computes position = ((server_now - T0) / 1000) % cycle
// and keeps correcting its playback. The server knows when the smoke moment
// of each loop is reached and fires the smoke machine itself.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const smoke = config.smoke || {};
const VIDEO_DIR = path.join(ROOT, 'video');
const STATE_FILE = path.join(ROOT, 'state.json');

// Settings editable from the control panel, kept across restarts:
//   phones : screen id -> { name, video, volume (0-100) }
//   slots  : slot number (1-3) -> { label } original file name
//   durations : file name -> { version, ms }, so a restart doesn't forget the cycle length
//   schedule : { enabled, days: { mon: [{ start: 'HH:MM', end: 'HH:MM' }], ... } } opening hours, in GMT/UTC
//   smokeEnabled : false = the smoke machine is never fired
//   smokeDurationSec : how long the smoke runs (null = config smoke.pulseMs)
//   smokeAtSec : moment of the smoke in the video, in seconds
let state = { phones: {}, smokeAtSec: 0, smokeDurationSec: null, smokeEnabled: true, slots: {}, durations: {}, schedule: { enabled: false, days: {} } };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
if (state.smokeAtSec == null) state.smokeAtSec = 0;
function saveState() {
  fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
}

let t0 = Date.now();
const fixedDurationMs = config.videoDurationSec ? config.videoDurationSec * 1000 : null;
let durationMs = fixedDurationMs;   // cycle length = longest of the videos in use
const durations = new Map();        // file name -> duration (ms), reported by the screens
const gapMs = (config.blackGapSec || 0) * 1000;   // black screen between two plays
let loopsDone = 0;           // smoke moments already handled
let smokeCount = 0;
let lastSmokeAt = null;
let stopped = false;         // stopped from the control panel: black screens, no smoke
const clients = new Map();   // id -> { ua, lastSeen, driftMs, loaded }

// Every log line is appended to logs/YYYY-MM-DD.log (one file per day, never deleted).
// The latest ones are also kept in memory for the bottom of the control panel.
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const pad = (n, w = 2) => String(n).padStart(w, '0');
const logs = [];   // { t: timestamp (ms), msg }
function log(...args) {
  const d = new Date();
  const msg = args.join(' ').trim();
  console.log(d.toLocaleTimeString('en-GB'), ...args);
  logs.push({ t: d.getTime(), msg });
  if (logs.length > 300) logs.shift();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  try { fs.appendFileSync(path.join(LOG_DIR, `${day}.log`), `${day} ${time}  ${msg}
`); } catch {}
}

// Screens going offline / coming back (no request for 10 s = offline)
const online = new Map();   // id -> boolean
setInterval(() => {
  for (const [id, c] of clients) {
    const on = Date.now() - c.lastSeen < 10000;
    if (online.get(id) !== on) {
      online.set(id, on);
      log(`Screen ${id} ${on ? 'back online' : 'went offline'}`);
    }
  }
}, 2000);

// ---------- Smoke machine ----------

async function hit(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (e) {
    log('  ! request failed', url, e.message);
    return false;
  }
}

let smokeActiveUntil = 0;    // the smoke is running until this time (for the control panel)
let smokeOffTimer = null;
const smokeDurationMs = () => Math.round((state.smokeDurationSec ?? (smoke.pulseMs || 3000) / 1000) * 1000);

async function triggerSmoke(reason) {
  if (!state.smokeEnabled) return;
  const dur = smokeDurationMs();
  smokeCount++;
  lastSmokeAt = Date.now();
  smokeActiveUntil = lastSmokeAt + dur;
  log(`💨 SMOKE #${smokeCount} (${reason}) for ${dur / 1000} s`);
  if (smoke.mode !== 'http') return;
  clearTimeout(smokeOffTimer);
  await hit(smoke.onUrl);
  if (smoke.offUrl) smokeOffTimer = setTimeout(() => hit(smoke.offUrl), dur);
}

// Is the smoke machine (or its relay) reachable? Checked every 5 s in "http" mode:
// any HTTP answer from the relay counts as a live link.
const machine = { mode: smoke.mode || 'log', target: null, reachable: null, checkedAt: null };
async function probeMachine() {
  if (machine.mode !== 'http' || !smoke.onUrl) return;
  machine.target = new URL(smoke.onUrl).host;
  let ok = true;
  try { await fetch(`http://${machine.target}/`, { signal: AbortSignal.timeout(1500) }); } catch { ok = false; }
  if (ok !== machine.reachable) log(ok ? `Smoke machine relay reachable (${machine.target})` : `Smoke machine relay NOT reachable (${machine.target})`);
  machine.reachable = ok;
  machine.checkedAt = Date.now();
}
setInterval(probeMachine, 5000);
probeMachine();

// ---------- Schedule (Automation tab) ----------
// With the schedule enabled, the system only runs inside the configured time windows.
// All schedule times are GMT (UTC), whatever the timezone of the server.
// Outside them it is "stopped", unless someone presses "Resume video": it then runs
// until the end of the next window.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (t, isEnd) => { const [h, m] = t.split(':').map(Number); const v = h * 60 + m; return isEnd && v === 0 ? 1440 : v; };   // end 00:00 = midnight
let scheduleOverride = false;   // resumed by hand outside a window
let wasInWindow = null;

function scheduleWindows(now) {
  const out = [];
  for (let off = -1; off <= 8; off++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + off);
    const at = (min) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, min);
    for (const r of state.schedule.days[DAY_KEYS[d.getUTCDay()]] || []) out.push({ start: at(minutesOf(r.start, false)), end: at(minutesOf(r.end, true)) });
  }
  return out;
}
function scheduleInfo(now = Date.now()) {
  const w = scheduleWindows(now);
  const ends = w.map((x) => x.end).filter((e) => e > now);
  const starts = w.map((x) => x.start).filter((e) => e > now);
  return {
    inWindow: w.some((x) => x.start <= now && now < x.end),
    nextEndAt: ends.length ? Math.min(...ends) : null,
    nextStartAt: starts.length ? Math.min(...starts) : null,
  };
}

function stopPlayback(reason) {
  stopped = true;
  cutSmoke();
  log(`⏹ Stopped (${reason}): black screens`);
}

function scheduleTick() {
  if (!state.schedule.enabled) { wasInWindow = null; scheduleOverride = false; return; }
  const { inWindow } = scheduleInfo();
  if (wasInWindow === null) wasInWindow = inWindow;
  if (inWindow && !wasInWindow && stopped) { restart(); log('Schedule: window started, video started'); }
  if (!inWindow && wasInWindow) { scheduleOverride = false; if (!stopped) stopPlayback('end of time window'); }
  if (!inWindow && !scheduleOverride && !stopped) stopPlayback('outside schedule');
  wasInWindow = inWindow;
}
setInterval(scheduleTick, 1000);

// Cuts any smoke in progress
function cutSmoke() {
  smokeActiveUntil = 0;
  clearTimeout(smokeOffTimer);
  if (smoke.mode === 'http' && smoke.offUrl) hit(smoke.offUrl);
}

// ---------- Videos ----------

// Three fixed slots: video/slot-1.mp4, slot-2.mp4, slot-3.mp4
const SLOTS = [1, 2, 3];
function listVideos() {
  return SLOTS.map((slot) => {
    const name = `slot-${slot}.mp4`;
    try {
      const st = fs.statSync(path.join(VIDEO_DIR, name));
      const label = (state.slots[slot] && state.slots[slot].label) || '';
      return { slot, name, label, size: st.size, version: Math.round(st.mtimeMs) };
    } catch { return null; }
  }).filter(Boolean);
}

// Video of a screen: the one assigned to it, else the config default, else the first one.
function videoFor(id) {
  const videos = listVideos();
  const wanted = state.phones[id] && state.phones[id].video;
  const fallback = path.basename(config.videoFile || '');
  return videos.find((v) => v.name === wanted) || videos.find((v) => v.name === fallback) || videos[0] || null;
}

const volumeFor = (id) => (state.phones[id] && state.phones[id].volume != null ? state.phones[id].volume : 100);

// The cycle lasts as long as the longest video in use.
function updateDuration() {
  if (fixedDurationMs) return;
  const ids = new Set([...Object.keys(state.phones), ...clients.keys()]);
  let max = null;
  for (const id of ids) {
    const v = videoFor(id);
    const d = v && durations.get(v.name);
    if (d && (max === null || d > max)) max = d;
  }
  if (max !== null && max !== durationMs) {
    durationMs = max;
    log(`Cycle length: ${(durationMs / 1000).toFixed(3)} s`);
    restart();
  }
}

// Addresses of this machine, read again every few seconds so the QR code in the control panel
// follows the network if the IP ever changes. Local network first, Tailscale last.
let addrCache = { at: 0, urls: null };
function accessUrls() {
  if (Date.now() - addrCache.at < 3000) return addrCache.urls;
  const rank = (ip) => (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(ip) ? 0 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? 2 : 1);
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
    .sort((a, b) => rank(a) - rank(b));
  const urls = ips.length ? { admin: `http://${ips[0]}:${config.port}/admin`, screens: `http://${ips[0]}:${config.port}/` } : null;
  addrCache = { at: Date.now(), urls };
  return urls;
}

// Name of the Wi-Fi network this machine is on (NetworkManager, i.e. Raspberry Pi OS). null if unknown
// or on a cable. Refreshed in the background at most every 10 s.
let wifiName = null, wifiAt = 0;
function refreshWifiName() {
  if (Date.now() - wifiAt < 10000) return;
  wifiAt = Date.now();
  execFile('nmcli', ['-t', '-f', 'active,ssid', 'dev', 'wifi'], { timeout: 3000 }, (err, out) => {
    const line = err ? null : String(out).split('\n').find((l) => l.startsWith('yes:'));
    wifiName = line ? line.slice(4).replace(/\\(.)/g, '$1') || null : null;
  });
}

// One cycle = video (durationMs) + black screen (gapMs).
// Smoke no. k (k >= 1) fires at t0 + (k-1)*cycle + smokeOffset: at the moment
// chosen in the control panel.
let reloadToken = Date.now();
const cycleMs = () => durationMs + gapMs;
const smokeOffsetMs = () => Math.min(state.smokeAtSec * 1000, durationMs);
const smokeAt = (k) => t0 + (k - 1) * cycleMs() + smokeOffsetMs();
const smokeLoopsNow = () => Math.floor((Date.now() - t0 + (smoke.leadMs || 0) - smokeOffsetMs()) / cycleMs()) + 1;

// Every 20 ms, checks whether the smoke moment has just been crossed.
setInterval(() => {
  if (!durationMs || stopped) return;
  const loops = smokeLoopsNow();
  if (loops > loopsDone) {
    loopsDone = loops;
    if (loops % (smoke.everyNLoops || 1) === 0) triggerSmoke(`loop ${loops}`);
  }
}, 20);

// The video restarts from the beginning in 2 s: enough time for every screen to
// learn about it (they poll the server every second) and start together.
const START_DELAY_MS = 2000;

function restart() {
  t0 = Date.now() + START_DELAY_MS;
  loopsDone = 0;
  stopped = false;
  log('↺ Timeline restarted');
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webmanifest': 'application/manifest+json',
};

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache ? 'public, max-age=31536000' : 'no-cache',
    };
    // Range requests: needed by the control panel previews to seek inside a video
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // Clock: polled in a loop by the screens (sync + heartbeat).
  // The reply also carries their video and volume, set from the control panel.
  if (url.pathname === '/api/time') {
    const id = url.searchParams.get('id');
    let video = null, volume = 100;
    if (id) {
      const isNew = !clients.has(id);
      clients.set(id, {
        ua: req.headers['user-agent'] || '',
        ip: req.socket.remoteAddress,
        lastSeen: Date.now(),
        driftMs: Number(url.searchParams.get('drift')) || 0,
        loaded: url.searchParams.get('loaded') === '1',
        sound: url.searchParams.get('sound') === '1',
        rttMs: url.searchParams.has('rtt') ? Number(url.searchParams.get('rtt')) : null,
      });
      if (isNew) { log(`Screen connected: ${id}`); online.set(id, true); updateDuration(); }
      // Each screen reports the exact duration of its video (learned again after a server restart)
      const vn = url.searchParams.get('vn'), vd = Number(url.searchParams.get('vd'));
      if (vn && vd > 0 && durations.get(vn) !== Math.round(vd)) {
        const v = listVideos().find((x) => x.name === vn);
        durations.set(vn, Math.round(vd));
        if (v) { state.durations[vn] = { version: v.version, ms: Math.round(vd) }; saveState(); }
        updateDuration();
      }
      const v = videoFor(id);
      if (v) video = { name: v.name, url: `/video/${encodeURIComponent(v.name)}?v=${v.version}` };
      volume = volumeFor(id);
    }
    return json(res, { now: Date.now(), t0, durationMs, gapMs, stopped, video, volume, reload: reloadToken });
  }

  if (url.pathname === '/api/status') {
    const now = Date.now();
    const list = [...clients.entries()]
      .filter(([, c]) => now - c.lastSeen < 60000)
      .map(([id, c]) => ({ id, ...c, ageMs: now - c.lastSeen }));
    let nextSmokeInMs = null;
    if (durationMs && !stopped && state.smokeEnabled) {
      const n = smoke.everyNLoops || 1;
      const next = (Math.floor(loopsDone / n) + 1) * n;
      nextSmokeInMs = smokeAt(next) - (smoke.leadMs || 0) - now;
    }
    const ids = new Set([...Object.keys(state.phones), ...list.map((c) => c.id)]);
    const phones = [...ids].map((id) => {
      const v = videoFor(id);
      return {
        id,
        name: (state.phones[id] && state.phones[id].name) || '',
        video: v ? v.name : null,
        assigned: !!(state.phones[id] && state.phones[id].video),
        volume: volumeFor(id),
        client: list.find((c) => c.id === id) || null,
      };
    });
    return json(res, {
      now, t0, durationMs, gapMs, smokeMode: smoke.mode, stopped, smokeCount, lastSmokeAt, nextSmokeInMs,
      smokeAtSec: state.smokeAtSec, smokeEnabled: state.smokeEnabled, smokeDurationSec: smokeDurationMs() / 1000,
      smokeActive: Date.now() < smokeActiveUntil, urls: accessUrls(), wifi: (refreshWifiName(), wifiName),
      schedule: { ...state.schedule, ...scheduleInfo(), override: scheduleOverride }, machine, logs: logs.slice(-150), videos: listVideos(), phones,
    });
  }

  // Forget a screen: { id }. If the phone is still connected it simply reappears as a new screen.
  if (url.pathname === '/api/phone-delete' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.id || typeof body.id !== 'string') { res.writeHead(400); return res.end('missing id'); }
    delete state.phones[body.id];
    clients.delete(body.id);
    online.delete(body.id);
    saveState();
    log(`Screen ${body.id} forgotten`);
    updateDuration();
    return json(res, { ok: true });
  }

  // Settings of one screen: { id, name?, video?, volume? }
  if (url.pathname === '/api/phone' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.id || typeof body.id !== 'string') { res.writeHead(400); return res.end('missing id'); }
    const ph = state.phones[body.id] || (state.phones[body.id] = {});
    if (typeof body.name === 'string') ph.name = body.name.slice(0, 40);
    if (typeof body.video === 'string') {
      if (body.video === '') delete ph.video;
      else if (listVideos().some((v) => v.name === body.video)) ph.video = body.video;
    }
    if (body.volume != null) ph.volume = Math.max(0, Math.min(100, Math.round(Number(body.volume)) || 0));
    saveState();
    log(`Screen ${body.id}: video ${ph.video || '(default)'}, volume ${ph.volume ?? 100}`);
    updateDuration();
    return json(res, { ok: true });
  }

  // Smoke timing: { atSec, durationSec } — seconds into the video, and how long it runs
  if (url.pathname === '/api/smoke-time' && req.method === 'POST') {
    const body = await readBody(req);
    const at = body.atSec === null || body.atSec === '' ? NaN : Number(body.atSec);
    if (!(at >= 0)) { res.writeHead(400); return res.end('invalid value'); }
    if (body.durationSec !== undefined) {
      const d = Number(body.durationSec);
      if (!(d > 0 && d <= 300)) { res.writeHead(400); return res.end('invalid duration'); }
      state.smokeDurationSec = d;
    }
    state.smokeAtSec = at;
    saveState();
    // No retroactive firing: the next trigger is the next upcoming one
    if (durationMs) loopsDone = Math.max(0, smokeLoopsNow());
    log(`Smoke at ${at} s, for ${smokeDurationMs() / 1000} s`);
    return json(res, { ok: true });
  }

  // Log archive: list of daily files, and the content of one of them
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    let files = [];
    try { files = fs.readdirSync(LOG_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().reverse(); } catch {}
    return json(res, files.map((name) => ({ name, size: fs.statSync(path.join(LOG_DIR, name)).size })));
  }
  if (url.pathname === '/api/logs/file' && req.method === 'GET') {
    const name = url.searchParams.get('name') || '';
    if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(name)) { res.writeHead(400); return res.end('invalid name'); }
    return fs.readFile(path.join(LOG_DIR, name), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  // Schedule: { enabled?, days? } with days = { mon: [{ start: 'HH:MM', end: 'HH:MM' }], ... }
  if (url.pathname === '/api/schedule' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.days !== undefined) {
      const days = {};
      for (const key of DAY_KEYS) {
        const list = (body.days && body.days[key]) || [];
        if (!Array.isArray(list) || list.length > 10) { res.writeHead(400); return res.end('invalid ranges'); }
        for (const r of list) {
          if (!r || !HHMM.test(r.start) || !HHMM.test(r.end) || minutesOf(r.start, false) >= minutesOf(r.end, true)) {
            res.writeHead(400); return res.end('each range needs a start before its end');
          }
        }
        days[key] = list.map((r) => ({ start: r.start, end: r.end }));
      }
      state.schedule.days = days;
    }
    if (body.enabled !== undefined) state.schedule.enabled = !!body.enabled;
    saveState();
    log(`Schedule ${state.schedule.enabled ? 'enabled' : 'disabled'} (updated)`);
    scheduleTick();
    return json(res, { ok: true });
  }

  // Smoke on/off: { enabled: true|false }
  if (url.pathname === '/api/smoke-enabled' && req.method === 'POST') {
    const body = await readBody(req);
    state.smokeEnabled = !!body.enabled;
    saveState();
    log(`Smoke ${state.smokeEnabled ? 'activated' : 'deactivated'}`);
    if (!state.smokeEnabled) cutSmoke();
    return json(res, { ok: true });
  }

  // Replace the video of a slot: raw file body, ?slot=1..3&label=name.mp4
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const slot = Number(url.searchParams.get('slot'));
    const label = path.basename(url.searchParams.get('label') || '').slice(0, 80);
    if (!SLOTS.includes(slot)) { res.writeHead(400); return res.end('invalid slot'); }
    if (!/\.(mp4|mov)$/i.test(label)) { res.writeHead(400); return res.end('The file must be a .mp4 or .mov'); }
    const name = `slot-${slot}.mp4`;
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
    const tmp = path.join(VIDEO_DIR, `.upload-${Date.now()}.tmp`);
    const out = fs.createWriteStream(tmp);
    const fail = () => { out.destroy(); fs.unlink(tmp, () => {}); };
    req.on('aborted', fail);
    out.on('error', () => { fail(); if (!res.headersSent) { res.writeHead(500); res.end('cannot write file'); } });
    out.on('finish', () => {
      fs.rename(tmp, path.join(VIDEO_DIR, name), (err) => {
        if (err) { fs.unlink(tmp, () => {}); res.writeHead(500); return res.end('cannot rename file'); }
        state.slots[slot] = { label };
        saveState();
        durations.delete(name);   // affected screens reload and report the exact duration
        probeDuration(listVideos().find((v) => v.name === name));
        updateDuration();
        log(`Video ${slot} replaced: ${label}`);
        json(res, { ok: true });
      });
    });
    return req.pipe(out);
  }

  if (url.pathname === '/api/smoke' && req.method === 'POST') {
    triggerSmoke('manual test');
    return json(res, { ok: true });
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    stopPlayback('manual');
    return json(res, { ok: true });
  }

  // Screens compare this token on every sync and reload their page when it changes
  if (url.pathname === '/api/reload' && req.method === 'POST') {
    reloadToken = Date.now();
    log('⟳ Reload requested for all screens');
    return json(res, { ok: true });
  }

  if (url.pathname === '/api/restart' && req.method === 'POST') {
    if (state.schedule.enabled && !scheduleInfo().inWindow && !scheduleOverride) {
      scheduleOverride = true;
      log('Resumed outside the schedule: runs until the end of the next time window');
    }
    restart();
    return json(res, { ok: true });
  }

  if (url.pathname.startsWith('/video/')) {
    const name = path.basename(decodeURIComponent(url.pathname.slice(7)));
    if (!listVideos().some((v) => v.name === name)) { res.writeHead(404); return res.end('Not found'); }
    return sendFile(req, res, path.join(VIDEO_DIR, name), true);   // the URL carries ?v=<date>: safe to cache
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(req, res, path.join(ROOT, 'public/index.html'));
  if (url.pathname === '/admin') return sendFile(req, res, path.join(ROOT, 'public/admin.html'));
  if (url.pathname === '/manifest.webmanifest') return sendFile(req, res, path.join(ROOT, 'public/manifest.webmanifest'));
  if (url.pathname === '/qrcode.js') return sendFile(req, res, path.join(ROOT, 'public/qrcode.js'));   // QR code generator (MIT), used by the control panel

  res.writeHead(404);
  res.end('Not found');
});

// Duration of an MP4 read from its header (moov > mvhd box), so the cycle length is known
// even before a screen has finished downloading the video. Screens report the exact value later.
function mp4DurationMs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    for (let pos = 0; pos + 8 <= size;) {
      fs.readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0), hdr = 8;
      if (boxSize === 1) { boxSize = Number(head.readBigUInt64BE(8)); hdr = 16; }
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < hdr) return null;
      if (head.toString('latin1', 4, 8) === 'moov') {
        if (boxSize > 64 * 1048576) return null;
        const moov = Buffer.alloc(boxSize - hdr);
        fs.readSync(fd, moov, 0, moov.length, pos + hdr);
        for (let p = 0; p + 8 <= moov.length;) {
          const s = moov.readUInt32BE(p);
          if (s < 8) return null;
          if (moov.toString('latin1', p + 4, p + 8) === 'mvhd') {
            const v1 = moov[p + 8] === 1;
            const timescale = moov.readUInt32BE(p + (v1 ? 28 : 20));
            const duration = v1 ? Number(moov.readBigUInt64BE(p + 32)) : moov.readUInt32BE(p + 24);
            return timescale > 0 && duration > 0 ? Math.round((duration / timescale) * 1000) : null;
          }
          p += s;
        }
        return null;
      }
      pos += boxSize;
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
function probeDuration(v) {
  if (!v || durations.has(v.name)) return;
  const ms = mp4DurationMs(path.join(VIDEO_DIR, v.name));
  if (ms) { durations.set(v.name, ms); log(`Video ${v.slot} duration read from the file: ${(ms / 1000).toFixed(3)} s`); }
}

// Durations learned in a previous run (only if the file has not changed since)
for (const v of listVideos()) {
  const d = state.durations[v.name];
  if (d && d.version === v.version) durations.set(v.name, d.ms);
  else probeDuration(v);
}
updateDuration();

server.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  log(`Server ready. Smoke mode: "${smoke.mode}".`);
  for (const ip of ips) {
    log(`  Phones  → http://${ip}:${config.port}/`);
    log(`  Control → http://${ip}:${config.port}/admin`);
  }
  if (!listVideos().length) log('  ⚠ No video in video/: upload one from the control panel');
});
