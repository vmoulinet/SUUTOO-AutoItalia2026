# Installs / updates / removes the SUUTOO server on a Windows PC.
# Safe to run again: if SUUTOO is already installed it asks whether to update (pull the latest
# version from GitHub and restart) or to remove everything it set up.
# Use install-windows.bat (double-click), or: powershell -ExecutionPolicy Bypass -File install-windows.ps1
param([string]$Dir = (Join-Path $env:USERPROFILE 'SUUTOO'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Zip = 'https://codeload.github.com/vmoulinet/SUUTOO-AutoItalia2026/zip/refs/heads/main'
$Task = 'SUUTOO server'
$Port = 8080

function Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }
$Backup = Join-Path $Dir '.power-backup.json'
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function RunAdmin($code) {
  if ($IsAdmin) { Invoke-Expression $code }
  else { Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command `"$code`"" }
}
function StopServer {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Dir\*" } | Stop-Process -Force
}
# Current plugged-in timeout (seconds) of a power setting, read from the language-independent hex values
function AcTimeout($setting) {
  $hex = [regex]::Matches((powercfg /q SCHEME_CURRENT SUB_SLEEP $setting | Out-String), '0x[0-9a-fA-F]{8}')
  [Convert]::ToInt32($hex[$hex.Count - 2].Value, 16)
}

if ((Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $Dir '.node'))) {
  Write-Host "SUUTOO is already installed in $Dir."
  $choice = Read-Host '[U]pdate to the latest version, [R]emove everything the installer set up, or [Q]uit? (U/R/Q)'
  if ($choice -match '^[Qq]') { return }
  if ($choice -match '^[Rr]') {
    Step 'Stopping the server and removing auto-start'
    StopServer
    Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
    Step 'Desktop shortcut'
    Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SUUTOO Admin.url') -ErrorAction SilentlyContinue
    Step 'Firewall rule'
    RunAdmin "Remove-NetFirewallRule -DisplayName 'SUUTOO' -ErrorAction SilentlyContinue"
    Step 'Sleep settings back to what they were'
    if (Test-Path $Backup) {
      $b = Get-Content $Backup | ConvertFrom-Json
      powercfg /change standby-timeout-ac ([int]($b.standby / 60))
      powercfg /change hibernate-timeout-ac ([int]($b.hibernate / 60))
    } else { Write-Host 'No backup found, sleep settings left as they are.' }
    $del = Read-Host "Also delete the folder $Dir (videos, settings, logs and the private Node)? [y/N]"
    if ($del -match '^[Yy]') {
      Set-Location $env:USERPROFILE
      Remove-Item $Dir -Recurse -Force -ErrorAction Continue
    } else { Write-Host "Folder kept: $Dir" }
    Write-Host 'SUUTOO removed.' -ForegroundColor Green
    return
  }
}


Step 'Stopping the running server (if any)'
StopServer

Step "Latest version from GitHub -> $Dir"
$tmp = Join-Path $env:TEMP 'suutoo-src'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Invoke-WebRequest $Zip -OutFile "$tmp.zip"
Expand-Archive "$tmp.zip" -DestinationPath $tmp -Force
New-Item -ItemType Directory -Force $Dir | Out-Null
# Overwrites the code only: videos, state.json, logs and .node are not in the archive
Copy-Item (Join-Path (Get-ChildItem $tmp | Select-Object -First 1).FullName '*') $Dir -Recurse -Force
Remove-Item $tmp, "$tmp.zip" -Recurse -Force

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
# Remember the original values (first install only) so that Remove can put them back
if (-not (Test-Path $Backup)) {
  @{ standby = (AcTimeout 'STANDBYIDLE'); hibernate = (AcTimeout 'HIBERNATEIDLE') } | ConvertTo-Json | Set-Content $Backup
}
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Step "Firewall (port $Port, private networks)"
$rule = "New-NetFirewallRule -DisplayName 'SUUTOO' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null; Set-NetFirewallRule -DisplayName 'SUUTOO' -Enabled True"
RunAdmin $rule

Step 'Desktop shortcut'
$desktop = [Environment]::GetFolderPath('Desktop')
Set-Content -Path (Join-Path $desktop 'SUUTOO Admin.url') -Value "[InternetShortcut]`r`nURL=http://localhost:$Port/admin" -Encoding ASCII

Start-Sleep 3
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1).IPAddress
Write-Host ''
Write-Host 'Done. The server starts by itself at each login (set Windows to sign in automatically for an unattended machine).' -ForegroundColor Green
Write-Host "Admin panel: http://${ip}:$Port/admin"
Write-Host 'To update or remove SUUTOO later: run this installer again.'
