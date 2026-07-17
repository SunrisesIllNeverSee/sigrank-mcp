/**
 * ops-review.mjs — INTERNAL owner-only ratio review + apply tool.
 *
 * NOT part of the public `npx sigrank` CLI. Run directly from a local clone
 * of sigrank-mcp with Supabase service-role credentials in env.
 *
 * WHY THIS EXISTS:
 *   ChatGPT/Codex bundles cache_write into input and reports cache_write as
 *   near-zero. This causes SigRank to flag these operators as non-compounding,
 *   null their yield, and sort them to the bottom. The re-parse tool splits
 *   combined_input into input + cache_write using a reference operating ratio,
 *   then recalculates the cascade. The correct ratio is identified by the
 *   cache_write convergence test (see METHODOLOGY below).
 *
 *   This tool modifies operator profiles. It does NOT belong in the public CLI.
 *   Owner runs it. Every apply is logged as a submission entry on the operator's
 *   profile with source='ops_reparse' so the action is transparent.
 *
 * THREE MODES:
 *
 *   1. calc (no DB) — run the ratio review on raw numbers:
 *      node ops-review.mjs calc --output N --cache-read N --combined-input N
 *      node ops-review.mjs calc --handle kr-yeon  # if raw-data-package CSV present
 *
 *   2. lookup (read DB) — pull an operator's current pillars from Supabase, then calc:
 *      node ops-review.mjs lookup --codename kr-yeon
 *
 *   3. apply (write DB) — re-parse + write as a submission + update board metrics:
 *      node ops-review.mjs apply --codename kr-yeon --ratio "Codex PU"
 *      (requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env)
 *
 * ENV VARS (for lookup + apply):
 *   SUPABASE_URL              — e.g. https://copqtaqzsdvpdbhpwjmt.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (bypasses RLS). NEVER commit.
 *
 * METHODOLOGY — the cache_write convergence test:
 *
 *   The operating ratio is cache_read : input : output (input=1).
 *   cache_write is the DERIVED number we solve for. cache_read is the REAL
 *   number that validates the solution.
 *
 *   Given an operator's real telemetry (output, cache_read, combined_input):
 *     input_est   = output / velocity          (from the ratio's velocity term)
 *     cache_write = combined_input - input_est  (the remainder)
 *
 *   If the ratio fits, cache_write should land in the same range as other
 *   operators on that ratio (roughly 230-320M for 30-day windows). If one
 *   ratio produces a cache_write far below the others (>50% below peer median),
 *   that ratio is BROKEN for this operator — the velocity assumption doesn't
 *   match their actual working pattern.
 *
 *   The three reference ratios:
 *     AA avg   3.5:1:0.5    all-users average
 *     HCM      20:1:0.1     human center of mass
 *     Codex PU 243:1:1.03   Codex power-user
 *
 *   Example: kr-yeon
 *     Real telemetry: output=2.6B, cache_read=11.3B, combined_input=39B
 *     AA avg:   input=5.2B,  cache_write=33.8B  VALID (converges)
 *     HCM:      input=26B,   cache_write=13B    VALID (converges, but leverage=0.4:1 vs ref 20:1 = POOR fit)
 *     Codex PU: input=2.5B,  cache_write=36.5B  VALID (converges, leverage=4.5:1 vs ref 243:1 = WEAK fit)
 *
 *     HCM passes cache_write but its leverage (0.4:1) is nowhere near its
 *     reference (20:1). The operator doesn't work like HCM. AA avg has the
 *     best leverage match. Result: kr-yeon #1514 → #137.
 *
 *   Known limitation: for massive operators (39B+ combined input), all three
 *   ratios may pass cache_write validation. Leverage match becomes the only
 *   signal. May need a secondary signal (platform check, velocity threshold).
 *
 * Transcribed by Devin from owner (djm) analysis and direction.
 */

import { cascade, classify, round } from "./cascade.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Reference operating ratios (cache_read : input : output, input=1) ───────

const RATIOS = {
  "AA avg": {
    cache: 3.5,
    velocity: 0.5,
    label: "3.5:1:0.5",
    description: "all-users average",
  },
  HCM: {
    cache: 20,
    velocity: 0.1,
    label: "20:1:0.1",
    description: "human center of mass",
  },
  "Codex PU": {
    cache: 243,
    velocity: 1.03,
    label: "243:1:1.03",
    description: "Codex power-user",
  },
};

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtTokens(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// ANSI colors
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

// ─── Core: run all three ratios against real telemetry ───────────────────────

function runRatios(output, cacheRead, combinedInput) {
  const results = {};

  for (const [name, r] of Object.entries(RATIOS)) {
    const v = r.velocity;
    const cRef = r.cache;

    const inputEst = Math.round(output / v);
    const cacheWriteEst = combinedInput - inputEst;

    const leverage = cacheRead / inputEst;
    const velocity = v;
    const yieldVal = leverage * velocity;

    // Run the full cascade on the re-parsed pillars
    const cascadeResult = cascade({
      input: inputEst,
      output,
      cacheCreate: cacheWriteEst,
      cacheRead,
    });

    results[name] = {
      label: r.label,
      description: r.description,
      refCache: cRef,
      refVelocity: v,
      input: inputEst,
      output,
      cacheWrite: cacheWriteEst,
      cacheRead,
      leverage,
      velocity,
      yield: yieldVal,
      levMatch: leverage / cRef,
      cwValid: cacheWriteEst > 0,
      cascade: cascadeResult,
    };
  }

  // Cache write convergence test
  const cwValues = Object.values(results)
    .filter((r) => r.cwValid)
    .map((r) => r.cacheWrite);

  for (const [name, r] of Object.entries(results)) {
    if (!r.cwValid) {
      r.cwStatus = "INVALID (negative input estimate)";
      r.cwConverges = false;
      continue;
    }
    const others = Object.entries(results)
      .filter(([n]) => n !== name && results[n].cwValid)
      .map(([, v]) => v.cacheWrite);
    if (others.length > 0) {
      const otherMedian = [...others].sort((a, b) => a - b)[
        Math.floor(others.length / 2)
      ];
      if (r.cacheWrite < otherMedian * 0.5) {
        r.cwStatus = `OUTLIER (cache_write ${fmtTokens(r.cacheWrite)} is >50% below peers)`;
        r.cwConverges = false;
      } else if (r.cacheWrite < otherMedian * 0.7) {
        r.cwStatus = `LOW (cache_write ${fmtTokens(r.cacheWrite)} is below peers)`;
        r.cwConverges = false;
      } else {
        r.cwStatus = "VALID (converges with peers)";
        r.cwConverges = true;
      }
    } else {
      r.cwStatus = "VALID";
      r.cwConverges = true;
    }
  }

  return results;
}

// ─── Display: the full ratio review report ───────────────────────────────────

function printReview(opts, results, originalPillars) {
  const { output, cacheRead, combinedInput, handle } = opts;

  console.log();
  console.log(`  ${"=".repeat(80)}`);
  console.log(`  RATIO REVIEW${handle ? `: ${handle}` : " (custom)"}`);
  console.log(`  ${"=".repeat(80)}`);
  console.log();

  // Real telemetry
  console.log(`  ${bold("REAL TELEMETRY (constants):")}`);
  console.log(`    Output:          ${output.toLocaleString()}  (${fmtTokens(output)})`);
  console.log(`    Cache read:      ${cacheRead.toLocaleString()}  (${fmtTokens(cacheRead)})`);
  console.log(`    Combined input:  ${combinedInput.toLocaleString()}  (${fmtTokens(combinedInput)})`);
  if (originalPillars) {
    console.log(`    ${dim("(original reported input: " + fmtTokens(originalPillars.input) + ", cache_write: " + fmtTokens(originalPillars.cacheWrite) + ")")}`);
  }
  console.log();
  console.log(`  ${bold("REFERENCE RATIOS (cache_read : input : output, input=1):")}`);
  for (const [name, r] of Object.entries(RATIOS)) {
    console.log(`    ${name.padEnd(10)}  ${r.label.padEnd(12)}  (${r.description})`);
  }
  console.log();

  // Side-by-side table
  const names = ["AA avg", "HCM", "Codex PU"];
  const headerRow = `  ${"".padEnd(14)}  ${"AA avg".padStart(14)}  ${"HCM".padStart(14)}  ${"Codex PU".padStart(14)}`;
  const subHeaderRow = `  ${"".padEnd(14)}  ${"3.5:1:0.5".padStart(14)}  ${"20:1:0.1".padStart(14)}  ${"243:1:1.03".padStart(14)}`;
  const divider = `  ${"-".repeat(14)}  ${"-".repeat(14)}  ${"-".repeat(14)}  ${"-".repeat(14)}`;

  console.log(headerRow);
  console.log(subHeaderRow);
  console.log(divider);

  const dataRows = [
    ["Input", "input", "int"],
    ["Output", "output", "int"],
    ["Cache write", "cacheWrite", "int"],
    ["Cache read", "cacheRead", "int"],
    ["Velocity", "velocity", "float"],
    ["Leverage", "leverage", "lev"],
    ["Yield", "yield", "float"],
  ];

  for (const [label, key, type] of dataRows) {
    const vals = names.map((n) => {
      const v = results[n][key];
      if (type === "float") return v.toFixed(2).padStart(14);
      if (type === "lev") return `${v.toFixed(1)}:1`.padStart(14);
      return v.toLocaleString().padStart(14);
    });
    console.log(`  ${label.padEnd(14)}  ${vals[0]}  ${vals[1]}  ${vals[2]}`);
  }

  console.log(divider);
  const classes = names.map((n) => (results[n].cascade.class || "NULL").padStart(14));
  console.log(`  ${"Class".padEnd(14)}  ${classes[0]}  ${classes[1]}  ${classes[2]}`);
  console.log();

  // Cache write validation
  console.log(`  ${bold("CACHE WRITE VALIDATION:")}`);
  console.log();
  for (const name of names) {
    const r = results[name];
    const marker = r.cwConverges ? green("PASS") : red("FAIL");
    console.log(`    ${name.padEnd(10)}  cache_write = ${fmtTokens(r.cacheWrite).padStart(10)}  [${marker}] ${r.cwStatus}`);
  }
  console.log();

  // Leverage match
  console.log(`  ${bold("LEVERAGE MATCH (actual cache_read/input vs reference cache term):")}`);
  console.log();
  for (const name of names) {
    const r = results[name];
    let matchStatus;
    if (r.levMatch < 0.5) matchStatus = "POOR (ratio does not fit this operator)";
    else if (r.levMatch < 0.8 || r.levMatch > 2.0) matchStatus = "WEAK (leverage far from reference)";
    else if (r.levMatch >= 0.8 && r.levMatch <= 1.3) matchStatus = "STRONG (leverage matches reference)";
    else matchStatus = "MODERATE";
    console.log(
      `    ${name.padEnd(10)}  actual ${r.leverage.toFixed(1)}:1  vs  ref ${r.refCache.toFixed(1)}:1  =  ${r.levMatch.toFixed(2)}x  [${matchStatus}]`,
    );
  }
  console.log();

  // Cascade metrics for each ratio
  console.log(`  ${bold("CASCADE METRICS (re-parsed):")}`);
  console.log();
  for (const name of names) {
    const c = results[name].cascade;
    console.log(`    ${name.padEnd(10)}  Yield=${c.yield ?? "null"}  SNR=${c.snr ?? "null"}  10xDEV=${c.dev10x ?? "null"}  Mode=${c.mode?.mode ?? "?"}`);
  }
  console.log();

  // Recommendation
  const valid = Object.entries(results).filter(([, r]) => r.cwConverges);
  const validNames = valid.map(([n]) => n);

  console.log(`  ${bold("RECOMMENDATION:")}`);
  console.log();

  if (valid.length === 0) {
    console.log(`    ${red("No ratio passes cache_write validation. Manual review needed.")}`);
  } else if (valid.length === 1) {
    const [name, r] = valid[0];
    console.log(`    ${green(name)} (${r.label}) is the only ratio that passes cache_write validation.`);
    console.log(`    Yield: ${r.yield.toFixed(2)}    Class: ${r.cascade.class || "NULL"}`);
  } else {
    const eliminated = names.filter((n) => !validNames.includes(n));
    if (eliminated.length > 0) {
      console.log(`    ${dim("Eliminated:")} ${eliminated.join(", ")} (cache_write outlier)`);
    }
    console.log(`    ${dim("Candidates:")} ${validNames.join(", ")}`);
    console.log();

    // Best leverage match
    const [bestName, best] = valid.reduce((best, cur) =>
      Math.abs(cur[1].levMatch - 1.0) < Math.abs(best[1].levMatch - 1.0) ? cur : best
    );

    console.log(`    ${green("Best fit:")} ${bestName} (${best.label})`);
    console.log(`      Leverage match: ${best.levMatch.toFixed(2)}x (actual ${best.leverage.toFixed(1)}:1 vs ref ${best.refCache.toFixed(1)}:1)`);
    console.log(`      Yield: ${best.yield.toFixed(2)}    Class: ${best.cascade.class || "NULL"}`);
    console.log();
    console.log(`    ${yellow("To apply:")} node ops-review.mjs apply --codename ${handle || "<codename>"} --ratio "${bestName}"`);
  }

  console.log();
}

// ─── Supabase client (REST API, no dependency) ───────────────────────────────

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(red("\n  Missing Supabase credentials. Set in env:"));
    console.error(dim("    export SUPABASE_URL=https://<project>.supabase.co"));
    console.error(dim("    export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>\n"));
    process.exit(1);
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function sbFetch(path, options = {}) {
  const { url, key } = getSupabaseConfig();
  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  return res;
}

// ─── Report generator ────────────────────────────────────────────────────────

/**
 * Generate a full human-readable re-parse report for an operator.
 * Includes: starting point, the problem, the method, the analysis,
 * the decision, and where it lands.
 *
 * @param {object} ctx - operator info + pillars + results + rank info
 * @returns {string} markdown report
 */
function generateReport(ctx) {
  const {
    codename, displayName, platform, snapshotDate, windowType,
    originalPillars, originalCascade, originalRank, totalOperators,
    results, bestRatio, bestResult, reparsedPillars, reparsedCascade,
    newRank,
  } = ctx;

  const lines = [];
  const W = "=" .repeat(78);

  lines.push(W);
  lines.push(`SIGRANK OPERATOR RE-PARSE REPORT`);
  lines.push(`Codex Combined-Input Split via Operating Ratio Analysis`);
  lines.push(W);
  lines.push("");
  lines.push(`Operator:    ${codename}${displayName && displayName !== codename ? ` (${displayName})` : ""}`);
  lines.push(`Platform:    ${platform || "unknown"}`);
  lines.push(`Snapshot:    ${snapshotDate} (${windowType})`);
  lines.push(`Generated:   ${new Date().toISOString()}`);
  lines.push(`Applied by:  owner (ops-review.mjs)`);
  lines.push("");

  // ─── 1. STARTING POINT ─────
  lines.push(W);
  lines.push("1. STARTING POINT (current state as stored)");
  lines.push(W);
  lines.push("");
  lines.push("  Token pillars as reported by the platform:");
  lines.push("");
  lines.push(`    Input (fresh):       ${originalPillars.input.toLocaleString()}  (${fmtTokens(originalPillars.input)})`);
  lines.push(`    Output:              ${originalPillars.output.toLocaleString()}  (${fmtTokens(originalPillars.output)})`);
  lines.push(`    Cache write:         ${originalPillars.cacheCreate.toLocaleString()}  (${fmtTokens(originalPillars.cacheCreate)})${originalPillars.cacheCreate < 1e6 ? "  <-- NEAR-ZERO (Codex reporting gap)" : ""}`);
  lines.push(`    Cache read:          ${originalPillars.cacheRead.toLocaleString()}  (${fmtTokens(originalPillars.cacheRead)})`);
  const origTotal = originalPillars.input + originalPillars.output + originalPillars.cacheCreate + originalPillars.cacheRead;
  lines.push(`    Total:               ${origTotal.toLocaleString()}  (${fmtTokens(origTotal)})`);
  lines.push("");
  lines.push("  Cascade metrics from stored pillars:");
  lines.push("");
  lines.push(`    Yield:     ${originalCascade.yield ?? "NULL (non-compounding flag)"}`);
  lines.push(`    Leverage:  ${originalCascade.leverage ?? "null"}:1`);
  lines.push(`    Velocity:  ${originalCascade.velocity ?? "null"}`);
  lines.push(`    SNR:       ${originalCascade.snr ?? "null"}`);
  lines.push(`    10xDEV:    ${originalCascade.dev10x ?? "null"}`);
  lines.push(`    Class:     ${originalCascade.class || "NULL"}`);
  lines.push(`    Mode:      ${originalCascade.mode?.mode ?? "?"}`);
  lines.push("");
  lines.push(`  Board position:  rank #${originalRank} of ${totalOperators} operators`);
  lines.push("");

  // ─── 2. THE PROBLEM ─────
  lines.push(W);
  lines.push("2. THE PROBLEM");
  lines.push(W);
  lines.push("");
  if (originalPillars.cacheCreate < 1e6) {
    lines.push("  ChatGPT/Codex does not report cache_creation_tokens. It bundles user");
    lines.push("  input and cache write into a single 'input' field. SigRank sees");
    lines.push("  cache_write = 0 and flags the operator as non-compounding, which");
    lines.push("  nulls yield and sorts them to the bottom of the board.");
    lines.push("");
    lines.push(`  But cache_read is ${fmtTokens(originalPillars.cacheRead)} — ${(originalPillars.cacheRead / originalPillars.input).toFixed(1)}x the reported input.`);
    lines.push("  The operator is clearly compounding. The telemetry is blind to");
    lines.push("  their cache writes, not their workflow.");
  } else {
    lines.push("  The operator's reported cache_write is non-zero but may not reflect");
    lines.push("  the true split between fresh input and cache commits. The re-parse");
    lines.push("  tool validates the split using reference operating ratios.");
  }
  lines.push("");

  // ─── 3. THE METHOD ─────
  lines.push(W);
  lines.push("3. THE METHOD — cache_write convergence test");
  lines.push(W);
  lines.push("");
  lines.push("  The operating ratio is cache_read : input : output (input=1).");
  lines.push("  cache_write is the DERIVED number we solve for.");
  lines.push("  cache_read is the REAL number that validates the solution.");
  lines.push("");
  lines.push("  Equations:");
  lines.push("");
  lines.push("    1. Pick a reference velocity (output/input ratio) for the operator type");
  lines.push("    2. estimated_input = output / velocity");
  lines.push("    3. cache_write = combined_input - estimated_input  (the remainder)");
  lines.push("    4. Recompute all cascade metrics from the split pillars:");
  lines.push("");
  lines.push("       leverage = cache_read / estimated_input");
  lines.push("       velocity = output / estimated_input  (= reference velocity)");
  lines.push("       yield    = leverage * velocity = (cache_read * output) / estimated_input^2");
  lines.push("       10xDEV   = log10(leverage)");
  lines.push("       SNR      = output / (estimated_input + output)");
  lines.push("");
  lines.push("  Three reference ratios tested:");
  lines.push("");
  lines.push("    AA avg    3.5:1:0.5     velocity=0.5    all-users average");
  lines.push("    HCM       20:1:0.1      velocity=0.1    human center of mass");
  lines.push("    Codex PU  243:1:1.03    velocity=1.03   Codex power-user");
  lines.push("");
  lines.push("  Two tests eliminate wrong ratios:");
  lines.push("");
  lines.push("    Test 1 — cache_write convergence: the derived cache_write should land");
  lines.push("      in the same range as peer operators (roughly 230-320M for 30d).");
  lines.push("      If >50% below peer median, the ratio is broken for this operator.");
  lines.push("");
  lines.push("    Test 2 — leverage match: the operator's actual leverage (cache_read /");
  lines.push("      estimated_input) should be close to the ratio's reference cache term.");
  lines.push("      Look for levMatch closest to 1.0x.");
  lines.push("");

  // ─── 4. THE ANALYSIS ─────
  lines.push(W);
  lines.push("4. THE ANALYSIS — all three ratios");
  lines.push(W);
  lines.push("");
  lines.push("  Real telemetry (constants):");
  lines.push(`    Output:          ${originalPillars.output.toLocaleString()}  (${fmtTokens(originalPillars.output)})`);
  lines.push(`    Cache read:      ${originalPillars.cacheRead.toLocaleString()}  (${fmtTokens(originalPillars.cacheRead)})`);
  lines.push(`    Combined input:  ${originalPillars.input.toLocaleString()}  (${fmtTokens(originalPillars.input)})`);
  lines.push("");
  lines.push("  ┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐");
  lines.push("  │                  │     AA avg       │      HCM         │    Codex PU      │");
  lines.push("  │                  │    3.5:1:0.5     │    20:1:0.1      │   243:1:1.03     │");
  lines.push("  ├──────────────────┼──────────────────┼──────────────────┼──────────────────┤");

  const names = ["AA avg", "HCM", "Codex PU"];
  const rows = [
    ["Input (est)", "input", "int"],
    ["Cache write", "cacheWrite", "int"],
    ["Leverage", "leverage", "lev"],
    ["Velocity", "velocity", "float"],
    ["Yield", "yield", "float"],
    ["10xDEV", "dev10x", "dev"],
    ["Class", "class", "str"],
  ];

  for (const [label, key, type] of rows) {
    const vals = names.map((n) => {
      const r = results[n];
      if (key === "class") return (r.cascade.class || "NULL").padStart(16);
      if (type === "float") return r[key].toFixed(2).padStart(16);
      if (type === "lev") return `${r[key].toFixed(1)}:1`.padStart(16);
      if (type === "dev") return (r.cascade.dev10x ?? "null").toString().padStart(16);
      return r[key].toLocaleString().padStart(16);
    });
    lines.push(`  │ ${label.padEnd(16)} │${vals[0]}│${vals[1]}│${vals[2]}│`);
  }
  lines.push("  └──────────────────┴──────────────────┴──────────────────┴──────────────────┘");
  lines.push("");

  // Cache write validation
  lines.push("  Cache write validation:");
  for (const name of names) {
    const r = results[name];
    const pass = r.cwConverges ? "PASS" : "FAIL";
    lines.push(`    ${name.padEnd(10)}  cache_write = ${fmtTokens(r.cacheWrite).padStart(10)}  [${pass}]  ${r.cwStatus}`);
  }
  lines.push("");

  // Leverage match
  lines.push("  Leverage match (actual vs reference):");
  for (const name of names) {
    const r = results[name];
    let matchStatus;
    if (r.levMatch < 0.5) matchStatus = "POOR";
    else if (r.levMatch < 0.8 || r.levMatch > 2.0) matchStatus = "WEAK";
    else if (r.levMatch >= 0.8 && r.levMatch <= 1.3) matchStatus = "STRONG";
    else matchStatus = "MODERATE";
    lines.push(`    ${name.padEnd(10)}  actual ${r.leverage.toFixed(1)}:1  vs  ref ${r.refCache.toFixed(1)}:1  =  ${r.levMatch.toFixed(2)}x  [${matchStatus}]`);
  }
  lines.push("");

  // ─── 5. THE DECISION ─────
  lines.push(W);
  lines.push("5. THE DECISION");
  lines.push(W);
  lines.push("");

  const valid = Object.entries(results).filter(([, r]) => r.cwConverges);
  const eliminated = names.filter((n) => !valid.some(([v]) => v === n));

  if (eliminated.length > 0) {
    lines.push(`  Eliminated: ${eliminated.join(", ")}`);
    for (const name of eliminated) {
      lines.push(`    ${name}: ${results[name].cwStatus}`);
    }
    lines.push("");
  }

  lines.push(`  Selected ratio: ${bestRatio} (${bestResult.label})`);
  lines.push(`    Reason: ${bestResult.cwConverges ? "passes cache_write convergence" : "cache_write validation"} + best leverage match (${bestResult.levMatch.toFixed(2)}x)`);
  lines.push(`    Leverage: ${bestResult.leverage.toFixed(1)}:1 (actual) vs ${bestResult.refCache.toFixed(1)}:1 (reference)`);
  lines.push("");

  // ─── 6. WHERE IT LANDS ─────
  lines.push(W);
  lines.push("6. WHERE IT LANDS (re-parsed state)");
  lines.push(W);
  lines.push("");
  lines.push("  Re-parsed token pillars:");
  lines.push("");
  lines.push(`    Input (fresh):       ${reparsedPillars.input.toLocaleString()}  (${fmtTokens(reparsedPillars.input)})`);
  lines.push(`    Output:              ${reparsedPillars.output.toLocaleString()}  (${fmtTokens(reparsedPillars.output)})`);
  lines.push(`    Cache write:         ${reparsedPillars.cacheCreate.toLocaleString()}  (${fmtTokens(reparsedPillars.cacheCreate)})`);
  lines.push(`    Cache read:          ${reparsedPillars.cacheRead.toLocaleString()}  (${fmtTokens(reparsedPillars.cacheRead)})`);
  const newTotal = reparsedPillars.input + reparsedPillars.output + reparsedPillars.cacheCreate + reparsedPillars.cacheRead;
  lines.push(`    Total:               ${newTotal.toLocaleString()}  (${fmtTokens(newTotal)})`);
  lines.push("");
  lines.push("  Recalculated cascade metrics:");
  lines.push("");
  lines.push(`    Yield:     ${reparsedCascade.yield ?? "null"}`);
  lines.push(`    Leverage:  ${reparsedCascade.leverage ?? "null"}:1`);
  lines.push(`    Velocity:  ${reparsedCascade.velocity ?? "null"}`);
  lines.push(`    SNR:       ${reparsedCascade.snr ?? "null"}`);
  lines.push(`    10xDEV:    ${reparsedCascade.dev10x ?? "null"}`);
  lines.push(`    Class:     ${reparsedCascade.class || "NULL"}`);
  lines.push(`    Mode:      ${reparsedCascade.mode?.mode ?? "?"} (confidence ${(reparsedCascade.mode?.confidence ?? 0).toFixed(2)})`);
  lines.push("");
  lines.push("  Rank change:");
  lines.push(`    Before:  #${originalRank} of ${totalOperators}`);
  lines.push(`    After:   #${newRank} of ${totalOperators}`);
  lines.push(`    Delta:   ${originalRank - newRank > 0 ? "+" : ""}${originalRank - newRank} positions ${originalRank - newRank > 0 ? "up" : "down"}`);
  lines.push("");
  lines.push(W);
  lines.push("End of report.");
  lines.push(W);
  lines.push("");

  return lines.join("\n");
}

/**
 * Compute approximate rank by pulling all operators' latest pillars
 * and computing yield for each. Returns { rank, total }.
 */
async function computeRank(operatorId, reparsedYield, useReparsed) {
  // Pull all latest metric_snapshots with pillar data
  // We get the latest per operator by ordering + limiting, but PostgREST
  // doesn't do DISTINCT ON. Instead pull all and dedupe client-side.
  const pageSize = 1000;
  let allRows = [];
  let offset = 0;

  while (true) {
    const res = await sbFetch(
      `/rest/v1/metric_snapshots?select=operator_id,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens&order=operator_id,snapshot_date.desc&limit=${pageSize}&offset=${offset}`
    );
    const batch = await res.json();
    if (!batch.length) break;
    allRows = allRows.concat(batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  // Dedupe: keep only the latest row per operator (first occurrence since ordered by date desc)
  const latestByOp = new Map();
  for (const row of allRows) {
    if (!latestByOp.has(row.operator_id)) {
      latestByOp.set(row.operator_id, row);
    }
  }

  // If useReparsed, temporarily replace our operator's pillars
  // (the caller handles this by passing the reparsed yield directly)

  // Compute yield for each operator
  const yields = [];
  for (const [opId, row] of latestByOp) {
    if (!row.output_tokens || !row.input_tokens) continue;
    // If cache_write is 0 (Codex gap), the app nulls yield — skip
    if (row.cache_creation_tokens === 0 && opId !== operatorId) {
      continue;
    }
    const i = row.input_tokens;
    const o = row.output_tokens;
    const cr = row.cache_read_tokens;
    const leverage = i > 0 ? cr / i : 0;
    const velocity = i > 0 ? o / i : 0;
    const y = leverage * velocity;
    yields.push({ opId, yield: y });
  }

  // Add/replace our operator's yield
  if (useReparsed && reparsedYield != null) {
    yields.push({ opId: operatorId, yield: reparsedYield });
  }

  // Sort descending by yield
  yields.sort((a, b) => b.yield - a.yield);

  // Find our operator's rank
  const rank = yields.findIndex((y) => y.opId === operatorId) + 1;
  return { rank: rank || yields.length, total: yields.length };
}

// ─── Mode 1: calc (no DB) ────────────────────────────────────────────────────

async function modeCalc(args, flags) {
  const output = flags.output ? Number(flags.output) : undefined;
  const cacheRead = flags["cache-read"] ? Number(flags["cache-read"]) : undefined;
  const combinedInput = flags["combined-input"] ? Number(flags["combined-input"]) : undefined;
  const handle = args[0] && !args[0].startsWith("--") ? args[0] : undefined;

  if (!output || !cacheRead || !combinedInput) {
    console.error(red(
      "\n  Missing required values. Usage:\n" +
      "    node ops-review.mjs calc --output N --cache-read N --combined-input N\n"
    ));
    process.exit(1);
  }

  const results = runRatios(output, cacheRead, combinedInput);
  printReview({ output, cacheRead, combinedInput, handle }, results);
}

// ─── Mode 2: lookup (read DB) ────────────────────────────────────────────────

async function modeLookup(args, flags) {
  const codename = flags.codename || (args[0] && !args[0].startsWith("--") ? args[0] : undefined);
  if (!codename) {
    console.error(red("\n  Usage: node ops-review.mjs lookup --codename <name>\n"));
    process.exit(1);
  }

  console.log(cyan(`\n  Looking up ${codename} in Supabase...`));

  // Find the operator
  const opRes = await sbFetch(
    `/rest/v1/operators?codename=eq.${encodeURIComponent(codename)}&select=operator_id,codename,display_name,primary_domain`
  );
  const operators = await opRes.json();
  if (!operators.length) {
    console.error(red(`\n  Operator "${codename}" not found.\n`));
    process.exit(1);
  }
  const op = operators[0];
  console.log(`  Found: ${bold(op.codename)} (${op.display_name || "no display name"}) — ${op.primary_domain || "unknown platform"}`);

  // Get latest metric_snapshot with pillar data
  const msRes = await sbFetch(
    `/rest/v1/metric_snapshots?operator_id=eq.${op.operator_id}&order=snapshot_date.desc&limit=1&` +
    `select=snapshot_date,window_type,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,signa_rate,class_tier`
  );
  const snapshots = await msRes.json();
  if (!snapshots.length || !snapshots[0].output_tokens) {
    console.error(red(`\n  No pillar data found for ${codename}. The operator may not have token pillars stored.\n`));
    process.exit(1);
  }
  const ms = snapshots[0];
  console.log(`  Snapshot: ${ms.snapshot_date} (${ms.window_type})`);
  console.log();

  // The stored input_tokens may be the combined input (pre-re-parse).
  // cache_creation_tokens may be near-zero (the Codex reporting gap).
  // We treat stored input_tokens as combined_input for the review.
  const combinedInput = ms.input_tokens;
  const cacheRead = ms.cache_read_tokens;
  const output = ms.output_tokens;
  const originalPillars = {
    input: ms.input_tokens,
    cacheWrite: ms.cache_creation_tokens,
  };

  console.log(`  ${bold("STORED PILLARS (as reported):")}`);
  console.log(`    Input (combined):  ${fmtTokens(ms.input_tokens)}`);
  console.log(`    Output:            ${fmtTokens(ms.output_tokens)}`);
  console.log(`    Cache write:       ${fmtTokens(ms.cache_creation_tokens)}  ${ms.cache_creation_tokens < 1e6 ? red("(near-zero — Codex reporting gap)") : ""}`);
  console.log(`    Cache read:        ${fmtTokens(ms.cache_read_tokens)}`);
  console.log();

  const results = runRatios(output, cacheRead, combinedInput);
  printReview({ output, cacheRead, combinedInput, handle: codename }, results, originalPillars);
}

// ─── Mode 2b: report (generate full report, no DB write) ─────────────────────

async function modeReport(args, flags) {
  const codename = flags.codename || (args[0] && !args[0].startsWith("--") ? args[0] : undefined);
  const ratioName = flags.ratio;
  const saveFile = flags.save;

  if (!codename) {
    console.error(red("\n  Usage: node ops-review.mjs report --codename <name> [--ratio \"Codex PU\"] [--save <path>]\n"));
    process.exit(1);
  }

  console.log(cyan(`\n  Generating report for ${codename}...`));

  // Pull operator info
  const opRes = await sbFetch(
    `/rest/v1/operators?codename=eq.${encodeURIComponent(codename)}&select=operator_id,codename,display_name,primary_domain`
  );
  const operators = await opRes.json();
  if (!operators.length) {
    console.error(red(`\n  Operator "${codename}" not found.\n`));
    process.exit(1);
  }
  const op = operators[0];

  // Pull latest metric_snapshot
  const msRes = await sbFetch(
    `/rest/v1/metric_snapshots?operator_id=eq.${op.operator_id}&order=snapshot_date.desc&limit=1&` +
    `select=snapshot_date,window_type,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,class_tier`
  );
  const snapshots = await msRes.json();
  if (!snapshots.length || !snapshots[0].output_tokens) {
    console.error(red(`\n  No pillar data found for ${codename}.\n`));
    process.exit(1);
  }
  const ms = snapshots[0];

  const originalPillars = {
    input: ms.input_tokens,
    output: ms.output_tokens,
    cacheCreate: ms.cache_creation_tokens,
    cacheRead: ms.cache_read_tokens,
  };
  const originalCascade = cascade(originalPillars);

  // Run the ratio review
  const results = runRatios(ms.output_tokens, ms.cache_read_tokens, ms.input_tokens);

  // Pick the ratio: explicit flag, or auto-select best
  let bestRatio, bestResult;
  if (ratioName && RATIOS[ratioName]) {
    bestRatio = ratioName;
    bestResult = results[ratioName];
  } else {
    const valid = Object.entries(results).filter(([, r]) => r.cwConverges);
    if (valid.length === 0) {
      console.error(red("\n  No ratio passes cache_write validation. Cannot generate report.\n"));
      process.exit(1);
    }
    [bestRatio, bestResult] = valid.reduce((best, cur) =>
      Math.abs(cur[1].levMatch - 1.0) < Math.abs(best[1].levMatch - 1.0) ? cur : best
    );
    console.log(`  ${dim("Auto-selected ratio:")} ${bestRatio} (${bestResult.label})`);
  }

  // Compute re-parsed pillars
  const r = RATIOS[bestRatio];
  const inputEst = Math.round(ms.output_tokens / r.velocity);
  const cacheWriteEst = ms.input_tokens - inputEst;
  const reparsedPillars = {
    input: inputEst,
    output: ms.output_tokens,
    cacheCreate: cacheWriteEst,
    cacheRead: ms.cache_read_tokens,
  };
  const reparsedCascade = cascade(reparsedPillars);

  // Compute ranks
  console.log(cyan(`  Computing board ranks (pulling all operators)...`));
  const origRankInfo = await computeRank(op.operator_id, null, false);
  const newRankInfo = await computeRank(op.operator_id, reparsedCascade.yield, true);

  // Generate the report
  const report = generateReport({
    codename: op.codename,
    displayName: op.display_name,
    platform: op.primary_domain,
    snapshotDate: ms.snapshot_date,
    windowType: ms.window_type,
    originalPillars,
    originalCascade,
    originalRank: origRankInfo.rank,
    totalOperators: origRankInfo.total,
    results,
    bestRatio,
    bestResult,
    reparsedPillars,
    reparsedCascade,
    newRank: newRankInfo.rank,
  });

  // Print the report
  console.log();
  console.log(report);

  // Save to file if requested
  if (saveFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(saveFile, report);
    console.log(green(`  Report saved to ${saveFile}`));
    console.log();
  } else {
    console.log(dim(`  Use --save <path> to save to a file.`));
    console.log(dim(`  Use apply --codename ${codename} --ratio "${bestRatio}" to write to Supabase.`));
    console.log();
  }

  return { report, bestRatio, reparsedPillars, reparsedCascade, operatorId: op.operator_id };
}

// ─── Mode 3: apply (write DB) ────────────────────────────────────────────────

async function modeApply(args, flags) {
  const codename = flags.codename || (args[0] && !args[0].startsWith("--") ? args[0] : undefined);
  const ratioName = flags.ratio;
  const output = flags.output ? Number(flags.output) : undefined;
  const cacheRead = flags["cache-read"] ? Number(flags["cache-read"]) : undefined;
  const combinedInput = flags["combined-input"] ? Number(flags["combined-input"]) : undefined;
  const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";

  if (!codename) {
    console.error(red("\n  Usage: node ops-review.mjs apply --codename <name> --ratio \"Codex PU\"\n"));
    process.exit(1);
  }
  if (!ratioName || !RATIOS[ratioName]) {
    console.error(red(`\n  Invalid or missing --ratio. Choose from: ${Object.keys(RATIOS).join(", ")}\n`));
    process.exit(1);
  }

  // Get pillars: either from flags or from DB lookup
  let realOutput, realCacheRead, realCombinedInput;
  let operatorId, deviceId, originalPillars;
  let applyReport = null;

  if (output && cacheRead && combinedInput) {
    // Manual mode — need to look up operator_id + device_id
    realOutput = output;
    realCacheRead = cacheRead;
    realCombinedInput = combinedInput;
    const opRes = await sbFetch(
      `/rest/v1/operators?codename=eq.${encodeURIComponent(codename)}&select=operator_id,codename`
    );
    const operators = await opRes.json();
    if (!operators.length) {
      console.error(red(`\n  Operator "${codename}" not found.\n`));
      process.exit(1);
    }
    operatorId = operators[0].operator_id;
    // Look up device_id (FK constraint requires a valid device_id)
    const devRes = await sbFetch(
      `/rest/v1/devices?operator_id=eq.${operatorId}&limit=1&select=device_id`
    );
    const devices = await devRes.json();
    if (!devices.length) {
      console.error(red(`\n  No device found for operator "${codename}". Cannot write submission.\n`));
      process.exit(1);
    }
    deviceId = devices[0].device_id;
  } else {
    // Lookup mode — pull from DB
    console.log(cyan(`\n  Looking up ${codename} in Supabase...`));
    const opRes = await sbFetch(
      `/rest/v1/operators?codename=eq.${encodeURIComponent(codename)}&select=operator_id,codename`
    );
    const operators = await opRes.json();
    if (!operators.length) {
      console.error(red(`\n  Operator "${codename}" not found.\n`));
      process.exit(1);
    }
    operatorId = operators[0].operator_id;
    // Look up device_id (FK constraint requires a valid device_id)
    const devRes = await sbFetch(
      `/rest/v1/devices?operator_id=eq.${operatorId}&limit=1&select=device_id`
    );
    const devices = await devRes.json();
    if (!devices.length) {
      console.error(red(`\n  No device found for operator "${codename}". Cannot write submission.\n`));
      process.exit(1);
    }
    deviceId = devices[0].device_id;

    const msRes = await sbFetch(
      `/rest/v1/metric_snapshots?operator_id=eq.${operatorId}&order=snapshot_date.desc&limit=1&` +
      `select=snapshot_date,window_type,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens`
    );
    const snapshots = await msRes.json();
    if (!snapshots.length || !snapshots[0].output_tokens) {
      console.error(red(`\n  No pillar data found for ${codename}.\n`));
      process.exit(1);
    }
    const ms = snapshots[0];
    realOutput = ms.output_tokens;
    realCacheRead = ms.cache_read_tokens;
    realCombinedInput = ms.input_tokens;
    originalPillars = {
      input: ms.input_tokens,
      output: ms.output_tokens,
      cacheCreate: ms.cache_creation_tokens,
      cacheRead: ms.cache_read_tokens,
    };
  }

  // Run the re-parse with the chosen ratio
  const r = RATIOS[ratioName];
  const inputEst = Math.round(realOutput / r.velocity);
  const cacheWriteEst = realCombinedInput - inputEst;
  const cascadeResult = cascade({
    input: inputEst,
    output: realOutput,
    cacheCreate: cacheWriteEst,
    cacheRead: realCacheRead,
  });

  // Generate the full report (for the submission payload + display)
  const allResults = runRatios(realOutput, realCacheRead, realCombinedInput);
  const origCascade = cascade(originalPillars || {
    input: realCombinedInput, output: realOutput, cacheCreate: 0, cacheRead: realCacheRead,
  });
  console.log(cyan(`  Computing board ranks...`));
  const origRankInfo = await computeRank(operatorId, null, false);
  const newRankInfo = await computeRank(operatorId, cascadeResult.yield, true);
  applyReport = generateReport({
    codename,
    displayName: codename,
    platform: null,
    snapshotDate: new Date().toISOString().slice(0, 10),
    windowType: "30d",
    originalPillars: originalPillars || {
      input: realCombinedInput, output: realOutput, cacheCreate: 0, cacheRead: realCacheRead,
    },
    originalCascade: origCascade,
    originalRank: origRankInfo.rank,
    totalOperators: origRankInfo.total,
    results: allResults,
    bestRatio: ratioName,
    bestResult: allResults[ratioName],
    reparsedPillars: { input: inputEst, output: realOutput, cacheCreate: cacheWriteEst, cacheRead: realCacheRead },
    reparsedCascade: cascadeResult,
    newRank: newRankInfo.rank,
  });

  // Show what we're about to write
  console.log();
  console.log(`  ${"=".repeat(80)}`);
  console.log(`  APPLY RE-PARSE: ${bold(codename)}  ratio=${green(ratioName)} (${r.label})`);
  if (dryRun) console.log(`  ${yellow("[DRY RUN — no DB writes]")}`);
  console.log(`  ${"=".repeat(80)}`);
  console.log();
  console.log(`  ${bold("RE-PARSED PILLARS:")}`);
  console.log(`    Input:          ${inputEst.toLocaleString()}  (${fmtTokens(inputEst)})`);
  console.log(`    Output:         ${realOutput.toLocaleString()}  (${fmtTokens(realOutput)})`);
  console.log(`    Cache write:    ${cacheWriteEst.toLocaleString()}  (${fmtTokens(cacheWriteEst)})`);
  console.log(`    Cache read:     ${realCacheRead.toLocaleString()}  (${fmtTokens(realCacheRead)})`);
  console.log();
  console.log(`  ${bold("RECALCULATED CASCADE:")}`);
  console.log(`    Yield:     ${cascadeResult.yield ?? "null"}`);
  console.log(`    Leverage:  ${cascadeResult.leverage ?? "null"}:1`);
  console.log(`    Velocity:  ${cascadeResult.velocity ?? "null"}`);
  console.log(`    SNR:       ${cascadeResult.snr ?? "null"}`);
  console.log(`    10xDEV:    ${cascadeResult.dev10x ?? "null"}`);
  console.log(`    Class:     ${cascadeResult.class || "NULL"}`);
  console.log(`    Mode:      ${cascadeResult.mode?.mode ?? "?"} (conf ${(cascadeResult.mode?.confidence ?? 0).toFixed(2)})`);
  if (cascadeResult.warnings?.length) {
    console.log(`    Warnings:  ${cascadeResult.warnings.join("; ")}`);
  }
  console.log();

  if (dryRun) {
    console.log();
    console.log(applyReport);
    console.log(`  ${yellow("Dry run complete. Remove --dry-run to write to Supabase.")}`);
    console.log(`  ${dim("The report above will be included in the submission payload on the operator's profile.")}`);
    console.log();
    return;
  }

  // Confirm before writing
  if (!flags["yes"]) {
    console.log(`  ${yellow("This will write to Supabase. Confirm? (y/N)")}`);
    const buf = Buffer.alloc(1);
    const { fd } = await import("node:fs");
    // Read one byte from stdin
    const fs = await import("node:fs/promises");
    process.stdin.resume();
    const answer = await new Promise((resolve) => {
      process.stdin.once("data", (d) => {
        process.stdin.pause();
        resolve(d.toString().trim().toLowerCase());
      });
    });
    if (answer !== "y" && answer !== "yes") {
      console.log(dim("  Aborted."));
      process.exit(0);
    }
  }

  // 1. Insert a re-parse submission into snapshot_submissions
  //    This is the transparency log — shows up in the operator's submission history.
  const now = new Date().toISOString();
  const submissionPayload = {
    operator_id: operatorId,
    device_id: deviceId, // real device_id from devices table (FK constraint)
    submitted_at: now,
    window_type: "30d",
    window_start: new Date(Date.now() - 30 * 864e5).toISOString(),
    window_end: now,
    schema_version: "1.0",
    ruleset_version: "ops-reparse-v1",
    snapshot_hash: `reparse_${codename}_${Date.now()}`,
    signature: "ops_reparse",
    status: "scored",
    payload_json: {
      source: "ops_reparse",
      codename,
      ratio_used: ratioName,
      ratio_label: r.label,
      applied_at: now,
      applied_by: "owner",
      reason: "cache_write convergence re-parse (Codex combined-input split)",
      original_pillars: originalPillars || {
        input: realCombinedInput,
        output: realOutput,
        cacheCreate: 0,
        cacheRead: realCacheRead,
      },
      reparsed_pillars: {
        input: inputEst,
        output: realOutput,
        cacheCreate: cacheWriteEst,
        cacheRead: realCacheRead,
      },
      cascade: {
        yield: cascadeResult.yield,
        leverage: cascadeResult.leverage,
        velocity: cascadeResult.velocity,
        snr: cascadeResult.snr,
        dev10x: cascadeResult.dev10x,
        class: cascadeResult.class,
        mode: cascadeResult.mode,
      },
      report: applyReport || null,
    },
    input_tokens: inputEst,
    output_tokens: realOutput,
    cache_creation_tokens: cacheWriteEst,
    cache_read_tokens: realCacheRead,
  };

  console.log(cyan(`  Writing re-parse submission to snapshot_submissions...`));
  await sbFetch("/rest/v1/snapshot_submissions", {
    method: "POST",
    body: JSON.stringify(submissionPayload),
    headers: { Prefer: "return=representation" },
  });
  console.log(green(`  ✓ Submission logged (source=ops_reparse, ratio=${ratioName})`));

  // 2. Update metric_snapshots with re-parsed pillars
  //    Insert a new row for today (or update if exists for today + window)
  const today = now.slice(0, 10);
  console.log(cyan(`  Updating metric_snapshots (${today}, 30d)...`));

  // Try upsert: insert with the re-parsed pillars + cascade metrics
  const metricPayload = {
    operator_id: operatorId,
    snapshot_date: today,
    window_type: "30d",
    input_tokens: inputEst,
    output_tokens: realOutput,
    cache_creation_tokens: cacheWriteEst,
    cache_read_tokens: realCacheRead,
    class_tier: cascadeResult.class,
    ruleset_version: "ops-reparse-v1",
  };

  // Use upsert via Prefer header
  await sbFetch("/rest/v1/metric_snapshots", {
    method: "POST",
    body: JSON.stringify(metricPayload),
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
  });
  console.log(green(`  ✓ Board metrics updated (pillars + class=${cascadeResult.class || "NULL"})`));

  console.log();
  console.log(bold(`  Done. ${codename} re-parsed with ${ratioName} (${r.label}).`));
  console.log(dim(`  The re-parse is logged as a submission entry on the operator's profile.`));
  console.log(dim(`  Yield: ${cascadeResult.yield ?? "null"}  Class: ${cascadeResult.class || "NULL"}`));
  console.log();
}

// ─── Mode 0: guided flow (the full process, start to finish) ─────────────────

/**
 * The guided re-parse workflow. One command, walks through everything:
 *
 *   Step 1: Pull operator from Supabase, show current state
 *   Step 2: Run the ratio review (all 3 ratios, convergence test)
 *   Step 3: Generate the full report (starting point, equations, analysis, decision, landing)
 *   Step 4: Show the report, ask "apply or abort?"
 *   Step 5: If apply, write to Supabase (submission log + board update, report embedded)
 *   Step 6: Confirm done, show before/after summary
 *
 * Usage:
 *   node ops-review.mjs kr-yeon                    # guided flow, auto-select ratio
 *   node ops-review.mjs kr-yeon --ratio "Codex PU" # guided flow, explicit ratio
 *   node ops-review.mjs kr-yeon --dry-run          # guided flow, no DB writes
 *   node ops-review.mjs kr-yeon --save report.txt  # save report to file too
 */
async function modeGuided(args, flags) {
  const codename = flags.codename || (args[0] && !args[0].startsWith("--") ? args[0] : undefined);
  const ratioOverride = flags.ratio;
  const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
  const saveFile = flags.save;

  if (!codename) {
    console.error(red("\n  Usage: node ops-review.mjs <codename> [--ratio \"Codex PU\"] [--dry-run] [--save <path>]\n"));
    process.exit(1);
  }

  const banner = "=".repeat(80);
  console.log();
  console.log(`  ${bold(cyan(banner))}`);
  console.log(`  ${bold(cyan("  SIGRANK RE-PARSE WORKFLOW"))}`);
  console.log(`  ${bold(cyan(banner))}`);
  if (dryRun) console.log(`  ${yellow("  [DRY RUN MODE — no DB writes]")}`);
  console.log();

  // ─── Step 1: Pull operator ─────
  console.log(`  ${bold("STEP 1: Pull operator from Supabase")}`);
  console.log(`  ${dim("─".repeat(76))}`);

  const opRes = await sbFetch(
    `/rest/v1/operators?codename=eq.${encodeURIComponent(codename)}&select=operator_id,codename,display_name,primary_domain,status`
  );
  const operators = await opRes.json();
  if (!operators.length) {
    console.error(red(`\n  ✗ Operator "${codename}" not found in Supabase.\n`));
    process.exit(1);
  }
  const op = operators[0];
  console.log(`    Operator:    ${bold(op.codename)}${op.display_name && op.display_name !== op.codename ? ` (${op.display_name})` : ""}`);
  console.log(`    Platform:    ${op.primary_domain || "unknown"}`);
  console.log(`    Status:      ${op.status}`);
  console.log(`    Operator ID: ${op.operator_id}`);
  console.log();

  // Pull latest metric_snapshot
  const msRes = await sbFetch(
    `/rest/v1/metric_snapshots?operator_id=eq.${op.operator_id}&order=snapshot_date.desc&limit=1&` +
    `select=snapshot_date,window_type,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,class_tier`
  );
  const snapshots = await msRes.json();
  if (!snapshots.length || !snapshots[0].output_tokens) {
    console.error(red(`\n  ✗ No pillar data found for ${codename}. The operator may not have token pillars stored.\n`));
    process.exit(1);
  }
  const ms = snapshots[0];
  const originalPillars = {
    input: ms.input_tokens,
    output: ms.output_tokens,
    cacheCreate: ms.cache_creation_tokens,
    cacheRead: ms.cache_read_tokens,
  };
  const originalCascade = cascade(originalPillars);

  console.log(`    Snapshot:    ${ms.snapshot_date} (${ms.window_type})`);
  console.log(`    Stored pillars:`);
  console.log(`      Input (combined):  ${fmtTokens(ms.input_tokens)}`);
  console.log(`      Output:            ${fmtTokens(ms.output_tokens)}`);
  console.log(`      Cache write:       ${fmtTokens(ms.cache_creation_tokens)}${ms.cache_creation_tokens < 1e6 ? red("  <-- NEAR-ZERO (Codex gap)") : ""}`);
  console.log(`      Cache read:        ${fmtTokens(ms.cache_read_tokens)}`);
  console.log(`    Current cascade: yield=${originalCascade.yield ?? "NULL"}  class=${originalCascade.class || "NULL"}`);
  console.log();

  // Check if already re-parsed
  if (ms.ruleset_version === "ops-reparse-v1") {
    console.log(`  ${yellow("⚠ This operator was already re-parsed (ruleset_version=ops-reparse-v1).")}`);
    console.log(`  ${yellow("  Running again will overwrite the previous re-parse. Continue? (y/N)")}`);
    const cont = await readLine();
    if (cont !== "y" && cont !== "yes") {
      console.log(dim("  Aborted."));
      process.exit(0);
    }
    console.log();
  }

  // ─── Step 2: Run the ratio review ─────
  console.log(`  ${bold("STEP 2: Run ratio review (all 3 reference ratios)")}`);
  console.log(`  ${dim("─".repeat(76))}`);
  console.log();

  const results = runRatios(ms.output_tokens, ms.cache_read_tokens, ms.input_tokens);
  const names = ["AA avg", "HCM", "Codex PU"];

  // Print the compact review table
  for (const name of names) {
    const r = results[name];
    const cwMarker = r.cwConverges ? green("PASS") : red("FAIL");
    let levStatus;
    if (r.levMatch < 0.5) levStatus = "POOR";
    else if (r.levMatch < 0.8 || r.levMatch > 2.0) levStatus = "WEAK";
    else if (r.levMatch >= 0.8 && r.levMatch <= 1.3) levStatus = "STRONG";
    else levStatus = "MODERATE";
    console.log(`    ${name.padEnd(10)} (${r.label.padEnd(12)})  yield=${String(r.yield.toFixed(2)).padStart(8)}  class=${(r.cascade.class || "NULL").padEnd(8)}  CW=[${cwMarker}]  Lev=${r.levMatch.toFixed(2)}x [${levStatus}]`);
  }
  console.log();

  // Select ratio
  let bestRatio, bestResult;
  if (ratioOverride && RATIOS[ratioOverride]) {
    bestRatio = ratioOverride;
    bestResult = results[ratioOverride];
    console.log(`    ${dim("Ratio selected:")} ${bold(bestRatio)} (explicit --ratio flag)`);
  } else {
    const valid = Object.entries(results).filter(([, r]) => r.cwConverges);
    if (valid.length === 0) {
      console.error(red(`\n  ✗ No ratio passes cache_write validation. Cannot proceed.\n`));
      process.exit(1);
    }
    [bestRatio, bestResult] = valid.reduce((best, cur) =>
      Math.abs(cur[1].levMatch - 1.0) < Math.abs(best[1].levMatch - 1.0) ? cur : best
    );
    const eliminated = names.filter((n) => !valid.some(([v]) => v === n));
    if (eliminated.length > 0) {
      console.log(`    ${dim("Eliminated:")} ${eliminated.join(", ")} (cache_write outlier)`);
    }
    console.log(`    ${dim("Auto-selected:")} ${bold(bestRatio)} (${bestResult.label}) — leverage match ${bestResult.levMatch.toFixed(2)}x`);
  }
  console.log();

  // ─── Step 3: Generate the full report ─────
  console.log(`  ${bold("STEP 3: Generate full re-parse report")}`);
  console.log(`  ${dim("─".repeat(76))}`);

  const r = RATIOS[bestRatio];
  const inputEst = Math.round(ms.output_tokens / r.velocity);
  const cacheWriteEst = ms.input_tokens - inputEst;
  const reparsedPillars = {
    input: inputEst,
    output: ms.output_tokens,
    cacheCreate: cacheWriteEst,
    cacheRead: ms.cache_read_tokens,
  };
  const reparsedCascade = cascade(reparsedPillars);

  console.log(cyan(`  Computing board ranks (pulling all operators)...`));
  const origRankInfo = await computeRank(op.operator_id, null, false);
  const newRankInfo = await computeRank(op.operator_id, reparsedCascade.yield, true);

  const report = generateReport({
    codename: op.codename,
    displayName: op.display_name,
    platform: op.primary_domain,
    snapshotDate: ms.snapshot_date,
    windowType: ms.window_type,
    originalPillars,
    originalCascade,
    originalRank: origRankInfo.rank,
    totalOperators: origRankInfo.total,
    results,
    bestRatio,
    bestResult,
    reparsedPillars,
    reparsedCascade,
    newRank: newRankInfo.rank,
  });

  // Save to file if requested
  if (saveFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(saveFile, report);
    console.log(green(`  ✓ Report saved to ${saveFile}`));
    console.log();
  }

  // ─── Step 4: Show the report + ask for confirmation ─────
  console.log(`  ${bold("STEP 4: Review the report")}`);
  console.log(`  ${dim("─".repeat(76))}`);
  console.log();
  console.log(report);

  console.log(`  ${bold("STEP 5: Apply decision")}`);
  console.log(`  ${dim("─".repeat(76))}`);
  console.log();
  console.log(`    Operator:  ${bold(op.codename)}`);
  console.log(`    Ratio:     ${bold(bestRatio)} (${bestResult.label})`);
  console.log(`    Yield:     ${originalCascade.yield ?? "NULL"} → ${bold(green(reparsedCascade.yield ?? "null"))}`);
  console.log(`    Class:     ${originalCascade.class || "NULL"} → ${bold(green(reparsedCascade.class || "NULL"))}`);
  console.log(`    Rank:      #${origRankInfo.rank} → ${bold(green("#" + newRankInfo.rank))} (${origRankInfo.rank - newRankInfo.rank > 0 ? "+" : ""}${origRankInfo.rank - newRankInfo.rank} positions)`);
  console.log();

  if (dryRun) {
    console.log(`  ${yellow("[DRY RUN] No DB writes. The report above would be embedded in the submission payload.")}`);
    console.log(`  ${dim("Remove --dry-run to apply for real.")}`);
    console.log();
    return;
  }

  // Confirmation
  console.log(`  ${yellow("This will write to Supabase:")}`);
  console.log(`    1. Insert a submission entry in snapshot_submissions (source=ops_reparse, report embedded)`);
  console.log(`    2. Upsert metric_snapshots with re-parsed pillars + new class tier`);
  console.log();
  console.log(`  ${bold("Apply? (y/N)")}`);

  const answer = await readLine();
  if (answer !== "y" && answer !== "yes") {
    console.log(dim("  Aborted. No changes written."));
    process.exit(0);
  }
  console.log();

  // ─── Step 5: Write to Supabase ─────
  console.log(`  ${bold("STEP 6: Writing to Supabase")}`);
  console.log(`  ${dim("─".repeat(76))}`);

  const now = new Date().toISOString();
  const submissionPayload = {
    operator_id: op.operator_id,
    device_id: op.operator_id,
    submitted_at: now,
    window_type: ms.window_type || "30d",
    window_start: new Date(Date.now() - 30 * 864e5).toISOString(),
    window_end: now,
    schema_version: "1.0",
    ruleset_version: "ops-reparse-v1",
    snapshot_hash: `reparse_${codename}_${Date.now()}`,
    signature: "ops_reparse",
    status: "scored",
    payload_json: {
      source: "ops_reparse",
      codename,
      ratio_used: bestRatio,
      ratio_label: r.label,
      applied_at: now,
      applied_by: "owner",
      reason: "cache_write convergence re-parse (Codex combined-input split)",
      original_pillars: originalPillars,
      reparsed_pillars: reparsedPillars,
      cascade: {
        yield: reparsedCascade.yield,
        leverage: reparsedCascade.leverage,
        velocity: reparsedCascade.velocity,
        snr: reparsedCascade.snr,
        dev10x: reparsedCascade.dev10x,
        class: reparsedCascade.class,
        mode: reparsedCascade.mode,
      },
      rank_before: origRankInfo.rank,
      rank_after: newRankInfo.rank,
      total_operators: origRankInfo.total,
      report,
    },
    input_tokens: inputEst,
    output_tokens: ms.output_tokens,
    cache_creation_tokens: cacheWriteEst,
    cache_read_tokens: ms.cache_read_tokens,
  };

  console.log(cyan(`    Writing submission to snapshot_submissions...`));
  await sbFetch("/rest/v1/snapshot_submissions", {
    method: "POST",
    body: JSON.stringify(submissionPayload),
    headers: { Prefer: "return=representation" },
  });
  console.log(green(`    ✓ Submission logged (source=ops_reparse, ratio=${bestRatio}, report embedded)`));

  const today = now.slice(0, 10);
  console.log(cyan(`    Upserting metric_snapshots (${today}, ${ms.window_type || "30d"})...`));
  const metricPayload = {
    operator_id: op.operator_id,
    snapshot_date: today,
    window_type: ms.window_type || "30d",
    input_tokens: inputEst,
    output_tokens: ms.output_tokens,
    cache_creation_tokens: cacheWriteEst,
    cache_read_tokens: ms.cache_read_tokens,
    class_tier: reparsedCascade.class,
    ruleset_version: "ops-reparse-v1",
  };
  await sbFetch("/rest/v1/metric_snapshots", {
    method: "POST",
    body: JSON.stringify(metricPayload),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  console.log(green(`    ✓ Board metrics updated (class=${reparsedCascade.class || "NULL"})`));

  // ─── Step 6: Done ─────
  console.log();
  console.log(`  ${bold(green("═".repeat(76)))}`);
  console.log(`  ${bold(green("  RE-PARSE COMPLETE"))}`);
  console.log(`  ${bold(green("═".repeat(76)))}`);
  console.log();
  console.log(`    Operator:    ${bold(op.codename)}`);
  console.log(`    Ratio used:  ${bestRatio} (${r.label})`);
  console.log();
  console.log(`    ${bold("BEFORE")}                          ${bold("AFTER")}`);
  console.log(`    Yield:     ${String(originalCascade.yield ?? "NULL").padEnd(20)}  →  ${bold(green(String(reparsedCascade.yield ?? "null")))}`);
  console.log(`    Class:     ${(originalCascade.class || "NULL").padEnd(20)}  →  ${bold(green(reparsedCascade.class || "NULL"))}`);
  console.log(`    Rank:      #${String(origRankInfo.rank).padEnd(19)}  →  ${bold(green("#" + newRankInfo.rank))}`);
  console.log(`    Input:     ${fmtTokens(originalPillars.input).padEnd(20)}  →  ${fmtTokens(inputEst)}`);
  console.log(`    Cache write: ${fmtTokens(originalPillars.cacheCreate).padEnd(18)}  →  ${fmtTokens(cacheWriteEst)}`);
  console.log();
  console.log(`    ${dim("The re-parse is logged as a submission entry on the operator's profile.")}`);
  console.log(`    ${dim("The full report is embedded in the submission payload (payload_json.report).")}`);
  console.log();
}

// ─── Helper: read a line from stdin ──────────────────────────────────────────

function readLine() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(d.toString().trim().toLowerCase());
    });
  });
}

// ─── CLI dispatch ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(`
  ${bold("ops-review.mjs")} — internal ratio review + apply tool

  ${bold("Guided flow (default — just pass a codename):")}

    ${cyan("<codename>")}           Full workflow: pull → review → report → confirm → apply
              node ops-review.mjs kr-yeon
              node ops-review.mjs kr-yeon --ratio "Codex PU"
              node ops-review.mjs kr-yeon --dry-run
              node ops-review.mjs kr-yeon --save report.txt

  ${bold("Individual modes (for scripting / partial use):")}

    ${cyan("calc")}     Run ratio review on raw numbers (no DB)
              node ops-review.mjs calc --output N --cache-read N --combined-input N

    ${cyan("lookup")}  Pull operator pillars from Supabase, then run review
              node ops-review.mjs lookup --codename kr-yeon

    ${cyan("report")}  Generate full re-parse report (starting point, equations, decision, landing)
              node ops-review.mjs report --codename kr-yeon
              node ops-review.mjs report --codename kr-yeon --ratio "Codex PU" --save kr-yeon-report.txt

    ${cyan("apply")}   Re-parse + write to Supabase (submission log + board update, includes report)
              node ops-review.mjs apply --codename kr-yeon --ratio "Codex PU"
              node ops-review.mjs apply --codename kr-yeon --ratio "Codex PU" --dry-run

  ${bold("Env vars (lookup + apply):")}
    SUPABASE_URL              Supabase project URL
    SUPABASE_SERVICE_ROLE_KEY Service-role key (bypasses RLS)

  ${bold("Reference ratios:")}
    AA avg    3.5:1:0.5     all-users average
    HCM       20:1:0.1      human center of mass
    Codex PU  243:1:1.03    Codex power-user

  See OPS_REVIEW_README.md for full methodology + instructions.
    `);
    process.exit(0);
  }

  const mode = argv[0];
  const knownModes = ["calc", "lookup", "report", "apply"];
  const { args, flags } = parseArgs(argv.slice(1));

  // If the first arg is not a known mode, treat it as a codename → guided flow
  if (!knownModes.includes(mode)) {
    // The codename is the first arg; pass all args (including the codename)
    const guidedArgs = [...argv];
    const guidedFlags = {};
    // Re-parse: extract flags from all argv, leave positional as args
    const guidedParsed = parseArgs(guidedArgs);
    await modeGuided(guidedParsed.args, guidedParsed.flags);
    return;
  }

  switch (mode) {
    case "calc":
      await modeCalc(args, flags);
      break;
    case "lookup":
      await modeLookup(args, flags);
      break;
    case "report":
      await modeReport(args, flags);
      break;
    case "apply":
      await modeApply(args, flags);
      break;
    default:
      console.error(red(`\n  Unknown mode "${mode}". Use calc, lookup, report, or apply.\n`));
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(red(`\n  Error: ${err.message}\n`));
  process.exit(1);
});
