/**
 * __tests__/contract/class-tier-contract.test.mjs
 *
 * CROSS-REPO CONTRACT TEST — the class-tier parity guard.
 *
 * The MCP server (sigrank-mcp) and the web app (sigrank-app) each maintain a
 * class-tier taxonomy. If they drift (different tier names, different
 * thresholds, different sub-stage counts), the client's local display will
 * mismatch the server's computed class — the exact bug Phase 2 was built to
 * fix. This test catches it at PR time.
 *
 * In CI: the workflow checks out BOTH repos (self + the other), then runs this
 * script. It extracts the tier lists + thresholds from each repo's files and
 * diffs them.
 *
 * Locally: run with the other repo's root path as the first arg:
 *   node __tests__/contract/class-tier-contract.test.mjs /path/to/the/other/repo
 *
 * The two contract surfaces:
 *   1. Tier names: 8 base tiers (CLASS_TIERS) — display grouping
 *   2. Thresholds: 24 sub-stage totalMin values (RS05_CLASS_THRESHOLDS) —
 *      the actual classification breakpoints
 *
 * Sources:
 *   sigrank-mcp:  analytics/cascade.mjs  →  CLASS_TIERS + RS05_CLASS_THRESHOLDS
 *   sigrank-app:  lib/identity/canon-ids.ts  →  CLASS_TIERS (Record<K.xx, {name}>)
 *                 lib/analytics/ruleset.ts   →  RS05_CLASS_THRESHOLDS
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  CLASS_TIERS as MCP_CLASS_TIERS,
  RS05_CLASS_THRESHOLDS as MCP_THRESHOLDS,
  SIGNAL_CLASSES as MCP_SIGNAL_CLASSES,
} from "../../analytics/cascade.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Extraction helpers ─────────────────────────────────────────────────────

/**
 * Extract the 8 base tier names from the server's canon-ids.ts.
 * The server uses `CLASS_TIERS: Record<string, ClassTierDef>` where each
 * entry has a `name` field. We extract the names in K.01→K.08 order.
 */
function extractServerTierNames(repoDir) {
  const src = readFileSync(
    join(repoDir, "lib/identity/canon-ids.ts"),
    "utf8",
  );
  // Match each K.xx block and extract the name field
  const tierMatches = [...src.matchAll(/"K\.\d{2}"\s*:\s*\{[^}]*name:\s*"([^"]+)"/g)];
  if (tierMatches.length === 0) {
    throw new Error("Could not extract tier names from canon-ids.ts");
  }
  return tierMatches.map((m) => m[1]);
}

/**
 * Extract the 24 sub-stage thresholds from the server's ruleset.ts.
 * Matches: { class: "ARCH+ I", totalMin: 7068201104627 },
 */
function extractServerThresholds(repoDir) {
  const src = readFileSync(
    join(repoDir, "lib/analytics/ruleset.ts"),
    "utf8",
  );
  // Find the RS05_CLASS_THRESHOLDS array
  const arrayMatch = src.match(
    /RS05_CLASS_THRESHOLDS[^=]*=\s*\[([\s\S]*?)\];/,
  );
  if (!arrayMatch) {
    throw new Error("Could not extract RS05_CLASS_THRESHOLDS from ruleset.ts");
  }
  // Extract each { class, totalMin } entry
  const entries = [...arrayMatch[1].matchAll(/\{\s*class:\s*"([^"]+)"\s*,\s*totalMin:\s*(\d+)\s*\}/g)];
  if (entries.length === 0) {
    throw new Error("Could not parse threshold entries from ruleset.ts");
  }
  return entries.map((m) => ({ class: m[1], totalMin: Number(m[2]) }));
}

/**
 * Detect which repo we're in by looking for marker files.
 */
function detectRepo(rootDir) {
  try {
    readFileSync(join(rootDir, "lib/identity/canon-ids.ts"), "utf8");
    return "web";
  } catch {
    try {
      readFileSync(join(rootDir, "analytics/cascade.mjs"), "utf8");
      return "mcp";
    } catch {
      throw new Error(
        `Could not detect repo type at ${rootDir} (no canon-ids.ts or cascade.mjs)`,
      );
    }
  }
}

// ── INTRA-REPO drift guard ──────────────────────────────────────────────────
// Assert that the client's own data is internally consistent:
//   - CLASS_TIERS has 8 entries
//   - SIGNAL_CLASSES has 24 entries (8 × 3)
//   - RS05_CLASS_THRESHOLDS has 24 entries matching SIGNAL_CLASSES
//   - Every threshold's base tier (via tierOf) is in CLASS_TIERS
// This runs unconditionally so an intra-repo drift fails CI regardless
// of whether the other repo is checked out.

const selfRoot = resolve(__dirname, "..", "..");
const selfType = detectRepo(selfRoot);

if (selfType === "mcp") {
  // CLASS_TIERS count
  if (MCP_CLASS_TIERS.length !== 8) {
    console.error(
      `✗ INTRA-REPO CONTRACT TEST: CLASS_TIERS has ${MCP_CLASS_TIERS.length} entries, expected 8.`,
    );
    process.exit(1);
  }
  // SIGNAL_CLASSES count
  if (MCP_SIGNAL_CLASSES.length !== 24) {
    console.error(
      `✗ INTRA-REPO CONTRACT TEST: SIGNAL_CLASSES has ${MCP_SIGNAL_CLASSES.length} entries, expected 24.`,
    );
    process.exit(1);
  }
  // Thresholds count + name match
  if (MCP_THRESHOLDS.length !== 24) {
    console.error(
      `✗ INTRA-REPO CONTRACT TEST: RS05_CLASS_THRESHOLDS has ${MCP_THRESHOLDS.length} entries, expected 24.`,
    );
    process.exit(1);
  }
  for (let i = 0; i < 24; i++) {
    if (MCP_THRESHOLDS[i].class !== MCP_SIGNAL_CLASSES[i]) {
      console.error(
        `✗ INTRA-REPO CONTRACT TEST: threshold[${i}] class "${MCP_THRESHOLDS[i].class}" != SIGNAL_CLASSES[${i}] "${MCP_SIGNAL_CLASSES[i]}".`,
      );
      process.exit(1);
    }
  }
  // Every threshold's base tier must be in CLASS_TIERS
  const tierSet = new Set(MCP_CLASS_TIERS);
  for (const t of MCP_THRESHOLDS) {
    const base = t.class.split(" ").slice(0, -1).join(" ");
    if (!tierSet.has(base)) {
      console.error(
        `✗ INTRA-REPO CONTRACT TEST: threshold "${t.class}" has base tier "${base}" not in CLASS_TIERS.`,
      );
      process.exit(1);
    }
  }
  console.log(
    `✓ INTRA-REPO CONTRACT TEST: class-tier taxonomy internally consistent ` +
      `(8 tiers, 24 sub-stages, 24 thresholds).`,
  );
}

// ── CROSS-REPO contract check ───────────────────────────────────────────────

const otherRoot = process.argv[2] || process.env.OTHER_REPO_ROOT;

if (!otherRoot) {
  console.error(
    "✗ CROSS-REPO CONTRACT TEST: missing other repo path.\n" +
      "  Pass it as arg: node __tests__/contract/class-tier-contract.test.mjs /path/to/other/repo\n" +
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

// Extract server data
let serverTierNames, serverThresholds;
try {
  serverTierNames = extractServerTierNames(otherRoot);
  serverThresholds = extractServerThresholds(otherRoot);
} catch (err) {
  console.error(
    `✗ CROSS-REPO CONTRACT TEST: failed to extract from server repo: ${err.message}`,
  );
  process.exit(1);
}

// ── Compare tier names (8 base tiers) ───────────────────────────────────────
const mcpTierNames = MCP_CLASS_TIERS;
const tierNameMismatch =
  mcpTierNames.length !== serverTierNames.length ||
  mcpTierNames.some((t, i) => t !== serverTierNames[i]);

if (tierNameMismatch) {
  console.error(
    `✗ CROSS-REPO CONTRACT TEST: tier names DRIFTED!\n` +
      `  mcp  (CLASS_TIERS):         [${mcpTierNames.join(", ")}]\n` +
      `  web  (canon-ids.ts names):  [${serverTierNames.join(", ")}]\n` +
      `\n  FIX: update analytics/cascade.mjs CLASS_TIERS to match canon-ids.ts.`,
  );
  process.exit(1);
}

// ── Compare thresholds (24 sub-stage totalMin values) ───────────────────────
const mcpThresholds = MCP_THRESHOLDS;
const thresholdMismatch =
  mcpThresholds.length !== serverThresholds.length ||
  mcpThresholds.some((t, i) => {
    const s = serverThresholds[i];
    return t.class !== s.class || t.totalMin !== s.totalMin;
  });

if (thresholdMismatch) {
  console.error(
    `✗ CROSS-REPO CONTRACT TEST: thresholds DRIFTED!\n` +
      `  mcp (cascade.mjs RS05_CLASS_THRESHOLDS):\n` +
      mcpThresholds.map((t) => `    ${t.class}: ${t.totalMin}`).join("\n") +
      "\n" +
      `  web (ruleset.ts RS05_CLASS_THRESHOLDS):\n` +
      serverThresholds.map((t) => `    ${t.class}: ${t.totalMin}`).join("\n") +
      "\n\n  FIX: update analytics/cascade.mjs RS05_CLASS_THRESHOLDS to match ruleset.ts.",
  );
  process.exit(1);
}

console.log(
  `✓ CROSS-REPO CONTRACT TEST: class-tier taxonomy matches (${mcpTierNames.length} tiers, ${mcpThresholds.length} thresholds).\n` +
    `  tier names: [${mcpTierNames.join(", ")}]\n` +
    `  thresholds: ${mcpThresholds.length} entries, floor=${mcpThresholds[23].totalMin}`,
);
process.exit(0);
