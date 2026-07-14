#!/usr/bin/env node
/**
 * Sync platform lists from upstream sources (tokscale + ccusage).
 *
 * Runs `tokscale models --help` and `ccusage --help` to discover the
 * current set of supported clients, then checks our adapter registry
 * and client maps for gaps. Prints a report — does NOT auto-edit files
 * (human reviews the diff first).
 *
 * Usage:
 *   node scripts/sync-platforms.mjs              # print report
 *   node scripts/sync-platforms.mjs --json        # machine-readable
 *   node scripts/sync-platforms.mjs --update      # auto-update the maps
 *
 * Exit codes:
 *   0 = in sync (or updated successfully)
 *   1 = gaps found (review needed)
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
  const src = readFileSync(join(ROOT, "adapters.mjs"), "utf8");
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
  const src = readFileSync(join(ROOT, "tools.mjs"), "utf8");
  // Find the first TOKSCALE_CLIENT_MAP block
  const m = src.match(/const TOKSCALE_CLIENT_MAP = \{([\s\S]*?)\};/);
  if (!m) return {};
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
  return map;
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
    console.log("\n--update not yet implemented for auto-editing. Review gaps manually.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(2);
});
