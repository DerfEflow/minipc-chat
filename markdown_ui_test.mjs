/*
 * Assistant formatting regression test. The parser is executed exactly as shipped, without a DOM,
 * so its block/inline decisions can be pinned while rendering remains safely DOM-only.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./public/dominion-markdown.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { filename: "dominion-markdown.js" });
const markdown = sandbox.window.DominionMarkdown;
assert.ok(markdown && typeof markdown.parse === "function", "the browser parser must initialize");

const sample = [
  "- Marketing claims unsubstantiated: Bench-scale projections without pilot data",
  "",
  "**RESEARCH COMPLETE - All Work Delivered**",
  "",
  "**Evidence Collected (21 IDs):** tr_13fd9916, tr_0efe0629",
  "",
  "| Source | Files |",
  "| --- | ---: |",
  "| GitHub | 10 |",
  "",
  "See [Rowow](https://rowow.net/) and `task_complete`.",
].join("\n");

const blocks = markdown.parse(sample);
assert.deepEqual(Array.from(blocks, (block) => block.type),
  ["list", "paragraph", "paragraph", "table", "paragraph"]);
assert.equal(blocks[0].items.length, 1, "a leading dash must render as a list item");
assert.equal(blocks[1].children[0].type, "strong", "double asterisks must render as bold");
assert.equal(blocks[2].children[0].type, "strong", "bold labels must not expose marker characters");
assert.equal(blocks[2].children.at(-1).value.includes("tr_0efe0629"), true,
  "evidence-id underscores must remain literal text");
assert.equal(blocks[3].rows.length, 1, "Markdown tables must become structured rows");
assert.ok(blocks[4].children.some((token) => token.type === "link"), "Markdown links must be recognized");
assert.ok(blocks[4].children.some((token) => token.type === "code"), "inline code must be recognized");
assert.doesNotMatch(source, /\.innerHTML\s*=/, "model output rendering must never use innerHTML");

const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
assert.match(app, /DominionMarkdown\.renderInto\(b,\s*m\.content\)/,
  "assistant bubbles must use the safe Markdown renderer");

console.log("markdown_ui_test: lists, emphasis, tables, links, code, and safe DOM rendering are pinned");
