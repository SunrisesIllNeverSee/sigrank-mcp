/**
 * tools/compare-self.mjs — compare_self tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { COMPARE_SELF_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";
import {
  _powerUserAssessment,
  _classMeaning,
  _improvementSuggestion,
  _competitiveLayer,
  _competitiveSummary,
} from "./_framing.mjs";

export const TOOL_DEF = {
  name: "compare_self",
  description:
    "Compares an operator's metrics against board averages and power-user archetypes, returning a behavioral assessment. Accepts either a codename (fetches from the board) or raw token pillars (computes locally). Returns: your yield/leverage/velocity/class/rank, a power-user assessment mapping your class tier to AI power-user language, comparison vs board averages (your percentile), and one actionable suggestion to improve. Use this when users ask 'how do I measure up to other AI users?' or 'am I a power user?' or 'compare me to others'. Intent: COMPARE_SELF.",
  annotations: { title: "Compare self to board", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      codename: {
        type: "string",
        description:
          "Your codename on the SigRank leaderboard. If provided, fetches your live profile from the board. Case-insensitive.",
      },
      text: {
        type: "string",
        description:
          'Alternative: raw token pillars to score locally (ccusage JSON or "input output cacheCreate cacheRead"). Use this if you are not on the board yet but want to see how you would compare.',
      },
    },
    description:
      "Provide either `codename` (to fetch from the board) or `text` (to score locally). At least one is required.",
  },
  outputSchema: COMPARE_SELF_OUTPUT,
};

export async function handleCompareSelf(args, ctx) {
  const codename = String(args?.codename || "").trim();
  const text = String(args?.text || "").trim();

  if (!codename && !text)
    throw new Error(
      "compare_self requires either `codename` (to fetch from the board) or `text` (raw token pillars to score locally).",
    );

  let yourMetrics;
  if (codename) {
    yourMetrics = await ctx.fetchJson(
      `/api/v1/operators/${encodeURIComponent(codename)}`,
    );
  } else {
    if (text.length > MAX_INPUT) {
      return {
        error: "input_too_large",
        detail: `text exceeds ${MAX_INPUT} chars.`,
      };
    }
    const pillars = parsePillars(text);
    const c = withParseWarnings(pillars, cascade(pillars));
    yourMetrics = {
      codename: "you (local)",
      yield_: c.yield,
      leverage: c.leverage,
      velocity: c.velocity,
      class: c.class,
      rank: null,
    };
  }

  // Fetch board for comparison
  const board = await ctx.fetchJson("/api/v1/leaderboard?metric=yield_");
  const allOps = board.operators || board || [];
  const yields = allOps.map((o) => o.yield_ || 0).sort((a, b) => a - b);
  const avgYield = yields.length
    ? yields.reduce((s, y) => s + y, 0) / yields.length
    : 0;
  const yourYield = yourMetrics.yield_ || 0;
  const percentile = yields.length
    ? Math.round(
        (yields.filter((y) => y < yourYield).length / yields.length) * 100,
      )
    : 0;

  const klass = yourMetrics.class || "Burner";
  const powerUserAssessment = _powerUserAssessment(klass, yourMetrics);
  const classMeaning = _classMeaning(klass);

  const yieldVsAvg = yields.length
    ? yourYield > avgYield
      ? `${(yourYield / avgYield).toFixed(1)}× the board average`
      : `${((yourYield / avgYield) * 100).toFixed(0)}% of the board average`
    : "board has no other operators";

  const suggestion = _improvementSuggestion(klass, yourMetrics);

  // Competitive layer per SHARED_DESIGN_DECISIONS.md §3/§4/§5
  const competitive = _competitiveLayer(yourMetrics, board);
  const competitiveSummary = _competitiveSummary(yourMetrics, board);

  return {
    your_metrics: yourMetrics,
    power_user_assessment: powerUserAssessment,
    comparison: {
      your_yield_vs_avg: yieldVsAvg,
      your_class_meaning: classMeaning,
      percentile,
      rank: competitive.rank,
      total_operators: competitive.total_operators,
      class_tier: competitive.class_tier,
      delta_from_average: competitive.delta_from_average,
      delta_from_top: competitive.delta_from_top,
    },
    competitive_summary: competitiveSummary,
    shareable_url: competitive.shareable_url,
    suggestion,
    cta: "See where I stand",
  };
}
