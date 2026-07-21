/**
 * tools/rank-paste.mjs — rank_paste tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { CASCADE_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "rank_paste",
  description:
    'Computes the SigRank yield cascade from a paste of token counts. Parses the input, runs the full cascade math locally (no network calls), and returns: Υ Yield (the headline efficiency metric, Υ = Cache Reads × Output / Input²), SNR (signal-to-noise ratio), Leverage ratio (Cr/I = cache reads divided by input), Velocity (O/I = output divided by input), 10xDEV score, operator class tier (Burner / Builder / 10xer), and a deterministic prose "card" summarizing the result in plain English. Accepts two input formats: (1) JSON object {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} or (2) four whitespace-separated numbers in order: input output cacheCreate cacheRead. Returns an error if the input is malformed or has negative values. Use this for a quick one-off ranking without submitting to the board. Do NOT use this to submit your score — use submit_paste instead, which both ranks and publishes. Do NOT use this if you want to rank all four time windows at once — use rank_windows for that. After calling this, use submit_paste to publish the result if you want to appear on the leaderboard.',
  annotations: {
    title: "Rank a paste",
    ...ANNOTATIONS.readOnlyHint,
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
          'Token counts to rank. Two formats accepted: (1) JSON object {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} where all values are non-negative integers, or (2) four whitespace-separated numbers in order: input output cacheCreate cacheRead. Get these from `ccusage` output, the Claude Max usage dashboard, tokscale, or any token reader. Example valid input: {"input":1000000,"output":500000,"cacheCreate":50000,"cacheRead":800000}',
      },
    },
    required: ["text"],
    description:
      "Requires the token counts as a string. No other parameters are accepted.",
  },
  outputSchema: CASCADE_OUTPUT,
};

export async function handleRankPaste(args) {
  if (!args?.text)
    throw new Error("rank_paste requires a non-empty `text` argument.");
  // E2: reject oversized pastes before parsing (parity with submit_paste / rank_windows).
  if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
    return {
      status: "error",
      reason: "input_too_large",
      detail: `text exceeds ${MAX_INPUT} chars (${args.text.length}). Paste only the token-count table, not full output.`,
    };
  }
  const pillars = parsePillars(args.text);
  const c = withParseWarnings(pillars, cascade(pillars));
  return { ...c, card: narrate(c) };
}
