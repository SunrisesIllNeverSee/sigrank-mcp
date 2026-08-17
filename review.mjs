/**
 * review.mjs — `sigrank review` subcommand.
 *
 * Runs an operator's numbers through all three reference operating ratios
 * (AA avg, HCM, Codex PU) and validates results to identify correct placement.
 *
 * Usage:
 *   npx sigrank review <handle>                    # pull from raw data (if available)
 *   npx sigrank review --output N --cache-read N --combined-input N
 *
 * The cache_write convergence test:
 *   When we split combined_input into input + cache_write using each ratio's
 *   velocity, the cache_write values should converge. If one ratio produces
 *   a cache_write far below the others, that ratio is broken for this operator.
 *
 * Transcribed by Devin from owner (djm) analysis and direction.
 */

import { cascade, classify, round } from "./cascade.mjs";

// Reference operating ratios (cache_read : input : output, input=1)
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

function fmtTokens(n) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

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
    };
  }

  // Convergence test
  const cwValues = Object.values(results)
    .filter((r) => r.cwValid)
    .map((r) => r.cacheWrite);

  for (const [name, r] of Object.entries(results)) {
    if (!r.cwValid) {
      r.cwStatus = "INVALID (negative)";
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

function classifyYield(y) {
  if (y >= 100) return "POWER";
  if (y >= 10) return "SEEKER";
  if (y >= 1) return "IGNITER";
  if (y > 0) return "BURNER";
  return "BASE";
}

// ANSI colors
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

export async function runReview(opts) {
  const { handle, output, cacheRead, combinedInput } = opts;

  if (!output || !cacheRead || !combinedInput) {
    console.error(
      red(
        "\n  Missing required values. Usage:\n" +
          "    npx sigrank review --output N --cache-read N --combined-input N\n",
      ),
    );
    process.exit(1);
  }

  const results = runRatios(output, cacheRead, combinedInput);

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
  const classes = names.map((n) => classifyYield(results[n].yield).padStart(14));
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
    console.log(`    Yield: ${r.yield.toFixed(2)}    Class: ${classifyYield(r.yield)}`);
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
    console.log(`      Yield: ${best.yield.toFixed(2)}    Class: ${classifyYield(best.yield)}`);
  }

  console.log();
  console.log(`  Run ${cyan("`npx sigrank`")} to get a real signed snapshot with proper cache_write.`);
  console.log();
}
