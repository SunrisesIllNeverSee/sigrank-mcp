/**
 * tools/tokscale-cost-analysis.mjs — tokscale_cost_analysis tool.
 */

import { tokscaleCostAnalysis } from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_cost_analysis",
  description:
    "Cost analysis per developer per model from your local tokscale data. Returns a per-client × per-model cost breakdown with cost_per_million_tokens, cost_per_message, and share_cost. Includes a per-client cost rollup and totals: total_cost, total_tokens, avg_cost_per_million_tokens, most_expensive_model, cheapest_per_token. Use this to see exactly where your AI spend goes — which tools and models cost the most and which give the best value per token. Do NOT use this for market share — use tokscale_market_share for that.",
  annotations: { title: "Cost analysis per model", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description: "No parameters. Derives cost breakdown from tokscale models data.",
  },
  outputSchema: {
    type: "object",
    properties: {
      entries: { type: "array", description: "Per-client×per-model cost rows sorted by cost desc" },
      client_rollup: { type: "array", description: "Per-client cost summary with share_cost and cost_per_million_tokens" },
      totals: { type: "object", description: "Aggregate cost totals and extremes" },
      error: { type: "string", description: "Present if tokscale is unavailable" },
    },
  },
};

export async function handleTokscaleCostAnalysis() {
  return await tokscaleCostAnalysis();
}
