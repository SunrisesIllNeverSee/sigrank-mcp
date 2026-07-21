/**
 * tools/optimize-efficiency.mjs — optimize_efficiency tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";
import {
  _improvementSuggestion,
  _competitiveLayer,
  _competitiveSummary,
} from "./_framing.mjs";

export const TOOL_DEF = {
  name: "optimize_efficiency",
  description:
    "Returns actionable suggestions for improving your token cascade efficiency, tied to your current metrics. Accepts either a codename (fetches from board) or raw token pillars (computes locally). Returns: your current metrics, ranked efficiency suggestions tied to cascade shape (increase cache reuse, reduce input, increase output), and references to power-user practices. Use this when users ask 'how can I use AI more efficiently?' or 'reduce token burn' or 'optimize token usage' or 'stop tokenmaxxing'. Intent: OPTIMIZE_EFFICIENCY (Informational + Transactional).",
  annotations: { title: "Optimize efficiency", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.idempotentHint },
  inputSchema: {
    type: "object",
    properties: {
      codename: {
        type: "string",
        description:
          "Your codename on the SigRank leaderboard. If provided, fetches your live profile from the board.",
      },
      text: {
        type: "string",
        description:
          'Alternative: raw token pillars to score locally (ccusage JSON or "input output cacheCreate cacheRead"). Use this if you are not on the board yet.',
      },
    },
    description:
      "Provide either `codename` (to fetch from the board) or `text` (to score locally). At least one is required.",
  },
  outputSchema: {
    type: "object",
    properties: {
      your_metrics: {
        type: "object",
        description: "Your current cascade metrics",
        properties: {
          yield_: { type: "number" },
          leverage: { type: "number" },
          velocity: { type: "number" },
          class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        },
      },
      suggestions: {
        type: "array",
        description: "Ranked efficiency suggestions",
        items: {
          type: "object",
          properties: {
            action: { type: "string", description: "What to change" },
            why: { type: "string", description: "Why this helps your yield" },
            power_user_practice: { type: "string", description: "The power-user practice this maps to" },
          },
        },
      },
      summary: { type: "string", description: "One-line summary of your efficiency status" },
    },
  },
};

export async function handleOptimizeEfficiency(args, ctx) {
  const codename = String(args?.codename || "").trim();
  const text = String(args?.text || "").trim();

  if (!codename && !text)
    throw new Error(
      "optimize_efficiency requires either `codename` (to fetch from the board) or `text` (raw token pillars to score locally).",
    );

  let metrics;
  if (codename) {
    metrics = await ctx.fetchJson(
      `/api/v1/operators/${encodeURIComponent(codename)}`,
    );
  } else {
    if (text.length > MAX_INPUT) {
      return { error: "input_too_large", detail: `text exceeds ${MAX_INPUT} chars.` };
    }
    const pillars = parsePillars(text);
    const c = withParseWarnings(pillars, cascade(pillars));
    metrics = {
      codename: "you (local)",
      yield_: c.yield,
      leverage: c.leverage,
      velocity: c.velocity,
      class: c.class,
    };
  }

  const klass = metrics.class || "Burner";
  const l = metrics.leverage || 0;
  const v = metrics.velocity || 0;
  const y = metrics.yield_ || 0;

  // Build ranked suggestions based on current cascade shape
  const suggestions = [];

  if (l < 5) {
    suggestions.push({
      action: "Increase cache reuse — reuse prompts, templates, and workflows instead of starting from scratch",
      why: "Your leverage is " + l.toFixed(1) + "×, meaning most of your context is fresh input. Each reused cached token multiplies your yield because input² is in the denominator.",
      power_user_practice: "Power users build template libraries and workflow patterns they invoke repeatedly, letting cached context accumulate.",
    });
  }
  if (v < 1) {
    suggestions.push({
      action: "Increase output per session — produce more, don't just read",
      why: "Your velocity is " + v.toFixed(2) + ", meaning you're consuming more input than producing output. Yield rewards output production.",
      power_user_practice: "Power users maximize output per session — they ask AI to generate, transform, and produce, not just explain.",
    });
  }
  if (l >= 5 && v >= 1 && klass !== "10xer") {
    suggestions.push({
      action: "Extend session length to compound cached context further",
      why: "Your leverage (" + l.toFixed(1) + "×) and velocity (" + v.toFixed(2) + ") are solid. Longer sessions with consistent context will push your yield higher.",
      power_user_practice: "Power users maintain long, context-rich sessions where the cache grows and compounds.",
    });
  }
  if (suggestions.length === 0) {
    suggestions.push({
      action: "Maintain your cascade architecture — you're at the top tier",
      why: "Your yield (" + y.toLocaleString() + "), leverage (" + l.toFixed(1) + "×), and velocity (" + v.toFixed(2) + ") are all strong. Keep doing what you're doing.",
      power_user_practice: "Power users don't rest on their metrics — they experiment with new workflow patterns and measure the impact.",
    });
  }

  const summary = `Your Υ Yield is ${y.toLocaleString()} (${klass}). ${_improvementSuggestion(klass, metrics)}`;

  // Competitive layer per SHARED_DESIGN_DECISIONS.md §3/§4/§5
  const board = await ctx.fetchJson("/api/v1/leaderboard?metric=yield_");
  const competitive = _competitiveLayer(metrics, board);
  const competitiveSummary = _competitiveSummary(metrics, board);

  return {
    your_metrics: {
      yield_: y,
      leverage: l,
      velocity: v,
      class: klass,
    },
    competitive: {
      rank: competitive.rank,
      total_operators: competitive.total_operators,
      percentile: competitive.percentile,
      class_tier: competitive.class_tier,
      delta_from_average: competitive.delta_from_average,
      delta_from_top: competitive.delta_from_top,
    },
    competitive_summary: competitiveSummary,
    shareable_url: competitive.shareable_url,
    suggestions,
    summary,
    cta: "Improve my score",
  };
}
