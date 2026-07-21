/**
 * tools/rank-windows.mjs — rank_windows tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { CASCADE_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "rank_windows",
  description:
    "Rank all four time windows (7d/30d/90d/all-time) in one call from a dashboard paste — paste the full table from ccusage, tokscale, or the Claude Max usage dashboard and get the cascade (Υ, SNR, Leverage, Velocity, 10xDEV, class, card) for each window. Each window is parsed and scored independently. Named keys required (input/output/cacheCreate/cacheRead); positional order is NOT safe here (dashboards list cache_read before cache_create — see WINDOWED_PROFILES gotcha). Omit windows you don't have — partial input is allowed (1–4 windows). Does NOT submit to the board; use tokenpull_submit for zero-paste publishing.",
  annotations: {
    title: "Rank all time windows",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      "7d": {
        type: "string",
        description:
          "ccusage/tokscale paste or JSON for the 7-day window (optional)",
      },
      "30d": {
        type: "string",
        description:
          "ccusage/tokscale paste or JSON for the 30-day window (optional)",
      },
      "90d": {
        type: "string",
        description:
          "ccusage/tokscale paste or JSON for the 90-day window (optional)",
      },
      all: {
        type: "string",
        description:
          "ccusage/tokscale paste or JSON for the all-time window (optional)",
      },
      source_tool: {
        type: "string",
        enum: [
          "ccusage",
          "tokscale",
          "claude_max",
          "token_dashboard",
          "other",
        ],
        description:
          "which token reader produced the paste (for cross-tool variance tracking)",
      },
    },
    // at least one window paste is required (runtime check backs this up)
    anyOf: [
      { required: ["7d"] },
      { required: ["30d"] },
      { required: ["90d"] },
      { required: ["all"] },
    ],
  },
  outputSchema: {
    type: "object",
    properties: {
      windows: {
        type: "array",
        description: "Cascade results per window",
        items: {
          type: "object",
          properties: {
            window: { type: "string", enum: ["7d", "30d", "90d", "all"] },
            ...CASCADE_OUTPUT.properties,
          },
        },
      },
    },
  },
};

export async function handleRankWindows(args) {
  // Score up to 4 named window pastes independently. Named-key parsing only —
  // positional is unsafe here because dashboards list cache_read before cache_create
  // (the WINDOWED_PROFILES swap gotcha). Each window goes through parsePillars →
  // cascade → narrate individually; results are collected into a windows[] array
  // in the same shape as tokenpull output for easy follow-up with tokenpull_submit.
  const WINDOW_KEYS = ["7d", "30d", "90d", "all"];
  const sourceTool = args?.source_tool || null;
  // E2: reject any oversized window paste up front (token tables are tiny).
  for (const wk of WINDOW_KEYS) {
    const v = args?.[wk];
    if (typeof v === "string" && v.length > MAX_INPUT) {
      return {
        status: "error",
        reason: "input_too_large",
        detail: `window '${wk}' exceeds ${MAX_INPUT} chars (${v.length}). Paste only the token-count table.`,
      };
    }
  }
  const windows = [];
  for (const wk of WINDOW_KEYS) {
    const text = args?.[wk];
    if (!text || typeof text !== "string" || !text.trim()) continue;
    const pillars = parsePillars(text);
    const c = withParseWarnings(pillars, cascade(pillars));
    const card = narrate(c, `${wk} window`);
    windows.push({ window: wk, pillars, cascade: c, card });
  }
  if (windows.length === 0) {
    throw new Error(
      "rank_windows requires at least one window paste (7d, 30d, 90d, or all).",
    );
  }
  return {
    windows,
    source_tool: sourceTool,
    note: "Local preview only — use tokenpull_submit to publish to the board.",
  };
}
