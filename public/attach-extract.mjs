/*
 * Attachment document extraction — PDF and DOCX to plain text, ON THE DEVICE.
 * Loaded lazily by app.js the first time someone attaches a document, and imported
 * directly by attach_extract_test.mjs in Node (DecompressionStream/Blob/Response are
 * global in both). Extracted text rides the existing {kind:"text"} attachment wire,
 * which is why documents work with EVERY model (local Qwen and DeepSeek included) and
 * why the server needed no new parsing surface for this feature.
 *
 * PDF text comes from the vendored Mozilla pdf.js (public/vendor/pdfjs, Apache-2.0,
 * pinned 4.10.38 legacy build) because real-world PDF font/CMap handling is exactly
 * where homegrown extractors produce garbage. DOCX is a rigid zip-of-XML from a single
 * producer family, so a small dependency-free reader is enough.
 */

// ---- shared helpers ---------------------------------------------------------------

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}

const XML_ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return XML_ENT[e] ?? m;
  });
}

// Reasonable-text ratio: letters/numbers/punctuation/spaces in ANY script count as good
// (so non-Latin documents pass); control chars, replacement chars, and private-use junk
// from broken font maps count as bad.
function readableRatio(s) {
  if (!s.length) return 0;
  const sample = s.length > 8000 ? s.slice(0, 8000) : s;
  let good = 0;
  for (const ch of sample) if (/[\p{L}\p{N}\p{P}\p{Sm}\p{Sc}\p{Zs}\n\r\t]/u.test(ch)) good++;
  return good / [...sample].length;
}

// ---- PDF --------------------------------------------------------------------------

// Browser-side loader for the vendored pdf.js. Tests load the lib themselves and pass it in.
export async function loadPdfjsBrowser() {
  const lib = await import("/vendor/pdfjs/pdf.min.mjs");
  lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
  return lib;
}

export async function extractPdf(data, pdfjs, { maxChars = 200000 } = {}) {
  if (!pdfjs) throw new Error("PDF engine didn't load");
  // pdf.js TRANSFERS the buffer to its worker (detaching the caller's copy) — always hand it
  // a private copy so the same bytes can be reused afterward (e.g. the scanned->OCR path).
  const bytes = (data instanceof Uint8Array ? data : new Uint8Array(data)).slice();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: true }).promise;
  } catch (e) {
    throw new Error(/password/i.test(String(e && e.message)) ? "this PDF is password-protected" : "couldn't open this PDF");
  }
  try {
    let out = "", truncated = false;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      // Join items, respecting pdf.js's end-of-line hints so paragraphs survive.
      let line = "";
      for (const it of tc.items) {
        if (typeof it.str === "string") line += it.str;
        if (it.hasEOL) line += "\n";
        else if (it.str && !it.str.endsWith(" ")) line += " ";
      }
      const pageText = line.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      if (pageText) out += (out ? "\n\n" : "") + `[Page ${p} of ${doc.numPages}]\n` + pageText;
      if (out.length >= maxChars) { out = out.slice(0, maxChars); truncated = true; break; }
    }
    const trimmed = out.trim();
    // Honest refusal beats confidently feeding a model nothing: scanned/image-only PDFs
    // have no text layer, and broken font maps yield unreadable soup.
    if (trimmed.length < Math.max(40, doc.numPages * 8)) throw new Error("no extractable text (this PDF looks scanned or image-only)");
    if (readableRatio(trimmed) < 0.7) throw new Error("the text in this PDF isn't extractable (exotic fonts)");
    return { text: trimmed, pages: doc.numPages, truncated };
  } finally {
    try { await doc.destroy(); } catch {}
  }
}

// ---- DOCX -------------------------------------------------------------------------

const U16 = (b, o) => b[o] | (b[o + 1] << 8);
const U32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Minimal central-directory zip reader: enough for OOXML packages, nothing more.
async function zipEntry(bytes, wantName) {
  // End Of Central Directory: scan back over the max comment length.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a valid .docx (zip directory missing)");
  const count = U16(bytes, eocd + 10);
  let off = U32(bytes, eocd + 16);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (U32(bytes, off) !== 0x02014b50) break;
    const method = U16(bytes, off + 10);
    const csize = U32(bytes, off + 20);
    const nameLen = U16(bytes, off + 28), extraLen = U16(bytes, off + 30), cmtLen = U16(bytes, off + 32);
    const lho = U32(bytes, off + 42);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    if (name === wantName) {
      if (csize === 0xffffffff || lho === 0xffffffff) throw new Error("this .docx uses zip64 (too large)");
      if (U32(bytes, lho) !== 0x04034b50) throw new Error("corrupt .docx entry");
      const lNameLen = U16(bytes, lho + 26), lExtraLen = U16(bytes, lho + 28);
      const start = lho + 30 + lNameLen + lExtraLen;
      const comp = bytes.subarray(start, start + csize);
      if (method === 0) return comp;
      if (method === 8) return await inflateRaw(comp);
      throw new Error("unsupported .docx compression");
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

// Render a PDF's pages to JPEG data URLs (browser only) — the scanned-PDF path: when a PDF
// has no text layer, the pages become images and the server's /api/ocr transcribes them
// with a vision model, so the result still reaches EVERY chat model as ordinary text.
export async function renderPdfPages(data, pdfjs, { maxPages = 12, edge = 1400, quality = 0.8 } = {}) {
  if (typeof document === "undefined") throw new Error("page rendering needs a browser");
  // private copy: pdf.js detaches what it's given (see extractPdf note)
  const bytes = (data instanceof Uint8Array ? data : new Uint8Array(data)).slice();
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: true }).promise;
  // A pathological file must never wedge the composer: every page gets a hard time budget.
  const withTimeout = (promise, ms, what) => Promise.race([promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);
  try {
    const n = Math.min(doc.numPages, maxPages);
    const pages = [];
    for (let p = 1; p <= n; p++) {
      const page = await withTimeout(doc.getPage(p), 15000, "couldn't open page " + p + " for OCR");
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, edge / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale });
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
      await withTimeout(page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise, 20000, "couldn't render page " + p + " for OCR");
      pages.push(cv.toDataURL("image/jpeg", quality));
    }
    return { pages, total: doc.numPages, rendered: n };
  } finally { try { await doc.destroy(); } catch {} }
}

// ---- XLSX -------------------------------------------------------------------------
// Spreadsheets flatten to "[Sheet: Name]" blocks of tab-separated rows. Cell coverage:
// shared strings (real Excel), inline strings (our own exports), numbers, booleans,
// formula cached values, and date/time cells converted from Excel serials to ISO via
// the styles table (raw serials like 45123 would just confuse the model and Fred).

const colIndex = (ref) => { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c >= 65 && c <= 90) n = n * 26 + (c - 64); else break; } return Math.max(0, n - 1); };

// Builtin numFmt ids that render as dates/times, plus a heuristic for custom codes.
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateCode = (code) => /[dyhs]/i.test(String(code || "").replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, ""));

function serialToIso(n, date1904) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + n * 86400000);
  if (isNaN(d.getTime())) return String(n);
  const iso = d.toISOString();
  return n % 1 ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

function xmlTexts(block) {
  // concat every <t> run (rich text splits one cell across runs), entities decoded
  let s = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m; while ((m = re.exec(block))) s += decodeEntities(m[1]);
  return s;
}

export async function extractXlsx(data, { maxChars = 200000 } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new Error("old .xls format; save it as .xlsx first");
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("not an .xlsx file");
  const dec = new TextDecoder();
  const read = async (name) => { const b = await zipEntry(bytes, name); return b ? dec.decode(b) : ""; };

  const workbook = await read("xl/workbook.xml");
  if (!workbook) throw new Error("no workbook found (is this really an Excel .xlsx?)");
  const date1904 = /<workbookPr[^>]*date1904="(?:1|true)"/.test(workbook);

  // sheet name -> target file, via the rels when present, positional fallback otherwise
  const rels = await read("xl/_rels/workbook.xml.rels");
  const relMap = new Map();
  { const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g; let m; while ((m = re.exec(rels))) relMap.set(m[1], m[2]); }
  const sheets = [];
  { const re = /<sheet\b[^>]*\/?>/g; let m, i = 0;
    while ((m = re.exec(workbook))) {
      i++;
      const tag = m[0];
      const name = decodeEntities((tag.match(/\bname="([^"]*)"/) || [])[1] || ("Sheet" + i));
      const rid = (tag.match(/\br:id="([^"]*)"/) || [])[1] || "";
      let target = relMap.get(rid) || ("worksheets/sheet" + i + ".xml");
      target = target.replace(/^\//, "").replace(/^\.\//, "");
      if (!target.startsWith("xl/")) target = "xl/" + target;
      sheets.push({ name, target });
    } }
  if (!sheets.length) throw new Error("this workbook has no sheets");

  // shared strings + date styles
  const sharedXml = await read("xl/sharedStrings.xml");
  const shared = [];
  { const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(sharedXml))) shared.push(xmlTexts(m[1])); }
  const stylesXml = await read("xl/styles.xml");
  const customDate = new Set();
  { const re = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g; let m;
    while ((m = re.exec(stylesXml))) if (isDateCode(decodeEntities(m[2]))) customDate.add(+m[1]); }
  const xfDate = [];
  { const cellXfs = (stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [""])[0];
    const re = /<xf\b[^>]*\/?>/g; let m;
    while ((m = re.exec(cellXfs))) { const id = +((m[0].match(/\bnumFmtId="(\d+)"/) || [])[1] || 0); xfDate.push(DATE_FMT_IDS.has(id) || customDate.has(id)); } }

  let out = "", truncated = false;
  for (const sh of sheets) {
    if (out.length >= maxChars) { truncated = true; break; }
    const xml = await read(sh.target);
    if (!xml) continue;
    const lines = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || "", inner = cm[2] || "";
        const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1] || "";
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push("");
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
        const v = (inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/) || [])[1] || "";
        let val = "";
        if (t === "s") val = shared[+decodeEntities(v)] ?? "";
        else if (t === "inlineStr") val = xmlTexts(inner);
        else if (t === "str") val = decodeEntities(v);
        else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
        else if (t === "e") val = decodeEntities(v);
        else if (v !== "") {
          const sIdx = +((attrs.match(/\bs="(\d+)"/) || [])[1] || -1);
          const num = Number(v);
          val = (sIdx >= 0 && xfDate[sIdx] && Number.isFinite(num) && num > 0) ? serialToIso(num, date1904) : decodeEntities(v);
        }
        cells.push(val.replace(/[\t\n\r]+/g, " "));
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      if (cells.length) lines.push(cells.join("\t"));
    }
    if (!lines.length) continue;
    const block = `[Sheet: ${sh.name}]\n` + lines.join("\n");
    out += (out ? "\n\n" : "") + block;
    if (out.length >= maxChars) { out = out.slice(0, maxChars) + "\n(truncated)"; truncated = true; break; }
  }
  if (!out.trim()) throw new Error("this workbook has no readable cells");
  return { text: out, sheets: sheets.length, truncated };
}

export async function extractDocx(data, { maxChars = 200000 } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // Old binary Word files start with the OLE compound-file signature.
  if (bytes.length > 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new Error("old .doc format; save it as .docx first");
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("not a .docx file");
  const xmlBytes = await zipEntry(bytes, "word/document.xml");
  if (!xmlBytes) throw new Error("no document body found (is this really a Word .docx?)");
  const xml = new TextDecoder().decode(xmlBytes);
  const text = decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")            // table cells separate with tabs
      .replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  if (!text) throw new Error("this .docx has no readable text");
  return { text, truncated: text.length >= maxChars };
}
