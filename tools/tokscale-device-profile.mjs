/**
 * tools/tokscale-device-profile.mjs — tokscale_device_profile tool.
 */

import { tokscaleDeviceProfile } from "../tokscale_analytics.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_device_profile",
  description:
    "Device fingerprinting: profiles this machine's AI tool footprint — which AI tools are installed, where their session logs live (paths redacted to ~), how many sessions and messages each has, when the machine was active (daily activity + day-of-week distribution), session concurrency, and longest continuous session. Combines tokscale clients + graph data. All filesystem paths are redacted so no local username leaks. Use this to audit your own machine's AI tool installation and activity pattern. This is local-only — it profiles the current machine, not remote devices.",
  annotations: { title: "Device profile", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description: "No parameters. Profiles the local machine via tokscale.",
  },
  outputSchema: {
    type: "object",
    properties: {
      installed_tools: { type: "array", description: "Detected AI tools with redacted session paths and message counts" },
      installed_tool_count: { type: "integer" },
      active_tool_count: { type: "integer", description: "Tools whose session path exists on disk" },
      date_range: { type: "object", description: "{ start, end } of the activity data" },
      activity: { type: "object", description: "Daily activity + day-of-week token distribution" },
      sessions: { type: "object", description: "Session metrics: count, total/longest active time, max concurrent" },
      summary: { type: "object", description: "Cost summary from graph: total_tokens, total_cost, avg_per_day, max_single_day" },
      error: { type: "string", description: "Present if tokscale is unavailable" },
    },
  },
};

export async function handleTokscaleDeviceProfile() {
  return await tokscaleDeviceProfile();
}
