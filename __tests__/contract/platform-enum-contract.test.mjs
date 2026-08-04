/**
 * __tests__/contract/platform-enum-contract.test.mjs
 *
 * CROSS-REPO CONTRACT TEST — the codex-landing guard.
 *
 * The MCP server (sigrank-mcp) and the web app (sigrank-app) each maintain a
 * platform enum. If they drift (one repo accepts a platform the other doesn't),
 * submissions silently fail — the codex landing was triple-blocked by exactly
 * this drift. This test catches it at PR time.
 *
 * In CI: the workflow checks out BOTH repos (self + the other), then runs this
 * script. It extracts the enum from each repo's file and diffs them.
 *
 * Locally: run with the other repo's root path as the first arg:
 *   node __tests__/contract/platform-enum-contract.test.mjs /path/to/the/other/repo
 *
 * The two enum sources:
 *   sigrank-app:  lib/ingest/payload-schema.ts  →  platformPrimaryEnum (zod enum)
 *   sigrank-mcp:  submit/index.mjs      →  PLATFORM_ENUM (Set)
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── INTRA-REPO drift guard ───────────────────────────────────────────────────
// Pass 8: the original test only diffed the cross-repo enums. A registry/
// enum mismatch INSIDE this repo (ADAPTERS keys vs PLATFORM_ENUM in
// submit/index.mjs) was uncaught — a new adapter could be added to ADAPTERS
// without being added to PLATFORM_ENUM, and submissions for that platform
// would silently bucket to "other" on the client and 400 on the server.
// This block asserts the two lists agree before even looking at the other
// repo, so an intra-repo drift fails CI regardless of whether the other
// repo is checked out.

/**
 * Extract the ADAPTERS registry keys + the appended claude/codex from
 * adapters/index.mjs. Matches `export const ALL_PLATFORMS = Object.keys(ADAPTERS).concat(["claude", "codex"])`
 * directly (preferred), falling back to parsing the ADAPTERS object literal.
 */
function extractAllPlatforms(repoDir) {
  const src = readFileSync(join(repoDir, "adapters/index.mjs"), "utf8");
  // Preferred: ALL_PLATFORMS is the canonical exported list.
  const allMatch = src.match(
    /ALL_PLATFORMS\s*=\s*Object\.keys\(ADAPTERS\)\.concat\(\s*\[([\s\S]*?)\]\s*\)/,
  );
  if (allMatch) {
    const extra = allMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/['"`]/g, ""))
      .filter(Boolean);
    // Pull the ADAPTERS keys too.
    const reg = src.match(/export const ADAPTERS = \{([\s\S]*?)\};/);
    const keys = reg
      ? reg[1]
          .split("\n")
          .map((l) => l.match(/^\s*(\w+):\s*\w+Adapter,?$/))
          .filter(Boolean)
          .map((m) => m[1])
      : [];
    return [...keys, ...extra].sort();
  }
  // Fallback: parse the ADAPTERS object + assume claude/codex appended.
  const reg = src.match(/export const ADAPTERS = \{([\s\S]*?)\};/);
  if (!reg) throw new Error("Could not extract ADAPTERS from adapters/index.mjs");
  const keys = reg[1]
    .split("\n")
    .map((l) => l.match(/^\s*(\w+):\s*\w+Adapter,?$/))
    .filter(Boolean)
    .map((m) => m[1]);
  return [...keys, "claude", "codex"].sort();
}

/**
 * Extract the platform enum from the web app's schema.ts (zod enum).
 * Matches: z.enum(['claude', 'chatgpt', ...])
 */
function extractWebEnum(filePath) {
  const src = readFileSync(filePath, "utf8");
  // Match the z.enum([...]) call for platformPrimaryEnum
  const match = src.match(
    /platformPrimaryEnum\s*=\s*z\.enum\(\s*\[([\s\S]*?)\]\s*\)/,
  );
  if (!match)
    throw new Error(`Could not extract platformPrimaryEnum from ${filePath}`);
  const items = match[1]
    .split(",")
    .map((s) => s.trim().replace(/['"`]/g, ""))
    .filter(Boolean);
  return new Set(items);
}

/**
 * Extract the platform enum from the MCP's submit/index.mjs (Set constructor).
 * Matches: new Set(['claude', 'chatgpt', ...])
 */
function extractMcpEnum(filePath) {
  const src = readFileSync(filePath, "utf8");
  const match = src.match(
    /PLATFORM_ENUM\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/,
  );
  if (!match)
    throw new Error(`Could not extract PLATFORM_ENUM from ${filePath}`);
  const items = match[1]
    .split(",")
    .map((s) => s.trim().replace(/['"`]/g, ""))
    .filter(Boolean);
  return new Set(items);
}

/**
 * Detect which repo we're in by looking for the marker files.
 * sigrank-app has `lib/ingest/payload-schema.ts`; sigrank-mcp has
 * `submit/index.mjs` (the file that actually declares PLATFORM_ENUM — the
 * root `submit.mjs` is just a re-export shim and is not a reliable marker).
 */
function detectRepo(rootDir) {
  try {
    readFileSync(join(rootDir, "lib/ingest/payload-schema.ts"), "utf8");
    return "web";
  } catch {
    try {
      readFileSync(join(rootDir, "submit/index.mjs"), "utf8");
      return "mcp";
    } catch {
      throw new Error(
        `Could not detect repo type at ${rootDir} (no schema.ts or submit/index.mjs)`,
      );
    }
  }
}

/**
 * Get the platform enum from a repo at the given path.
 */
function getEnumForRepo(repoDir) {
  const type = detectRepo(repoDir);
  if (type === "web") {
    return extractWebEnum(join(repoDir, "lib/ingest/payload-schema.ts"));
  } else {
    return extractMcpEnum(join(repoDir, "submit/index.mjs"));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

// This repo's root (parent of __tests__/contract/)
const selfRoot = resolve(__dirname, "..", "..");
const selfType = detectRepo(selfRoot);
const selfEnum = getEnumForRepo(selfRoot);

// ── INTRA-REPO drift check (runs even without the other repo) ───────────────
// Pass 8: assert every PLATFORM_ENUM entry (the server-validated submit enum)
// has a matching adapter in ALL_PLATFORMS — UNLESS it's a known special-case
// bucket. The contract is one-directional by design:
//
//   PLATFORM_ENUM ⊆ (ALL_PLATFORMS ∪ SPECIAL_BUCKETS)
//
// The reverse (an adapter with no enum entry) is NOT a drift — adapters can
// pull data for platforms that bucket to "other" on submit via
// toPlatformPrimary(). The drift that IS a bug: a platform listed in
// PLATFORM_ENUM (so the server accepts it as a primary) but with NO native
// adapter — the client claims to submit it but can never pull data for it,
// so the operator can never actually produce a snapshot for that platform.
//
// Special buckets excluded from the adapter requirement:
//   "other"    — the safe fallback for unmapped tokscale clients
//   "multi"    — synthetic cross-platform aggregate (no single adapter)
//   "chatgpt"  — server-side only; users submit via the web paste path,
//                not via the MCP client (no native ChatGPT log adapter)
//
// This check runs unconditionally so an intra-repo drift fails CI regardless
// of whether the other repo is checked out.
if (selfType === "mcp") {
  const allPlatforms = new Set(extractAllPlatforms(selfRoot));
  const SPECIAL_BUCKETS = new Set(["other", "multi", "chatgpt"]);
  const enumWithoutAdapter = [...selfEnum].filter(
    (p) => !allPlatforms.has(p) && !SPECIAL_BUCKETS.has(p),
  );
  if (enumWithoutAdapter.length > 0) {
    console.error(
      "✗ INTRA-REPO CONTRACT TEST: PLATFORM_ENUM has entries with no adapter!\n" +
        `  PLATFORM_ENUM (submit/index.mjs): [${[...selfEnum].join(", ")}]\n` +
        `  ALL_PLATFORMS    (adapters/index.mjs): [${[...allPlatforms].join(", ")}]\n` +
        `  Enum entries with NO native adapter (excluding special buckets ${[...SPECIAL_BUCKETS].join(", ")}): [${enumWithoutAdapter.join(", ")}]\n` +
        "\n  A platform in PLATFORM_ENUM with no adapter means the client can\n" +
        "  submit it (server accepts it) but can never PULL data for it — the\n" +
        "  operator can never produce a snapshot. Either write a native adapter\n" +
        "  in adapters/index.mjs OR remove the platform from PLATFORM_ENUM\n" +
        "  (and the server's enum) if it's not a real submit target.",
    );
    process.exit(1);
  }
  console.log(
    `✓ INTRA-REPO CONTRACT TEST: every PLATFORM_ENUM entry has a native ` +
      `adapter (or is a special bucket). ${selfEnum.size} enum entries, ` +
      `${allPlatforms.size} adapters.`,
  );
}

// The other repo's root: either from CLI arg (local) or from CI env var
const otherRoot = process.argv[2] || process.env.OTHER_REPO_ROOT;

if (!otherRoot) {
  console.error(
    "✗ CROSS-REPO CONTRACT TEST: missing other repo path.\n" +
      "  Pass it as arg: node __tests__/contract/platform-enum-contract.test.mjs /path/to/other/repo\n" +
      "  Or set OTHER_REPO_ROOT env var (CI sets this).\n" +
      "  Skipping (not a failure — run in CI where both repos are checked out).",
  );
  process.exit(0); // Don't fail when run locally without the other repo
}

const otherType = detectRepo(otherRoot);
if (otherType === selfType) {
  console.error(
    `✗ CROSS-REPO CONTRACT TEST: both repos are type "${selfType}" — need one web + one mcp.\n` +
      `  self: ${selfRoot} (${selfType})\n` +
      `  other: ${otherRoot} (${otherType})`,
  );
  process.exit(1);
}

const otherEnum = getEnumForRepo(otherRoot);

// Diff the two enums
const selfOnly = [...selfEnum].filter((p) => !otherEnum.has(p));
const otherOnly = [...otherEnum].filter((p) => !selfEnum.has(p));

if (selfOnly.length === 0 && otherOnly.length === 0) {
  console.log(
    `✓ CROSS-REPO CONTRACT TEST: platform enums match (${selfEnum.size} platforms).\n` +
      `  ${selfType} (${selfRoot}): [${[...selfEnum].join(", ")}]\n` +
      `  ${otherType} (${otherRoot}): [${[...otherEnum].join(", ")}]`,
  );
  process.exit(0);
} else {
  console.error(
    `✗ CROSS-REPO CONTRACT TEST: platform enums DRIFTED!\n` +
      `  ${selfType} (${selfRoot}): [${[...selfEnum].join(", ")}]\n` +
      `  ${otherType} (${otherRoot}): [${[...otherEnum].join(", ")}]\n` +
      (selfOnly.length > 0
        ? `  Only in ${selfType}: [${selfOnly.join(", ")}]\n`
        : "") +
      (otherOnly.length > 0
        ? `  Only in ${otherType}: [${otherOnly.join(", ")}]\n`
        : "") +
      `\n  FIX: add the missing platform(s) to BOTH repos before merging.\n` +
      `  sigrank-app:  lib/ingest/payload-schema.ts  →  platformPrimaryEnum\n` +
      `  sigrank-mcp:  submit/index.mjs      →  PLATFORM_ENUM\n` +
      `  Also update: lib/canon/ids.ts (P.xx ID) + lib/constants.ts (PLATFORM_UI) + globals.css (--platform-xxx)`,
  );
  process.exit(1);
}
