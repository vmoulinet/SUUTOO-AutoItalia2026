# Expo: 3 synchronised phones + smoke machine

```
        Local Wi-Fi (router or small dedicated router)
 ┌─────────┐  ┌─────────┐  ┌─────────┐
 │ Phone 1 │  │ Phone 2 │  │ Phone 3 │   ← web page, video loaded once into memory
 └────┬────┘  └────┬────┘  └────┬────┘
      └──────── server time ────┘
                   │
         ┌─────────┴─────────┐          ┌──────────────┐     ┌───────────────┐
         │ Computer / Pi     │── HTTP ─▶│ Wi-Fi relay  │────▶│ Smoke machine │
         │   node server.js  │          │ (e.g. Shelly)│     │ (remote)      │
         └───────────────────┘          └──────────────┘     └───────────────┘
```

The server is the **master clock**. Each phone constantly computes where it should be in
the video and corrects itself (invisible micro speed-up/slow-down, or a jump if the gap
exceeds 0.5 s). The server therefore knows exactly when the smoke moment is reached and
fires the smoke itself: no phone needs to "command" the machine.

## Getting started

1. Install [Node.js](https://nodejs.org) (v18+). No other dependency.
2. The 3 videos live in `video/slot-N.mp4` (H.264, 1080p max, ideally < 150 MB each) and are
   replaced from the control panel. Green / blue / red test videos are provided.
3. `node server.js` → the address to open is printed (e.g. `http://192.168.1.30:8080/`).
4. Control panel: `http://<ip>:8080/admin`, in five tabs (Screens, Library, Smoke machine, Automation, Logs):
   - **Screens**: for each phone, a name, the assigned video and the volume (0-100). Settings
     are stored on the server (`state.json`) and restored when the phone reconnects.
     A screen with no assignment plays `videoFile` (`config.json`), else the first video.
   - **Library**: 3 fixed slots (`video/slot-1.mp4` to `slot-3.mp4`). The "import" icon on the
     right of each slot replaces its video (affected screens reload by themselves).
   - **Smoke machine**: countdown, test button, trigger moment in seconds into the video
     and how long the smoke runs (saved automatically as you type), and a Deactivate / Activate switch (greys out the block and
     prevents any smoke, test included).
   - **Live preview** of each screen, on the right of its card: same file, same point in
     the video as the phone (muted, downscaled by the browser).
   - Per screen: drift and network rtt.
   - **Automation**: weekly schedule (Monday to Sunday, several time windows per day, all
     times in the **Pi's local time**). With the schedule enabled, the system only runs inside the windows
     and is stopped outside them. "Resume video" outside a window runs it until the end of
     the next window. A window that starts while the system is stopped starts the video.
     The schedule is disabled by default.

   The cycle lasts as long as the longest video; a shorter video goes black before the
   end of the cycle.

## Preparing each phone

- Settings › Display & Brightness › **Auto-Lock: Never**.
- Open the address in Safari › Share › **Add to Home Screen**, then launch from the icon:
  fullscreen, no Safari bar.
- Settings › Accessibility › turn on **Guided Access**, then triple-click the side button in
  the app: locks the phone on the page (no gestures, no way out).
- Airplane mode + Wi-Fi only, Do Not Disturb, notifications off.
- Keep plugged in to power.
- Add `?debug` to the URL to show diagnostics on screen during setup:

  | Line | Meaning |
  |------|---------|
  | `drift` | offset from the server timeline (good < 20 ms, OK < 50 ms) |
  | `rate` | playback speed, 1 = on time, otherwise a slight catch-up (max ±3 %) |
  | `lead` | how early playback is started to compensate for the start-up delay (learned) |
  | `video` | video file assigned to this screen |
  | `uptime` | time since the page was loaded |
  | `dropped frames` | frames the phone failed to display |
  | `sound` / `vol` | whether sound is active, and the volume set in the control panel |
  | `rtt` | network round trip to the server, in ms (lower = more accurate sync) |
  | `reloads` | number of page reloads; tap the line to reset it to 0 |

**Volume**: set from the control panel. On iPhone, `video.volume` is locked: the page goes
through Web Audio, which only starts after the initial tap (the control panel shows
"sound NO" until then). The physical volume buttons remain a ceiling.

**Sound**: iOS requires a tap on the screen to play with sound. When starting each
phone: load the page, **tap the screen once**, set the master volume with the buttons, then
enable Guided Access. If a screen restarts by itself, it keeps running without sound and
the control panel shows it in red ("sound NO").

If a phone loses Wi-Fi, it keeps running with its last known clock.

## Cycle

Video → black screen for `blackGapSec` seconds (`config.json`, `0` = videos play back to
back, current setting) → video…
The smoke fires at the moment set in the control panel (seconds into the video).

## Connecting the smoke machine

In `config.json`, `smoke` section:

| Key           | Role                                                                   |
|---------------|------------------------------------------------------------------------|
| `mode`        | `"log"` = only prints to the console (tests) · `"http"` = for real    |
| `onUrl`       | URL called to start the smoke                                          |
| `offUrl`      | URL called `pulseMs` later to stop it (can be `null`)                  |
| `pulseMs`     | default smoke duration in ms (overridden by the control panel field)   |
| `leadMs`      | fire X ms **before** the moment (smoke takes ~1 s to come out)         |
| `everyNLoops` | 1 = every loop, 3 = one loop out of three…                             |

**Recommended solution: a Shelly Wi-Fi relay (Shelly 1 / Shelly 1 Mini, ~€15)**
wired as a **dry contact** in parallel with the button of the machine's wired remote
(the button only closes a contact). Never **cut the mains power** of the machine: it has
to stay on to keep its heater hot.

- Shelly Gen1: `http://IP/relay/0?turn=on` / `http://IP/relay/0?turn=off`
- Shelly Gen2/Plus: `http://IP/rpc/Switch.Set?id=0&on=true` / `…&on=false`

If the machine has a DMX input, a USB-DMX interface on the computer is an alternative;
just replace the body of `triggerSmoke()` in `server.js`.

⚠ Check with the venue: smoke detectors, ventilation.

## Logs

Every event (smoke fired, screen connected / offline, video replaced, settings changed…) is
appended with a timestamp to `logs/YYYY-MM-DD.log`, one file per day. Files are never
deleted or rotated by the server. The control panel shows the latest 150 lines, and a dropdown above them opens any
day's archive (with a Download link).

## Day to day

- Start the server **before** switching the phones on (each phone reports its video's
  duration to the server). To stop depending on that, set `videoDurationSec` in
  `config.json`.
- To change a video: replace it from the control panel (no restart needed).
- The **Restart loop** button in the control panel puts everyone back at the start.
