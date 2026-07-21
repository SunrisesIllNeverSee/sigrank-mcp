/**
 * tools/get-operator.mjs — get_operator tool.
 */

import { OPERATOR_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "get_operator",
  description:
    "Fetches one operator's live profile from the SigRank board by their codename. Reads the operator's current submission data from signalaf.com and returns their detailed metrics: yield (Υ), leverage ratio (Cr/I), velocity (O/I), class tier (Burner / Builder / 10xer), rank position (integer, 1-based), and per-window breakdowns for each time range (7d, 30d, 90d, all-time) with the four canonical pillars (input, output, cacheCreate, cacheRead) per window. Returns an error if the codename is not found on the board. Use this to look up any operator who has submitted to the board — codenames are public and visible on the leaderboard. Do NOT use this to browse all operators — use get_leaderboard for that. After calling this, you can use simulate_change to model what would happen if the operator adjusted their token mix.",
  annotations: { title: "Get operator profile", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      codename: {
        type: "string",
        description:
          'The operator\'s public codename as shown on the SigRank leaderboard. Case-insensitive — "Ghost Falcon" and "ghost falcon" are equivalent. Must match a codename that exists on the board; returns an error if not found. To discover valid codenames, call get_leaderboard first.',
      },
    },
    required: ["codename"],
    description:
      "Requires the operator's codename. No other parameters are accepted.",
  },
  outputSchema: OPERATOR_OUTPUT,
};

export async function handleGetOperator(args, ctx) {
  const codename = String(args?.codename || "").trim();
  if (!codename)
    throw new Error("get_operator requires a non-empty `codename` argument.");
  return ctx.fetchJson(`/api/v1/operators/${encodeURIComponent(codename)}`);
}
