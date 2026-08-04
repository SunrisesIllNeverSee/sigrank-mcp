/**
 * __tests__/contract/leaderboard-metric-contract.test.mjs
 *
 * LEADERBOARD-METRIC CONTRACT TEST — mirrors platform-enum-contract.test.mjs.
 *
 * The `metric=yield_` query parameter is an invisible cross-repo coupling:
 * the sigrank-mcp client requests it on every leaderboard fetch
 * (tools/get-leaderboard.mjs, presentation/cli.mjs fetchBoard,
 *  presentation/tui.mjs, compare-self / optimize-efficiency /
 *  get-best-operator / compare-operators), and the sigrank-app server must
 * accept it as a valid sort metric. If either side renames the metric
 * (e.g. server switches to `metric=yield`), every leaderboard fetch in the
 * client silently breaks — the server 400s or returns an unsorted board.
 *
 * This test guards both directions:
 *   1. INTRA-REPO: every leaderboard fetch site in sigrank-mcp uses the
 *      centralized LEADERBOARD_METRIC constant (no inline "yield_" literal
 *      lingering in a fetch URL). Catches a future copy-paste that bypasses
 *      the constant.
 *   2. CROSS-REPO (CI only): the constant matches the metric the server
 *      accepts. The server's accepted metric is read from
 *      sigrank-app/lib/board/leaderboard.ts (or the route handler) via regex.
 *      Locally without the other repo, the cross-repo check is skipped (not
 *      a failure) — same convention as platform-enum-contract.test.mjs.
 *
 * Run locally: node --test __tests__/contract/leaderboard-metric-contract.test.mjs
 * Run cross-repo: node __tests__/contract/leaderboard-metric-contract.test.mjs /path/to/sigrank-app
 *   (or set OTHER_REPO_ROOT env var — CI sets this.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { LEADERBOARD_METRIC } from "../../lib/constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = resolve(__dirname, "..", "..");

// ── 1. INTRA-REPO: no inline "yield_" metric literal in any fetch site ──────

/**
 * Recursively collect .mjs files under a directory (skipping node_modules,
 * .git, and this test directory). Returns absolute paths.
 */
function collectMjs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "__tests__")
      continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...collectMjs(full));
    } else if (name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

test("LEADERBOARD_METRIC constant is the canonical 'yield_' value", () => {
  assert.equal(
    LEADERBOARD_METRIC,
    "yield_",
    "LEADERBOARD_METRIC must be 'yield_' — the server ranks by this metric. " +
      "If you are intentionally renaming it, update the server (sigrank-app) " +
      "in the same change and update this assertion.",
  );
});

test("INTRA-REPO: no leaderboard fetch site inlines a metric literal", () => {
  // Every leaderboard/submissions fetch must use the LEADERBOARD_METRIC
  // constant, not a hard-coded "yield_" string. We scan every .mjs file
  // (excluding __tests__) for `metric=yield_` or `metric: "yield_"` /
  // `metric: 'yield_'` literals and fail if any remain.
  //
  // The constant import (`import { LEADERBOARD_METRIC } from ...`) is the
  // only sanctioned way to reference the metric. A literal in a fetch URL
  // is a drift waiting to happen — the platform-enum drift was the same
  // shape (one site forgot to use the shared enum).
  const files = collectMjs(SELF_ROOT);
  const offenders = [];
  // Match a metric literal in a URL query string or a URLSearchParams init.
  //   metric=yield_            (template/string URL)
  //   metric: "yield_"         (URLSearchParams object literal)
  //   metric: 'yield_'
  // We do NOT match `LEADERBOARD_METRIC` (the constant) — only the literal.
  const literalRe = /metric=yield_|metric:\s*["']yield_["']/;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Find every line with the literal; ignore lines that are comments.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (literalRe.test(line)) {
        // Skip comment-only lines (// or *).
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        offenders.push(`${relative(SELF_ROOT, f)}:${i + 1}: ${trimmed}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    "Found inline 'yield_' metric literal(s) in leaderboard fetch sites. " +
      "Import LEADERBOARD_METRIC from lib/constants.mjs and use it instead — " +
      "a literal here is an invisible cross-repo coupling with no guard.\n" +
      offenders.join("\n"),
  );
});

test("INTRA-REPO: every leaderboard fetch site imports LEADERBOARD_METRIC", () => {
  // Any .mjs file that builds a leaderboard/submissions URL must import the
  // constant. This catches the case where a fetch site uses the constant in
  // a template string but forgot the import (would throw at module load).
  const files = collectMjs(SELF_ROOT);
  const urlRe = /api\/v1\/(leaderboard|submissions)/;
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!urlRe.test(src)) continue;
    if (!/LEADERBOARD_METRIC/.test(src)) {
      offenders.push(relative(SELF_ROOT, f));
    }
  }
  assert.equal(
    offenders.length,
    0,
    "Found leaderboard/submissions fetch site(s) that do NOT import " +
      "LEADERBOARD_METRIC. Every fetch URL must use the constant — " +
      "a fetch site without the import is either inlining a literal " +
      "(caught by the previous test) or building the URL without the metric " +
      "(would 400 or return an unsorted board).\n" +
      offenders.join("\n"),
  );
});

// ── 2. CROSS-REPO (CI only): constant matches the server's accepted metric ──

/**
 * Extract the server's accepted leaderboard metric from sigrank-app.
 * The server's leaderboard route validates the `metric` query param against
 * an allow-list (zod enum or a Set). We look for the canonical pattern in
 * the most likely files:
 *   lib/board/leaderboard.ts
 *   app/api/v1/leaderboard/route.ts
 *   app/api/v1/submissions/route.ts
 *   lib/ingest/payload-schema.ts
 *
 * We search for `metric` zod enum or a Set/array of allowed metric names
 * and extract the first one. If we can't find it, we throw (the CI path
 * should fail loudly when the server file moves — better than silently
 * skipping).
 */
function extractServerMetric(repoRoot) {
  const candidates = [
    "lib/board/leaderboard.ts",
    "app/api/v1/leaderboard/route.ts",
    "app/api/v1/submissions/route.ts",
    "lib/ingest/payload-schema.ts",
  ];
  // Match either a zod enum: z.enum(["yield_", ...])  OR  a literal
  // "yield_" appearing next to `metric` in a validation context.
  const enumRe = /metric[^;]*?z\.enum\(\s*\[([\s\S]*?)\]/;
  const literalRe = /["']yield_["']/;
  for (const rel of candidates) {
    let src;
    try {
      src = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const enumMatch = src.match(enumRe);
    if (enumMatch) {
      const items = enumMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/['"`]/g, ""))
        .filter(Boolean);
      if (items.includes("yield_")) return "yield_";
      if (items.length > 0) return items[0];
    }
    if (literalRe.test(src)) return "yield_";
  }
  return null;
}

const otherRoot = process.argv[2] || process.env.OTHER_REPO_ROOT;

test("CROSS-REPO: LEADERBOARD_METRIC matches the server's accepted metric", () => {
  if (!otherRoot) {
    // Same convention as platform-enum-contract.test.mjs: skip locally
    // without the other repo, fail loudly in CI where both repos are checked out.
    console.log(
      "ℹ CROSS-REPO METRIC TEST: missing other repo path.\n" +
        "  Pass it as arg: node --test __tests__/contract/leaderboard-metric-contract.test.mjs /path/to/sigrank-app\n" +
        "  Or set OTHER_REPO_ROOT env var (CI sets this).\n" +
        "  Skipping (not a failure — run in CI where both repos are checked out).",
    );
    return;
  }
  const serverMetric = extractServerMetric(otherRoot);
  if (serverMetric == null) {
    // Could not find the server's metric allow-list — fail loudly so the CI
    // path surfaces a moved/renamed server file instead of silently passing.
    assert.fail(
      `Could not extract the server's accepted leaderboard metric from ${otherRoot}. ` +
        "Looked in lib/board/leaderboard.ts, app/api/v1/leaderboard/route.ts, " +
        "app/api/v1/submissions/route.ts, lib/ingest/payload-schema.ts. " +
        "If the server file moved, update this test's candidate list.",
    );
  }
  assert.equal(
    LEADERBOARD_METRIC,
    serverMetric,
    `Leaderboard metric DRIFTED! Client requests metric=${LEADERBOARD_METRIC} ` +
      `but the server accepts metric=${serverMetric}. Every leaderboard fetch ` +
      "in the client would 400 or return an unsorted board. Update BOTH sides " +
      "in the same change: lib/constants.mjs (client) + the server's metric " +
      "allow-list (sigrank-app).",
  );
});
