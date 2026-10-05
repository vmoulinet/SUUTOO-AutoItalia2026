# Installs / updates the SUUTOO server on a Windows PC.
# Safe to run again: each run pulls the latest version from GitHub and restarts the server.
# Use install-windows.bat (double-click), or: powershell -ExecutionPolicy Bypass -File install-windows.ps1
param([string]$Dir = (Join-Path $env:USERPROFILE 'SUUTOO'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Repo = 'https://github.com/vmoulinet/SUUTOO-AutoItalia2026.git'
$Task = 'SUUTOO server'
$Port = 8080

function Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }

Step 'Git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
  $env:Path += ";$env:ProgramFiles\Git\cmd"
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git was installed but is not found yet: close this window and run the installer again.' }
}

Step 'Stopping the running server (if any)'
Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir\*" } | Stop-Process -Force

Step "Latest version from GitHub -> $Dir"
if (Test-Path "$Dir\.git") {
  git -C $Dir pull --ff-only
} else {
  if (Test-Path $Dir) { throw "$Dir exists but is not a SUUTOO clone. Move it away or pass -Dir." }
  git clone $Repo $Dir
}
if ($LASTEXITCODE -ne 0) { throw 'git failed (sign in to GitHub if asked; the repository is private).' }

Step 'Node.js (private copy, does not touch any Node already installed)'
$NodeDir = Join-Path $Dir '.node'
$Node = Join-Path $NodeDir 'node.exe'
if (-not (Test-Path $Node)) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $lts = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts } | Select-Object -First 1
  $name = "node-$($lts.version)-win-$arch"
  $zip = Join-Path $env:TEMP "$name.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$($lts.version)/$name.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $env:TEMP -Force
  Move-Item (Join-Path $env:TEMP $name) $NodeDir
  Remove-Item $zip
}
& $Node -v

Step 'Auto-start at login, restart if it crashes'
$cmd = "Set-Location '$Dir'; New-Item -ItemType Directory -Force logs | Out-Null; while (`$true) { & '$Node' server.js *>> logs\service.log; Start-Sleep 2 }"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $Task

Step 'Never go to sleep while plugged in'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Step "Firewall (port $Port, private networks)"
$rule = "New-NetFirewallRule -DisplayName 'SUUTOO' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null; Set-NetFirewallRule -DisplayName 'SUUTOO' -Enabled True"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Invoke-Expression $rule }
else { Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command `"$rule`"" }

Start-Sleep 3
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Done. The server starts by itself at each login (set Windows to sign in automatically for an unattended machine).' -ForegroundColor Green
Write-Host "Admin panel: http://${ip}:$Port/admin"
Write-Host 'To update later: run this installer again.'
