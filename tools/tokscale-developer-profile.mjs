/**
 * tools/tokscale-developer-profile.mjs — tokscale_developer_profile tool.
 */

import { tokscaleDeveloperProfile } from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_developer_profile",
  description:
    "Per-developer usage profile across all 20+ AI tools detected by tokscale on this machine. For each tool: model mix (per-model tokens/cost/messages/performance), token pillars (input/output/cache_read/cache_write/reasoning), cache_read_pct, session count, scan path (redacted to ~), workspace breakdown, and headless support flag. Returns a summary with tool_count, total_cost, dominant_tool. All filesystem paths are redacted (home dir → ~). Use this to understand your full AI tool footprint — which tools you use, which models per tool, and how your usage is distributed. Do NOT use this for cost-only analysis — use tokscale_cost_analysis for that.",
  annotations: { title: "Developer usage profile", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description: "No parameters. Profiles all locally-detected AI tools via tokscale.",
  },
  outputSchema: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        description: "Per-tool profile with model mix, token pillars, session counts, workspaces",
      },
      summary: {
        type: "object",
        description: "Aggregate summary: { tool_count, total_cost, total_tokens, total_messages, avg_cost_per_tool, dominant_tool }",
      },
      error: { type: "string", description: "Present if tokscale is unavailable" },
    },
  },
};

export async function handleTokscaleDeveloperProfile() {
  return await tokscaleDeveloperProfile();
}
