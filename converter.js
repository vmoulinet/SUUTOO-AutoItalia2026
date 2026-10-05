// Converts a video to the format the screens need (H.264, 720x1280, 30 fps, AAC, under 140 MB,
// a keyframe every second, faststart) with ffmpeg, in the background. One conversion at a time,
// at the lowest CPU priority so the show keeps running.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_MB = 140, AUDIO_K = 96, MAX_VIDEO_K = 3500, MIN_VIDEO_K = 300;
const VF = 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p';

let ffmpegOk = null;   // is ffmpeg installed?
execFile('ffmpeg', ['-version'], { timeout: 8000 }, (err) => { ffmpegOk = !err; });

const jobs = new Map();   // slot -> { state: 'running' | 'error', percent, etaSec, error, child, tmp, startedAt, cancelled }
const available = () => ffmpegOk === true;
const busy = () => [...jobs.values()].some((j) => j.state === 'running');
const shorten = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 90);
const unlink = (f) => { try { fs.unlinkSync(f); } catch {} };

function statusFor(slot) {
  const j = jobs.get(slot);
  return j ? { state: j.state, percent: j.percent, etaSec: j.etaSec, error: j.error } : null;
}

// Returns an error message, or null when the conversion started.
// onDone() is called when the converted file is ready in `tmp`: it must put it in place.
function start({ slot, input, tmp, durationMs, onDone }) {
  if (!available()) return 'ffmpeg is not installed on the server';
  if (busy()) return 'Another optimization is already running';
  const seconds = durationMs ? durationMs / 1000 : 0;
  // Video bitrate that keeps the whole file under the size limit
  const videoK = seconds > 0
    ? Math.max(MIN_VIDEO_K, Math.min(MAX_VIDEO_K, Math.floor((MAX_MB * 1048576 * 8) / seconds / 1000 * 0.95 - AUDIO_K)))
    : 1500;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', VF,
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'veryfast',
    '-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.25)}k`, '-bufsize', `${videoK * 2}k`,
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', `${AUDIO_K}k`, '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', tmp];
  const job = { state: 'running', percent: 0, etaSec: null, error: '', tmp, startedAt: Date.now(), cancelled: false, child: null, stderr: '' };
  jobs.set(slot, job);

  let finished = false;
  const finish = (err) => {
    if (finished) return;
    finished = true;
    if (job.cancelled) { unlink(tmp); jobs.delete(slot); return; }
    const fail = (message) => {
      unlink(tmp);
      job.state = 'error';
      job.error = shorten(message);
      setTimeout(() => { if (jobs.get(slot) === job) jobs.delete(slot); }, 60000);   // the message disappears by itself
    };
    if (err) return fail(err);
    try {
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 100 * 1024) throw new Error('the converted file is empty');
    } catch (e) { return fail(e.message); }
    // onDone puts the converted file in place (it may be asynchronous)
    Promise.resolve().then(() => onDone(tmp)).then(() => jobs.delete(slot), (e) => fail(e.message));
  };

  let child;
  try { child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { finish(e.message); return null; }
  job.child = child;
  try { os.setPriority(child.pid, 19); } catch {}
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);   // both are in microseconds in ffmpeg
      if (m && seconds > 0) {
        job.percent = Math.min(99, Math.round((Number(m[1]) / 1e6 / seconds) * 100));
        const elapsed = (Date.now() - job.startedAt) / 1000;
        job.etaSec = job.percent >= 3 ? Math.round((elapsed * (100 - job.percent)) / job.percent) : null;
      }
    }
  });
  child.stderr.on('data', (d) => { job.stderr = (job.stderr + d).slice(-400); });
  child.on('error', (e) => finish(e.message));
  child.on('close', (code) => finish(code === 0 ? '' : (job.stderr.trim().split('\n').pop() || `ffmpeg stopped (code ${code})`)));
  return null;
}

// Cancels a running conversion, or dismisses an error message
function cancel(slot) {
  const j = jobs.get(slot);
  if (!j) return false;
  if (j.state === 'running') { j.cancelled = true; try { j.child.kill(); } catch {} }
  else jobs.delete(slot);
  return true;
}

function cancelAll() {
  for (const j of jobs.values()) if (j.state === 'running') { j.cancelled = true; try { j.child.kill(); } catch {} unlink(j.tmp); }
}

// Leftovers of a conversion interrupted by a crash or a power cut
function cleanTemp(dir) {
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith('.convert-')) unlink(path.join(dir, f)); } catch {}
}

module.exports = { available, busy, start, cancel, cancelAll, statusFor, cleanTemp };
