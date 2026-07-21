/**
 * tools/suggest-improvements.mjs — suggest_improvements tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { SUGGEST_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "suggest_improvements",
  description:
    "Generates ranked, simulated improvement suggestions for your token cascade. Takes your 4 pillars, tests multiple improvement strategies (increase cache reads, reduce fresh input, increase output, optimize cache creation), simulates each with the canonical cascade engine, and returns them ranked by Υ yield impact. Each suggestion includes: the action, which pillar to change, how much to change it, the projected Υ after the change, the yield delta, the projected class tier, and a rationale. Also returns the single highest-impact change (best_single_change). Pure local math — no network, no submission. Use this after diagnose_cascade to get actionable next steps, then use simulate_change to fine-tune before committing. Accepts the same input formats as rank_paste.",
  annotations: {
    title: "Suggest improvements",
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
  outputSchema: SUGGEST_OUTPUT,
};

export async function handleSuggestImprovements(args) {
  if (!args?.text)
    throw new Error(
      "suggest_improvements requires a non-empty `text` argument (token pillars).",
    );
  if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
    return {
      status: "error",
      reason: "input_too_large",
      detail: `text exceeds ${MAX_INPUT} chars.`,
    };
  }

  const p = parsePillars(args.text);
  const current = withParseWarnings(p, cascade(p));
  const { input: i, output: o, cacheCreate: cw, cacheRead: cr } = p;

  // Generate candidate improvements, simulate each, rank by Υ impact
  const candidates = [];

  // Strategy 1: Increase cache reads (the #1 lever)
  const crBoosts = cr > 0 ? [1.5, 2, 3, 5] : [];
  for (const mult of crBoosts) {
    const sim = cascade({ ...p, cacheRead: Math.round(cr * mult) });
    if (sim.yield !== null) {
      candidates.push({
        action: `Increase cache reads by ${Math.round((mult - 1) * 100)}%`,
        pillar: "cacheRead",
        delta: `+${Math.round(cr * (mult - 1)).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
        class_after: sim.class,
        rationale:
          "Cache reads are the strongest Υ multiplier. More reuse = higher leverage = higher yield.",
      });
    }
  }
  // For zero-cache operators, suggest enabling caching with a starter amount
  if (cr === 0 && cw === 0) {
    const starterAmounts = [
      Math.round(i * 10),
      Math.round(i * 50),
      Math.round(i * 100),
    ];
    for (const amt of starterAmounts) {
      const sim = cascade({
        ...p,
        cacheCreate: Math.round(amt * 0.5),
        cacheRead: amt,
      });
      if (sim.yield !== null && sim.yield > 0) {
        candidates.push({
          action: `Enable caching with ${amt.toLocaleString()} cache reads`,
          pillar: "cacheRead",
          delta: `+${amt.toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
          class_after: sim.class,
          rationale:
            "You have no cache — enabling it unlocks the cascade. Start by reusing prior context.",
        });
      }
    }
  }

  // Strategy 2: Reduce fresh input (Υ = Cr·O/I² — input is squared in the denominator)
  const inputReductions = [0.9, 0.75, 0.5];
  for (const mult of inputReductions) {
    const newInput = Math.round(i * mult);
    if (newInput < 1) continue;
    const sim = cascade({ ...p, input: newInput });
    if (sim.yield !== null) {
      candidates.push({
        action: `Reduce fresh input by ${Math.round((1 - mult) * 100)}%`,
        pillar: "input",
        delta: `-${Math.round(i * (1 - mult)).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
        class_after: sim.class,
        rationale:
          "Input is squared in the Υ denominator (Υ = Cr·O/I²). Reducing input has a quadratic payoff.",
      });
    }
  }

  // Strategy 3: Increase output
  const outputBoosts = [1.25, 1.5, 2];
  for (const mult of outputBoosts) {
    const sim = cascade({ ...p, output: Math.round(o * mult) });
    if (sim.yield !== null) {
      candidates.push({
        action: `Increase output by ${Math.round((mult - 1) * 100)}%`,
        pillar: "output",
        delta: `+${Math.round(o * (mult - 1)).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
        class_after: sim.class,
        rationale:
          "Output is a linear multiplier in Υ. More output per session = higher yield.",
      });
    }
  }

  // Strategy 4: Optimize cache creation (reduce if over-committing)
  if (cw > o * 10) {
    const sim = cascade({ ...p, cacheCreate: Math.round(o * 5) });
    if (sim.yield !== null) {
      candidates.push({
        action: "Reduce cache creation to 5× output",
        pillar: "cacheCreate",
        delta: `-${Math.round(cw - o * 5).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
        class_after: sim.class,
        rationale:
          "You're over-committing cache (cw >> output). Trimming to a healthy ratio reduces cost without hurting yield.",
      });
    }
  }

  // Sort by yield_delta descending, take top 8
  candidates.sort((a, b) => b.yield_delta - a.yield_delta);
  const top = candidates
    .slice(0, 8)
    .map((c, idx) => ({ rank: idx + 1, ...c }));

  const best = top[0];
  return {
    suggestions: top,
    current_yield: current.yield,
    current_class: current.class,
    best_single_change: best
      ? `${best.action} (Υ ${current.yield} → ${best.simulated_yield}, +${best.yield_delta} yield, class ${best.class_after})`
      : "No improvements found — your cascade is already optimized.",
  };
}
