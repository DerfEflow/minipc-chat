# setup-openssh.ps1 - make THIS Windows machine a reliable SSH target for the Dominion coordinator.
#
# Run once per machine (mini-PC + each laptop) in an ELEVATED PowerShell during Phase 2 wire-up.
# It installs the built-in OpenSSH Server, sets it to auto-start, opens the firewall, and authorizes
# the coordinator's public key for admin login. ASCII-only on purpose (PS 5.1 reads .ps1 as ANSI).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\setup-openssh.ps1 -CoordinatorPublicKey "ssh-ed25519 AAAA... coordinator"
#
# The public key is the coordinator's - generated when we stand the coordinator up. Nothing here
# touches Drive C source files; it only configures the SSH service and the admin authorized_keys.

param(
  [Parameter(Mandatory = $true)]
  [string]$CoordinatorPublicKey
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "This must run in an ELEVATED PowerShell (Run as Administrator)." -ForegroundColor Red
    exit 1
  }
}

Assert-Admin
Write-Host "== Dominion OpenSSH setup ==" -ForegroundColor Cyan

# 1. Install the OpenSSH Server capability if it is not already present.
$cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like "OpenSSH.Server*" }
if ($cap -and $cap.State -ne "Installed") {
  Write-Host "Installing OpenSSH Server..." -ForegroundColor Yellow
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
} else {
  Write-Host "OpenSSH Server already installed." -ForegroundColor Green
}

# 2. Service: auto-start + running.
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Write-Host "sshd service set to Automatic and started." -ForegroundColor Green

# 3. Firewall rule (create only if missing).
if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  Write-Host "Firewall rule for port 22 created." -ForegroundColor Green
} else {
  Write-Host "Firewall rule already present." -ForegroundColor Green
}

# 4. Authorize the coordinator's key for admin login. Windows OpenSSH reads
#    %ProgramData%\ssh\administrators_authorized_keys for members of the Administrators group,
#    and requires its ACL to grant only Administrators + SYSTEM.
$adminKeys = Join-Path $env:ProgramData "ssh\administrators_authorized_keys"
$key = $CoordinatorPublicKey.Trim()

$existing = ""
if (Test-Path $adminKeys) { $existing = (Get-Content $adminKeys -Raw -ErrorAction SilentlyContinue) }
if ($existing -notmatch [regex]::Escape($key)) {
  Add-Content -Path $adminKeys -Value $key -Encoding ascii
  Write-Host "Coordinator public key authorized." -ForegroundColor Green
} else {
  Write-Host "Coordinator public key already authorized." -ForegroundColor Green
}

# Lock the ACL down (required, or sshd ignores the file).
icacls $adminKeys /inheritance:r | Out-Null
icacls $adminKeys /grant "Administrators:F" "SYSTEM:F" | Out-Null
Write-Host "administrators_authorized_keys ACL locked to Administrators + SYSTEM." -ForegroundColor Green

# 5. Report this machine's Tailscale name so Fred can register it with the coordinator.
Write-Host "`n-- Register this machine with the coordinator --" -ForegroundColor Cyan
try {
  $ts = (Get-Command tailscale -ErrorAction SilentlyContinue)
  if ($ts) {
    $name = (& tailscale status --self --json | ConvertFrom-Json).Self.DNSName
    if ($name) { Write-Host ("Tailscale name: " + $name.TrimEnd('.')) -ForegroundColor Green }
  } else {
    Write-Host "Tailscale CLI not found on PATH - grab this machine's name from the Tailscale admin console." -ForegroundColor Yellow
  }
} catch {
  Write-Host "Could not read Tailscale name automatically - grab it from the Tailscale admin console." -ForegroundColor Yellow
}
Write-Host "`nDone. This machine is now a Dominion SSH target." -ForegroundColor Cyan
