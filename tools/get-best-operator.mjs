/**
 * tools/get-best-operator.mjs — get_best_operator tool.
 */

import { BEST_OPERATOR_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { DEFAULT_API_BASE } from "./_helpers.mjs";
import { _behavioralFraming, _competitiveLayer } from "./_framing.mjs";

export const TOOL_DEF = {
  name: "get_best_operator",
  description:
    "Returns the top N operators on the SigRank leaderboard with behavioral framing in power-user language. Wraps get_leaderboard and adds plain-language interpretation of each top operator's cascade: what their yield, leverage, and velocity mean in terms of AI power-user behavior (cache reuse, input economy, output productivity). Use this when users ask 'who is the best AI user?' or 'who tops the SigRank leaderboard?' or 'show me the AI user leaderboard'. Do NOT use get_leaderboard if you want the raw array without interpretation — use this for the power-user framing. Intent: BEST_OPERATOR.",
  annotations: { title: "Get best operator", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      n: {
        type: "integer",
        description:
          "Number of top operators to return (default: 5, max: 20). Returns the top N by yield.",
        minimum: 1,
        maximum: 20,
      },
    },
    description:
      "Optional: how many top operators to return. Defaults to 5.",
  },
  outputSchema: BEST_OPERATOR_OUTPUT,
};

export async function handleGetBestOperator(args, ctx) {
  const rawN = args?.n;
  const n = Math.min(20, Math.max(1, rawN == null ? 5 : Number(rawN)));
  const board = await ctx.fetchJson("/api/v1/leaderboard?metric=yield_");
  const ops = (board.operators || board || []).slice(0, n);
  const total = Array.isArray(board.operators || board)
    ? (board.operators || board).length
    : 0;

  const top = ops.map((op) => ({
    ...op,
    behavioral_framing: _behavioralFraming(op),
    competitive: _competitiveLayer(op, board),
  }));

  const best = top[0];
  const summary = best
    ? `${best.codename} tops the SigRank leaderboard at Υ ${best.yield_?.toLocaleString?.() || best.yield_} — ${_behavioralFraming(best)}`
    : "No operators on the board yet.";

  return {
    top_operators: top,
    total_operators: total,
    summary,
    cta: "Check my rank",
    shareable_url: best ? `${DEFAULT_API_BASE}/operator/${encodeURIComponent(best.codename)}` : null,
  };
}
