/**
 * tools/tokscale-model-trends.mjs — tokscale_model_trends tool.
 */

import { tokscaleModelTrends } from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_model_trends",
  description:
    "Model adoption trends over time from your local tokscale data. Combines monthly aggregates with per-day contribution data to build a model-level adoption timeline: each model's first_seen / last_seen / active_days / tokens / clients, plus a month-by-month adoption curve showing how many new models appeared each month. Returns months[], models[], and adoption_curve[]. Use this to track which AI models you adopted when, and how your model mix evolved over time. Do NOT use this for cost trends — use tokscale_cost_analysis for current cost breakdown.",
  annotations: { title: "Model adoption trends", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description: "No parameters. Derives trends from tokscale monthly + graph data.",
  },
  outputSchema: {
    type: "object",
    properties: {
      months: { type: "array", description: "Per-month aggregates: { month, models, model_count, input, output, cache_read, messages, cost }" },
      models: { type: "array", description: "Per-model adoption: { model, first_seen, last_seen, active_days, tokens, cost, messages, client_count, clients }" },
      adoption_curve: { type: "array", description: "Per-month new-model count: { month, new_models, new_model_count, total_models }" },
      date_range: { type: "object", description: "{ start, end } date range of the data" },
      error: { type: "string", description: "Present if tokscale is unavailable" },
    },
  },
};

export async function handleTokscaleModelTrends() {
  return await tokscaleModelTrends();
}
