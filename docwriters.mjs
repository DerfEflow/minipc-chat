/*
 * Dominion AI — zero-dependency native document generation (Group E restoration, audit item 7).
 *
 * The spec (135-136 / 815-818) wants native DOCX / PDF / spreadsheet outputs. No npm deps allowed,
 * so this file implements the minimum honest versions by hand:
 *   - a ZIP writer (local headers + central directory + EOCD, table-based CRC32, DEFLATE via
 *     node:zlib deflateRawSync with a STORED fallback when compression doesn't help) — the exact
 *     mirror of persona.mjs's docxToText reader, which is the round-trip test
 *   - markdownToDocx: minimal OOXML ([Content_Types].xml, _rels/.rels, word/document.xml) with
 *     headings (bold + sized runs — no styles.xml needed), bold/italic/inline-code runs, bullet
 *     and numbered list paragraphs, and code blocks
 *   - markdownToPdf: minimal multi-page text PDF (catalog/pages/page objects, Helvetica +
 *     Helvetica-Bold, per-line Tj text showing, paren escaping, wrapping, pagination, real xref)
 *   - parseTable/toCsv/rowsToXlsx: markdown-table or CSV content -> CSV always, XLSX (inline
 *     strings) via the same zip writer
 *
 * The Forge (Claude Code) remains a FALLBACK for docx/pdf only if these throw — never the primary.
 */
import { deflateRawSync } from "node:zlib";

// ---- CRC32 (standard table-based) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- ZIP writer ----
// entries: [{ name, data: Buffer|string }]. DEFLATE when it shrinks, STORED otherwise.
export function zipBuffer(entries) {
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(data);
    let method = 8, comp = deflateRawSync(data);
    if (comp.length >= data.length) { method = 0; comp = data; }   // STORED when deflate doesn't help
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);        // local file header signature
    lh.writeUInt16LE(20, 4);                // version needed
    lh.writeUInt16LE(0, 6);                 // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    central.push({ name, crc, comp: comp.length, uncomp: data.length, method, offset, dosTime, dosDate });
    chunks.push(lh, name, comp);
    offset += 30 + name.length + comp.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);        // central directory signature
    ch.writeUInt16LE(20, 4);                // version made by
    ch.writeUInt16LE(20, 6);                // version needed
    ch.writeUInt16LE(0, 8);                 // flags
    ch.writeUInt16LE(c.method, 10);
    ch.writeUInt16LE(c.dosTime, 12); ch.writeUInt16LE(c.dosDate, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.comp, 20); ch.writeUInt32LE(c.uncomp, 24);
    ch.writeUInt16LE(c.name.length, 28);    // extra(30)/comment(32)/disk(34)/attrs(36,38) stay 0
    ch.writeUInt32LE(c.offset, 42);
    chunks.push(ch, c.name);
    offset += 46 + c.name.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

// List a zip's entry names (test/verification helper — reads the central directory).
export function listZip(buf) {
  const names = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return names;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ---- markdown parsing (shared by docx + pdf) ----
// blocks: { kind: "h"|"p"|"li"|"code", level?, ordered?, index?, text?, inlines? }
// inlines: [{ text, b, i, code }]
export function parseInlines(s) {
  const out = [];
  const parts = String(s).split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  for (const p of parts) {
    if (!p) continue;
    if (/^\*\*[^*]+\*\*$/.test(p)) out.push({ text: p.slice(2, -2), b: true });
    else if (/^\*[^*]+\*$/.test(p)) out.push({ text: p.slice(1, -1), i: true });
    else if (/^`[^`]+`$/.test(p)) out.push({ text: p.slice(1, -1), code: true });
    else out.push({ text: p });
  }
  return out;
}
export function parseMarkdown(md) {
  const blocks = [];
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false, codeBuf = [];
  let olIndex = 0;
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      if (inCode) { blocks.push({ kind: "code", text: codeBuf.join("\n") }); codeBuf = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push({ kind: "h", level: h[1].length, inlines: parseInlines(h[2]) }); olIndex = 0; continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { blocks.push({ kind: "li", ordered: false, inlines: parseInlines(ul[1]) }); olIndex = 0; continue; }
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) { olIndex++; blocks.push({ kind: "li", ordered: true, index: olIndex, inlines: parseInlines(ol[2]) }); continue; }
    if (!line.trim()) { olIndex = 0; continue; }
    blocks.push({ kind: "p", inlines: parseInlines(line.replace(/^>\s?/, "")) });
    olIndex = 0;
  }
  if (inCode && codeBuf.length) blocks.push({ kind: "code", text: codeBuf.join("\n") });
  return blocks;
}

// ---- DOCX ----
const xesc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const H_SIZE = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 24 };   // half-points (36 = 18pt)
function runXml(t, extra = {}) {
  const rpr = [];
  if (t.b || extra.b) rpr.push("<w:b/>");
  if (t.i) rpr.push("<w:i/>");
  if (t.code || extra.mono) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  if (extra.sz) rpr.push(`<w:sz w:val="${extra.sz}"/><w:szCs w:val="${extra.sz}"/>`);
  return `<w:r>${rpr.length ? "<w:rPr>" + rpr.join("") + "</w:rPr>" : ""}<w:t xml:space="preserve">${xesc(t.text)}</w:t></w:r>`;
}
function paraXml(inlines, { extra = {}, indent = 0 } = {}) {
  const ppr = indent ? `<w:pPr><w:ind w:left="${indent}"/></w:pPr>` : "";
  return `<w:p>${ppr}${inlines.map((t) => runXml(t, extra)).join("")}</w:p>`;
}
export function markdownToDocx(md, title = "") {
  const blocks = parseMarkdown(md);
  const body = [];
  if (title) body.push(paraXml([{ text: title }], { extra: { b: true, sz: 40 } }));
  for (const b of blocks) {
    if (b.kind === "h") body.push(paraXml(b.inlines, { extra: { b: true, sz: H_SIZE[b.level] || 24 } }));
    else if (b.kind === "li") body.push(paraXml([{ text: b.ordered ? `${b.index}. ` : "• " }, ...b.inlines], { indent: 360 }));
    else if (b.kind === "code") for (const line of b.text.split("\n")) body.push(paraXml([{ text: line || " " }], { extra: { mono: true, sz: 20 } }));
    else body.push(paraXml(b.inlines));
  }
  if (!body.length) body.push(paraXml([{ text: " " }]));
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body.join("") +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  return zipBuffer([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: documentXml },
  ]);
}

// ---- PDF ----
const PAGE_W = 612, PAGE_H = 792, MARGIN = 56;
const pdfEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  .replace(/[^\x20-\x7e\t]/g, (c) => ({ "•": "*", "—": "--", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"' }[c] || "?"));
function wrapText(text, maxChars) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (para.length <= maxChars) { out.push(para); continue; }
    let line = "";
    for (const w of para.split(/\s+/)) {
      if (!line) line = w;
      else if (line.length + 1 + w.length <= maxChars) line += " " + w;
      else { out.push(line); line = w.length > maxChars ? w.slice(0, maxChars) : w; }
    }
    if (line) out.push(line);
  }
  return out;
}
export function markdownToPdf(md, title = "") {
  const blocks = parseMarkdown(md);
  const inlineText = (inl) => inl.map((t) => t.text).join("");
  // layout: [{ text, size, bold, lead }] flattened to lines
  const lines = [];
  const push = (text, size, bold, lead) => { for (const l of wrapText(text, Math.floor((PAGE_W - 2 * MARGIN) / (size * 0.5)))) lines.push({ text: l, size, bold, lead }); };
  if (title) { push(title, 18, true, 24); lines.push({ text: "", size: 11, bold: false, lead: 10 }); }
  for (const b of blocks) {
    if (b.kind === "h") { lines.push({ text: "", size: 11, bold: false, lead: 6 }); push(inlineText(b.inlines), b.level === 1 ? 16 : b.level === 2 ? 14 : 12, true, 20); }
    else if (b.kind === "li") push((b.ordered ? `${b.index}. ` : "- ") + inlineText(b.inlines), 11, false, 14);
    else if (b.kind === "code") for (const l of b.text.split("\n")) push("    " + l, 9, false, 12);
    else { push(inlineText(b.inlines), 11, false, 14); lines.push({ text: "", size: 11, bold: false, lead: 6 }); }
  }
  if (!lines.length) lines.push({ text: " ", size: 11, bold: false, lead: 14 });
  // paginate
  const pages = [];
  let cur = [], y = PAGE_H - MARGIN;
  for (const l of lines) {
    if (y - l.lead < MARGIN) { pages.push(cur); cur = []; y = PAGE_H - MARGIN; }
    y -= l.lead;
    if (l.text) cur.push({ ...l, y });
  }
  pages.push(cur);
  // objects: 1 catalog, 2 pages, 3 F1 Helvetica, 4 F2 Helvetica-Bold, then per page: page, content
  const objs = [];   // 1-indexed strings (without "N 0 obj" wrapper)
  const pageObjNums = pages.map((_, i) => 5 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => n + " 0 R").join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  pages.forEach((pls, i) => {
    const n = pageObjNums[i];
    const ops = pls.map((l) => `BT /${l.bold ? "F2" : "F1"} ${l.size} Tf 1 0 0 1 ${MARGIN} ${Math.round(l.y)} Tm (${pdfEsc(l.text)}) Tj ET`).join("\n");
    objs[n + 1] = `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`;
    objs[n] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${n + 1} 0 R >>`;
  });
  // serialize with a real xref
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---- spreadsheet ----
// parseTable: markdown table or CSV content -> rows[][] (strings), or null when no table found.
export function parseTable(content) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  // markdown table: a |-row followed by a separator row of ---
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i].trim(), sep = lines[i + 1].trim();
    if (l.includes("|") && /^\|?[\s:|-]+\|?$/.test(sep) && sep.includes("-")) {
      const splitRow = (s) => s.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const rows = [splitRow(l)];
      for (let j = i + 2; j < lines.length; j++) {
        const r = lines[j].trim();
        if (!r.includes("|")) break;
        rows.push(splitRow(r));
      }
      if (rows.length > 1) return rows;
    }
  }
  // CSV: every non-empty line parses to the same field count (>1) — quote-aware, so a comma
  // inside "smith, john" doesn't break detection
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length >= 2) {
    const parsed = nonEmpty.map(parseCsvLine);
    const first = parsed[0].length;
    if (first > 1 && parsed.every((r) => r.length === first)) return parsed;
  }
  return null;
}
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
export function toCsv(rows) {
  return rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v))).join(",")).join("\r\n") + "\r\n";
}
function colLetter(n) {   // 0 -> A, 25 -> Z, 26 -> AA
  let s = "";
  n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function rowsToXlsx(rows) {
  const sheetRows = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      const ref = colLetter(ci) + (ri + 1);
      const s = String(v == null ? "" : v);
      if (/^-?\d+(\.\d+)?$/.test(s)) return `<c r="${ref}"><v>${s}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(s)}</t></is></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheetRows + "</sheetData></worksheet>";
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  return zipBuffer([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
