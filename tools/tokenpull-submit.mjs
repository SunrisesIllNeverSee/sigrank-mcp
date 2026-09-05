/**
 * tools/tokenpull-submit.mjs — tokenpull_submit tool.
 */

import { cascade } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { SUBMIT_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import {
  pullByPlatform,
} from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "tokenpull_submit",
  description:
    "Pull your LOCAL token usage from session logs and compute the cascade per window — the zero-paste preview flow. Reads the four canonical pillars (input, output, cacheCreate, cacheRead) per window from your local logs and computes yield, leverage, velocity, class, and card. This is a PREVIEW-ONLY tool — it does not publish to the board. The board's /api/v1/ingest-paste endpoint now requires an authenticated Supabase session, which MCP tools do not carry. To publish to the leaderboard, use submit_verified (which signs and posts to /api/v1/snapshots via the enrolled-device path) or submit directly through the signalaf.com web UI. Token-only — no prompt content is read or transmitted.",
  annotations: {
    title: "Pull and preview tokens",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.idempotentHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      codename: {
        type: "string",
        description:
          'Operator codename for the ranking card display (e.g. "Iron Lotus"). Optional — used only for the local preview card, not for board submission.',
      },
      window: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        description:
          'Preview only this time window (default: all 4 windows). Use "7d" for recent activity or "all" for all-time ranking.',
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
  // Pull local usage and compute the cascade per window. This tool is
  // preview-only — the board's /api/v1/ingest-paste endpoint now requires
  // an authenticated Supabase session, which MCP tools do not carry. Use
  // submit_verified for authenticated board submission.
  const codename = String(args?.codename || "").trim();
  const platform = args?.platform || "claude";

  // MULTI: same combined cross-platform cascade as submit_verified. Includes Devin
  // (cloud, via tokscale). Aggregate every locally-detected platform's pillars per
  // window.
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
      out.push({
        window: wk,
        pillars: sum,
        cascade: c,
        card,
        submission: {
          status: "not_submitted",
          reason: "preview_only",
          detail:
            "tokenpull_submit is preview-only. Use submit_verified (enrolled device) or the signalaf.com web UI to publish.",
        },
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
    out.push({
      window: w.window,
      pillars: w.pillars,
      cascade: c,
      card,
      submission: {
        status: "not_submitted",
        reason: "preview_only",
        detail:
          "tokenpull_submit is preview-only. Use submit_verified (enrolled device) or the signalaf.com web UI to publish.",
      },
    });
  }
  return {
    platform: pulled.platform,
    codename: codename || null,
    generatedAt: pulled.generatedAt,
    windows: out,
  };
}
