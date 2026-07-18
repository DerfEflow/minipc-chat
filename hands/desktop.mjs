/*
 * Dominion hands node - desktop control (Windows), zero npm dependencies.
 *
 * Screenshots use .NET System.Drawing; input uses user32.dll through Add-Type, driven by the same
 * PowerShell -EncodedCommand path the rest of the node uses so quoting can never bite.
 *
 * READ THIS BEFORE TRUSTING THE CARVE-OUTS HERE.
 * The D:\ backup and production-database carve-outs are enforced at the TOOL boundary. Desktop
 * control sits below that boundary: a mouse and a keyboard can open File Explorer and reach
 * anything the logged-in user can reach. What follows is real mitigation, and it is not a
 * guarantee of the same strength as the filesystem carve-out:
 *   - typed text and window titles are scanned for protected paths and refused,
 *   - these verbs are owner-only and gated as `dangerous` on the cloud side,
 *   - every call is logged with its arguments like any other tool run.
 * Fred accepted this trade deliberately when he chose full desktop reach (2026-07-18).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";

// Same patterns as the node's tool-boundary guard, applied to anything we are asked to TYPE or
// to any window we are asked to focus. Blunt on purpose.
const PROTECTED_RE = [/(^|[^a-z0-9])d:[\\/]/i, /app[-_ ]?backups?/i, /\bdb[-_ ]?backups?\b/i, /pg_dump|pg_restore/i];
const protectedHit = (s) => PROTECTED_RE.some((re) => re.test(String(s || "")));

// PowerShell preamble: win32 input + screen capture helpers.
const PS_HELPERS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ([System.Management.Automation.PSTypeName]'DomInput').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DomInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
"@
}
`;

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

export function desktopScript(op, args, shotDir) {
  const x = Math.round(Number(args.x) || 0), y = Math.round(Number(args.y) || 0);
  switch (op) {
    case "screenshot": {
      const path = join(shotDir, `screen-${Date.now()}.png`);
      return { path, script: `${PS_HELPERS}
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)
$bmp.Save(${psQuote(path)},[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved " + ${psQuote(path)} + " " + $b.Width + "x" + $b.Height)` };
    }
    case "windows":
      return { script: `${PS_HELPERS}
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $_.Id.ToString() + ' | ' + $_.ProcessName + ' | ' + $_.MainWindowTitle }` };
    case "focus":
      return { script: `${PS_HELPERS}
$p = Get-Process | Where-Object { $_.MainWindowTitle -like ${psQuote("*" + (args.title || "") + "*")} } | Select-Object -First 1
if (-not $p) { Write-Output 'no window matched'; exit 1 }
[void][DomInput]::ShowWindow($p.MainWindowHandle, 9)
[void][DomInput]::SetForegroundWindow($p.MainWindowHandle)
Write-Output ('focused ' + $p.ProcessName + ' | ' + $p.MainWindowTitle)` };
    case "move":
      return { script: `${PS_HELPERS}
[void][DomInput]::SetCursorPos(${x},${y}); Write-Output 'moved ${x},${y}'` };
    case "click": {
      const right = String(args.button || "left") === "right";
      const dn = right ? "RIGHTDOWN" : "LEFTDOWN", upc = right ? "RIGHTUP" : "LEFTUP";
      const dbl = args.double ? `Start-Sleep -Milliseconds 60
[DomInput]::mouse_event([DomInput]::${dn},0,0,0,0); [DomInput]::mouse_event([DomInput]::${upc},0,0,0,0)` : "";
      return { script: `${PS_HELPERS}
[void][DomInput]::SetCursorPos(${x},${y})
Start-Sleep -Milliseconds 80
[DomInput]::mouse_event([DomInput]::${dn},0,0,0,0); [DomInput]::mouse_event([DomInput]::${upc},0,0,0,0)
${dbl}
Write-Output 'clicked ${x},${y}'` };
    }
    case "type":
      return { script: `${PS_HELPERS}
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(String(args.text || "").replace(/([+^%~(){}\[\]])/g, "{$1}"))})
Write-Output ('typed ' + ${String(args.text || "").length} + ' chars')` };
    case "key":
      // Raw SendKeys sequence, e.g. "^s" (ctrl+s), "%{F4}" (alt+F4), "{ENTER}".
      return { script: `${PS_HELPERS}
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(String(args.keys || ""))})
Write-Output 'sent keys'` };
    default:
      return null;
  }
}

// Called by executeJob. runShell is injected so this module stays free of process concerns.
export async function desktopOp(op, args, { shotDir, runShell }) {
  if (!IS_WIN) return { ok: false, error: "desktop control is implemented for Windows only on this node" };
  if (op === "type" && protectedHit(args.text)) return { ok: false, refused: true, reason: "typed text references a protected resource (app backups / customer DB) - hard carve-out" };
  if (op === "focus" && protectedHit(args.title)) return { ok: false, refused: true, reason: "window title references a protected resource - hard carve-out" };
  if (op === "screenshot") mkdirSync(shotDir, { recursive: true });

  const built = desktopScript(op, args || {}, shotDir);
  if (!built) return { ok: false, error: "unknown desktop op: " + op };
  const r = await runShell(built.script, 30000);
  if (!r.ok) return { ok: false, error: (r.stderr || r.error || "desktop command failed").slice(0, 400) };
  const out = String(r.stdout || "").trim();
  if (op === "screenshot") return { ok: true, path: built.path, detail: out, note: "saved on the node; pull it with fs_read if you need the bytes" };
  if (op === "windows") return { ok: true, windows: out.split(/\r?\n/).filter(Boolean).slice(0, 60) };
  return { ok: true, detail: out };
}

export const _test = { protectedHit, desktopScript };
