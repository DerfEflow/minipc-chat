# =============================================================================
# Fred's Assistant PWA - mini-PC setup  (run this ON the mini-PC)
# =============================================================================
# Serves the chat PWA + an Ollama proxy on one local port, runs it as a DETACHED
# always-on task, and exposes it over Tailscale HTTPS so your phone can install it.
#
# Run in an ELEVATED PowerShell (Run as administrator):
#   powershell -ExecutionPolicy Bypass -File .\setup-minipc-chat.ps1
# =============================================================================

$ErrorActionPreference = "Stop"
$RepoDir  = $PSScriptRoot
$Port     = 8088
$TaskName = "MiniPC Chat PWA"
$Wrapper  = Join-Path $RepoDir "run-chat.cmd"
$LogFile  = Join-Path $RepoDir "chat.log"
$Server   = Join-Path $RepoDir "server.mjs"

function OK($m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Say($m)  { Write-Host "  $m" }

Write-Host ""
Write-Host "=== Fred's Assistant PWA - mini-PC setup ===" -ForegroundColor Cyan
Write-Host ""

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Warn "Not elevated - registering the task needs admin. Re-run in an elevated PowerShell." }

# 1. update (best-effort)
try { Push-Location $RepoDir; git -c safe.directory=* pull --ff-only 2>$null | Out-Null; Pop-Location; OK "Code up to date." } catch { Pop-Location -ErrorAction SilentlyContinue; Warn "git pull skipped: $($_.Exception.Message)" }

# 2. node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "[FAIL] Node.js not found on PATH. Install Node, then re-run." -ForegroundColor Red; exit 1 }
OK "node: $node"
if (-not (Test-Path $Server)) { Write-Host "[FAIL] server.mjs not found in $RepoDir." -ForegroundColor Red; exit 1 }

# 3. wrapper (full node path; logs to chat.log; PORT in env)
@(
  '@echo off',
  'cd /d "' + $RepoDir + '"',
  'set PORT=' + $Port,
  '"' + $node + '" "' + $Server + '" >> "' + $LogFile + '" 2>&1'
) | Set-Content -Path $Wrapper -Encoding ascii
OK "Wrote launcher $Wrapper"

# 4. make it always-on as a scheduled task WITH restart-on-failure.
#    Admin     -> S4U + Hidden (fully detached: survives logoff, runs before interactive logon).
#    Non-admin -> Interactive at-logon (the mini-PC auto-logs-in, so the user session is always
#                 present); still restart-on-failure. This replaces the old fragile Startup-folder
#                 launcher. If even a non-elevated task registration is denied, it falls back to the
#                 Startup folder so the result is never worse than before.
$startupCmd = Join-Path ([Environment]::GetFolderPath("Startup")) "minipc-chat.cmd"

# Kill ONLY the process listening on $Port before we (re)start, so a server left from a previous
# run can't double-bind. NEVER 'taskkill /IM node.exe' - the Command Deck bridge poller is also
# node and must keep running.
function Stop-ChatPort($p) {
  try {
    $owners = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $owners) { try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {} }
  } catch {}
}
function Port-Up($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

Info "Registering the always-on task '$TaskName'..."
try { if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false } } catch {}

$action   = New-ScheduledTaskAction -Execute $Wrapper
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
              -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Hidden
$userId   = "$env:USERDOMAIN\$env:USERNAME"
$registered = $false; $mode = ""
try {
  if ($isAdmin) { $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited; $mode = "S4U detached" }
  else          { $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive;            $mode = "Interactive at-logon" }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  $registered = $true
  OK "Registered '$TaskName' ($mode, restart-on-fail 999 x 1min, no time limit)."
} catch {
  Warn "Scheduled-task registration was denied ($($_.Exception.Message)). Falling back to the Startup folder."
}

# (Re)start cleanly: retire the old launcher, free the port, then bring the server up. Prefer the
# task; if it doesn't bind within ~12s (e.g. an Interactive task triggered from a non-interactive
# context), launch the wrapper detached as a guaranteed safety net so the server is never left down.
if ($registered -and (Test-Path $startupCmd)) { Remove-Item $startupCmd -Force -ErrorAction SilentlyContinue }
Stop-ChatPort $Port
Start-Sleep -Milliseconds 800
$broughtUpBy = "none"
if ($registered) {
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { Warn "On-demand task start: $($_.Exception.Message)" }
  for ($t = 0; $t -lt 12 -and -not (Port-Up $Port); $t++) { Start-Sleep -Seconds 1 }
  if (Port-Up $Port) { $broughtUpBy = "task" }
}
if (-not (Port-Up $Port)) {
  if (-not $registered) { Copy-Item $Wrapper $startupCmd -Force; OK "Installed $startupCmd (runs every logon)." }
  Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd /c "' + $Wrapper + '"' } | Out-Null
  for ($t = 0; $t -lt 10 -and -not (Port-Up $Port); $t++) { Start-Sleep -Seconds 1 }
  if (Port-Up $Port) { if ($registered) { $broughtUpBy = "safety-net (task registered; takes over at next logon)" } else { $broughtUpBy = "startup-folder launcher" } }
}
if ($registered) { try { OK "Task state: $((Get-ScheduledTask -TaskName $TaskName).State); server up via: $broughtUpBy." } catch {} }
else             { OK "Server up via: $broughtUpBy." }

# 5. local health check
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 6
  if ($resp.StatusCode -eq 200) { OK "Server responding on http://127.0.0.1:$Port" }
} catch { Warn "Server didn't answer yet on port $Port - check $LogFile (Get-Content '$LogFile' -Tail 20)." }

# 6. Tailscale HTTPS (idempotent: only (re)assert the serve mapping if it isn't already there, so
#    re-runs are fast and we don't re-trigger cert provisioning).
Info "Ensuring the Tailscale HTTPS mapping..."
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts -and (Test-Path "C:\Program Files\Tailscale\tailscale.exe")) { $ts = "C:\Program Files\Tailscale\tailscale.exe" }
if (-not $ts) { Warn "tailscale CLI not found - install Tailscale, then run:  tailscale serve --bg $Port" }
else {
  try {
    $already = $false
    try { $already = (((& $ts serve status) 2>&1 | Out-String) -match (":" + $Port)) } catch {}
    if ($already) { OK "Tailscale already serving port $Port." } else { & $ts serve --bg $Port 2>&1 | Out-Host }
    $name = ""
    try { $name = ((& $ts status --json | ConvertFrom-Json).Self.DNSName).TrimEnd(".") } catch {}
    Write-Host ""
    if ($name) { OK "PHONE URL:  https://$name/" } else { OK "Served. Run 'tailscale serve status' to see the https URL." }
    Say "If it errors about HTTPS/certs: in the Tailscale admin console enable MagicDNS + HTTPS Certificates, then re-run 'tailscale serve --bg $Port'."
  } catch { Warn "tailscale step failed: $($_.Exception.Message). Try manually: tailscale serve --bg $Port" }
}

Write-Host ""
Info "Done. Log: $LogFile   Restart: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
