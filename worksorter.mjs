/*
 * Dominion AI — WORK ORDER #1: sort a folder's loose files into subfolders by type.
 *
 * Fred's design, 2026-07-31: "instead of trying to trust the interpretation of the different
 * models, why don't we come up with a list of 15 to 20 tasks that we are comfortable with being
 * very straightforward and hard to misinterpret with guardrails built into them."
 *
 * That decision is what makes this file possible. No model reads the instruction, so there is
 * nothing to misinterpret. This is deterministic code with a fixed contract, which means it can be
 * tested exactly, and it can offer something an agent never could: because every action is a
 * recorded move, the whole run can be UNDONE.
 *
 * WHY POWERSHELL. The hands node exposes fs_write, fs_list and shell_run. It has no fs_move. Adding
 * one would mean updating the node software on Fred's laptop, which is not happening at 10pm for a
 * 3am job. The alternative was composing Move-Item command lines server-side, which is precisely
 * where a filename containing a quote, a bracket or an apostrophe destroys somebody's files. So the
 * entire sort is ONE reviewed script, written to the machine and run with the folder as a
 * parameter. Every path inside it is handled with -LiteralPath, which does no globbing and no
 * interpretation.
 *
 * THE GUARDRAILS, all enforced inside the script rather than by the caller:
 *   - LOOSE FILES ONLY. It reads the immediate contents of the folder. It never recurses, so a
 *     folder already sorted into subfolders is left alone and running twice is a no-op.
 *   - NEVER DELETES. There is no Remove-Item anywhere in it.
 *   - NEVER OVERWRITES. A collision becomes "report (2).pdf". A destination that exists is never
 *     replaced, which is the single most common way a "tidy up" script eats work.
 *   - NEVER LEAVES THE ROOT. Every destination is composed from the root; the script re-checks the
 *     resolved path is still under the root before each move and aborts the file if not.
 *   - SKIPS WHAT IT SHOULD NOT TOUCH: hidden, system, read-only, and anything locked by another
 *     process. Those are reported, never forced.
 *   - CAPPED. Stops after MaxFiles and says so, so a folder with 400,000 files cannot run for hours.
 *   - REPORTS EVERY MOVE as JSON, which becomes the journal the undo is built from.
 *
 * ASCII only and no BOM: PowerShell on this machine mangles a UTF-8 BOM in a .ps1.
 */

// Extension -> folder name. Deliberately boring and explicit. Anything unlisted goes to "Other",
// which is the honest answer for a file we have no opinion about.
export const SORT_CATEGORIES = {
  Images: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "svg", "ico", "raw", "cr2", "nef"],
  Documents: ["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "pages", "epub", "mobi"],
  Spreadsheets: ["xls", "xlsx", "csv", "ods", "numbers", "tsv"],
  Presentations: ["ppt", "pptx", "odp", "key"],
  Archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
  Video: ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm", "m4v", "mpg", "mpeg"],
  Audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff"],
  Installers: ["exe", "msi", "dmg", "pkg", "appx", "deb", "rpm"],
  Code: ["js", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "php", "sh", "ps1", "sql", "json", "xml", "yaml", "yml", "html", "css"],
};

export const SORT_FOLDERS = [...Object.keys(SORT_CATEGORIES), "Other"];

// The PowerShell map literal, generated from the table above so there is ONE source of truth.
function psCategoryMap() {
  const lines = [];
  for (const [folder, exts] of Object.entries(SORT_CATEGORIES)) {
    for (const e of exts) lines.push(`  '${e}' = '${folder}'`);
  }
  return "@{\n" + lines.join("\n") + "\n}";
}

/*
 * The script. Emits a single line of JSON on stdout prefixed with a marker, so the caller can find
 * the result even if PowerShell prints a warning above it.
 */
const SORTER_BODY = `$ErrorActionPreference = 'Stop'
$ext2folder = ${psCategoryMap()}
$knownFolders = @(${SORT_FOLDERS.map((f) => `'${f}'`).join(",")})

$result = [ordered]@{
  ok = $false; root = $Root; dryRun = [bool]$DryRun
  moved = @(); skipped = @(); created = @()
  scanned = 0; capped = $false; error = ''
}

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  Write-Output ('DOMINION_RESULT ' + $json)
}

try {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    $result.error = 'That folder does not exist on this machine: ' + $Root
    Emit $result; exit 0
  }
  $rootItem = Get-Item -LiteralPath $Root
  $rootFull = $rootItem.FullName.TrimEnd('\\')

  # Immediate children only. No recursion: a folder already sorted stays sorted, and running this
  # twice does nothing the second time.
  $files = @(Get-ChildItem -LiteralPath $rootFull -File -Force)
  $count = 0

  foreach ($f in $files) {
    if ($count -ge $MaxFiles) { $result.capped = $true; break }
    $count++
    $result.scanned = $count

    # Leave alone anything the operating system marks as special. Forcing these is how a tidy-up
    # script breaks an application that was relying on them.
    $attrs = $f.Attributes
    if ($attrs -band [IO.FileAttributes]::Hidden)   { $result.skipped += @{ name = $f.Name; why = 'hidden' }; continue }
    if ($attrs -band [IO.FileAttributes]::System)   { $result.skipped += @{ name = $f.Name; why = 'system' }; continue }
    if ($attrs -band [IO.FileAttributes]::ReadOnly) { $result.skipped += @{ name = $f.Name; why = 'read-only' }; continue }

    $ext = $f.Extension.TrimStart('.').ToLowerInvariant()
    $folder = 'Other'
    if ($ext -and $ext2folder.ContainsKey($ext)) { $folder = $ext2folder[$ext] }

    $destDir = Join-Path $rootFull $folder

    # Belt and braces: the destination must still be inside the root. A category name can never
    # escape, but this is the check that would catch it if one ever could.
    $destDirFull = [IO.Path]::GetFullPath($destDir)
    if (-not $destDirFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      $result.skipped += @{ name = $f.Name; why = 'destination resolved outside the folder' }; continue
    }

    # Never overwrite. "report.pdf" meeting an existing "report.pdf" becomes "report (2).pdf".
    $target = Join-Path $destDirFull $f.Name
    if (Test-Path -LiteralPath $target) {
      $base = [IO.Path]::GetFileNameWithoutExtension($f.Name)
      $suffix = $f.Extension
      $n = 2
      while (Test-Path -LiteralPath $target) {
        $target = Join-Path $destDirFull ($base + ' (' + $n + ')' + $suffix)
        $n++
        if ($n -gt 999) { break }
      }
      if (Test-Path -LiteralPath $target) {
        $result.skipped += @{ name = $f.Name; why = 'too many name collisions' }; continue
      }
    }

    if ($DryRun) {
      $result.moved += @{ from = $f.FullName; to = $target; planned = $true }
      continue
    }

    if (-not (Test-Path -LiteralPath $destDirFull -PathType Container)) {
      New-Item -ItemType Directory -Path $destDirFull -Force | Out-Null
      if ($result.created -notcontains $folder) { $result.created += $folder }
    }

    try {
      Move-Item -LiteralPath $f.FullName -Destination $target -ErrorAction Stop
      $result.moved += @{ from = $f.FullName; to = $target }
    } catch {
      # A file open in another program is the usual cause. Reported, never forced.
      $result.skipped += @{ name = $f.Name; why = ('could not move: ' + $_.Exception.Message) }
    }
  }

  $result.ok = $true
  Emit $result
} catch {
  $result.error = $_.Exception.Message
  Emit $result
}
`;

/*
 * Two ways to run the same body, one source of truth.
 *
 * SORTER_PS1 is the file form, taking parameters, which is what the test drives.
 *
 * sorterCommand() is what actually runs on Fred's laptop: the same body with the inputs prepended
 * as variables, the whole thing base64'd into -EncodedCommand. That choice does two jobs at once.
 * It leaves no script file behind, so the node's roots containment never has to be widened to let
 * a scratch file be written. And because the folder path arrives base64 and is decoded INSIDE
 * PowerShell, it passes through no parser on the way: a folder named  C:\Fred's "stuff" [2026]
 * cannot break the command, because at no point is it part of the command text.
 */
export const SORTER_PS1 = `# Dominion AI work order: sort loose files by type. Generated; do not edit on the machine.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [switch]$DryRun,
  [int]$MaxFiles = 5000
)
${SORTER_BODY}`;

const b64utf8 = (s) => Buffer.from(String(s), "utf8").toString("base64");

/*
 * These return PLAIN POWERSHELL TEXT, because hands/hands.mjs already base64s whatever command it
 * is given into -EncodedCommand and spawns powershell DIRECTLY rather than through cmd.exe. Two
 * consequences, both learned by running it:
 *
 *   - Pre-encoding here would double-encode and produce gibberish.
 *   - cmd.exe caps a command line at 8191 characters and this script encodes to about 13KB, which
 *     is exactly the "The command line is too long" wall the first attempt hit. Spawning powershell
 *     directly raises that to 32767, so the script fits with room to spare. The failure only showed
 *     up because the probe went through execSync (which uses cmd) rather than the node's own path.
 *
 * The FOLDER PATH still arrives base64 and is decoded inside PowerShell. It therefore passes
 * through no parser on the way in, so a folder named  C:\Fred's [2026] & co  cannot break anything,
 * because at no point is it part of the command text.
 */
export function sorterCommand({ root, dryRun = false, maxFiles = 5000 } = {}) {
  const head = [
    `$Root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(root)}'))`,
    `$DryRun = $${dryRun ? "true" : "false"}`,
    `$MaxFiles = ${Math.max(1, Math.min(Number(maxFiles) || 5000, 100000))}`,
  ].join("\n");
  return head + "\n" + SORTER_BODY;
}

export function undoCommand({ moves = [] } = {}) {
  const payload = JSON.stringify(moves.map((m) => ({ from: m.from, to: m.to })));
  return `$Journal = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(payload)}'))\n` + UNSORTER_BODY;
}

/*
 * The UNDO script. Takes the journal this run produced and puts every file back where it was.
 * Refuses to overwrite on the way back too, so an undo can never destroy something created since.
 */
const UNSORTER_BODY = `$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok = $false; restored = @(); skipped = @(); error = '' }
function Emit($obj) { Write-Output ('DOMINION_RESULT ' + ($obj | ConvertTo-Json -Depth 6 -Compress)) }
try {
  $moves = $Journal | ConvertFrom-Json
  foreach ($m in $moves) {
    if (-not (Test-Path -LiteralPath $m.to)) { $result.skipped += @{ to = $m.to; why = 'no longer there' }; continue }
    if (Test-Path -LiteralPath $m.from)      { $result.skipped += @{ to = $m.to; why = 'something is back at the original name' }; continue }
    try { Move-Item -LiteralPath $m.to -Destination $m.from -ErrorAction Stop; $result.restored += $m.from }
    catch { $result.skipped += @{ to = $m.to; why = $_.Exception.Message } }
  }
  $result.ok = $true
  Emit $result
} catch { $result.error = $_.Exception.Message; Emit $result }
`;

// File form of the undo, for the test. The live path uses undoCommand() below.
export const UNSORTER_PS1 = `# Dominion AI work order: undo a sort. Generated; do not edit on the machine.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$JournalPath)
$Journal = Get-Content -LiteralPath $JournalPath -Raw
${UNSORTER_BODY}`;

// The script prints one marked line so the caller can find it past any PowerShell noise.
export function parseSorterResult(stdout) {
  const text = String(stdout || "");
  const i = text.lastIndexOf("DOMINION_RESULT ");
  if (i < 0) return { ok: false, error: "the sorter produced no result line", raw: text.slice(0, 500) };
  const line = text.slice(i + "DOMINION_RESULT ".length).split(/\r?\n/)[0];
  try {
    const j = JSON.parse(line);
    // PowerShell's ConvertTo-Json collapses a one-element array to a bare object.
    for (const k of ["moved", "skipped", "created"]) {
      if (j[k] && !Array.isArray(j[k])) j[k] = [j[k]];
      if (!j[k]) j[k] = [];
    }
    return j;
  } catch (e) {
    return { ok: false, error: "could not read the sorter's result: " + e.message, raw: line.slice(0, 500) };
  }
}

// A plain-words summary for the dashboard and the morning report.
export function summarizeSort(r) {
  if (!r || r.ok === false) return "The sort did not run: " + ((r && r.error) || "unknown reason");
  const moved = (r.moved || []).length, skipped = (r.skipped || []).length;
  const folders = (r.created || []).length;
  const bits = [];
  bits.push(r.dryRun ? `${moved} file${moved === 1 ? "" : "s"} would be sorted` : `${moved} file${moved === 1 ? "" : "s"} sorted`);
  if (folders) bits.push(`${folders} new folder${folders === 1 ? "" : "s"}`);
  if (skipped) bits.push(`${skipped} left alone`);
  if (r.capped) bits.push("stopped at the file limit");
  if (moved === 0 && skipped === 0) return "Nothing to sort: the folder had no loose files.";
  return bits.join(", ") + ".";
}
