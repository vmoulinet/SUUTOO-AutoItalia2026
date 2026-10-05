# SUUTOO – Installation guide

Related: [TECHNICAL.md](TECHNICAL.md) · [DEBUGGING.md](DEBUGGING.md)

Two ways to run the server: on a **PC** (Windows/macOS/Linux, quick start / tests) or on a
**Raspberry Pi** (permanent installation, starts by itself, recovers from crashes).

## 0. What you need

| Item | Notes |
|------|-------|
| Server | PC, or Raspberry Pi running Raspberry Pi OS with desktop (for the kiosk) |
| Node.js 18+ | Nothing else to install (no `npm install`) |
| Network | One Wi-Fi network that the server and all screens share. No internet needed during the show |
| Screens | Phones / tablets, Chrome (Android) or Safari (iOS), plugged into power |
| Videos | Up to 3. H.264 + AAC `.mp4`, portrait 9:16 (720×1280 recommended, 1080×1920 max), 30 fps constant, keyframe every 1–2 s, faststart, **under 150 MB**. The converter tool in the Library tab produces exactly this |
| Smoke (optional) | A Wi-Fi relay (Shelly 1 / 1 Mini) wired as a dry contact across the machine's remote button |

Network rules: the server's address must not change during the event (see
[Fixed IP](#fixed-ip)); client isolation ("AP isolation" / "guest network") must be **off**,
otherwise the screens cannot reach the server.

---

## 1. Install on a PC

1. Install [Node.js](https://nodejs.org) 18 or newer. Check: `node -v`.
2. Get the project folder (clone `https://github.com/vmoulinet/SUUTOO-AutoItalia2026` or copy it).
3. Start it:
   ```
   node server.js
   ```
   The console prints the addresses:
   ```
   Phones  → http://192.168.1.30:8080/
   Control → http://192.168.1.30:8080/admin
   ```
4. **Windows only**: allow Node.js through the firewall (private network) when prompted, or
   screens will not connect. Manual rule (admin PowerShell):
   `New-NetFirewallRule -DisplayName "SUUTOO" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private`
5. Open `/admin`, go to **Library**, import your videos (see [section 4](#4-first-configuration)).

The server stops when the terminal closes and does not restart after a reboot: use the
one-click installer below or the Raspberry Pi install for a real event.

### 1.1 One-click installer (Windows / Mac)

Turns a PC or Mac into the server (backup server): downloads the latest version from GitHub
(no Git, no account: the repository must be **public**), a private copy of Node.js in `.node/`,
starts the server at each login (restarted if it crashes), disables sleep and opens the
firewall (Windows) and puts a **SUUTOO Admin** shortcut on the desktop (opens `/admin` in the default browser). Run it again at any time to **update**: it overwrites the code and restarts.
Videos, `state.json` and logs are kept. Needs internet during the install only.

Run the installer again on a machine where SUUTOO is already installed and it asks: **U**pdate, **R**emove or **Q**uit.
Remove stops the server and undoes everything the installer set up (auto-start, firewall rule, desktop shortcut,
sleep settings put back to their original values), then asks whether to delete the `SUUTOO` folder too (videos,
settings, logs). The folder is kept by default.

- Windows: double-click `deploy/install-windows.bat`
- Mac: double-click `deploy/install-mac.command` (first time: right-click > Open)
- Raspberry Pi (from a USB stick): `bash setup-pi.sh` (section 2.3 bis)

**Only one server must be running
per show**: screens talk to the one address they were opened with and there is no failover or
priority between servers. Two servers would each fire the smoke relay. Stop the other one
(`sudo systemctl stop suutoo` on the Pi, or run the Pi and the PC on different days/networks).

---

## 2. Install on a Raspberry Pi

### 2.1 Prepare the Pi

- Flash **Raspberry Pi OS with desktop** (64-bit recommended) with Raspberry Pi Imager; in the
  advanced options set the hostname, a user, Wi-Fi (or use Ethernet) and **enable SSH**.
- Boot it and make sure it has the network (`hostname -I`).

### 2.2 Copy the project to the Pi

From your PC (adapt the user and host):

```bash
scp -r "Sutuu" pi@raspberrypi:~/suutoo          # or: git clone <repo> ~/suutoo on the Pi
```

Videos are git-ignored: they are not in a clone. Import them from the control panel after install.

### 2.3 Install the server

On the Pi, in the project folder, as the **normal user** (not root):

```bash
cd ~/suutoo
bash deploy/install-pi.sh                  # add --tailscale for remote SSH access
```

It: installs Node.js, git and curl, checks Node ≥ 18, creates and starts the `suutoo`
systemd service (auto-start at boot, restart on crash), enables the hardware watchdog (the
Pi reboots itself if frozen) and enables SSH.

Check:

```bash
systemctl status suutoo
curl -s localhost:8080/api/time | head -c 200
```

#### 2.3 bis One-shot setup from a USB stick

Copy `deploy/setup-pi.sh` to a stick, plug it in the Pi, and run it as the normal user:

```bash
bash /media/$USER/<stick>/setup-pi.sh        # --no-kiosk, --no-tailscale, --claude to adjust
```

It clones the repository, then runs `install-pi.sh --tailscale` and `install-kiosk.sh`
(service, watchdog, SSH, Tailscale login link, kiosk). Run it again to update.

### 2.4 Kiosk mode (control panel on the Pi's own screen)

```bash
bash deploy/install-kiosk.sh
```

It: lets your user start/stop/restart `suutoo` without password, installs the
`suutoo-control` helper (powers the "Start/Stop server" button), disables screen blanking,
opens the admin panel fullscreen in Chromium at login and adds a "SUUTOO Admin" desktop icon.
Reboot to test: `sudo reboot`.

### 2.5 Remote access (optional)

`bash deploy/install-pi.sh --tailscale` and follow the login link. You can then use
`ssh <user>@<pi-tailscale-name>` from anywhere without opening any port. Tailscale addresses
are listed last in the panel's join card, so the local address stays the one shown.

### 2.6 Updating the code on the Pi

```bash
cd ~/suutoo
git pull                                  # only if the folder is a clone, else copy the files
sudo systemctl restart suutoo             # only needed if server.js or config.json changed
```

Changes to files in `public/` apply on the next page load (reload the panel / use
"Reload screens"). Screens keep running through a server restart without visible
interruption (see [TECHNICAL.md §5](TECHNICAL.md#5-persistence-and-restarts)).

---

<a id="fixed-ip"></a>
## 3. Fixed IP address

Screens, the panel and the QR code use the server's IP. Any change breaks the screens'
saved addresses and also changes their identity (new origin = new screens in the panel).

1. In your router / internet box, create a **DHCP reservation** for the server (by MAC address).
   For the Raspberry Pi: `ip link` shows the MAC; use the Wi-Fi MAC if it is on Wi-Fi.
2. Reboot the server and confirm: `hostname -I`.
3. On every Chrome screen that uses the "insecure origin" flag (section 5.1), update
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` to `http://<final-ip>:8080`.
4. Update `smoke.onUrl` / `offUrl` if the relay's IP also changed. Give the relay a
   reservation too.

---

## 4. First configuration

### 4.1 Videos

Control panel → **Library**. There are three fixed slots. Click the import icon (cloud with an
arrow) on a slot and pick an `.mp4`. Screens affected reload by themselves. Each slot shows a
thumbnail, its title (pencil icon to rename it, the file is untouched), the upload date and the
result of an automatic **spec check**. After an upload, a pop-up lists every problem found
(errors = likely not to play or to crash a phone, warnings = works but not ideal). The file is
kept even when problems are reported: fix it and import it again.

**Converting a video**: at the bottom of the Library tab, download the **Conversion tool**
(Windows and Mac). It turns any video into the right format (H.264, 720×1280 portrait, 30 fps,
AAC, under 140 MB) and saves `<name>-suutoo.mp4` next to the original.
- Windows: *before unzipping*, right-click the zip → Properties → tick **Unblock** → OK
  (otherwise Smart App Control refuses the `.bat`). Then double-click `convert-windows.bat`,
  or drop the video on it.
- Mac: double-click `convert-mac.command` (first time: right-click → Open; or
  `bash convert-mac.command` in Terminal).
- First run only: if ffmpeg is not installed, the tool downloads it (~100 MB, needs internet).

### 4.2 `config.json`

Edit, then `sudo systemctl restart suutoo` (or restart `node server.js`).

```json
{
  "port": 8080,
  "videoFile": "video/slot-1.mp4",
  "videoDurationSec": null,
  "blackGapSec": 0,
  "smoke": { "mode": "log", "onUrl": "…", "offUrl": "…", "pulseMs": 3000, "leadMs": 0, "everyNLoops": 1 }
}
```

Keep `port` at 8080 on the Pi (the kiosk script and the control helper assume it).
Full table: [TECHNICAL.md §7](TECHNICAL.md#7-configuration-reference-configjson).

### 4.3 Smoke machine

1. Wire the relay (Shelly 1 / 1 Mini) as a **dry contact** in parallel with the remote's
   button. Do not switch the machine's mains power.
2. Connect the relay to the same Wi-Fi, reserve its IP in the router.
3. Test the relay from a browser: `http://<relay-ip>/relay/0?turn=on` (Gen1) then `…turn=off`.
   For Gen2: `http://<relay-ip>/rpc/Switch.Set?id=0&on=true`.
4. Put the URLs in `config.json`, set `"mode": "http"`, restart the server.
5. Panel → **Smoke machine**: the status line should read "Smoke machine link OK".
   Press **Test smoke** with the machine warm and the room clear. Set the moment (min:sec in
   the video) and the duration. Use `leadMs` if the smoke appears late (≈ 1000).
6. Check with the venue: smoke detectors, ventilation.

**DMX (not active yet).** The Smoke machine tab also has a "DMX interface" block (DMX King
ultraDMX MAX or ENTTEC Open DMX USB: serial port, smoke channel, ON/OFF values). It only saves
the settings; **the server does not send DMX yet**, so the smoke is still driven by `config.json`
(`log` / `http`). If you prepare an ultraDMX MAX: set its port to DMX-OUT with the DMXking eDMX
MAX utility, and set the failsafe to a snapshot with the smoke channel at OFF (by default it
holds the last frame if USB is lost, which could leave smoke on). On the Pi it appears as
`/dev/ttyACM0`.

### 4.4 Schedule (optional)

Panel → **Automation**: add time windows per day. **Times are the Pi's local time** (timezone shown in the panel).
Press **Enable schedule**. Disabled by default.

---

## 5. Preparing each screen

Open `http://<server-ip>:8080/` (or scan the QR code on the panel's join card; the phone
must be on the same Wi-Fi). Add `?debug` to the address during setup to see diagnostics.

**Common**: Auto-lock / screen timeout: **never** · plugged in to power · Do Not Disturb,
notifications off · Wi-Fi on, mobile data off · **start the server before the screens**.

### 5.1 Android (Chrome)

1. Set `chrome://flags/#unsafely-treat-insecure-origin-as-secure` to `http://<server-ip>:8080`,
   restart Chrome (needed because the page is plain HTTP; without this, install and some
   fullscreen features are unavailable).
2. Open the address, menu → **Install app / Add to Home screen**, launch from the icon.
3. Tap the screen once (starts the sound and goes fullscreen).
4. Optional: screen pinning (Settings → Security → App pinning) to lock the device on the page.

### 5.2 iPhone / iPad (Safari)

1. Open the address, Share → **Add to Home Screen**, launch from the icon (fullscreen).
2. **Tap the screen once** to enable sound, set the master volume with the side buttons
   (physical volume is a ceiling for the panel's volume).
3. Settings → Accessibility → **Guided Access** → on. In the app, triple-click the side
   button to lock the phone on the page.
4. Airplane mode + Wi-Fi only.

### 5.3 Name the screens

In the panel → **Screens**, give each card a name (e.g. "Left"), choose its video and volume.
Settings are kept on the server and restored when the screen reconnects.

---

## 6. Pre-show acceptance test

- [ ] `systemctl status suutoo` is `active (running)`; reboot the Pi and confirm it comes back by itself
- [ ] Panel opens on the Pi's screen at boot (kiosk) and from a phone/laptop via the IP
- [ ] Every screen shows **video ✓**, **sound yes**, drift < 50 ms, "seen" < 8 s ago
- [ ] **Restart loop**: all screens start together (visually check side by side)
- [ ] Leave running 15+ minutes: drift stays low, `reloads` stays at 0
- [ ] Pull the Wi-Fi from one screen for 30 s: it keeps playing and resyncs
- [ ] `sudo systemctl restart suutoo`: screens do not go black
- [ ] **Test smoke** produces smoke, then stops after the duration; **Deactivate smoke** blocks it
- [ ] First automatic smoke happens at the configured moment (watch the countdown in the panel)
- [ ] Schedule: enabled, correct windows (Pi local time), status line reads as expected
- [ ] DHCP reservations done for the server and the relay; Chrome flag updated on all screens
- [ ] Library: every video shows "✓ Meets the specs" (or you accept the listed warnings)
- [ ] Pi timezone is right (`timedatectl`), since the schedule uses the Pi's local time
- [ ] Spare videos and a copy of `config.json` / `state.json` stored off the machine

## 7. Backup / restore

Back up: `config.json`, `state.json` (screen names, assignments, schedule, smoke settings) and
the original videos. `video/*.mp4` and `state.json` are git-ignored. Logs (`logs/`) are
optional. To restore: copy back into the project folder and restart the server.
