/*
 * Reviewed broker project identities. These are deliberately not derived from a
 * database row or a request: the static broker and the controller must agree on
 * the exact workspace subtree and ext4 project-quota ID before any payload can
 * be authorized.
 */
export const GAME_FACTORY_BROKER_PROJECTS = Object.freeze({
  "system-canary": 10001,
  "vector-vault": 10101,
  "bolt-bloom": 10102,
  "pocket-gravity": 10103,
  "chromalock": 10104,
  "tiny-foundry": 10105,
  "letter-loom": 10106,
  "pulse-path": 10107,
  "shelf-shift": 10108,
  "wobble-works": 10109,
  "signal-grid": 10110,
});

export const GAME_FACTORY_PORTFOLIO_SLUGS = Object.freeze(Object.keys(GAME_FACTORY_BROKER_PROJECTS)
  .filter((slug) => slug !== "system-canary"));

export function brokerProject(slug) {
  const name = typeof slug === "string" ? slug : "";
  const quotaId = GAME_FACTORY_BROKER_PROJECTS[name];
  if (!Number.isSafeInteger(quotaId)) return null;
  return Object.freeze({ slug: name, quotaId, workspaceRoot: `/workspace/${name}` });
}

export function isBrokerProject(slug, quotaId) {
  const project = brokerProject(slug);
  return !!project && (quotaId == null || Number(quotaId) === project.quotaId);
}
