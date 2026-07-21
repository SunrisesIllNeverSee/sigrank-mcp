/**
 * tools/tokenpull-submit.mjs — tokenpull_submit tool.
 */

import { cascade } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { SUBMIT_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import {
  MAX_INPUT,
  pullByPlatform,
  uploadStamp,
  WINDOW_TYPE,
} from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "tokenpull_submit",
  description:
    "Pull your LOCAL token usage from session logs AND publish it to the SigRank board in one call — the zero-paste flow. Reads the four canonical pillars (input, output, cacheCreate, cacheRead) per window from your local logs, computes the cascade, and submits each window to the board where it is re-scored server-side and tagged with the source platform. Requires a codename to publish; omit for a local preview only. Token-only — no prompt content is read or transmitted.",
  annotations: {
    title: "Pull and submit tokens",
    ...ANNOTATIONS.destructiveHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      codename: {
        type: "string",
        description:
          'Operator codename to publish under on the leaderboard (e.g. "Iron Lotus"). Required to submit — omit for local preview only.',
      },
      window: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        description:
          'Submit only this time window (default: all 4 windows). Use "7d" for recent activity or "all" for all-time ranking.',
      },
      platform: {
        type: "string",
        enum: [...ALL_PLATFORMS, "multi"],
        description: `Source platform to pull from (default: claude). Supported: ${ALL_PLATFORMS.join(", ")}, multi. 'multi' = combined cascade summed across all locally-detected platforms (needs 2+ active). 'devin' reads from ~/.local/share/devin/cli/sessions.db (SQLite, all windows). 'other' reads from a user-supplied JSON file (set SIGRANK_OTHER_PATH). Each platform reads its own session logs locally.`,
      },
    },
  },
  outputSchema: SUBMIT_OUTPUT,
};

export async function handleTokenpullSubmit(args, ctx) {
  // Pull local usage, then publish each window's CANONICAL pillars to the board
  // (server re-scores). The board stays platform-agnostic via the 4 pillars; the
  // source platform rides along as a tag. Conversion already happened in the adapter.
  const codename = String(args?.codename || "").trim();
  const platform = args?.platform || "claude";

  // MULTI: same combined cross-platform cascade as submit_verified. Includes Devin
  // (cloud, via tokscale). Aggregate every locally-detected platform's pillars per
  // window and publish as platform='multi'.
  if (platform === "multi") {
    const detected = [];
    for (const p of ALL_PLATFORMS) {
      const r = await pullByPlatform(p, ctx.opts).catch(() => null);
      const live =
        r &&
        (r.windows || []).some(
          (w) =>
            w.pillars.input +
              w.pillars.output +
              w.pillars.cacheCreate +
              w.pillars.cacheRead >
            0,
        );
      if (live) detected.push(r);
    }
    if (detected.length < 2) {
      return {
        platform: "multi",
        codename: codename || undefined,
        status: "skipped",
        reason: "need_2_platforms",
        detail: `multi needs 2+ active platforms; found ${detected.length} (${detected.map((d) => d.platform).join(", ") || "none"}).`,
        windows: [],
      };
    }
    const winKeys = args?.window ? [args.window] : ["7d", "30d", "90d", "all"];
    const out = [];
    for (const wk of winKeys) {
      const sum = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
      let msgs = 0;
      for (const d of detected) {
        const w = (d.windows || []).find((x) => x.window === wk);
        if (!w) continue;
        sum.input += w.pillars.input || 0;
        sum.output += w.pillars.output || 0;
        sum.cacheCreate += w.pillars.cacheCreate || 0;
        sum.cacheRead += w.pillars.cacheRead || 0;
        msgs += w.messages || 0;
      }
      if (sum.input + sum.output + sum.cacheCreate + sum.cacheRead <= 0)
        continue;
      const c = cascade(sum);
      const card = narrate(c, `${wk} multi`);
      if (!codename) {
        out.push({
          window: wk,
          pillars: sum,
          cascade: c,
          card,
          submission: { status: "not_submitted", reason: "codename_required" },
        });
        continue;
      }
      const rawPaste = `${sum.input} ${sum.output} ${sum.cacheCreate} ${sum.cacheRead}`;
      const windowType = WINDOW_TYPE[wk] || wk;
      const stamp = uploadStamp({
        codename,
        window: windowType,
        pillars: sum,
        platform: "multi",
      });
      const res = await ctx.doFetch(`${ctx.apiBase}/api/v1/ingest-paste`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          codename,
          raw_paste: rawPaste,
          window_type: windowType,
          telemetry: { platform: { primary: "multi" } },
          consent_acknowledged: true,
          terms_version: "2026-07-21",
          privacy_version: "2026-07-21",
          ...stamp,
        }),
      });
      let ack;
      try {
        ack = await res.json();
      } catch {
        ack = { status: "parse_error", httpStatus: res.status };
      }
      const ranked = ack?.ranked ?? ack?.accepted ?? false;
      out.push({
        window: wk,
        pillars: sum,
        cascade: c,
        card,
        submission: { ...stamp, httpStatus: res.status, ranked, ...ack },
      });
    }
    return {
      platform: "multi",
      codename: codename || undefined,
      sources: detected.map((d) => d.platform),
      windows: out,
    };
  }

  const pulled = await pullByPlatform(platform, ctx.opts);
  const targets = args?.window
    ? pulled.windows.filter((w) => w.window === args.window)
    : pulled.windows;
  const out = [];
  for (const w of targets) {
    const c = cascade(w.pillars);
    const card = narrate(c, `${w.window} window`);
    if (!codename) {
      out.push({
        window: w.window,
        pillars: w.pillars,
        cascade: c,
        card,
        submission: { status: "not_submitted", reason: "codename_required" },
      });
      continue;
    }
    // canonical pillars → "input output cacheCreate cacheRead" (the parser's 4-bare-number form)
    const rawPaste = `${w.pillars.input} ${w.pillars.output} ${w.pillars.cacheCreate} ${w.pillars.cacheRead}`;
    const windowType = WINDOW_TYPE[w.window] || w.window;
    const stamp = uploadStamp({
      codename,
      window: windowType,
      pillars: w.pillars,
      platform: pulled.platform,
    });
    const res = await ctx.doFetch(`${ctx.apiBase}/api/v1/ingest-paste`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        codename,
        raw_paste: rawPaste,
        window_type: windowType,
        telemetry: { platform: { primary: pulled.platform } },
        consent_acknowledged: true,
        terms_version: "2026-07-21",
        privacy_version: "2026-07-21",
        ...stamp,
      }),
    });
    let ack;
    try {
      ack = await res.json();
    } catch {
      ack = { status: "error", detail: `HTTP ${res.status} (non-JSON)` };
    }
    // ranked = actually on the board (verified + persisted), not just received — parity
    // with submit_verified (submit/index.mjs). An unenrolled/revoked device gets 202 but is NEVER ranked.
    const ranked = !!(
      res.ok &&
      ack.verification_tier === "verified" &&
      ack.persisted === true
    );
    out.push({
      window: w.window,
      pillars: w.pillars,
      cascade: c,
      card,
      ranked,
      submission: { ...stamp, httpStatus: res.status, ranked, ...ack },
    });
  }
  return {
    platform: pulled.platform,
    codename: codename || null,
    generatedAt: pulled.generatedAt,
    windows: out,
  };
}
