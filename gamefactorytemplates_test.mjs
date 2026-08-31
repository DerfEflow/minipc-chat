import assert from "node:assert/strict";
import { PORTFOLIO, REQUIRED_GAME_ARTIFACTS } from "./gamefactory.mjs";
import {
  ARTIFACT_RENDERERS,
  GAME_PORTFOLIO_SPECS,
  MARKET_RESEARCH_SOURCES,
  PORTFOLIO_PACKAGE_DATE,
  createPortfolioSpecificationManifest,
  renderGameArtifact,
  validatePortfolioSpecs,
} from "./gamefactorytemplates.mjs";

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok", n, "-", name); };

test("portfolio templates exactly match the authoritative ten-game order", () => {
  assert.deepEqual(
    GAME_PORTFOLIO_SPECS.map(({ order, name, slug }) => ({ order, name, slug })),
    PORTFOLIO,
  );
  assert.deepEqual(validatePortfolioSpecs(), []);
  assert.equal(new Set(GAME_PORTFOLIO_SPECS.map((game) => game.logline)).size, 10);
  assert.equal(new Set(GAME_PORTFOLIO_SPECS.map((game) => game.differentiator)).size, 10);
});

test("all and only the eleven required artifacts have renderers", () => {
  assert.deepEqual(Object.keys(ARTIFACT_RENDERERS), REQUIRED_GAME_ARTIFACTS);
  for (const game of GAME_PORTFOLIO_SPECS) {
    for (const artifact of REQUIRED_GAME_ARTIFACTS) {
      const text = renderGameArtifact(game, artifact);
      assert.ok(text.startsWith(`# ${game.name} — `), `${game.slug}/${artifact} heading`);
      assert.ok(text.includes(game.status), `${game.slug}/${artifact} status`);
      assert.ok(text.includes("No product, legal, store, playtest, release or production approval is recorded"), `${game.slug}/${artifact} evidence rule`);
      assert.ok(text.length > 900, `${game.slug}/${artifact} is substantive`);
      assert.ok(text.endsWith("\n"));
    }
  }
});

test("market cases cite current research and distinguish evidence from a forecast", () => {
  assert.equal(PORTFOLIO_PACKAGE_DATE, "2026-08-31");
  assert.ok(MARKET_RESEARCH_SOURCES.length >= 7);
  assert.equal(new Set(MARKET_RESEARCH_SOURCES.map((source) => source.url)).size, MARKET_RESEARCH_SOURCES.length);
  for (const game of GAME_PORTFOLIO_SPECS) {
    const text = renderGameArtifact(game, "01_MARKET_CASE");
    for (const source of MARKET_RESEARCH_SOURCES) assert.ok(text.includes(`](${source.url})`), `${game.slug} cites ${source.id}`);
    assert.match(text, /do \*\*not\*\* validate this game/i);
    assert.match(text, /Testable acquisition hypothesis/);
    assert.match(text, /Kill\/revise criterion/);
    assert.ok(text.includes(game.hypothesis));
    assert.ok(text.includes(game.kill));
  }
});

test("each game has a distinct visual, commercial, QA and store contract", () => {
  assert.equal(new Set(GAME_PORTFOLIO_SPECS.map((game) => JSON.stringify(game.visual.palette))).size, 10);
  assert.equal(new Set(GAME_PORTFOLIO_SPECS.map((game) => game.visual.icon)).size, 10);
  assert.equal(new Set(GAME_PORTFOLIO_SPECS.map((game) => game.monetization.model)).size, 10);
  assert.equal(new Set(GAME_PORTFOLIO_SPECS.map((game) => game.store.subtitle)).size, 10);
  for (const game of GAME_PORTFOLIO_SPECS) {
    assert.equal(game.visual.palette.length, 5);
    assert.ok(game.mechanics.specialQa.length >= 4);
    assert.equal(game.store.shots.length, 5);
    assert.equal(game.risks.length, game.mitigations.length);
  }
});

test("the architecture and QA artifacts cover the mandatory game concerns", () => {
  const architectureTerms = [
    "Core system", "Controls", "Scoring", "Progression", "Difficulty", "Win", "Failure",
    "Persistence", "Audio and haptics", "Content and asset strategy", "Analytics contract",
    "Monetization hooks", "Error handling", "Performance", "Platform-specific considerations",
    "Update path", "Test approach",
  ];
  const qaTerms = ["Core loop", "Launch/crash", "Controls", "Save state", "Viewport", "Performance", "Monetization", "Offline", "Analytics", "Privacy/consent", "Store readiness"];
  for (const game of GAME_PORTFOLIO_SPECS) {
    const architecture = renderGameArtifact(game, "04_GAME_ARCHITECTURE");
    const qa = renderGameArtifact(game, "07_QA_AND_TESTING");
    for (const term of architectureTerms) assert.ok(architecture.includes(term), `${game.slug} architecture: ${term}`);
    for (const term of qaTerms) assert.ok(qa.includes(term), `${game.slug} QA: ${term}`);
    assert.match(qa, /NOT RUN — no game build exists/);
  }
});

test("handoff prompts preserve lifecycle, checkpoint and human approval gates", () => {
  for (const game of GAME_PORTFOLIO_SPECS) {
    const text = renderGameArtifact(game, "09_HANDOFF_PROMPT");
    for (const term of ["ARCHITECTURE", "ASSET_GENERATION", "IMPLEMENTATION", "safe boundary", "durable checkpoint", "owner", "store submission", "production release"]) {
      assert.ok(text.includes(term), `${game.slug} handoff: ${term}`);
    }
    assert.ok(text.includes(game.logline));
    assert.ok(text.includes(game.monetization.model));
  }
});

test("only Vector Vault is identified as the provisional pilot and no game is admitted", () => {
  const pilots = GAME_PORTFOLIO_SPECS.filter((game) => game.status.includes("PILOT_CANDIDATE"));
  assert.deepEqual(pilots.map((game) => game.slug), ["vector-vault"]);
  for (const game of GAME_PORTFOLIO_SPECS) {
    assert.ok(game.status.includes("PRE-ADMISSION"));
    const review = renderGameArtifact(game, "10_COMPLETENESS_REVIEW");
    assert.match(review, /SPECIFICATION PACKAGE COMPLETE; GAME PRE-ADMISSION BLOCKED/);
    assert.match(review, /No approval is recorded/);
  }
});

test("the deterministic manifest creates eleven documents and three truthful placeholders per game", () => {
  const manifest = createPortfolioSpecificationManifest();
  assert.equal(manifest.length, 10 * (11 + 3));
  assert.equal(new Set(manifest.map((file) => file.relativePath)).size, manifest.length);
  for (const game of GAME_PORTFOLIO_SPECS) {
    const files = manifest.filter((file) => file.game === game.slug);
    assert.equal(files.length, 14);
    for (const artifact of REQUIRED_GAME_ARTIFACTS) assert.ok(files.some((file) => file.relativePath === `${game.name}/${artifact}.md`));
    for (const directory of ["assets", "build", "release"]) {
      const placeholder = files.find((file) => file.relativePath === `${game.name}/${directory}/README.md`);
      assert.ok(placeholder);
      assert.match(placeholder.content, /EMPTY BY DESIGN/);
      assert.match(placeholder.content, /No game implementation, build, release, approval or store submission exists/);
    }
  }
});

test("rendered package contains no likely embedded credentials or false completion markers", () => {
  const joined = createPortfolioSpecificationManifest().map((file) => file.content).join("\n");
  for (const pattern of [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
    /\bAIza[0-9A-Za-z_-]{25,}\b/,
  ]) assert.doesNotMatch(joined, pattern);
  assert.doesNotMatch(joined, /\bSTORE APPROVED\b/);
  assert.doesNotMatch(joined, /\bRELEASED TO PRODUCTION\b/);
});

console.log(`\n${n} game factory portfolio template tests passed`);
