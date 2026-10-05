# SUUTOO – Debugging checklists

Related: [TECHNICAL.md](TECHNICAL.md) · [INSTALL.md](INSTALL.md)

Start with the control panel (`/admin` → **Screens** and **Logs**), then follow the matching
checklist. Commands marked 🍓 are for the Raspberry Pi (SSH or terminal).

## Quick reference

**Per-screen status line (panel → Screens)**

| Field | Green | Orange | Red / meaning |
|-------|-------|--------|---------------|
| `offline` | | | no request for > 10 s (the card also names the Wi-Fi network to check) |
| `video ✓` / `video…` | loaded | still downloading | |
| `sound yes` / `sound NO` | sound on | | tap the screen (autoplay blocked) |
| `(vol: …)` | `element` (Android) / `gain` (iOS) | | `ctx-suspended` = not tapped yet · `none` = no audio path |
| `drift` | < 20 ms | < 50 ms | ≥ 50 ms |
| `rtt` | < 50 ms | < 150 ms | ≥ 150 ms (weak Wi-Fi) |
| `seen N s ago` | < 8 s | | ≥ 8 s |

**On a screen, add `?debug` to the URL**: `drift`, `rate`, `lead`, `video`, `uptime`,
`dropped frames`, `sound / vol`, `rtt`, `reloads` (tap to reset).

**Server-side tools**

```bash
journalctl -u suutoo -f                 # 🍓 live server output
systemctl status suutoo suutoo-control  # 🍓
sudo systemctl restart suutoo           # 🍓 safe: screens keep playing
tail -f logs/$(date +%F).log            # today's log (also in panel → Logs, with archive + download)
curl -s http://localhost:8080/api/status | head -c 1500
curl -s "http://localhost:8080/api/time?id=test"
```

Log lines to know: `Screen connected / went offline / back online`, `Cycle length`,
`↺ Timeline restarted`, `💨 SMOKE #n`, `⏹ Stopped (reason)`, `Smoke machine relay (NOT) reachable`,
`Timeline restored from the previous run`, `! request failed <url>`,
`Video N replaced: <file>` / `Video N check: n problem(s)` / `Video N renamed`, `DMX interface: …` (settings only).

---

## A. A screen shows nothing / wrong message

| Message on the screen | Meaning | Fix |
|-----------------------|---------|-----|
| "Server unreachable – check Wi-Fi" | `/api/time` fails | Checklist **B** |
| "No video assigned – waiting…" | server has no video for it | Library has no video in any slot → import one |
| "Loading video…" bar stuck | download in progress / stalled | Wi-Fi weak (rtt), file too large; wait or press **Reload screens** |
| "Loading error – retrying…" | download failed, retries in 5 s | server stopped mid-download, or file removed; check server log |
| "Tap the screen to start" | browser refused `play()` even muted | tap once |
| Black screen | normal outside the video, in the black gap, when **STOPPED**, or outside the schedule | check the panel header: `⏹ STOPPED`? Schedule status? Press **Resume loop** |

Checklist:
- [ ] Panel header shows `STOPPED`? → **Resume loop**. If "outside schedule": see **H**
- [ ] Screen card in panel: `video ✓`? If `video…` for long → download problem
- [ ] A video exists in the slot assigned to the screen (Library not empty)
- [ ] Library tab: read the spec check under the video. Any red ✗ (not H.264, 10-bit, above 1080p, not AAC, > 150 MB) can explain a black or crashing screen: convert it with the Conversion tool and import it again
- [ ] Video is H.264 `.mp4`; try another file; try playing `/video/slot-1.mp4` directly in a browser
- [ ] Press **Reload screens**; if still bad, reload the browser tab/app on the device
- [ ] iPhone: video too big (> ~150 MB) → page killed, `reloads` climbing → use a smaller/lower-bitrate file

## B. A screen cannot reach the server / goes offline

- [ ] Server running? `systemctl status suutoo` 🍓 or the `node server.js` console on the PC
- [ ] From the screen's browser, open `http://<ip>:8080/api/time`: JSON appears?
- [ ] Same Wi-Fi network as the server (not guest network, not mobile data, airplane mode + Wi-Fi on)
- [ ] Router "client isolation / AP isolation" is **off**
- [ ] **IP changed?** (`hostname -I` 🍓 / `ipconfig` PC). Screens still pointing at the old IP fail; fix with a DHCP reservation ([INSTALL.md](INSTALL.md#fixed-ip)), update the Chrome flag and re-open the page. Changing IP creates new screens in the panel: delete the old (offline) ones with the trash icon
- [ ] Windows server: firewall allows Node.js / port 8080 on the private network
- [ ] Port in use: server log `EADDRINUSE` → another process uses 8080 (`sudo ss -ltnp | grep 8080` 🍓)
- [ ] High `rtt` (red): move the router closer, reduce Wi-Fi congestion (many devices), prefer 5 GHz
- [ ] Remember a screen already playing **keeps running** on its last clock when the network drops: "offline" in the panel does not mean black screen

## C. Screens are out of sync

- [ ] Look at `drift` in the panel / `?debug`. Under ~50 ms is fine; the page only corrects drift above **1 s**
- [ ] **High `rtt` or jittery Wi-Fi** is the usual cause: sync error ≈ rtt asymmetry. Improve the network first
- [ ] Press **Restart loop**: everyone restarts together 2 s later. Re-check drift after one minute
- [ ] One screen always behind/ahead after a restart: its `lead` is learned over several starts; let it run a few cycles
- [ ] Old/slow device with high `dropped frames`: lower the video resolution/bitrate
- [ ] Videos of different lengths: the cycle uses the **longest**; the shorter one goes black before the end. Intended
- [ ] A video was replaced / reassigned: the cycle length changed and the loop restarted (log: `Cycle length`)
- [ ] Browser tab in the background or device in power saving mode throttles timers: keep the page in the foreground, disable battery saver
- [ ] Screen was asleep: set auto-lock to never; Guided Access (iOS)

## D. No sound / wrong volume

- [ ] Panel says `sound NO` → **tap the screen once** (after any restart the sound needs a tap)
- [ ] `vol: ctx-suspended` (iPhone): not tapped yet. `vol: none`: Web Audio could not start; reload the page and tap
- [ ] Volume slider at 0 for that screen?
- [ ] Device physical volume at minimum (on iPhone it is a ceiling for the panel)
- [ ] iPhone silent switch: the page requests "playback" audio, so it should be ignored; if not, flip the switch
- [ ] Video has no audio track (check the file)
- [ ] Pops/clicks on volume change: normal volume is ramped; sudden clicks usually mean a hard seek (drift > 1 s) → see **C**
- [ ] A screen restarted by itself keeps playing but **muted** until someone taps it

## E. Smoke does not fire / fires at the wrong time

1. [ ] Panel → **Smoke machine** is **activated** (not greyed, header countdown shows seconds not "deactivated")
2. [ ] Loop not stopped (`⏹ STOPPED`: no automatic smoke; **Test smoke** still works)
3. [ ] Countdown shows a number. "video duration unknown" means no video duration yet: a screen must have loaded the video, or set `videoDurationSec`
4. [ ] `config.json` `smoke.mode` is `"http"` (in `"log"` mode it only writes `💨 SMOKE` to the log, nothing is sent). Server restarted after editing?
5. [ ] Panel status: "Smoke machine link OK (ip)". If "No response":
   - [ ] relay powered and on the same Wi-Fi; its IP unchanged (DHCP reservation)
   - [ ] `curl -v http://<relay-ip>/relay/0?turn=on` from the **server** works (Gen2: `/rpc/Switch.Set?id=0&on=true`)
   - [ ] correct Shelly generation URLs in `onUrl` / `offUrl`
6. [ ] Log shows `💨 SMOKE #n` but no smoke:
   - [ ] `! request failed <url>` follows? → network/relay problem (above)
   - [ ] Relay clicks but machine silent: wiring of the dry contact across the remote's button, remote plugged in, **machine warm and filled with fluid**
   - [ ] Machine ready LED / thermostat: it will not release smoke until heated
7. [ ] Smoke too early/late: adjust **moment** and **duration**, or `leadMs` (≈ 1000 if the machine takes 1 s to react); smoke lasts `Duration` seconds then `offUrl` is called
8. [ ] Smoke never stops: `offUrl` is `null` or unreachable → check the log; press **Deactivate smoke** (this cuts it); fall back to the machine's own switch/mains if needed
9. [ ] Smoke fires only on some loops: `everyNLoops` > 1
10. [ ] "Smoke machine link OK" does **not** prove the machine works, it only proves the relay answers

> Safety: if smoke runs away, press **Stop loop** or **Deactivate smoke** in the panel, or power the machine off at the wall.

## F. Control panel problems

| Symptom | Check |
|---------|-------|
| Panel greys out, "server unreachable" | Server down or network lost (3 failed refreshes ≈ 1.5 s). Back automatically (page reloads) |
| "The command failed…" alert | Server is an old version or unreachable. Restart it |
| Settings jump back after editing | Invalid value rejected (e.g. schedule end before start: red "Not saved" text) |
| Upload fails | Must be `.mp4` / `.mov`; disk full (`df -h` 🍓); connection lost mid-upload; very large file on weak Wi-Fi |
| Pop-up "problems were found" after upload | The file was **kept**, but the spec check found issues (listed in the pop-up and under the video). Errors matter most; convert with the Conversion tool and re-import |
| "Not a valid MP4/MOV file" | Wrong format or corrupted file (index missing); re-export it |
| Warning "Shorter than the longest video" | Intended behaviour: the shorter video goes black for the rest of the cycle. Use videos of equal length if unwanted |
| Thumbnail shows `…` or `–` | `…` = being made (the browser streams a frame of the video); `–` = the frame could not be read (unsupported codec, or timeout after 25 s). Thumbnails are cached in the browser (`localStorage`) |
| Rename does nothing | Title only: Enter saves, Esc cancels; needs a video in the slot |
| Conversion tool blocked on Windows | Right-click the **zip** → Properties → Unblock *before* unzipping, or run `Get-ChildItem -Recurse \| Unblock-File` in the folder. Smart App Control has no "Run anyway" |
| Conversion tool refused on Mac | Right-click → Open, or `bash convert-mac.command` in Terminal |
| Converter cannot download ffmpeg | Needs internet once; otherwise install it yourself (`winget install Gyan.FFmpeg` / `brew install ffmpeg`) |
| DMX settings saved but nothing happens | Expected: DMX output is not implemented yet, only the settings are stored. "Not saved: …" means a value was out of range (channel 1–512, values 0–255, refresh 1–44 Hz) or the port format is invalid |
| Offline screen card says "check if the phone is connected to <network>" | The Wi-Fi name is the one the Pi is on (needs `nmcli`; otherwise "the same network") |
| No QR code | `qrcode.js` not loading, or no non-loopback IPv4 on the server |
| Wrong IP in QR / addresses | Server has several interfaces. First private (192.168 / 10 / 172.16-31) is used, Tailscale last |
| "Start/Stop server" button missing | Only shown when the panel is opened on the Pi itself (`localhost`) |
| Start/Stop button fails | `systemctl status suutoo-control` 🍓, `ls /etc/sudoers.d/suutoo`; re-run `deploy/install-kiosk.sh` |
| Preview black | Preview is muted and loads its own copy; wait for the download, or the screen is offline |
| Wi-Fi name not shown | Needs `nmcli` (NetworkManager). Absent on Windows or on Ethernet: harmless |

## G. Server problems

- [ ] `systemctl status suutoo` 🍓 / `journalctl -u suutoo -n 100` 🍓 for a crash reason
- [ ] `node -v` ≥ 18 (older versions lack `fetch`/`AbortSignal.timeout`)
- [ ] `state.json` corrupted (hand-edited)? The server silently falls back to defaults: screen names/assignments lost. Restore from backup, or delete it to reset
- [ ] `config.json` invalid JSON: server will not start (error at once). Validate with `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"`
- [ ] Disk full: logs/uploads fail. `df -h` 🍓. Delete old `logs/*.log` (never rotated)
- [ ] Server restarted and screens went black? They should not: a **crash/unclean** stop restores the timeline but starts "running". A **clean** stop (< 10 min) restores `STOPPED` too. If screens did restart, look for `Timeline restored from the previous run` in the log (missing = `state.json` lost its `runtime`)
- [ ] Pi freezes: the hardware watchdog should reboot it in ~15 s; check `journalctl -b -1` for the previous boot
- [ ] Time wrong on the Pi without internet: the schedule uses the system clock. Check `date -u`, `timedatectl`

## H. Schedule / automatic start-stop

- [ ] Times are the Pi's local time. If the clock shown in the panel looks off by 1 h or 2 h, check the Pi timezone (`timedatectl`)
- [ ] Status line meaning: green = in window · orange = outside but resumed by hand (stops at end of next window) · red = outside, stopped
- [ ] Nothing starts at the window start: schedule is **enabled**? Server clock right? The window start only starts the video if the system was **stopped**
- [ ] Stops unexpectedly: end of window reached, or a window set to end `00:00` (midnight) vs a typo. A window can't cross midnight; use two
- [ ] Rejected save: start must be before end (`end 00:00` means midnight)
- [ ] Need to run outside the schedule: **Resume loop** (until end of next window) or **Disable schedule**

## I. After a restart / power cut (Raspberry Pi)

- [ ] Pi boots and `suutoo` is `active`: `systemctl is-active suutoo`
- [ ] Screens reconnect by themselves (log: `Screen … back online`). A phone that **rebooted** also needs a **tap** (sound) and Guided Access re-enabled on iOS
- [ ] Kiosk panel reopens on the Pi screen; otherwise run `deploy/kiosk.sh` or double-click "SUUTOO Admin"
- [ ] Smoke relay back on the network (link OK in the panel)
- [ ] IP unchanged (`hostname -I`) or screens/QR use the new one

---

## Collecting information for a bug report

1. Time of the incident and what was expected (note the timezone: logs and schedule are in server local time).
2. Which screen(s): name, id, device model, browser.
3. Panel screenshot of the **Screens** tab.
4. `logs/<date>.log` (panel → Logs → Download) and, on the Pi, `journalctl -u suutoo --since "1 hour ago"`.
5. `?debug` overlay screenshot from the affected screen.
6. `config.json` (smoke URLs redacted if needed).
7. `curl -s http://localhost:8080/api/status > status.json`.
