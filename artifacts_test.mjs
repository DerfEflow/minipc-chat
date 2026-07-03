/*
 * Group-E restoration self-test — run with: node artifacts_test.mjs
 * Proves (no live model / server needed):
 *   1. all NINE artifact mentor-review triggers fire on synthetic artifacts (spec 1011-1023)
 *   2. the export safety gate enforces the seven-check matrix — warnings under LAX, hard block on
 *      sensitive data without an explicit override, confirmation demanded in spec mode
 *   3. native document generation verifies byte-level: docx round-trips through persona.mjs's
 *      docxToText, pdf passes a %PDF/Tj/xref sanity check, xlsx zip lists the right OOXML entries
 *      and the sheet XML carries the cell data
 *   4. the artifact store records per-version provenance, reaches archived, stores the structured
 *      lastReview, flags review-recommended, and computes drift change-ratios
 *   5. the model-facing export tool passes through the gate (bypass closed) and the three
 *      create_docx/create_pdf/create_spreadsheet tools create + export end-to-end
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { detectArtifactTriggers, exportSafetyGate } from "./review.mjs";
import { crc32, zipBuffer, listZip, parseMarkdown, markdownToDocx, markdownToPdf, parseTable, toCsv, rowsToXlsx } from "./docwriters.mjs";
import { createArtifactStore } from "./artifacts.mjs";
import { docxToText } from "./persona.mjs";
import { runTool } from "./tools.mjs";

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

// mini zip-entry reader (mirror of persona.mjs's central-directory walk) for content verification
function readZipEntry(buf, wanted) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const raw = buf.slice(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + compSize);
    return (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
  }
  return null;
}

// ============ 1. the nine artifact triggers ============
await t("trigger 1/9 final_output: marked final", () => {
  assert.ok(detectArtifactTriggers({ content: "short note", status: "draft" }, { markedFinal: true }).includes("final_output"));
  assert.ok(detectArtifactTriggers({ content: "short note", status: "final" }, {}).includes("final_output"));
});
await t("trigger 2/9 external_send: exported / destined external", () => {
  assert.ok(detectArtifactTriggers({ content: "short note" }, { exported: true }).includes("external_send"));
  assert.ok(detectArtifactTriggers({ content: "short note" }, { externalSend: true }).includes("external_send"));
});
await t("trigger 3/9 long_document: word/char threshold", () => {
  const long = Array.from({ length: 1300 }, (_, i) => "word" + i).join(" ");
  assert.ok(detectArtifactTriggers({ content: long }, {}).includes("long_document"));
});
await t("trigger 4/9 technical_claims: dense factual claims + technical terms", () => {
  const tech = Array.from({ length: 10 }, (_, i) =>
    `The API endpoint number ${i} handles ${100 + i} requests per second and the database holds ${i}00 records under the v${i} schema.`).join(" ");
  assert.ok(detectArtifactTriggers({ content: tech }, {}).includes("technical_claims"));
});
await t("trigger 5/9 code_content: fence or code type", () => {
  assert.ok(detectArtifactTriggers({ content: "```python\nprint('hi')\n```" }, {}).includes("code_content"));
  assert.ok(detectArtifactTriggers({ content: "x = 1", type: "code" }, {}).includes("code_content"));
});
await t("trigger 6/9 retrieval_sourced: provenance says retrieval contributed", () => {
  assert.ok(detectArtifactTriggers({ content: "summary of retrieved docs", sourceContextRefs: ["[M1]", "[A2]"] }, {}).includes("retrieval_sourced"));
});
await t("trigger 7/9 legal_financial_language", () => {
  assert.ok(detectArtifactTriggers({ content: "This contract limits liability and sets payment terms." }, {}).includes("legal_financial_language"));
  assert.ok(detectArtifactTriggers({ content: "Recommended dosage depends on the diagnosis." }, {}).includes("legal_financial_language"));
});
await t("trigger 8/9 uncertainty: model self-reported doubt", () => {
  assert.ok(detectArtifactTriggers({ content: "I'm not sure about the totals. I can't verify the last column either." }, {}).includes("uncertainty"));
});
await t("trigger 9/9 drift: heavy divergence from the reviewed version", () => {
  assert.ok(detectArtifactTriggers({ content: "v5 content", versionCount: 5 }, { driftRatio: 0.7 }).includes("drift"));
  assert.ok(detectArtifactTriggers({ content: "v4 never reviewed", versionCount: 4, mentorReviewed: false }, {}).includes("drift"));
  assert.ok(!detectArtifactTriggers({ content: "v2 small tweak", versionCount: 2 }, { driftRatio: 0.1 }).includes("drift"));
});
await t("clean short draft fires NO triggers", () => {
  assert.deepEqual(detectArtifactTriggers({ content: "Buy milk and eggs tomorrow.", status: "draft", versionCount: 1 }, {}), []);
});

// ============ 2. export safety gate matrix ============
const cleanArt = { title: "Notes", content: "Plain harmless prose about gardening.", mentorReviewed: true, lastReview: { unsupported_claims: [] } };
await t("gate: clean reviewed artifact passes with structured echo (title/format/destination/preserve)", () => {
  const g = exportSafetyGate({ artifact: cleanArt, format: "md", destination: "exports" });
  assert.equal(g.ok, true);
  assert.equal(g.checks.title, "Notes");
  assert.equal(g.checks.format, "md");
  assert.equal(g.checks.destination, "exports");
  assert.equal(g.checks.preservesSource, true);
  assert.equal(g.warnings.length, 0);
});
await t("gate: review-skipped warning (LAX proceeds)", () => {
  const g = exportSafetyGate({ artifact: { ...cleanArt, mentorReviewed: false }, format: "pdf", lax: true });
  assert.equal(g.ok, true, "LAX = warn + proceed");
  assert.ok(g.warnings.some((w) => w.check === "review_skipped"));
});
await t("gate: unsupported-claims warning from the latest structured review", () => {
  const g = exportSafetyGate({ artifact: { ...cleanArt, lastReview: { unsupported_claims: ["the 40% figure", "the 2019 date"] } }, format: "docx" });
  assert.equal(g.ok, true);
  const w = g.warnings.find((x) => x.check === "unsupported_claims");
  assert.ok(w && w.claims.length === 2);
});
await t("gate: sensitive data BLOCKS without an explicit override — even under LAX", () => {
  const g = exportSafetyGate({ artifact: { ...cleanArt, content: "Reach me at fred@example.com, password: hunter2secret" }, format: "md", lax: true });
  assert.equal(g.ok, false);
  assert.equal(g.blocked, "sensitive_data");
  assert.ok(g.detected.length >= 1);
});
await t("gate: explicit override converts the sensitive block into a recorded warning", () => {
  const g = exportSafetyGate({ artifact: { ...cleanArt, content: "email fred@example.com" }, format: "md", overrideSensitive: true });
  assert.equal(g.ok, true);
  const w = g.warnings.find((x) => x.check === "sensitive_data");
  assert.ok(w && w.overridden === true);
});
await t("gate: unsupported format blocks", () => {
  const g = exportSafetyGate({ artifact: cleanArt, format: "exe" });
  assert.equal(g.ok, false);
  assert.equal(g.blocked, "unsupported_format");
});
await t("gate: spec mode demands confirmation when warnings fired; confirmed=true passes", () => {
  const unreviewed = { ...cleanArt, mentorReviewed: false };
  const g1 = exportSafetyGate({ artifact: unreviewed, format: "md", lax: false });
  assert.equal(g1.ok, false);
  assert.equal(g1.blocked, "needs_confirmation");
  const g2 = exportSafetyGate({ artifact: unreviewed, format: "md", lax: false, confirmed: true });
  assert.equal(g2.ok, true);
  const g3 = exportSafetyGate({ artifact: cleanArt, format: "md", lax: false });
  assert.equal(g3.ok, true, "spec mode with zero warnings needs no confirmation");
});

// ============ 3. native document writers ============
await t("crc32 matches the known check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});
await t("zipBuffer: entries list back out of the central directory", () => {
  const z = zipBuffer([{ name: "a.txt", data: "hello" }, { name: "dir/b.txt", data: "world ".repeat(50) }]);
  assert.deepEqual(listZip(z), ["a.txt", "dir/b.txt"]);
  assert.equal(readZipEntry(z, "a.txt"), "hello");
  assert.equal(readZipEntry(z, "dir/b.txt"), "world ".repeat(50));
});
const MD_DOC = "# Project Report\n\nThe **first** deliverable shipped *early*.\n\n- item one\n- item two\n\n1. step alpha\n2. step beta\n\n```js\nconst x = 1;\n```\n";
await t("docx: round-trips through persona.mjs docxToText", () => {
  const buf = markdownToDocx(MD_DOC, "Project Report");
  assert.deepEqual(listZip(buf), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const text = docxToText(buf);
  for (const s of ["Project Report", "first", "shipped", "item one", "item two", "step alpha", "const x = 1;"]) {
    assert.ok(text.includes(s), `docx text carries "${s}"`);
  }
});
await t("docx: parseMarkdown structures headings/lists/code correctly", () => {
  const blocks = parseMarkdown(MD_DOC);
  assert.equal(blocks[0].kind, "h"); assert.equal(blocks[0].level, 1);
  assert.ok(blocks.some((b) => b.kind === "li" && !b.ordered));
  assert.ok(blocks.some((b) => b.kind === "li" && b.ordered && b.index === 2));
  assert.ok(blocks.some((b) => b.kind === "code" && b.text.includes("const x = 1;")));
  const inl = blocks[1].inlines;
  assert.ok(inl.some((x) => x.b && x.text === "first"), "bold inline parsed");
  assert.ok(inl.some((x) => x.i && x.text === "early"), "italic inline parsed");
});
await t("pdf: %PDF header, Tj text ops, xref/EOF, and multi-page pagination", () => {
  const buf = markdownToPdf(MD_DOC, "Project Report");
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4"), "header");
  assert.ok(s.includes(" Tj"), "text-showing operator present");
  assert.ok(s.includes("(Project Report)"), "title drawn");
  assert.ok(/%%EOF\n$/.test(s), "EOF trailer");
  assert.ok(/\/Count 1/.test(s), "single page for a short doc");
  // synthetic long doc paginates
  const big = markdownToPdf(Array.from({ length: 200 }, (_, i) => `- line item number ${i}`).join("\n"), "Big");
  const m = big.toString("latin1").match(/\/Count (\d+)/);
  assert.ok(m && Number(m[1]) >= 2, "long doc spans multiple pages (got " + (m && m[1]) + ")");
  // paren escaping never breaks the stream
  const esc = markdownToPdf("Balance (net) is 40% (up)", "T").toString("latin1");
  assert.ok(esc.includes("\\(net\\)"), "parens escaped");
});
await t("spreadsheet: markdown table and CSV both parse; quoting round-trips", () => {
  const rows = parseTable("| name | qty |\n|---|---|\n| widget | 2 |\n| gadget | 5 |");
  assert.deepEqual(rows, [["name", "qty"], ["widget", "2"], ["gadget", "5"]]);
  const csvRows = parseTable('name,qty\n"smith, john",7\nplain,3');
  assert.deepEqual(csvRows[1], ["smith, john", "7"]);
  assert.equal(parseTable("just prose, nothing tabular here\nno structure"), null);
  assert.ok(toCsv([["a,b", 'say "hi"']]).includes('"a,b","say ""hi"""'));
});
await t("xlsx: zip lists the OOXML entries and sheet1 carries the cells", () => {
  const buf = rowsToXlsx([["name", "qty"], ["widget", "2"]]);
  const names = listZip(buf);
  for (const n of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]) {
    assert.ok(names.includes(n), "entry " + n);
  }
  const sheet = readZipEntry(buf, "xl/worksheets/sheet1.xml");
  assert.ok(sheet.includes("<t xml:space=\"preserve\">widget</t>"), "inline string cell");
  assert.ok(sheet.includes("<v>2</v>"), "numeric cell");
  assert.ok(readZipEntry(buf, "xl/workbook.xml").includes('name="Sheet1"'));
});

// ============ 4. artifact store: provenance, archived, lastReview, drift ============
const dir = mkdtempSync(join(tmpdir(), "dominion-artifacts-test-"));
const store = createArtifactStore({ dir });
await t("store: creation records provenance on v1 itself", () => {
  const r = store.create({ title: "Doc", content: "hello world content", sourceChatId: "chat_1", sourceContextRefs: ["[M1]"], sourceToolRunIds: ["tr_a"], promptSummary: "make a doc" });
  const v1 = r.item.versions[0];
  assert.equal(v1.sourceChatId, "chat_1");
  assert.deepEqual(v1.sourceContextRefs, ["[M1]"]);
  assert.deepEqual(v1.sourceToolRunIds, ["tr_a"]);
});
let artId;
await t("store: revisions record their own provenance (E4)", () => {
  const made = store.create({ title: "Living Doc", content: "version one text about the plan", sourceChatId: "chat_1", sourceContextRefs: ["[M1]"] });
  artId = made.item.id;
  const r = store.addVersion(artId, { content: "version two text, revised after new retrieval", sourceChatId: "chat_2", sourceContextRefs: ["[A9]"], sourceToolRunIds: ["tr_z"], promptSummary: "revise it" });
  const v2 = r.item.versions[1];
  assert.equal(v2.sourceChatId, "chat_2");
  assert.deepEqual(v2.sourceContextRefs, ["[A9]"]);
  assert.deepEqual(v2.sourceToolRunIds, ["tr_z"]);
  assert.equal(v2.promptSummary, "revise it");
});
await t("store: archived status reachable and reversible", () => {
  assert.equal(store.update(artId, { status: "archived" }).item.status, "archived");
  assert.equal(store.update(artId, { status: "draft" }).item.status, "draft");
});
await t("store: attachReview stores the structured lastReview + reviewedVersion, clears the flag", () => {
  store.flagReview(artId, ["long_document"]);
  assert.deepEqual(store.get(artId).reviewRecommended, ["long_document"]);
  const r = store.attachReview(artId, "notes text", { overall_score: 6, ready_for_use: false, unsupported_claims: ["claim A"], risk_flags: ["risk B"], should_generate_revision: true });
  assert.equal(r.item.lastReview.overall_score, 6);
  assert.deepEqual(r.item.lastReview.unsupported_claims, ["claim A"]);
  assert.equal(r.item.reviewedVersion, r.item.version);
  assert.equal(r.item.reviewRecommended, null, "review clears the recommendation flag");
});
await t("store: changeRatio measures drift between versions", () => {
  const made = store.create({ title: "Drifting", content: "alpha\nbeta\ngamma\ndelta" });
  store.addVersion(made.item.id, { content: "alpha\nbeta\ngamma\ndelta" });
  assert.equal(store.changeRatio(made.item.id, 1, 2), 0, "identical versions = 0");
  store.addVersion(made.item.id, { content: "totally\ndifferent\nlines\nnow\nplus more" });
  assert.ok(store.changeRatio(made.item.id, 1, 3) > 0.4, "heavy rewrite > drift threshold");
});
await t("store: native exports write real docx/pdf/xlsx/csv files", () => {
  const made = store.create({ title: "Export Me", content: MD_DOC });
  for (const fmt of ["docx", "pdf"]) {
    const r = store.exportArtifact(made.item.id, fmt);
    assert.ok(!r.error, fmt + ": " + (r.error || ""));
    assert.ok(r.native && existsSync(r.path) && r.bytes > 100, fmt + " written natively");
  }
  const tbl = store.create({ title: "Table", content: "| a | b |\n|---|---|\n| 1 | 2 |" });
  const x = store.exportArtifact(tbl.item.id, "spreadsheet");
  assert.equal(x.format, "xlsx", "table content -> real xlsx");
  assert.ok(docxToText(readFileSync(store.exportArtifact(made.item.id, "docx").path)).includes("deliverable"), "written docx re-reads");
  const prose = store.create({ title: "Prose", content: "no table here\njust words" });
  const c = store.exportArtifact(prose.item.id, "spreadsheet");
  assert.equal(c.format, "csv", "prose spreadsheet falls back to csv");
});

// ============ 5. the tool paths pass through the gate ============
// mirror of server.mjs exportGated (LAX), wired as ctx.exportGated for the tool bus
const gatedExport = async (id, format, { overrideSensitive = false, destination = "" } = {}) => {
  const a = store.get(id);
  if (!a) return { error: "not found" };
  const gate = exportSafetyGate({ artifact: a, format, destination: destination || "local exports folder", overrideSensitive, lax: true });
  if (!gate.ok) return { blocked: gate.blocked, detected: gate.detected, error: gate.message, gate: { checks: gate.checks, warnings: gate.warnings } };
  const r = store.exportArtifact(id, gate.checks.format);
  if (r.error) return { ...r, gate: { checks: gate.checks, warnings: gate.warnings } };
  return { ...r, gate: { checks: gate.checks, warnings: gate.warnings } };
};
const triggerCalls = [];
const ctx = {
  artifacts: store, exportGated: gatedExport,
  provenance: () => ({ sourceChatId: "chat_t", sourceContextRefs: ["[M7]"], sourceToolRunIds: ["tr_t"], promptSummary: "tool turn" }),
  artifactTriggers: (id, sig) => { triggerCalls.push({ id, sig }); return { triggers: [] }; },
};
await t("tool export_artifact: sensitive content BLOCKS through the gate (bypass closed)", async () => {
  const made = store.create({ title: "Secrets", content: "the admin password: swordfish9 lives here" });
  const out = await runTool("export_artifact", { id: made.item.id, format: "md" }, ctx);
  assert.ok(/EXPORT BLOCKED/i.test(out), "tool relays the block: " + out);
  assert.ok(/acknowledge_sensitive/.test(out), "tool is told the override contract");
});
await t("tool export_artifact: explicit acknowledge_sensitive exports with a recorded warning", async () => {
  const made = store.create({ title: "Secrets2", content: "contact fred@example.com about it" });
  const out = await runTool("export_artifact", { id: made.item.id, format: "md", acknowledge_sensitive: true }, ctx);
  assert.ok(/Exported/.test(out), out);
  assert.ok(/sensitive/i.test(out), "warning relayed, not buried");
});
await t("tool export_artifact: no gate wired = refuse (never falls back to the raw store)", async () => {
  const made = store.create({ title: "NoGate", content: "plain" });
  const out = await runTool("export_artifact", { id: made.item.id, format: "md" }, { artifacts: store });
  assert.ok(/isn't available|no export gate/i.test(out));
});
await t("tool create_docx: creates a provenance-stamped artifact AND exports through the gate", async () => {
  triggerCalls.length = 0;
  const out = await runTool("create_docx", { title: "Tool Doc", content: "# Hi\n\nA tool-made document." }, ctx);
  assert.ok(/Saved artifact "Tool Doc"/.test(out), out);
  assert.ok(/Exported .* as docx/.test(out), out);
  const a = store.list({ q: "Tool Doc" }).map((m) => store.get(m.id)).find((x) => x.title === "Tool Doc");
  assert.equal(a.versions[0].sourceChatId, "chat_t", "provenance stamped by the tool");
  assert.equal(triggerCalls.length, 1, "trigger sweep ran on the tool-created artifact");
});
await t("tool create_pdf + create_spreadsheet: native end-to-end", async () => {
  const p = await runTool("create_pdf", { title: "Tool PDF", content: "One page of text." }, ctx);
  assert.ok(/Exported .* as pdf/.test(p), p);
  const s = await runTool("create_spreadsheet", { title: "Tool Sheet", content: "| x | y |\n|---|---|\n| 1 | 2 |" }, ctx);
  assert.ok(/Exported .* as xlsx/.test(s), s);
  const s2 = await runTool("create_spreadsheet", { title: "Tool Sheet CSV", content: "just words, no real table\nsecond line" }, ctx);
  assert.ok(/as csv/.test(s2), "no table -> csv fallback: " + s2);
});
await t("tool revise_artifact: stamps provenance and re-sweeps triggers", async () => {
  const made = store.create({ title: "ToolRev", content: "original words" });
  triggerCalls.length = 0;
  const out = await runTool("revise_artifact", { id: made.item.id, content: "revised words", note: "tweak" }, ctx);
  assert.ok(/Saved revision v2/.test(out), out);
  const a = store.get(made.item.id);
  assert.equal(a.versions[1].sourceChatId, "chat_t");
  assert.equal(triggerCalls.length, 1);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\nartifacts_test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
