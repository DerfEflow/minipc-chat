/*
 * Dominion AI — zero-dependency native document generation (Group E; upgraded 2026-07-17 for
 * professional layout).
 *
 * The spec wants native DOCX / PDF / spreadsheet output that looks professionally laid out. No npm
 * deps allowed, so everything here is hand-built:
 *   - a ZIP writer (local headers + central directory + EOCD, table-based CRC32, DEFLATE via
 *     node:zlib deflateRawSync with a STORED fallback) — the exact mirror of persona.mjs's docxToText
 *     reader, which is the round-trip test.
 *   - parseMarkdown: headings, paragraphs, bullet/numbered lists, fenced code, and MARKDOWN TABLES.
 *   - markdownToDocx: real OOXML with a styles.xml (Calibri body, coloured heading styles, a Title
 *     style, a monospace Code style), paragraph spacing, and bordered tables with a shaded header row.
 *   - markdownToPdf: a laid-out multi-page PDF — title block + brass rule, coloured heading hierarchy
 *     with rules, inline bold/italic/mono runs, hanging-indent lists, shaded code blocks, bordered
 *     tables with a shaded header, and "Page N of M" footers. Four base-14 fonts, real xref.
 *   - parseTable/toCsv/rowsToXlsx: markdown-table or CSV content -> CSV always, or a styled XLSX
 *     (bold frozen header row, auto-fit column widths, autofilter) via the same zip writer.
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
// blocks: { kind: "h"|"p"|"li"|"code"|"table", level?, ordered?, index?, text?, inlines?, rows? }
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
const splitTableRow = (s) => s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isTableSep = (s) => /^\|?[\s:|-]+\|?$/.test(s.trim()) && s.includes("-");
export function parseMarkdown(md) {
  const blocks = [];
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  let inCode = false, codeBuf = [];
  let olIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^```/.test(raw.trim())) {
      if (inCode) { blocks.push({ kind: "code", text: codeBuf.join("\n") }); codeBuf = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    const line = raw.trimEnd();
    // Markdown table: a header row containing "|" followed by a "---" separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [splitTableRow(line)];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const r = lines[j].trim();
        if (!r.includes("|")) break;
        rows.push(splitTableRow(r));
      }
      if (rows.length > 1) { blocks.push({ kind: "table", rows }); i = j - 1; olIndex = 0; continue; }
    }
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

const xesc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inlineText = (inl) => (inl || []).map((t) => t.text).join("");

// =====================================================================================
//  DOCX
// =====================================================================================
// Heading colour (deep blue) + a Calibri body, defined once in styles.xml so Word renders a real
// document, not a wall of manually-sized runs.
const DOCX_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:b/><w:color w:val="1F3864"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="6B6B6B"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="320" w:after="120"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="C0A062"/></w:pBdr></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="280" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="2E5496"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="2E5496"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F3F7"/><w:ind w:left="200"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>' +
  '</w:styles>';
const H_STYLE = { 1: "Heading1", 2: "Heading2", 3: "Heading3", 4: "Heading3", 5: "Heading3", 6: "Heading3" };

function runXml(t, extra = {}) {
  const rpr = [];
  if (t.b || extra.b) rpr.push("<w:b/>");
  if (t.i) rpr.push("<w:i/>");
  if (t.code) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F3F7"/>');
  return `<w:r>${rpr.length ? "<w:rPr>" + rpr.join("") + "</w:rPr>" : ""}<w:t xml:space="preserve">${xesc(t.text)}</w:t></w:r>`;
}
function paraXml(inlines, { style = "", listPrefix = "", indent = 0 } = {}) {
  const props = [];
  if (style) props.push(`<w:pStyle w:val="${style}"/>`);
  if (indent) props.push(`<w:ind w:left="${indent}" w:hanging="${Math.min(indent, 360)}"/>`);
  const ppr = props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
  const lead = listPrefix ? [{ text: listPrefix }] : [];
  return `<w:p>${ppr}${[...lead, ...inlines].map((t) => runXml(t)).join("")}</w:p>`;
}
function tableXml(rows) {
  const border = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7BECB"/><w:left w:val="single" w:sz="4" w:color="B7BECB"/><w:bottom w:val="single" w:sz="4" w:color="B7BECB"/><w:right w:val="single" w:sz="4" w:color="B7BECB"/><w:insideH w:val="single" w:sz="4" w:color="D6DAE4"/><w:insideV w:val="single" w:sz="4" w:color="D6DAE4"/></w:tblBorders>';
  const props = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>`;
  const body = rows.map((cells, ri) => {
    const header = ri === 0;
    const tcs = cells.map((c) => {
      const shd = header ? '<w:shd w:val="clear" w:color="auto" w:fill="E7EBF5"/>' : "";
      const runs = parseInlines(c).map((t) => runXml(t, { b: header })).join("") || '<w:r><w:t/></w:r>';
      return `<w:tc><w:tcPr>${shd}</w:tcPr><w:p><w:pPr><w:spacing w:after="40"/></w:pPr>${runs}</w:p></w:tc>`;
    }).join("");
    return `<w:tr>${tcs}</w:tr>`;
  }).join("");
  return `<w:tbl>${props}${body}</w:tbl><w:p/>`;
}
export function markdownToDocx(md, title = "", meta = {}) {
  const blocks = parseMarkdown(md);
  const body = [];
  if (title) body.push(paraXml([{ text: title }], { style: "Title" }));
  if (meta && meta.subtitle) body.push(paraXml([{ text: meta.subtitle }], { style: "Subtitle" }));
  for (const b of blocks) {
    if (b.kind === "h") body.push(paraXml(b.inlines, { style: H_STYLE[b.level] || "Heading3" }));
    else if (b.kind === "table") body.push(tableXml(b.rows));
    else if (b.kind === "li") body.push(paraXml(b.inlines, { listPrefix: b.ordered ? `${b.index}. ` : "• ", indent: 360 }));
    else if (b.kind === "code") for (const line of b.text.split("\n")) body.push(paraXml([{ text: line || " " }], { style: "Code" }));
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
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const docRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  return zipBuffer([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/_rels/document.xml.rels", data: docRels },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: DOCX_STYLES },
  ]);
}

// =====================================================================================
//  PDF
// =====================================================================================
const PAGE_W = 612, PAGE_H = 792, MARGIN = 56;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const pdfEsc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  .replace(/[^\x20-\x7e\t]/g, (c) => ({ "•": "-", "—": "--", "–": "-", "‘": "'", "’": "'", "“": '"', "”": '"' }[c] || "?"));
// Colours (r g b, 0..1).
const INK = "0.12 0.13 0.16", HEAD1 = "0.12 0.22 0.39", HEAD2 = "0.18 0.33 0.59", BRASS = "0.66 0.55 0.29",
  RULE2 = "0.72 0.78 0.88", CODEBG = "0.95 0.96 0.98", THEADBG = "0.90 0.92 0.96", GRID = "0.74 0.78 0.86", FOOT = "0.52 0.54 0.60";
// Per-font average glyph width as a fraction of the point size (base-14 metrics, good enough to wrap).
const FW = { F1: 0.5, F2: 0.53, F3: 0.5, F4: 0.6 };
const fontFor = (w) => w.code ? "F4" : w.b ? "F2" : w.i ? "F3" : "F1";
const wordW = (w, size) => w.t.length * FW[fontFor(w)] * size;
// Split inlines into style-carrying tokens (whitespace preserved so wrapping keeps word gaps).
function styleTokens(inlines) {
  const out = [];
  for (const r of inlines || []) for (const p of String(r.text).split(/(\s+)/)) if (p !== "") out.push({ t: p, b: !!r.b, i: !!r.i, code: !!r.code });
  return out;
}
// Greedy word-wrap of tokens to a max width; returns lines (each an array of tokens).
function wrapTokens(tokens, size, maxW) {
  const lines = []; let line = [], w = 0;
  for (const tok of tokens) {
    const tw = wordW(tok, size);
    if (line.length && w + tw > maxW && tok.t.trim()) { lines.push(line); line = []; w = 0; }
    if (!line.length && !tok.t.trim()) continue;   // don't start a line with whitespace
    line.push(tok); w += tw;
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[{ t: " " }]];
}
const textOp = (font, size, color, x, y, s) => `${color} rg BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y} Tm (${pdfEsc(s)}) Tj ET`;
function tokenLineOps(tokens, size, x0, y, color) {
  let x = x0; const ops = [];
  for (const tok of tokens) { ops.push(textOp(fontFor(tok), size, color, x, y, tok.t)); x += wordW(tok, size); }
  return ops.join("\n");
}
const strTokW = (tokens, size) => tokens.reduce((n, t) => n + wordW(t, size), 0);

export function markdownToPdf(md, title = "", meta = {}) {
  const blocks = parseMarkdown(md);
  // ---- pass 1: flatten to single-row draw items {h: rowHeight, draw(y)->ops} ----
  const items = [];
  const space = (h) => items.push({ h, draw: () => "" });
  const textLine = (tokens, size, color, lead, x0 = MARGIN) => items.push({ h: lead, draw: (y) => tokenLineOps(tokens, size, x0, y, color) });
  if (title) {
    for (const ln of wrapTokens(styleTokens([{ text: title, b: true }]), 22, CONTENT_W)) textLine(ln, 22, HEAD1, 27);
    items.push({ h: 10, draw: (y) => `q ${BRASS} RG 1.4 w ${MARGIN} ${y + 4} m ${PAGE_W - MARGIN} ${y + 4} l S Q` });
    if (meta && meta.subtitle) textLine(styleTokens([{ text: meta.subtitle }]), 11, FOOT, 20);
    space(8);
  }
  for (const b of blocks) {
    if (b.kind === "h") {
      const size = b.level === 1 ? 17 : b.level === 2 ? 14 : 12;
      const color = b.level === 1 ? HEAD1 : HEAD2;
      space(b.level === 1 ? 10 : 6);
      for (const ln of wrapTokens(styleTokens(b.inlines), size, CONTENT_W)) textLine(ln, size, color, size + 6);
      if (b.level <= 2) items.push({ h: 6, draw: (y) => `q ${b.level === 1 ? BRASS : RULE2} RG ${b.level === 1 ? 0.8 : 0.5} w ${MARGIN} ${y + 3} m ${PAGE_W - MARGIN} ${y + 3} l S Q` });
      space(2);
    } else if (b.kind === "li") {
      const bullet = b.ordered ? `${b.index}.` : "•";
      const indent = 18;
      const lines = wrapTokens(styleTokens(b.inlines), 11, CONTENT_W - indent);
      lines.forEach((ln, k) => {
        if (k === 0) items.push({ h: 15, draw: (y) => textOp("F1", 11, INK, MARGIN, y, bullet) + "\n" + tokenLineOps(ln, 11, MARGIN + indent, y, INK) });
        else textLine(ln, 11, INK, 14, MARGIN + indent);
      });
    } else if (b.kind === "code") {
      space(4);
      for (const raw of b.text.split("\n")) {
        const line = raw || " ";
        items.push({ h: 12.5, draw: (y) => `q ${CODEBG} rg ${MARGIN} ${y - 3} ${CONTENT_W} 12.5 re f Q\n` + textOp("F4", 9, INK, MARGIN + 6, y, line) });
      }
      space(4);
    } else if (b.kind === "table") {
      pushTable(items, b.rows);
      space(6);
    } else {
      for (const ln of wrapTokens(styleTokens(b.inlines), 11, CONTENT_W)) textLine(ln, 11, INK, 15);
      space(5);
    }
  }
  if (!items.length) textLine([{ t: " " }], 11, INK, 14);

  // ---- pass 2: paginate by height ----
  const TOP = PAGE_H - MARGIN, BOTTOM = MARGIN + 24;   // leave room for the footer
  const pages = []; let cur = [], y = TOP;
  for (const it of items) {
    if (y - it.h < BOTTOM) { pages.push(cur); cur = []; y = TOP; }
    y -= it.h;
    const ops = it.draw(y);
    if (ops) cur.push(ops);
  }
  pages.push(cur);

  // ---- pass 3: serialise (catalog, pages, 4 fonts, then per page: page + content) ----
  const N = pages.length;
  const objs = [];
  const pageObjNums = pages.map((_, i) => 7 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => n + " 0 R").join(" ")}] /Count ${N} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>";
  objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  pages.forEach((opsList, i) => {
    const n = pageObjNums[i];
    const footer = `Page ${i + 1} of ${N}`;
    const fx = (PAGE_W - footer.length * 0.5 * 8) / 2;
    const foot = textOp("F1", 8, FOOT, fx, MARGIN - 8, footer);
    const stream = opsList.join("\n") + "\n" + foot;
    objs[n + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objs[n] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${n + 1} 0 R >>`;
  });
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefAt = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// Emit a bordered table as one draw-item per row so it paginates naturally. The header row is shaded
// + bold; column widths are proportional to the longest cell in each column.
function pushTable(items, rows) {
  const ncol = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => { const c = r.slice(); while (c.length < ncol) c.push(""); return c; });
  const weights = new Array(ncol).fill(1);
  for (const r of norm) for (let c = 0; c < ncol; c++) weights[c] = Math.max(weights[c], Math.min(40, String(r[c]).length || 1));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => (w / wsum) * CONTENT_W);
  const colX = [MARGIN]; for (let c = 0; c < ncol; c++) colX.push(colX[c] + colW[c]);
  norm.forEach((cells, ri) => {
    const header = ri === 0;
    const rowH = 17;
    items.push({ h: rowH, draw: (y) => {
      const ops = [];
      if (header) ops.push(`q ${THEADBG} rg ${MARGIN} ${y - 4} ${CONTENT_W} ${rowH} re f Q`);
      // grid: verticals + row bottom line
      ops.push(`q ${GRID} RG 0.5 w`);
      for (let c = 0; c <= ncol; c++) ops.push(`${colX[c].toFixed(1)} ${y - 4} m ${colX[c].toFixed(1)} ${y + rowH - 4} l`);
      ops.push(`${MARGIN} ${y - 4} m ${PAGE_W - MARGIN} ${y - 4} l`);
      if (header) ops.push(`${MARGIN} ${y + rowH - 4} m ${PAGE_W - MARGIN} ${y + rowH - 4} l`);
      ops.push("S Q");
      for (let c = 0; c < ncol; c++) {
        const maxChars = Math.max(1, Math.floor((colW[c] - 8) / (0.5 * 9.5)));
        const txt = String(cells[c]).length > maxChars ? String(cells[c]).slice(0, maxChars - 1) + "…" : String(cells[c]);
        ops.push(textOp(header ? "F2" : "F1", 9.5, header ? HEAD1 : INK, colX[c] + 4, y + 2, txt));
      }
      return ops.join("\n");
    } });
  });
}

// =====================================================================================
//  spreadsheet
// =====================================================================================
// parseTable: markdown table or CSV content -> rows[][] (strings), or null when no table found.
export function parseTable(content) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
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
// Bold, shaded, frozen header row + a border style, defined in styles.xml (s="1" = header cell).
const XLSX_STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2E5496"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB7BECB"/></left><right style="thin"><color rgb="FFB7BECB"/></right><top style="thin"><color rgb="FFB7BECB"/></top><bottom style="thin"><color rgb="FFB7BECB"/></bottom></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/></cellXfs>' +
  '</styleSheet>';
export function rowsToXlsx(rows) {
  const ncol = Math.max(1, ...rows.map((r) => r.length));
  // Auto-fit column widths from the longest cell (bounded).
  const widths = new Array(ncol).fill(8);
  rows.forEach((r) => r.forEach((v, c) => { widths[c] = Math.min(60, Math.max(widths[c], String(v == null ? "" : v).length + 2)); }));
  const cols = "<cols>" + widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join("") + "</cols>";
  const sheetRows = rows.map((r, ri) => {
    const header = ri === 0;
    const cells = r.map((v, ci) => {
      const ref = colLetter(ci) + (ri + 1);
      const s = String(v == null ? "" : v);
      if (!header && /^-?\d+(\.\d+)?$/.test(s)) return `<c r="${ref}" s="2"><v>${s}</v></c>`;
      const style = header ? ' s="1"' : ' s="2"';
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xesc(s)}</t></is></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");
  const dim = `A1:${colLetter(ncol - 1)}${Math.max(1, rows.length)}`;
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${dim}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    '<sheetData>' + sheetRows + '</sheetData>' +
    (rows.length > 1 ? `<autoFilter ref="${dim}"/>` : "") +
    '</worksheet>';
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
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
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  return zipBuffer([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels },
    { name: "xl/styles.xml", data: XLSX_STYLES },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
