# SUUTOO – Technical documentation

Synchronised multi-screen video wall (phones / tablets in a browser) with a smoke machine
triggered by the server. Zero dependencies: a Node.js server (`server.js` plus two small modules), two static HTML pages.

Related: [INSTALL.md](INSTALL.md) · [DEBUGGING.md](DEBUGGING.md) · [../README.md](../README.md) (operator summary)

---

## 1. Architecture

```
 Screens (Chrome / Safari)                        Server (Node.js, port 8080)
 ┌──────────────────────┐   GET /api/time 1×/s   ┌────────────────────────────┐
 │ public/index.html    │ ─────────────────────▶ │ server.js                  │
 │  - video in memory   │ ◀───────────────────── │  - master clock (t0)       │
 │  - control loop 10Hz │  now, t0, duration,    │  - schedule, smoke, logs   │
 └──────────────────────┘  video, volume, reload │  - state.json persistence  │
 ┌──────────────────────┐   GET /api/status 2×/s │                            │──HTTP──▶ Wi-Fi relay ──▶ smoke machine
 │ public/admin.html    │ ◀────────────────────▶ │                            │         (Shelly, dry contact)
 │  - control panel     │   POST /api/…          └────────────────────────────┘
 └──────────────────────┘                          ▲ optional, Raspberry Pi only
                                                   │ POST localhost:8081/start|stop
                                          deploy/control.js (systemd "suutoo-control")
```

| Component | File | Role |
|-----------|------|------|
| Server | [server.js](../server.js) | HTTP server, master clock, smoke trigger, schedule, persistence, logs |
| Screen page | [public/index.html](../public/index.html) | Downloads the video, locks playback to the server clock |
| Control panel | [public/admin.html](../public/admin.html) | 5 tabs: Screens, Library, Smoke machine, Automation, Logs |
| QR generator | [public/qrcode.js](../public/qrcode.js) | Third-party (MIT), draws the "join" QR code |
| Video checker | [videocheck.js](../videocheck.js) | Reads an MP4 header and lists problems against the SUUTOO specs (section 9) |
| Zip writer | [zipper.js](../zipper.js) | Dependency-free ZIP writer, used to serve the converter download |
| Converter tool | [tools/](../tools) | `convert-windows.bat`, `convert-mac.command`, `README.txt`: ffmpeg wrappers that produce a compliant video |
| Config | [config.json](../config.json) | Static settings, read once at start-up |
| Runtime state | `state.json` (git-ignored) | Settings changed from the panel + timeline, written by the server |
| Videos | `video/slot-{1,2,3}.mp4` (git-ignored) | The 3 fixed slots |
| Logs | `logs/YYYY-MM-DD.log` (git-ignored) | One file per day, never rotated |
| Pi deployment | [deploy/](../deploy) | systemd units, installers, kiosk launcher, control helper |

Requirements: Node.js **18+** (uses global `fetch` and `AbortSignal.timeout`).

---

## 2. Synchronisation model

The server is the **only clock**. There is no per-screen state on the server beyond settings.

### 2.1 Cycle

```
cycle = durationMs + gapMs            durationMs = longest video in use (or config.videoDurationSec)
                                      gapMs      = config.blackGapSec * 1000
position(t) = ((serverNow(t) - t0) mod cycle)
```

A video shorter than the cycle plays, then the screen stays black until the cycle ends.
`t0` is set by `restart()` to `now + 2000 ms` (`START_DELAY_MS`), which gives every screen
time to learn the new value (they poll every second) so they all start together.

`updateDuration()` runs whenever a screen reports a video duration, a video is replaced, a
screen is assigned another video or forgotten. **If the cycle length changes it calls
`restart()`**, so every screen goes back to 0 two seconds later.

### 2.2 Clock offset (screen side, `syncOnce`)

Each `GET /api/time` measures a round trip. A sample is `offset = data.now − (a + rtt/2)`.
The page keeps the last 15 samples and uses the offset of the **sample with the lowest RTT**
(least asymmetric = most accurate). 8 samples are taken at start-up, then one per second.
`serverNow() = performance.now() + offset`. Each request has a 4 s timeout. If the network
drops, the last offset is kept and the screen keeps playing. At start-up, before the first
reply, the screen shows "Server unreachable – check Wi-Fi" (request failed) or "No video
assigned – waiting…" (server answered but has no video for it).

### 2.3 Playback control (screen side, `control()` every 100 ms)

1. **Stopped** (`stopped` flag from the server): video hidden, paused, rewound to 0.
2. **Black phase** (before `t0`, or `position ≥ video duration`): when the remaining time is
   ≤ `startLead + 0.15 s`, a timer starts `play()` exactly `startLead` early so the first
   frame lands on time.
3. **Playing**: measure drift = `video position − target position`.
   - Preferred: `requestVideoFrameCallback` (frame-accurate, uses `expectedDisplayTime`).
   - Fallback: `video.currentTime`.
   - |drift| ≤ 1 s: **nothing is touched** (no `playbackRate` change, avoids audio clicks).
   - |drift| > 1 s: hard seek to `target + 0.2 s`, then a 1.5 s grace period.
4. **`startLead`** (start-up latency of the device) is learned at every start:
   `lead −= drift × 0.7` (clamped 0–0.5 s) and stored in `localStorage.startLead2`.

> The README mentions a ±3 % speed correction and a 0.5 s jump threshold. The current code
> does neither: it only seeks when drift exceeds **1 s**. Drift colours in the panel
> (green < 20 ms, orange < 50 ms, red ≥ 50 ms) are diagnostic only.

### 2.4 Video loading

The whole file is downloaded once with `fetch`, assembled into a `Blob`, and played from
`URL.createObjectURL`. Consequences: no network dependency during playback (a Wi-Fi loss does
not interrupt the show), but the file must fit in the device's memory (keep ≤ ~150 MB; iOS
kills pages that use too much, visible as the `reloads` counter climbing).

The video URL carries `?v=<mtime>` and is served with `max-age=31536000`, so replacing a file
busts the cache automatically.

### 2.5 Screen identity

On first load a screen generates a 6-character random id in `localStorage.screenId`. All
per-screen settings (name, video, volume) are keyed by that id on the server. Clearing the
browser data or using a private tab creates a new screen. **The ID is per browser origin**,
so changing the server IP creates new screens (see [INSTALL.md](INSTALL.md#fixed-ip)).

### 2.6 Audio

| Platform | Mechanism | Panel shows `vol:` |
|----------|-----------|--------------------|
| Android / desktop | `video.volume`, ramped over ~150 ms to avoid pops | `element` |
| iPhone / iPad (`isApple`) | `video.volume` is read-only: Web Audio `GainNode`. Only connected once the `AudioContext` is `running`, which needs a tap | `gain`, `ctx-suspended` (not tapped yet), `none` |

Autoplay with sound is refused until a tap. Without it the video starts **muted** and the
panel shows "sound NO – tap the screen". `navigator.audioSession.type = 'playback'` makes
iPhones ignore the silent switch.

### 2.7 Soft reload vs reload

- **Reload screens** (panel): the server changes `reloadToken`. Screens run `softReload()`:
  black, re-download the video, resume. The page is **not** reloaded, so fullscreen and the
  sound permission survive.
- A change of the assigned video URL (new assignment or replaced file) does a real
  `location.reload()`.
- Load errors: `location.reload()` after 5 s.

---

## 3. Smoke machine

`triggerSmoke(reason)` is the single place that fires the machine.

```
smokeOffset = min(state.smokeAtSec × 1000, durationMs)
smoke k fires at   t0 + (k−1)·cycle + smokeOffset − leadMs
```

A 20 ms interval compares `smokeLoopsNow()` with `loopsDone`; every crossing increments the
counter and, if `loops % everyNLoops == 0`, calls `triggerSmoke`.

`triggerSmoke` does nothing if `smokeEnabled` is false. It does **not** check `stopped` (so
the "Test smoke" button works while stopped). In `http` mode it GETs `onUrl`, then `offUrl`
after the duration (`state.smokeDurationSec`, else `smoke.pulseMs`). A new trigger cancels the
pending "off" timer. `cutSmoke()` (stop, deactivate, shutdown) calls `offUrl` immediately.

`probeMachine()` (every 5 s, `http` mode only) requests `http://<host of onUrl>/` with a
1.5 s timeout. **Any HTTP answer counts as reachable.** It proves the relay is on the
network, not that the machine is wired or powered.

No catch-up: after a restart or a change of the smoke time, moments already in the past are
marked as done (`loopsDone`) and are not fired.

`smoke.mode`:

| Mode | Behaviour |
|------|-----------|
| `log` | Writes the event to the log only. Nothing is sent anywhere |
| `http` | GET `onUrl` / `offUrl` (Shelly Gen1 or Gen2 relay) |
| DMX | **Output not implemented.** Only the settings exist (below). A DMX output would be a new mode next to `http` in `triggerSmoke()` |

### 3.1 DMX interface settings (settings only)

The **Smoke machine** tab has a "DMX interface" block, stored in `state.dmx` and saved
automatically through `POST /api/dmx-config`. **The server does not send any DMX yet**; the
block only records what a future DMX mode will need.

| Field | Values | Notes |
|-------|--------|-------|
| `interface` | `''` (none), `dmxking-max`, `enttec-open` | DMX King ultraDMX MAX, or ENTTEC Open DMX USB |
| `port` | e.g. `/dev/ttyACM0` | Default `/dev/ttyACM0` for ultraDMX MAX (virtual COM port), `/dev/ttyUSB0` for ENTTEC (FTDI). Pattern `[\w./:-]{1,60}` |
| `channel` | 1–512 | Smoke channel |
| `onValue` / `offValue` | 0–255 | Defaults 255 / 0 |
| `refreshHz` | 1–44 | ENTTEC only (the host generates the frames); other interfaces keep 40 |

ultraDMX MAX notes (from the panel): single DMX port, set to **DMX-OUT** with the DMXking eDMX
MAX utility (v2.0+, firmware 4.5). By default the port **holds the last frame** if the USB link
is lost, so smoke could stay on: set the failsafe to a snapshot with the smoke channel at its
OFF value. Selecting an interface switches the port field to that interface's default if it
still holds the other one's default.

---

## 4. Schedule (Automation tab)

All times are in the **server's local timezone** (DST included). Up to 10 windows per day;
`end: "00:00"` means midnight. Windows are not required to be contiguous; overlap is not
checked.

`scheduleTick()` runs every second when the schedule is enabled:

| Transition | Effect |
|------------|--------|
| Outside → inside window, and stopped | `restart()` (video starts) |
| Inside → outside | clears the manual override, `stopPlayback()` |
| Outside, no override, not stopped | `stopPlayback('outside schedule')` |

**Resume loop** outside a window sets `scheduleOverride`, which lasts until the end of the
next window. Disabled schedule = manual control only. A window crossing midnight must be
written as two windows (e.g. 22:00–00:00 and 00:00–02:00).

---

## 5. Persistence and restarts

`state.json` holds:

| Key | Content |
|-----|---------|
| `phones` | `{ id: { name, video, volume } }` |
| `slots` | `{ 1: { label, uploadedAt } }` title shown in the panel (the original file name until renamed) and import time (ms). Without `uploadedAt` (file copied by hand) the file's mtime is used |
| `durations` | `{ file: { version, ms } }` validated against the file's mtime |
| `smokeAtSec`, `smokeDurationSec`, `smokeEnabled` | smoke settings |
| `dmx` | DMX interface settings (section 3.1) |
| `schedule` | `{ enabled, days }` |
| `runtime` | `{ t0, durationMs, reloadToken, stopped?, scheduleOverride?, clean?, savedAt? }` |

Writes are asynchronous (`fs.writeFile`), except on shutdown (synchronous).

**Restart behaviour.** `t0`, the cycle length and `reloadToken` are restored, so screens that
kept playing on their last clock see no change: no black, no restart, no new download. The
`stopped` / override flags are restored **only** after a clean stop (SIGTERM/SIGINT) less than
10 minutes old. After a crash the system starts "running". Video durations are re-read from
the MP4 header (`moov > mvhd`) if the cache is stale.

**Video duration source of truth**: `config.videoDurationSec` if set (fixed, never changes),
otherwise the longest of the durations read from the files / reported by the screens.

---

## 6. HTTP API

No authentication, no TLS. Anyone on the network can call everything. All `POST` bodies are JSON.

| Method & path | Body / query | Purpose |
|---------------|--------------|---------|
| `GET /` | | Screen page |
| `GET /admin` | | Control panel |
| `GET /video/<slot-N.mp4>` | `?v=` | Video, supports `Range`, cacheable |
| `GET /api/time` | `id, drift, rtt, loaded, sound, vm, vn, vd` | Clock + heartbeat. Returns `now, t0, durationMs, gapMs, stopped, video{name,url}, volume, reload` |
| `GET /api/status` | | Everything the panel displays (clients seen < 60 s, logs, schedule incl. `tz`, machine, `dmx`, videos with their `report`, join addresses, Wi-Fi name…) |
| `POST /api/phone` | `{ id, name?, video?, volume? }` | Screen settings (`video: ""` = default) |
| `POST /api/phone-delete` | `{ id }` | Forget a screen |
| `POST /api/smoke` | | Fire the smoke now (test) |
| `POST /api/smoke-time` | `{ atSec, durationSec? }` | Moment in the video / duration (0 < d ≤ 300 s) |
| `POST /api/smoke-enabled` | `{ enabled }` | Activate / deactivate smoke (deactivating cuts it) |
| `POST /api/schedule` | `{ enabled?, days? }` | Weekly schedule (validated: start < end) |
| `POST /api/stop` | | Black screens, no smoke |
| `POST /api/restart` | | Restart at 0 in 2 s (also resumes from stop) |
| `POST /api/reload` | | New `reloadToken`: screens soft-reload |
| `POST /api/dmx-config` | `{ interface, channel, onValue, offValue, port, refreshHz }` | DMX settings, validated (section 3.1). Saved only |
| `POST /api/upload` | raw body, `?slot=1..3&label=name.mp4` | Replace a slot. Written to a temp file then renamed atomically. Replies `{ ok, report }` with the spec check of the new file |
| `POST /api/video-label` | `{ slot, label }` | Rename the title of a video (max 80 chars, control characters stripped). The file is untouched |
| `GET /tools/SUUTOO-converter.zip` | | Converter tool, zipped on the fly (section 9.2) |
| `GET /api/logs` | | List of daily log files |
| `GET /api/logs/file` | `?name=YYYY-MM-DD.log` | Content of one file (name strictly validated) |

Helper (Pi only), `deploy/control.js` on `127.0.0.1:8081`: `POST /start`, `POST /stop` run
`sudo -n systemctl start|stop suutoo`. Rejects any request whose `Origin` is not
`http://localhost:8080` or `http://127.0.0.1:8080`. The "Start/Stop server" button is shown
in the panel only when it is opened on the Pi itself (`location.hostname == localhost`).

### Status flags worth knowing

| Where | Signal | Meaning |
|-------|--------|---------|
| Server | screen "offline" | no `/api/time` for 10 s |
| Server | screen dropped from the list | not seen for 60 s (but kept in `state.phones` if it has settings) |
| Panel | "video duration unknown" | no duration known yet (no screen has loaded the video and the header could not be parsed) |
| Panel | "server unreachable" | `/api/status` failed; after 3 failures (~1.5 s) the page greys out |

---

## 7. Configuration reference (`config.json`)

Read once at start: **restart the server after editing**.

| Key | Default | Meaning |
|-----|---------|---------|
| `port` | 8080 | HTTP port. `deploy/control.js` and the kiosk script assume **8080** |
| `videoFile` | `video/slot-1.mp4` | Video for screens with no assignment |
| `videoDurationSec` | `null` | Fix the cycle length instead of learning it |
| `blackGapSec` | 0 | Black screen between two plays |
| `smoke.mode` | `log` | `log` or `http` |
| `smoke.onUrl` / `offUrl` | Shelly Gen1 URLs | Placeholders (`192.168.1.50`). `offUrl` can be `null` |
| `smoke.pulseMs` | 3000 | Default duration (overridden by the panel) |
| `smoke.leadMs` | 0 | Fire this early (smoke takes ~1 s to appear) |
| `smoke.everyNLoops` | 1 | Fire once every N loops |

Shelly URLs: Gen1 `http://IP/relay/0?turn=on|off` · Gen2 `http://IP/rpc/Switch.Set?id=0&on=true|false`.
The relay must be wired as a **dry contact** across the remote's button. Never switch the
machine's mains.

---

## 8. Deployment files (Raspberry Pi)

| File | Purpose |
|------|---------|
| `deploy/install-pi.sh` | apt install nodejs/git/curl (checks Node ≥ 18), creates and starts `suutoo.service`, enables the hardware watchdog (15 s), enables SSH; optional `--tailscale`, `--claude` |
| `deploy/suutoo.service` | `node server.js`, `Restart=always`, `RestartSec=2`, no start limit; `__USER__` / `__DIR__` are substituted at install |
| `deploy/install-kiosk.sh` | sudoers rule (start/stop/restart `suutoo` only), `suutoo-control.service`, screen blanking off, autostart + desktop icon, no "execute?" prompt |
| `deploy/kiosk.sh` | starts `suutoo` if stopped, waits up to 60 s for the server, opens Chromium `--kiosk` on `/admin` with its own profile. No duplicate if already open |
| `deploy/control.js` | the localhost start/stop helper (section 6) |

Useful commands on the Pi:

```bash
systemctl status suutoo          # state
journalctl -u suutoo -f          # live server log
sudo systemctl restart suutoo    # restart (no password needed for the install user after install-kiosk.sh)
systemctl status suutoo-control  # kiosk helper
```

---

## 9. Video library: spec check and converter

### 9.1 Spec check (`videocheck.js`)

`analyze(file)` reads only the MP4/MOV box structure (`ftyp`, `moov`, `trak`, `stsd`, `stts`,
`stss`, …), without ffmpeg, so it also works offline on the Pi. It returns
`{ summary, issues[{ level: 'error' | 'warn', msg }] }`. The server caches the report per file
version (`reports` map, invalidated on upload) and `/api/status` adds it to each video; the
server also appends a "shorter than the longest video" warning when a video is more than 1 s
shorter than the longest one. On upload the report is returned and a log line
`Video N check: n problem(s)` is written; the panel shows a pop-up and lists the issues under
the video.

| Level | Condition |
|-------|-----------|
| error | structure unreadable / no video track · codec not H.264 · H.264 profile other than Baseline/Main/Extended/High (10-bit, 4:2:2, 4:4:4) · resolution above 1920×1080 · audio codec not AAC · file > 150 MB (with a bitrate hint) |
| warn | `.mov` (QuickTime) container · H.264 level > 4.1 · rotation flag · landscape, or aspect ratio not ≈ 9:16 (screens are portrait, the image is cropped) · variable frame rate, or > 60 fps · keyframe gap > 2.5 s · no audio track · audio sample rate not 44.1/48 kHz · index at the end of the file (no faststart) · duration unreadable |

### 9.2 Converter tool (`tools/`)

The Library tab offers a **Download** button for `/tools/SUUTOO-converter.zip`. The server builds
the ZIP on the fly from `tools/convert-windows.bat`, `tools/convert-mac.command` and
`tools/README.txt`, with Windows line endings for `.bat`/`.txt`, Unix ones and the executable
bit for `.command` (`.gitattributes` enforces the same). The tools run ffmpeg (downloaded once
into `%LOCALAPPDATA%\SUUTOO-converter` or `~/Library/Application Support/SUUTOO-converter` if not
installed) and produce `<name>-suutoo.mp4` next to the source file:

| Parameter | Value |
|-----------|-------|
| Video | H.264 High, level 4.1, 8-bit 4:2:0, 720×1280 portrait (black bars if the source has another shape), 30 fps constant, keyframe every 30 frames (1 s) |
| Audio | AAC 96 kbit/s, 48 kHz, stereo |
| Size | bitrate computed so that the file stays under **140 MB** (clamped 300–3500 kbit/s video) |
| Container | `+faststart` |

The converter runs on the user's computer, not on the server. On Windows the downloaded ZIP
must be **unblocked** (Properties → Unblock) before unzipping, otherwise SmartScreen / Smart App
Control refuses the `.bat`.

### 9.3 Library tab behaviour

- **Thumbnails** are made in the browser (a frame ~2 s into the video, streamed with `Range`
  requests) and cached in `localStorage` per `name:version` (`thumb:` keys); older versions of
  the same slot are purged.
- Each row shows title (with a rename pencil: Enter saves, Esc cancels), upload date/time,
  the spec check result and the one-line summary (codec, size, fps, audio, duration, MB).
- The import icon is a cloud with an up arrow.

---

## 10. Known limitations

- **No authentication or HTTPS.** Use a dedicated / trusted network. Do not expose port 8080 to the internet (use Tailscale for remote access).
- **Plain HTTP on a LAN IP** disables PWA install and some browser features on Chrome. Workaround: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` = `http://<ip>:8080` on each device, redone if the IP changes.
- Screen identity is `localStorage`: new browser profile = new screen.
- Whole video held in memory: large files can crash iOS pages.
- Logs are never rotated; `state.json` is not backed up. Videos are git-ignored, so they live only in `video/` and the originals must be kept elsewhere.
- Uploaded `.mov` files are stored as `slot-N.mp4` without conversion (the spec check warns). Use H.264 MP4, ideally from the converter tool.
- The spec check is structural: it does not decode frames, and the upload is **accepted even when it reports errors** (the panel only warns).
- Smoke status only checks that the relay answers HTTP. There is no feedback from the machine itself (and DMX, when implemented, is one-way).
- DMX: settings only, nothing is sent.
- The README still describes a ±3 % speed correction and a 0.5 s jump threshold (see section 2.3); this documentation follows the code.
- Changing the cycle length (assigning a longer video, replacing a video with a different duration) restarts every screen.
