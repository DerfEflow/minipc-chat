# Dominion AI - external self-heal watchdog (runs every 5 min as the 'Dominion SelfHeal' task).
# The in-process watchdog (watchdog.mjs) cannot restart a HUNG chat server (it lives inside it),
# cannot fix a stopped Tailscale backend, and cannot re-apply a lost serve mapping. This script
# covers those three gaps from OUTSIDE the node process. Silent when healthy; logs anomalies and
# repairs to logs\selfheal.log (rotated at 1 MB). ASCII only - PS 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$logFile = "C:\minipc-chat\logs\selfheal.log"
$tsExe = "C:\Program Files\Tailscale\tailscale.exe"
$chatTask = "MiniPC Chat PWA"
$firstRun = -not (Test-Path $logFile)

function Log($msg) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $msg
    Add-Content -Path $logFile -Value $line -Encoding ASCII
}

# rotate without Remove-Item: keep the last 200 lines when the log passes 1 MB
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
    $tail = Get-Content $logFile -Tail 200
    Set-Content -Path $logFile -Value $tail -Encoding ASCII
    Log "log rotated (kept last 200 lines)"
}

function Probe-Chat {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8088/" -UseBasicParsing -TimeoutSec 12
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

# ---- 1. chat server: loopback must answer 200 (a hung node listens but never responds) ----
$chatOk = Probe-Chat
if (-not $chatOk) { Start-Sleep -Seconds 5; $chatOk = Probe-Chat }
if (-not $chatOk) {
    Log "chat loopback DOWN - restarting task '$chatTask'"
    Stop-ScheduledTask -TaskName $chatTask
    Start-Sleep -Seconds 3   # port-release gap; an instant restart races EADDRINUSE (the 502 gotcha)
    Start-ScheduledTask -TaskName $chatTask
    Start-Sleep -Seconds 12
    if (Probe-Chat) { Log "chat RECOVERED after task restart" }
    else { Log "chat STILL DOWN after task restart - manual attention needed" }
    $chatOk = Probe-Chat
}

# ---- 2. tailscale backend: must be running and logged in ----
$st = (& $tsExe status 2>&1 | Out-String)
if (($LASTEXITCODE -ne 0) -or ($st -match "Logged out|Tailscale is stopped|NeedsLogin|not logged in")) {
    $snip = $st.Trim()
    if ($snip.Length -gt 120) { $snip = $snip.Substring(0, 120) }
    Log ("tailscale backend unhealthy - running 'tailscale up'. status: " + $snip)
    & $tsExe up 2>&1 | Out-Null
    Start-Sleep -Seconds 5
    $st2 = (& $tsExe status 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0 -and $st2 -notmatch "Logged out|stopped") { Log "tailscale RECOVERED" }
    else { Log "tailscale STILL unhealthy after 'up' - may need interactive login" }
}

# ---- 3. serve mapping: the phone's HTTPS URL depends on it ----
$sv = (& $tsExe serve status 2>&1 | Out-String)
if ($sv -notmatch "127\.0\.0\.1:8088") {
    Log "tailscale serve mapping MISSING - reapplying (serve --bg 8088)"
    & $tsExe serve --bg 8088 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    $sv2 = (& $tsExe serve status 2>&1 | Out-String)
    if ($sv2 -match "127\.0\.0\.1:8088") { Log "serve mapping RESTORED" }
    else { Log "serve mapping still missing - check tailscale serve syntax/version" }
}

if ($firstRun) {
    $summary = "selfheal installed; first run: chat={0}" -f $(if ($chatOk) { "up" } else { "DOWN" })
    Log $summary
}
exit 0
