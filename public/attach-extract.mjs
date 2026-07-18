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
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
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
