/**
 * tools/tokscale-mcp-usage.mjs — tokscale_mcp_usage tool.
 */

import { tokscaleMcpUsage } from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_mcp_usage",
  description:
    "MCP server usage patterns from your local tokscale data. Reports which MCP servers tokscale detected on this machine, the detection window, and active days in that window. tokscale currently exposes detected MCP servers as a set (not per-session attribution), so the report notes the detection window. Use this to see which MCP servers are active on your machine. If no servers are detected, the response explains that MCP server tracking requires a tokscale version that records per-session MCP attribution.",
  annotations: { title: "MCP server usage", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description: "No parameters. Reads MCP server data from tokscale graph output.",
  },
  outputSchema: {
    type: "object",
    properties: {
      servers: { type: "array", description: "Detected MCP servers: [{ name, detected: true }]" },
      server_count: { type: "integer" },
      detection_window: { type: "object", description: "{ start, end } date range" },
      active_days_in_window: { type: "integer" },
      note: { type: "string", description: "Explanation of the MCP server data granularity" },
      error: { type: "string", description: "Present if tokscale is unavailable" },
    },
  },
};

export async function handleTokscaleMcpUsage() {
  return await tokscaleMcpUsage();
}
