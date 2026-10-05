@echo off
rem SUUTOO video converter (Windows). Double-click it, or drop a video file on it.
setlocal
set "SUUTOO_FILE=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = Get-Content -Raw -LiteralPath '%~f0'; $i = $f.IndexOf('#PSBEGIN' + '#'); Invoke-Expression $f.Substring($i)"
exit /b
#PSBEGIN#
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$MaxMB = 140; $AudioK = 96; $MaxVideoK = 3500; $MinVideoK = 300

function Find-Ffmpeg {
  $c = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($c) { return Split-Path $c.Source }
  $local = Join-Path $env:LOCALAPPDATA 'SUUTOO-converter\ffmpeg'
  $f = Get-ChildItem $local -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { return $f.DirectoryName }
  return $null
}

try {
  Write-Host ''
  Write-Host '  SUUTOO video converter' -ForegroundColor Cyan
  Write-Host '  Output: H.264, 720x1280 portrait, 30 fps, AAC, under 140 MB, keyframe every second' -ForegroundColor DarkGray
  Write-Host ''

  $in = $env:SUUTOO_FILE
  if (-not $in) {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = 'Choose the video to convert'
    $dlg.Filter = 'Videos|*.mp4;*.mov;*.m4v;*.avi;*.mkv;*.webm;*.mts;*.m2ts;*.mpg;*.wmv|All files|*.*'
    if ($dlg.ShowDialog() -ne 'OK') { return }
    $in = $dlg.FileName
  }
  if (-not (Test-Path -LiteralPath $in)) { throw "File not found: $in" }

  $bin = Find-Ffmpeg
  if (-not $bin) {
    Write-Host '  ffmpeg is needed and was not found. Downloading it once (about 100 MB)...' -ForegroundColor Yellow
    $local = Join-Path $env:LOCALAPPDATA 'SUUTOO-converter\ffmpeg'
    New-Item -ItemType Directory -Force -Path $local | Out-Null
    $zip = Join-Path $local 'ffmpeg.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $local -Force
    Remove-Item $zip
    $bin = Find-Ffmpeg
    if (-not $bin) { throw 'Could not install ffmpeg. Install it yourself (winget install Gyan.FFmpeg) and try again.' }
  }
  $ffmpeg = Join-Path $bin 'ffmpeg.exe'
  $ffprobe = Join-Path $bin 'ffprobe.exe'

  $durText = (& $ffprobe -v error -show_entries format=duration -of csv=p=0 $in | Select-Object -First 1)
  $dur = [double]::Parse($durText.Trim(), [Globalization.CultureInfo]::InvariantCulture)
  # Total bitrate that keeps the file under the size limit, minus the audio
  $videoK = [int][Math]::Floor(($MaxMB * 1048576 * 8) / $dur / 1000 * 0.95 - $AudioK)
  $videoK = [Math]::Max($MinVideoK, [Math]::Min($MaxVideoK, $videoK))

  $dir = Split-Path -Parent $in
  $base = [IO.Path]::GetFileNameWithoutExtension($in)
  $out = Join-Path $dir "$base-suutoo.mp4"
  $n = 2
  while (Test-Path -LiteralPath $out) { $out = Join-Path $dir "$base-suutoo-$n.mp4"; $n++ }

  Write-Host "  Input : $in"
  Write-Host ("  Length: {0:N0} s   video bitrate: {1} kbit/s" -f $dur, $videoK)
  Write-Host "  Output: $out"
  Write-Host ''
  Write-Host '  Converting... (this can take a few minutes)' -ForegroundColor Yellow

  $vf = 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p'
  $ffArgs = @('-hide_banner', '-loglevel', 'warning', '-stats', '-n', '-i', $in,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', $vf,
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-preset', 'medium',
    '-b:v', "${videoK}k", '-maxrate', "$([int]($videoK * 1.25))k", '-bufsize', "$($videoK * 2)k",
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', "${AudioK}k", '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', $out)
  $ErrorActionPreference = 'Continue'
  & $ffmpeg @ffArgs
  if ($LASTEXITCODE -ne 0) { throw 'The conversion failed (see the message above).' }

  $mb = (Get-Item -LiteralPath $out).Length / 1MB
  Write-Host ''
  Write-Host ("  Done: {0}  ({1:N0} MB)" -f $out, $mb) -ForegroundColor Green
  Write-Host '  Now import this file in the SUUTOO control panel (Library tab).'
  if (-not $env:SUUTOO_NOPAUSE) { Start-Process explorer.exe -ArgumentList "/select,`"$out`"" }
} catch {
  Write-Host ''
  Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
if (-not $env:SUUTOO_NOPAUSE) { Write-Host ''; Read-Host '  Press Enter to close' | Out-Null }
