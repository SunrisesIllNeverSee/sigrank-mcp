#!/usr/bin/env node
/**
 * Sync platform lists from upstream sources (tokscale + ccusage).
 *
 * Runs `tokscale models --help` and `ccusage --help` to discover the
 * current set of supported clients, then checks our adapter registry
 * and client maps for gaps. Prints a report. With `--update`, also
 * auto-adds missing tokscale clients to `lib/constants.mjs`
 * (TOKSCALE_CLIENT_MAP), mapped to "other" (the safe bucket — a human
 * promotes them to a real platform ID later by writing a native
 * adapter). Adapter-side gaps are NOT auto-fixed (a new adapter is a
 * code change, not a map edit) — those are reported for manual review.
 *
 * Usage:
 *   node scripts/sync-platforms.mjs              # print report (review gaps)
 *   node scripts/sync-platforms.mjs --json        # machine-readable report
 *   node scripts/sync-platforms.mjs --update      # auto-add missing tokscale clients to the map
 *
 * Exit codes:
 *   0 = in sync (or updated successfully)
 *   1 = gaps found (review needed) / no gaps to --update
 *   2 = upstream source unavailable
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const json = (v) => JSON.stringify(v, null, 2);

// ── 1. Discover upstream platforms ────────────────────────────────────────────

function discoverTokscale() {
  try {
    const raw = execFileSync("npx", ["tokscale", "models", "--help"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Extract possible values from: -c, --client <CLIENTS> ... [possible values: a, b, c]
    const m = raw.match(/\[possible values:\s*([^\]]+)\]/);
    if (!m) return { clients: [], error: "no possible values found in help" };
    const clients = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { clients, error: null };
  } catch (e) {
    return { clients: [], error: e.message };
  }
}

function discoverCcusage() {
  try {
    const raw = execFileSync("npx", ["ccusage", "--help"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Parse subcommands that say "Show ... usage"
    const lines = raw.split("\n");
    const platforms = [];
    const skip = new Set([
      "daily",
      "weekly",
      "monthly",
      "session",
      "blocks",
      "statusline",
    ]);
    for (const line of lines) {
      const m = line.match(/^\s+(\w+)\s+Show.*(?:usage|commands)/);
      if (m && !skip.has(m[1])) platforms.push(m[1]);
    }
    return { clients: platforms, error: null };
  } catch (e) {
    return { clients: [], error: e.message };
  }
}

// ── 2. Read our current maps ──────────────────────────────────────────────────

function readOurAdapters() {
  const src = readFileSync(join(ROOT, "adapters/index.mjs"), "utf8");
  // Extract platform names from the ADAPTERS registry
  const m = src.match(/export const ADAPTERS = \{([\s\S]*?)\};/);
  if (!m) return [];
  const entries = m[1]
    .split("\n")
    .map((l) => l.match(/^\s*(\w+):\s*\w+Adapter,?$/))
    .filter(Boolean)
    .map((m) => m[1]);
  // claude + codex are not in ADAPTERS (they have special handling)
  return [...entries, "claude", "codex"].sort();
}

function readTokscaleMap() {
  // Pass 8: TOKSCALE_CLIENT_MAP was centralized to lib/constants.mjs (Fix 4).
  // The old regex looked in tools/index.mjs; it now reads lib/constants.mjs.
  // We fall back to tools/index.mjs for back-compat in case a branch hasn't
  // picked up the centralization yet.
  const candidates = [
    join(ROOT, "lib/constants.mjs"),
    join(ROOT, "tools/index.mjs"),
  ];
  for (const path of candidates) {
    let src;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // Find the first TOKSCALE_CLIENT_MAP block (export const or const).
    const m = src.match(
      /(?:export\s+)?const TOKSCALE_CLIENT_MAP = \{([\s\S]*?)\};/,
    );
    if (!m) continue;
    const map = {};
    for (const line of m[1].split("\n")) {
      // Match: key: "value", or "key": "value", or key: null,
      const lm = line.match(/^\s*"?([^:",]+)"?\s*:\s*(?:"([^"]*)"|null)\s*,?\s*(?:\/\/.*)?$/);
      if (lm) {
        const key = lm[1].trim();
        const val = lm[2] === undefined ? "null" : lm[2].trim();
        if (key) map[key] = val;
      }
    }
    if (Object.keys(map).length > 0) return map;
  }
  return {};
}

// ── 3. Diff ───────────────────────────────────────────────────────────────────

function diffPlatforms(upstream, ours) {
  const upstreamSet = new Set(upstream);
  const ourSet = new Set(ours);
  const missing = upstream.filter((p) => !ourSet.has(p));
  const extra = ours.filter((p) => !upstreamSet.has(p));
  return { missing, extra };
}

function diffMap(upstreamClients, ourMap) {
  const missing = [];
  for (const client of upstreamClients) {
    if (!(client in ourMap)) {
      missing.push(client);
    }
  }
  return missing;
}

// ── 4. Report ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const doUpdate = args.includes("--update");

  const tokscale = discoverTokscale();
  const ccusage = discoverCcusage();
  const ourAdapters = readOurAdapters();
  const ourMap = readTokscaleMap();

  const report = {
    timestamp: new Date().toISOString(),
    upstream: {
      tokscale: {
        clients: tokscale.clients,
        error: tokscale.error,
      },
      ccusage: {
        clients: ccusage.clients,
        error: ccusage.error,
      },
    },
    ours: {
      adapters: ourAdapters,
      tokscaleMap: ourMap,
    },
    gaps: {
      tokscale: {
        // Clients in tokscale but missing from our TOKSCALE_CLIENT_MAP entirely
        clientsNotInMap: diffMap(tokscale.clients || [], ourMap),
        // Clients that tokscale has AND we have a native adapter name for in the map,
        // but that adapter doesn't actually exist in ADAPTERS
        clientsWithMissingAdapter: (tokscale.clients || []).filter((c) => {
          const mapped = ourMap[c];
          // Only flag if mapped to a real platform (not "other" or null)
          if (!mapped || mapped === "other" || mapped === "null") return false;
          return !ourAdapters.includes(mapped);
        }),
      },
      ccusage: {
        // ccusage clients that don't have a matching adapter
        clientsNotInAdapters: diffPlatforms(ccusage.clients || [], ourAdapters).missing,
      },
    },
  };

  if (asJson) {
    console.log(json(report));
  } else {
    console.log("=== Platform Sync Report ===");
    console.log(`Date: ${report.timestamp}\n`);

    console.log("Upstream tokscale clients:");
    if (tokscale.error) {
      console.log(`  ERROR: ${tokscale.error}`);
    } else {
      console.log(`  ${tokscale.clients.length} clients: ${tokscale.clients.join(", ")}`);
    }
    console.log();

    console.log("Upstream ccusage clients:");
    if (ccusage.error) {
      console.log(`  ERROR: ${ccusage.error}`);
    } else {
      console.log(`  ${ccusage.clients.length} clients: ${ccusage.clients.join(", ")}`);
    }
    console.log();

    console.log("Our adapters:");
    console.log(`  ${ourAdapters.length}: ${ourAdapters.join(", ")}\n`);

    console.log("Gaps:");
    const tsMapGaps = report.gaps.tokscale.clientsNotInMap;
    const tsAdapterGaps = report.gaps.tokscale.clientsWithMissingAdapter;
    const ccGaps = report.gaps.ccusage.clientsNotInAdapters;

    if (tsMapGaps.length === 0 && tsAdapterGaps.length === 0 && ccGaps.length === 0) {
      console.log("  All in sync ✓");
    } else {
      if (tsMapGaps.length > 0) {
        console.log(`  tokscale clients NOT in our map: ${tsMapGaps.join(", ")}`);
      }
      if (tsAdapterGaps.length > 0) {
        console.log(`  tokscale clients mapped to a platform with no adapter: ${tsAdapterGaps.join(", ")}`);
      }
      if (ccGaps.length > 0) {
        console.log(`  ccusage clients NOT in our adapters: ${ccGaps.join(", ")}`);
      }
    }
  }

  const hasGaps =
    report.gaps.tokscale.clientsNotInMap.length > 0 ||
    report.gaps.tokscale.clientsWithMissingAdapter.length > 0 ||
    report.gaps.ccusage.clientsNotInAdapters.length > 0;

  if (hasGaps && !doUpdate) {
    process.exit(1);
  }
  if (hasGaps && doUpdate) {
    // Pass 8: implement the --update path. Only auto-adds tokscale clients that
    // are entirely missing from TOKSCALE_CLIENT_MAP — maps them to "other"
    // (the safe bucket; a human promotes them to a real platform ID later by
    // writing a native adapter). Does NOT touch the adapter registry — a new
    // adapter is a code change, not a map edit. Edits lib/constants.mjs in
    // place by inserting before the closing `};` of the map.
    const missing = report.gaps.tokscale.clientsNotInMap;
    if (missing.length === 0) {
      console.log("\n--update: no tokscale-map gaps to add (gaps are adapter-side).");
      process.exit(1);
    }
    const constantsPath = join(ROOT, "lib/constants.mjs");
    let src = readFileSync(constantsPath, "utf8");
    // Locate the TOKSCALE_CLIENT_MAP block and find its closing `};`.
    const blockRe = /((?:export\s+)?const TOKSCALE_CLIENT_MAP = \{)([\s\S]*?)(\};)/;
    const m = src.match(blockRe);
    if (!m) {
      console.log("\n--update: could not locate TOKSCALE_CLIENT_MAP in lib/constants.mjs.");
      process.exit(1);
    }
    const [, head, body, tail] = m;
    // Build the new lines, sorted alphabetically by key for deterministic output.
    const newLines = missing
      .slice()
      .sort((a, b) => (a < b ? -1 : 1))
      .map((k) => `  ${JSON.stringify(k)}: "other",`)
      .join("\n");
    // Insert before the closing brace, preserving the existing trailing comma
    // on the last real entry (if any) by adding a leading newline.
    const newBody = `${body.replace(/\s*$/, "")}\n${newLines}\n`;
    const newSrc = src.replace(blockRe, `${head}${newBody}${tail}`);
    writeFileSync(constantsPath, newSrc, "utf8");
    console.log(`\n--update: added ${missing.length} client(s) to lib/constants.mjs (mapped to "other"):`);
    for (const c of missing) console.log(`  + ${c}`);
    console.log("\nReview the diff, then promote any that deserve a native adapter.");
    process.exit(0);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(2);
});
