/**
 * tools/submit-paste.mjs — submit_paste tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { SUBMIT_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import {
  MAX_INPUT,
  withParseWarnings,
} from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "submit_paste",
  description:
    "Ranks a paste of token counts locally and shows the cascade result (yield, leverage, velocity, class, card). This is a PREVIEW-ONLY tool — it does not publish to the board. The board's /api/v1/ingest-paste endpoint now requires an authenticated Supabase session, which MCP tools do not carry. To publish to the leaderboard, use submit_verified (which signs and posts to /api/v1/snapshots via the enrolled-device path) or submit directly through the signalaf.com web UI. Use this when you have token counts from ccusage or a dashboard and want to see your score instantly. Do NOT use this if you want to pull your local usage automatically — use tokenpull_submit for the zero-paste flow. Do NOT use this for multi-window dashboard pastes — use rank_windows to rank them first.",
  annotations: {
    title: "Preview paste ranking",
    ...ANNOTATIONS.destructiveHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          'Token counts to rank. Two formats: (1) JSON {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} from ccusage (preferred), or (2) four whitespace-separated numbers: input output cacheCreate cacheRead. Example: {"input":1000000,"output":500000,"cacheCreate":50000,"cacheRead":800000}',
      },
      codename: {
        type: "string",
        description:
          'Operator codename for the ranking card display (e.g. "Ghost Falcon"). Optional — used only for the local preview card, not for board submission.',
      },
    },
    required: ["text"],
    description:
      "Requires token counts (text). Returns a local preview only — does not publish to the board.",
  },
  outputSchema: SUBMIT_OUTPUT,
};

export async function handleSubmitPaste(args, ctx) {
  if (!args?.text)
    throw new Error("submit_paste requires a non-empty `text` argument.");
  if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
    return {
      status: "error",
      reason: "input_too_large",
      detail: `text exceeds ${MAX_INPUT} chars (${args.text.length}). Paste only the token-count table, not full output.`,
    };
  }
  // Local preview — this tool is preview-only. The board's /api/v1/ingest-paste
  // endpoint now requires an authenticated Supabase session, which MCP tools
  // do not carry. Use submit_verified for authenticated board submission.
  const pillars = parsePillars(args.text);
  const c = withParseWarnings(pillars, cascade(pillars));
  const codename = String(args?.codename || "").trim();
  const card = narrate(c, codename || "This operator");

  return {
    ...c,
    card,
    submission: {
      status: "not_submitted",
      reason: "preview_only",
      detail:
        "submit_paste is preview-only. The board requires an authenticated session. Use submit_verified (enrolled device) or the signalaf.com web UI to publish.",
    },
  };
}
