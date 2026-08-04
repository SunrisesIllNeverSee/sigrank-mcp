/**
 * tools/submit-paste.mjs — submit_paste tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { SUBMIT_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import {
  MAX_INPUT,
  uploadStamp,
  withParseWarnings,
} from "./_helpers.mjs";
import { TERMS_VERSION, PRIVACY_VERSION, isRankedAck } from "../lib/constants.mjs";

export const TOOL_DEF = {
  name: "submit_paste",
  description:
    "Ranks a paste of token counts AND publishes it to the live SigRank board at signalaf.com in one call. First computes the cascade locally for an instant preview (yield, leverage, velocity, class, card), then submits the raw paste to the board's web-paste endpoint, which re-parses and re-scores it server-side. The server score is authoritative — it may differ from the local preview if the board applies additional validation. Returns both the local preview and the server response (including the operator's new rank if accepted). A codename is required to publish — omit it for a local preview only (no board submission). Token-only, no auth required. Use this when you have token counts from ccusage or a dashboard and want to both see your score and publish it. Do NOT use this if you want to pull your local usage automatically — use tokenpull_submit for the zero-paste flow. Do NOT use this for multi-window dashboard pastes — use rank_windows to rank them first, then submit each window. After calling this, use get_operator with your codename to verify your submission appeared on the board.",
  annotations: {
    title: "Submit paste to board",
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
          'Token counts to rank and submit. Two formats: (1) JSON {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} from ccusage (preferred — the board parses this reliably), or (2) four whitespace-separated numbers: input output cacheCreate cacheRead. The 4-number form ranks locally but the board may reject it. Example: {"input":1000000,"output":500000,"cacheCreate":50000,"cacheRead":800000}',
      },
      codename: {
        type: "string",
        description:
          'Operator codename to publish under on the leaderboard (e.g. "Ghost Falcon"). Required to submit — omit for local preview only (no board submission, just returns the local cascade result). Must be a non-empty string.',
      },
    },
    required: ["text"],
    description:
      "Requires token counts (text). Codename is optional but required for board submission — omit it for preview-only mode.",
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
  // Local preview first — also validates the paste is parseable before any POST.
  const pillars = parsePillars(args.text);
  const c = withParseWarnings(pillars, cascade(pillars));
  const codename = String(args?.codename || "").trim();
  const card = narrate(c, codename || "This operator");

  // No codename → cannot publish (the board endpoint requires it). Fail fast at the
  // tool boundary with a clear message instead of an opaque server 400.
  if (!codename) {
    return {
      ...c,
      card,
      submission: {
        status: "not_submitted",
        reason: "codename_required",
        detail:
          "Pass a codename to publish to the board. Showing local preview only.",
      },
    };
  }

  // Privacy: send ONLY the 4 parsed token numbers (canonical "input output
  // cacheCreate cacheRead" form), never the raw user text. parsePillars above
  // already validated the input — we reconstruct from the parsed pillars so
  // no conversation content or prose can leak to the server. The server's
  // ingestMeta() re-parses these 4 numbers authoritatively (Strategy 3:
  // four bare numbers). This makes every submit path — signed and paste —
  // send only token counts.
  const canonicalPaste = `${pillars.input} ${pillars.output} ${pillars.cacheCreate} ${pillars.cacheRead}`;
  const stamp = uploadStamp({
    codename,
    pillars: c.pillars,
    source: "web_paste",
  });
  const res = await ctx.doFetch(`${ctx.apiBase}/api/v1/ingest-paste`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      codename,
      raw_paste: canonicalPaste,
      consent_acknowledged: true,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      ...stamp,
    }),
  });
  let ack;
  try {
    ack = await res.json();
  } catch {
    ack = {
      status: "error",
      detail: `HTTP ${res.status} (non-JSON response)`,
    };
  }
  const ranked = isRankedAck(res, ack);
  return {
    ...c,
    card,
    ranked,
    submission: { ...stamp, httpStatus: res.status, ranked, ...ack },
  };
}
