# Dominion AI - hands node installer for a WINDOWS machine (mini-PC / laptop).
#
# Runs the node NATIVELY (not in Docker) so it reaches the whole machine, per Fred's max-access end
# goal. Registers a Scheduled Task that starts at boot and auto-restarts, matching how the existing
# "MiniPC Chat PWA" and "CommandDeck Bridge" tasks run. ASCII-only (PS 5.1 reads .ps1 as ANSI).
#
# Usage (elevated PowerShell):
#   .\install-windows.ps1 -HandsUrl "https://<orchestrator>" -HandsToken "<secret>" -NodeName "mini-pc"
#
# The token is stored in the task's environment via a per-user env var (set with setx), never inlined
# into the task definition or this script. Re-run to update; use -Uninstall to remove.

param(
  [string]$HandsUrl,
  [string]$HandsToken,
  [string]$NodeName = $env:COMPUTERNAME.ToLower(),
  [string]$Roots = "",              # optional explicit roots; blank + MaxAccess=on -> all drives minus carve-outs
  [switch]$MaxAccess = $true,       # Fred's default: max access minus the ironclad carve-outs
  [string]$TaskName = "Dominion Hands",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$nodeScript = Join-Path $PSScriptRoot "hands.mjs"

if ($Uninstall) {
  schtasks /Delete /TN $TaskName /F 2>$null
  Write-Output "Removed scheduled task '$TaskName'."
  return
}

if (-not $HandsUrl -or -not $HandsToken) { throw "HandsUrl and HandsToken are required." }
if (-not (Test-Path $nodeScript)) { throw "hands.mjs not found next to this script ($nodeScript)." }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH. Install Node 24+ first." }

# Persist config as machine env vars (read at runtime by hands.mjs; the token is never in the task XML).
[Environment]::SetEnvironmentVariable("HANDS_URL",   $HandsUrl,   "Machine")
[Environment]::SetEnvironmentVariable("HANDS_TOKEN", $HandsToken, "Machine")
[Environment]::SetEnvironmentVariable("HANDS_NODE",  $NodeName,   "Machine")
if ($MaxAccess) { [Environment]::SetEnvironmentVariable("HANDS_MAX_ACCESS", "1", "Machine") }
if ($Roots)     { [Environment]::SetEnvironmentVariable("HANDS_ROOTS", $Roots, "Machine") }

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$nodeScript`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started '$TaskName' (node=$NodeName, maxAccess=$MaxAccess). It dials out to $HandsUrl."
