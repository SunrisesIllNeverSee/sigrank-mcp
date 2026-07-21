/**
 * tools/tokscale-competitive-intel.mjs — tokscale_competitive_intel tool.
 */

import { tokscaleCompetitiveIntel } from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_competitive_intel",
  description:
    "Competitive intelligence for any AI tool company. Pass a target tool (by tokscale client slug like 'claude', 'codex', 'devin-cli' or canonical platform name like 'devin', 'other') and get: the target's rank by tokens among all detected tools, its full profile (tokens, cost, model mix, cache_read_pct, cost_per_million_tokens, market share), and a head-to-head comparison against every competitor (each competitor's tokens, cost, model_count, share, cost_per_million_tokens). Returns market_totals for context. If the target is not found, lists all detected clients. Use this to benchmark one AI tool against its competitors on this machine. All data is local — this is your own usage, not aggregate market data.",
  annotations: { title: "Competitive intelligence", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "The AI tool to analyze. Accepts a tokscale client slug (e.g. 'claude', 'codex', 'devin-cli', 'copilot') or a canonical platform name (e.g. 'devin', 'claude', 'other'). Case-insensitive. To discover valid slugs, call tokscale_market_share first.",
      },
    },
    required: ["target"],
    description: "Requires the target tool name. No other parameters accepted.",
  },
  outputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "The resolved target slug(s)" },
      found: { type: "boolean", description: "Whether the target was found in local data" },
      rank_by_tokens: { type: "integer", description: "Target's rank among all detected tools by token volume" },
      target_profile: { type: "object", description: "Target's full usage profile with model mix and market share" },
      competitors: { type: "array", description: "All other detected tools with comparison metrics" },
      market_totals: { type: "object", description: "Aggregate market context: { tokens, cost, messages, tool_count }" },
      error: { type: "string", description: "Present if tokscale is unavailable or target is empty" },
    },
  },
};

export async function handleTokscaleCompetitiveIntel(args) {
  const target = String(args?.target || "").trim();
  if (!target) {
    throw new Error("tokscale_competitive_intel requires a non-empty `target` argument (a tokscale client slug like 'claude' or 'codex').");
  }
  return await tokscaleCompetitiveIntel(target);
}
