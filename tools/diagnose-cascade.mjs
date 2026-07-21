/**
 * tools/diagnose-cascade.mjs — diagnose_cascade tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { DIAGNOSE_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "diagnose_cascade",
  description:
    "Analyzes your token cascade and diagnoses where you're leaking efficiency. Takes your 4 pillars (input/output/cacheCreate/cacheRead) and produces a ranked list of efficiency leaks with severity (critical/warning/info), findings, and recommendations. Checks: cache leverage (are you rereading what you wrote?), velocity (are you generating enough output per input?), SNR (is your signal drowning in noise?), cache creation ratio (are you over-committing?), input bloat (is fresh input too high?), and 10xDEV (is the full cascade compounding?). Each finding includes an estimated Υ impact. Pure local math — no network, no submission. Use this BEFORE simulate_change to understand what's wrong, then use simulate_change to test fixes. Accepts the same input formats as rank_paste (JSON or 4 whitespace numbers).",
  annotations: {
    title: "Diagnose cascade breakdown",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          'Token pillars — ccusage JSON or "input output cacheCreate cacheRead" (same format as rank_paste).',
      },
    },
    required: ["text"],
  },
  outputSchema: DIAGNOSE_OUTPUT,
};

export async function handleDiagnoseCascade(args) {
  if (!args?.text)
    throw new Error(
      "diagnose_cascade requires a non-empty `text` argument (token pillars).",
    );
  if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
    return {
      status: "error",
      reason: "input_too_large",
      detail: `text exceeds ${MAX_INPUT} chars.`,
    };
  }

  const p = parsePillars(args.text);
  const result = withParseWarnings(p, cascade(p));
  const { input: i, output: o, cacheCreate: cw, cacheRead: cr } = p;
  const diagnosis = [];

  // Cache leverage check — the #1 cascade efficiency signal
  const leverage = result.leverage;
  if (leverage !== null) {
    if (leverage < 10) {
      diagnosis.push({
        metric: "cache_leverage",
        severity: "critical",
        finding: `Cache leverage is ${leverage}× — you're reading only ${leverage}× your fresh input from cache. TRANSMITTER-class operators hit 200×+.`,
        recommendation:
          "Increase context reuse: load prior session context, use longer conversation threads, reference earlier outputs.",
        estimated_yield_impact: `+${Math.round((1 - leverage / 50) * 100)}% Υ potential`,
      });
    } else if (leverage < 50) {
      diagnosis.push({
        metric: "cache_leverage",
        severity: "warning",
        finding: `Cache leverage is ${leverage}× — decent but below the ARCH+ threshold (~100×+).`,
        recommendation:
          "Push cache reads higher by reusing prior context more aggressively.",
        estimated_yield_impact: `+${Math.round((1 - leverage / 100) * 50)}% Υ potential`,
      });
    }
  }

  // Velocity check — output per input
  const velocity = result.velocity;
  if (velocity !== null) {
    if (velocity < 0.5) {
      diagnosis.push({
        metric: "velocity",
        severity: "critical",
        finding: `Velocity is ${velocity} — generating only ${velocity}× your input as output. You're reading more than you produce.`,
        recommendation:
          "Increase output: ask the agent to generate more code/text per turn, reduce over-reading.",
        estimated_yield_impact: `+${Math.round((0.5 - velocity) * 100)}% Υ per 0.1 velocity gain`,
      });
    } else if (velocity < 1.0) {
      diagnosis.push({
        metric: "velocity",
        severity: "warning",
        finding: `Velocity is ${velocity} — below 1.0 (output < input). Healthy operators hit 1.5×+.`,
        recommendation:
          "Generate more output per input token — larger edits, more complete responses.",
        estimated_yield_impact: `+${Math.round((1 - velocity) * 30)}% Υ potential`,
      });
    }
  }

  // SNR check — signal-to-noise
  const snr = result.snr;
  if (snr !== null && snr < 0.3) {
    diagnosis.push({
      metric: "snr",
      severity: "warning",
      finding: `SNR is ${snr} — less than 30% of your token flow is output. Input is dominating.`,
      recommendation:
        "Reduce fresh input (reuse context) or increase output generation.",
      estimated_yield_impact:
        "Indirect — improves both velocity and leverage",
    });
  }

  // Cache creation ratio — are you over-committing?
  if (cw > 0 && o > 0) {
    const commitRatio = cw / o;
    if (commitRatio > 20) {
      diagnosis.push({
        metric: "cache_creation",
        severity: "info",
        finding: `Cache creation is ${commitRatio.toFixed(1)}× your output — high commitment. This is fine if you're rereading it (check leverage), but wasteful if not.`,
        recommendation:
          "Ensure you're rereading committed context. If leverage is low, you're writing cache you never read.",
        estimated_yield_impact: "Cost reduction, not Υ directly",
      });
    }
  }

  // Input bloat — is fresh input too high relative to total?
  const total = i + o + cw + cr;
  if (total > 0) {
    const inputPct = (i / total) * 100;
    if (inputPct > 10) {
      diagnosis.push({
        metric: "input_bloat",
        severity: "warning",
        finding: `Fresh input is ${inputPct.toFixed(1)}% of your total token flow — high. Efficient operators keep input under 1% by leaning on cache.`,
        recommendation:
          "Reduce fresh input by reusing prior context instead of re-pasting it.",
        estimated_yield_impact: `+${Math.round((inputPct - 1) * 5)}% Υ potential`,
      });
    }
  }

  // 10xDEV check — is the full cascade compounding?
  if (result.dev10x === null && cw === 0) {
    diagnosis.push({
      metric: "10xdev",
      severity: "critical",
      finding:
        "No cache creation — the cascade cannot compound. You're operating in a non-compounding mode (like ChatGPT without prompt caching).",
      recommendation:
        "Switch to a platform with prompt caching (Claude Code) or enable caching if available.",
      estimated_yield_impact: "Enables the full cascade — potentially 10×+ Υ",
    });
  } else if (result.dev10x !== null && result.dev10x < 1.0) {
    diagnosis.push({
      metric: "10xdev",
      severity: "info",
      finding: `10xDEV is ${result.dev10x} — below 1.0 (BASE threshold). The cascade is compounding but not strongly.`,
      recommendation:
        "Improve both leverage AND velocity — 10xDEV = log10(transmission × commitment × reuse).",
      estimated_yield_impact: "Class tier improvement",
    });
  }

  // Sort by severity (critical > warning > info)
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  diagnosis.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  const healthScore = diagnosis.filter(
    (d) => d.severity === "critical",
  ).length;
  const summary =
    healthScore === 0
      ? `Cascade is healthy — Υ ${result.yield}, class ${result.class}. ${diagnosis.length} minor optimizations available.`
      : `Cascade has ${healthScore} critical leak${healthScore > 1 ? "s" : ""} — Υ ${result.yield}, class ${result.class}. Fix the critical items first.`;

  return {
    pillars: p,
    cascade: {
      yield_: result.yield,
      snr: result.snr,
      leverage: result.leverage,
      velocity: result.velocity,
      tenx_dev: result.dev10x,
      class: result.class,
      warnings: result.warnings,
    },
    diagnosis,
    summary,
  };
}
