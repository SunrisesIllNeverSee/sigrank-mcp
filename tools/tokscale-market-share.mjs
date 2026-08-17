/**
 * tools/tokscale-market-share.mjs — tokscale_market_share tool.
 */

import {
  tokscaleMarketShare,
} from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_market_share",
  description:
    "Complete AI tool market share analysis from your local tokscale data. Aggregates per-model usage by client (AI tool) and computes each tool's share of total tokens, cost, and messages. Returns each tool ranked by token share, with share_tokens / share_cost / share_messages percentages and a totals rollup. All data is read locally from tokscale's scan of your session logs — no network calls, no PII. Use this to see which AI coding tools dominate your workflow by volume, spend, or activity. Do NOT use this for per-model detail — use tokscale_developer_profile for that.",
  annotations: { title: "AI tool market share", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description: "No parameters. Scans all locally-detected AI tools via tokscale.",
  },
  outputSchema: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        description: "AI tools ranked by token share, each with { client, label, tokens, cost, messages, model_count, share_tokens, share_cost, share_messages }",
      },
      totals: {
        type: "object",
        description: "Aggregate totals: { tokens, cost, messages, tool_count }",
      },
      error: { type: "string", description: "Present if tokscale is unavailable" },
    },
  },
};

export async function handleTokscaleMarketShare() {
  return await tokscaleMarketShare();
}
