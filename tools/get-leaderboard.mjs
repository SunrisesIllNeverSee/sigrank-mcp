/**
 * tools/get-leaderboard.mjs — get_leaderboard tool.
 */

import { LEADERBOARD_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { LEADERBOARD_METRIC } from "../lib/constants.mjs";

export const TOOL_DEF = {
  name: "get_leaderboard",
  description:
    "Fetches the live public SigRank leaderboard from signalaf.com. Reads all ranked operators sorted by yield (Υ = Cache Reads × Output / Input²) and returns an array of operator summaries. Each entry contains: codename (public display name), yield (Υ, the headline efficiency metric), leverage ratio (Cr/I = cache reads divided by input), velocity (O/I = output divided by input), class tier (one of 24 experience stages: 8 tiers × 3 sub-stages, e.g. ARCH+ I, REFINER II, IGNITER III), and rank position (integer, 1-based). Returns an empty array if no operators have submitted yet. Use this to see where operators stand overall, to find specific codenames for get_operator lookups, or to display the current rankings. Do NOT use this to check your own rank if you already know your codename — use get_operator instead for a single-operator profile with per-window breakdowns. After calling this, follow up with get_operator to get detailed metrics for any operator of interest.",
  annotations: { title: "Get leaderboard", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {},
    description:
      "This tool takes no parameters. It always fetches the full public leaderboard.",
  },
  outputSchema: LEADERBOARD_OUTPUT,
};

export async function handleGetLeaderboard(args, ctx) {
  const params = new URLSearchParams({ metric: LEADERBOARD_METRIC });
  if (args?.limit) params.set("limit", String(args.limit));
  if (args?.window) params.set("window", args.window);
  return ctx.fetchJson(`/api/v1/leaderboard?${params}`);
}
