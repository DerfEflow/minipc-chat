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

# 4. detached always-on task (S4U + Hidden = survives logoff / no console to Ctrl+C)
Info "Registering the detached task '$TaskName'..."
try {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  $action    = New-ScheduledTaskAction -Execute $Wrapper
  $trigger   = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
                 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Hidden
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  OK "Task registered + started (state: $((Get-ScheduledTask -TaskName $TaskName).State))."
} catch { Write-Host "[FAIL] Task registration: $($_.Exception.Message)" -ForegroundColor Red; Warn "Run as Administrator." }

# 5. local health check
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/" -TimeoutSec 6
  if ($resp.StatusCode -eq 200) { OK "Server responding on http://127.0.0.1:$Port" }
} catch { Warn "Server didn't answer yet on port $Port - check $LogFile (Get-Content '$LogFile' -Tail 20)." }

# 6. Tailscale HTTPS
Info "Exposing it over Tailscale HTTPS..."
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts -and (Test-Path "C:\Program Files\Tailscale\tailscale.exe")) { $ts = "C:\Program Files\Tailscale\tailscale.exe" }
if (-not $ts) { Warn "tailscale CLI not found - install Tailscale, then run:  tailscale serve --bg $Port" }
else {
  try {
    & $ts serve --bg $Port 2>&1 | Out-Host
    $name = ""
    try { $name = ((& $ts status --json | ConvertFrom-Json).Self.DNSName).TrimEnd(".") } catch {}
    Write-Host ""
    if ($name) { OK "PHONE URL:  https://$name/" } else { OK "Served. Run 'tailscale serve status' to see the https URL." }
    Say "Open that URL on your phone (it's on your tailnet), then use the browser menu ->"
    Say "  'Add to Home Screen' / 'Install app'."
    Say "If it errors about HTTPS/certs: in the Tailscale admin console enable MagicDNS + HTTPS Certificates, then re-run 'tailscale serve --bg $Port'."
  } catch { Warn "tailscale serve failed: $($_.Exception.Message). Try manually: tailscale serve --bg $Port" }
}

Write-Host ""
Info "Done. Log: $LogFile   Restart: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
