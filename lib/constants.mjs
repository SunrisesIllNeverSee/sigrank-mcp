// lib/constants.mjs — repo-wide constants that were previously inlined as
// literals across multiple files. Centralizing them here means a version bump
// or a client-map update lands in exactly one place.
//
//   TERMS_VERSION / PRIVACY_VERSION — embedded in every enroll + submit
//     payload (tools/enroll.mjs, tools/submit-paste.mjs,
//     tools/tokenpull-submit.mjs, submit/index.mjs). They were inlined as
//     "2026-07-21" in four files; a terms rev would have required finding
//     and editing all four. Now: one export, imported everywhere.
//
//   TOKSCALE_CLIENT_MAP — maps tokscale's raw client names to our platform
//     IDs. Was duplicated verbatim in tools/index.mjs and
//     tools/tokscale-breakdown.mjs (and again in tokscale_analytics.mjs);
//     the three copies had already started to drift. One export here.
//
//   isRankedAck — the "actually on the board" predicate (verified + persisted).
//     Was inlined as `ack.verification_tier === "verified" && ack.persisted
//     === true` in submit-paste, tokenpull-submit, and submit/index.mjs, with
//     tokenpull-submit's multi-platform branch using a DIFFERENT looser
//     predicate (`ack?.ranked ?? ack?.accepted ?? false`). One predicate here
//     closes that loophole so every submit path agrees on what "ranked" means.

/** Current Terms of Service version the client attests to. */
export const TERMS_VERSION = "2026-07-21";

/** Current Privacy Policy version the client attests to. */
export const PRIVACY_VERSION = "2026-07-21";

/**
 * The leaderboard sort metric the client requests from the server. Every
 * leaderboard fetch site (tools/get-leaderboard.mjs, presentation/cli.mjs
 * fetchBoard, presentation/tui.mjs, compare-self / optimize-efficiency /
 * get-best-operator / compare-operators) MUST use this value — the server
 * ranks by `yield_` and a different metric string would either 400 or return
 * an unsorted board. Centralized here so a future metric rename lands in one
 * place; the contract test in __tests__/contract/leaderboard-metric-contract.test.mjs
 * guards against intra-repo drift and (in CI) cross-repo drift vs sigrank-app.
 */
export const LEADERBOARD_METRIC = "yield_";

/**
 * Map a raw tokscale `client` string to our canonical platform ID.
 * Values mapped to `null` are skipped (synthetic / non-attributable).
 * Values mapped to `"other"` have no native adapter and bucket together.
 */
export const TOKSCALE_CLIENT_MAP = {
  claude: "claude",
  codex: "codex",
  "devin-cli": "devin",
  "devin-desktop": "devin",
  gemini: "gemini",
  amp: "amp",
  kimi: "kimi",
  qwen: "qwen",
  goose: "goose",
  kilo: "kilo",
  kilocode: "kilo",
  hermes: "hermes",
  droid: "droid",
  codebuff: "codebuff",
  copilot: "copilot",
  opencode: "opencode",
  openclaw: "openclaw",
  pi: "pi",
  omp: "omp",
  "oh-my-pi": "omp",
  cursor: "other",
  roocode: "other",
  mux: "other",
  crush: "other",
  antigravity: "other",
  "antigravity-cli": "other",
  zed: "other",
  kiro: "other",
  trae: "other",
  warp: "other",
  cline: "other",
  "9router": "other",
  gjc: "other",
  grok: "other",
  jcode: "other",
  commandcode: "other",
  micode: "other",
  junie: "other",
  zcode: "other",
  opencodereview: "other",
  codebuddy: "other",
  workbuddy: "other",
  senpi: "other",
  augment: "other",
  kimchi: "other",
  reasonix: "other",
  "prime-agent": "other",
  freebuff: "other",
  synthetic: null,
};

/**
 * Platforms whose local data tokscale CANNOT see, so `tokscale models --json`
 * never lists them as an active client. pullActivePlatforms() auto-detect must
 * probe these directly or their cascade row can never appear, even with GBs of
 * native local telemetry (that was exactly the omp bug: tokscale reports
 * claude/codex/copilot/gemini/grok/kimi/kiro/opencode/pi and nothing else, so
 * a tokscale-detected machine silently dropped oh-my-pi entirely).
 *
 * The adapter pull itself filters out platforms with no data, so probing a
 * platform the operator doesn't use costs one cheap missing-directory walk.
 *
 * As of 2026-08-08: oh-my-pi. Delete an entry once tokscale reports that client
 * (TOKSCALE_CLIENT_MAP already maps the `omp` / `oh-my-pi` client names for
 * when that happens).
 */
export const TOKSCALE_BLIND_PLATFORMS = ["omp"];

/**
 * The "actually on the board" predicate. A submission is ranked only when the
 * server returns HTTP ok AND verification_tier === "verified" AND persisted
 * === true. An unenrolled/revoked device gets 202 but is NEVER ranked.
 *
 * Use this everywhere a submit path decides whether to surface `ranked: true`.
 * The previous tokenpull-submit multi-platform branch used a looser
 * `ack?.ranked ?? ack?.accepted ?? false` which would mark a non-persisted
 * 202 as ranked — this predicate closes that loophole.
 *
 * @param {{ ok: boolean }} res  the fetch Response (or { ok } shim)
 * @param {Record<string, unknown>} ack  the parsed JSON ack body
 * @returns {boolean}
 */
export function isRankedAck(res, ack) {
  return !!(
    res &&
    res.ok &&
    ack &&
    ack.verification_tier === "verified" &&
    ack.persisted === true
  );
}
