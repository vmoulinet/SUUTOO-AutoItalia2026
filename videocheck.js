// Checks an MP4/MOV file against the specs SUUTOO expects, reading only the file structure
// (no ffmpeg needed, so it also works on the Pi without internet).
//   analyze(file) -> { summary, issues: [{ level: 'error' | 'warn', msg }] }
// "error" = likely not to play or to crash a phone; "warn" = works but is not ideal.
const fs = require('fs');

const MAX_MB = 150;              // whole file is held in memory by every phone (iPhone kills the page above ~150 MB)
const MAX_KEYFRAME_GAP_S = 2.5;  // recommended: one keyframe every 1-2 s

// Iterates over the boxes found between start and end in buf
function* boxes(buf, start, end) {
  for (let p = start; p + 8 <= end;) {
    let size = buf.readUInt32BE(p), hdr = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) { if (p + 16 > end) return; size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p + hdr, end: p + size };
    p += size;
  }
}
function child(buf, parent, type) {
  for (const b of boxes(buf, parent.start, parent.end)) if (b.type === type) return b;
  return null;
}

const VIDEO_CODECS = { avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265 (HEVC)', hev1: 'H.265 (HEVC)', dvh1: 'Dolby Vision (HEVC)', dvhe: 'Dolby Vision (HEVC)',
  vp09: 'VP9', av01: 'AV1', mp4v: 'MPEG-4 Visual', jpeg: 'Motion JPEG', mjpa: 'Motion JPEG',
  apch: 'ProRes', apcn: 'ProRes', apcs: 'ProRes', apco: 'ProRes', ap4h: 'ProRes', ap4x: 'ProRes' };
const AUDIO_CODECS = { '.mp3': 'MP3', 'mp3 ': 'MP3', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', alac: 'ALAC', fLaC: 'FLAC', sowt: 'PCM', twos: 'PCM', lpcm: 'PCM', in24: 'PCM', ulaw: 'G.711' };
const H264_PROFILES = { 44: 'CAVLC 4:4:4', 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4', 118: 'Multiview High', 128: 'Stereo High' };
const OK_H264_PROFILES = new Set([66, 77, 88, 100]);   // 8-bit 4:2:0

// AAC is announced by an esds box: ES descriptor (tag 3) > decoder config descriptor (tag 4) > object type
function descriptor(buf, p) {
  const tag = buf[p]; let len = 0, i = p + 1;
  for (let n = 0; n < 4; n++) { const b = buf[i++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
  return { tag, start: i, len };
}
function esdsObjectType(buf, esds) {
  try {
    const d3 = descriptor(buf, esds.start + 4);
    if (d3.tag !== 3) return null;
    const d4 = descriptor(buf, d3.start + 3);
    return d4.tag === 4 ? buf[d4.start] : null;
  } catch { return null; }
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function analyze(file) {
  const issues = [];
  const add = (level, msg) => issues.push({ level, msg });
  const info = {};
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    info.sizeMB = size / 1048576;

    // ----- Top level: order of the blocks, file brand
    let moovAt = -1, mdatAt = -1, moovBox = null, brand = '';
    const head = Buffer.alloc(16);
    for (let pos = 0, n = 0; pos + 8 <= size && n < 2000; n++) {
      fs.readSync(fd, head, 0, 16, pos);
      let boxSize = head.readUInt32BE(0), hdr = 8;
      const type = head.toString('latin1', 4, 8);
      if (boxSize === 1) { boxSize = Number(head.readBigUInt64BE(8)); hdr = 16; }
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < hdr) break;
      if (type === 'ftyp') brand = head.toString('latin1', 8, 12);
      if (type === 'moov' && moovAt < 0) moovBox = { pos, hdr, size: boxSize }, moovAt = pos;
      if (type === 'mdat' && mdatAt < 0) mdatAt = pos;
      pos += boxSize;
    }
    if (!moovBox || moovBox.size > 64 * 1048576) {
      add('error', 'Not a valid MP4/MOV file: its structure could not be read (wrong format or corrupted file).');
      return { summary: '', issues };
    }
    const moov = Buffer.alloc(moovBox.size - moovBox.hdr);
    fs.readSync(fd, moov, 0, moov.length, moovBox.pos + moovBox.hdr);

    // ----- moov: durations and tracks
    let durationS = null, video = null, audio = null;
    for (const t of boxes(moov, 0, moov.length)) {
      if (t.type === 'mvhd') {
        const v1 = moov[t.start] === 1;
        const timescale = moov.readUInt32BE(t.start + (v1 ? 20 : 12));
        const duration = v1 ? Number(moov.readBigUInt64BE(t.start + 24)) : moov.readUInt32BE(t.start + 16);
        if (timescale > 0 && duration > 0) durationS = duration / timescale;
      }
      if (t.type !== 'trak') continue;
      const mdia = child(moov, t, 'mdia'), tkhd = child(moov, t, 'tkhd');
      if (!mdia) continue;
      const hdlr = child(moov, mdia, 'hdlr'), mdhd = child(moov, mdia, 'mdhd'), minf = child(moov, mdia, 'minf');
      const stbl = minf && child(moov, minf, 'stbl');
      const kind = hdlr ? moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) : '';
      if (!stbl || !mdhd || (kind !== 'vide' && kind !== 'soun')) continue;
      const stsd = child(moov, stbl, 'stsd');
      if (!stsd) continue;
      const e = stsd.start + 8;                              // first sample entry
      const entryEnd = Math.min(e + moov.readUInt32BE(e), stsd.end);
      const fourcc = moov.toString('latin1', e + 4, e + 8);
      const ts = moov.readUInt32BE(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));

      if (kind === 'vide' && !video) {
        const v = { fourcc, width: moov.readUInt16BE(e + 32), height: moov.readUInt16BE(e + 34), rotation: 0 };
        for (const c of boxes(moov, e + 86, entryEnd)) {
          if (c.type === 'avcC') { v.profile = moov[c.start + 1]; v.level = moov[c.start + 3]; }
        }
        if (tkhd) {                                          // display size and rotation (matrix in 16.16)
          const o = tkhd.start + (moov[tkhd.start] === 1 ? 88 : 76);
          const w = moov.readUInt32BE(o) / 65536, h = moov.readUInt32BE(o + 4) / 65536;
          const m = tkhd.start + (moov[tkhd.start] === 1 ? 52 : 40);
          const a = moov.readInt32BE(m), b = moov.readInt32BE(m + 4), c = moov.readInt32BE(m + 8);
          if (Math.abs(a) < 1000 && Math.abs(b) > 60000) v.rotation = b > 0 ? 90 : 270;
          else if (a < -60000) v.rotation = 180;
          if (w > 0 && h > 0) { v.width = Math.round(w); v.height = Math.round(h); }
          if (v.rotation === 90 || v.rotation === 270) [v.width, v.height] = [v.height, v.width];   // size as displayed
          void c;
        }
        // Frame rate, regularity and keyframes
        const stts = child(moov, stbl, 'stts');
        let samples = 0, ticks = 0, dominant = 0;
        if (stts) {
          const n = moov.readUInt32BE(stts.start + 4);
          for (let i = 0; i < n && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
            const cnt = moov.readUInt32BE(stts.start + 8 + i * 8), delta = moov.readUInt32BE(stts.start + 12 + i * 8);
            samples += cnt; ticks += cnt * delta; if (cnt > dominant) dominant = cnt;
          }
        }
        if (samples > 0 && ticks > 0) { v.fps = samples / (ticks / ts); v.vfr = dominant / samples < 0.98; v.samples = samples; }
        const stss = child(moov, stbl, 'stss');
        if (stss && v.fps) {
          const n = moov.readUInt32BE(stss.start + 4);
          let prev = 1, maxGap = 0;
          for (let i = 0; i < n && stss.start + 8 + i * 4 + 4 <= stss.end; i++) {
            const s = moov.readUInt32BE(stss.start + 8 + i * 4);
            if (i > 0) maxGap = Math.max(maxGap, s - prev);
            prev = s;
          }
          maxGap = Math.max(maxGap, (v.samples + 1) - prev);
          v.keyframeGapS = maxGap / v.fps;
        }
        video = v;
      }
      if (kind === 'soun' && !audio) {
        const a = { fourcc, name: AUDIO_CODECS[fourcc] || fourcc };
        const ver = moov.readUInt16BE(e + 16);
        if (ver === 0) { a.channels = moov.readUInt16BE(e + 24); a.sampleRate = moov.readUInt32BE(e + 32) >>> 16; }
        if (fourcc === 'mp4a') {
          const kids = ver === 0 ? e + 36 : ver === 1 ? e + 52 : e + 72;
          const esds = (() => { for (const c of boxes(moov, kids, entryEnd)) { if (c.type === 'esds') return c; if (c.type === 'wave') { const x = child(moov, c, 'esds'); if (x) return x; } } return null; })();
          const oti = esds ? esdsObjectType(moov, esds) : null;
          a.name = oti === 0x40 || (oti >= 0x66 && oti <= 0x68) ? 'AAC' : oti === 0x6b || oti === 0x69 ? 'MP3' : 'MPEG audio';
        }
        audio = a;
      }
    }

    // ----- Verdict
    if (brand === 'qt  ') add('warn', 'QuickTime (.mov) container: it is stored as .mp4 without conversion. Re-export it as MP4.');
    if (!video) {
      add('error', 'No video track found.');
    } else {
      const codec = VIDEO_CODECS[video.fourcc] || video.fourcc;
      info.codec = codec;
      if (codec !== 'H.264') add('error', `Video codec is ${codec}: use H.264 (AVC). Many phones cannot play it.`);
      else {
        if (video.profile && !OK_H264_PROFILES.has(video.profile)) add('error', `H.264 profile "${H264_PROFILES[video.profile] || video.profile}" (10-bit or 4:2:2/4:4:4): use an 8-bit 4:2:0 High or Main profile.`);
        if (video.level > 41) add('warn', `H.264 level ${(video.level / 10).toFixed(1)}: some phones cannot decode above level 4.1.`);
      }
      const w = video.width, h = video.height;
      if (video.rotation) add('warn', `Video stored with a ${video.rotation}° rotation flag (shown as ${w}×${h}). Re-export it without the flag to be safe.`);
      if (Math.max(w, h) > 1920 || Math.min(w, h) > 1080) add('error', `Resolution ${w}×${h} is above 1920×1080. Re-encode at 1080×1920 or smaller (720×1280 is enough).`);
      if (w > h) add('warn', `Landscape ${w}×${h}: the screens are portrait, so the image is cropped to fill them. Use a 9:16 portrait video.`);
      else if (Math.abs(w / h - 9 / 16) > 0.04) add('warn', `Aspect ratio ${(w / h).toFixed(2)} is not 9:16: the image is cropped on the sides or top and bottom to fill the screens.`);
      if (video.vfr) add('warn', 'Variable frame rate: convert it to a constant frame rate (30 fps) to keep the screens in sync.');
      else if (video.fps > 60.5) add('warn', `Frame rate ${video.fps.toFixed(0)} fps is high: 30 fps is recommended.`);
      if (video.keyframeGapS > MAX_KEYFRAME_GAP_S) add('warn', `Keyframes only every ${video.keyframeGapS.toFixed(1)} s (recommended: every 1 to 2 s). Screens take longer to resynchronise.`);
    }
    if (!audio) add('warn', 'No audio track.');
    else {
      if (audio.name !== 'AAC') add('error', `Audio codec is ${audio.name}: use AAC.`);
      if (audio.sampleRate && audio.sampleRate !== 44100 && audio.sampleRate !== 48000) add('warn', `Audio sample rate is ${audio.sampleRate} Hz: use 44.1 or 48 kHz.`);
    }
    if (moovAt > mdatAt && mdatAt >= 0) add('warn', 'Not optimised for streaming (index at the end of the file): the admin preview starts slowly. Re-export with "faststart" (ffmpeg -movflags +faststart).');
    if (!durationS) add('warn', 'Duration could not be read.');
    if (info.sizeMB > MAX_MB) {
      const hint = durationS ? ` Lower the total bitrate to about ${Math.floor((MAX_MB * 1048576 * 8 * 0.95) / durationS / 1000)} kbit/s.` : '';
      add('error', `File is ${info.sizeMB.toFixed(0)} MB, above the ${MAX_MB} MB limit: every phone keeps the whole video in memory and an iPhone may restart the page.${hint}`);
    }

    // ----- One-line summary
    const parts = [];
    if (video) parts.push(`${info.codec}${video.profile && H264_PROFILES[video.profile] ? ' ' + H264_PROFILES[video.profile] : ''}`, `${video.width}×${video.height}`, video.fps ? `${video.fps.toFixed(video.fps % 1 ? 1 : 0)} fps` : null);
    if (audio) parts.push(`${audio.name}${audio.sampleRate ? ' ' + audio.sampleRate / 1000 + ' kHz' : ''}${audio.channels ? (audio.channels === 1 ? ' mono' : audio.channels === 2 ? ' stereo' : ` ${audio.channels} ch`) : ''}`);
    if (durationS) parts.push(fmtTime(durationS));
    parts.push(`${info.sizeMB.toFixed(0)} MB`);
    issues.sort((x, y) => (x.level === y.level ? 0 : x.level === 'error' ? -1 : 1));
    return { summary: parts.filter(Boolean).join(' · '), issues };
  } catch (e) {
    add('error', 'Could not analyse this file (unreadable or corrupted).');
    return { summary: '', issues };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { analyze, MAX_MB };
