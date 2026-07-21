/**
 * tools/submit-verified.mjs — submit_verified tool.
 */

import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { ensureIdentity } from "../identity/keystore.mjs";
import { submitSignedWindow } from "../submit/index.mjs";
import { SUBMIT_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { pullByPlatform, WINDOW_TYPE } from "./_helpers.mjs";
import { _computeReportBlock } from "./_report.mjs";

export const TOOL_DEF = {
  name: "submit_verified",
  description:
    "Publish your LOCAL token runs to the SigRank board as a VERIFIED operator — the enrolled, signed path. Reads your pillars (tokenpull), builds the canonical Schema 1.0 snapshot per window, ed25519-signs it with your device key, and POSTs to /api/v1/snapshots. Requires `npx sigrank-mcp enroll` first (a bound device). Only signed submissions from a trusted device rank on the board. Token-only; the private key never leaves your machine. Pass dry_run:true to inspect the exact signed payload without publishing.",
  annotations: {
    title: "Submit verified score",
    ...ANNOTATIONS.destructiveHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      window: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        description: "submit only this window (default: all 4)",
      },
      platform: {
        type: "string",
        enum: [...ALL_PLATFORMS, "multi"],
        description:
          "source platform (default: claude). 'multi' = combined cascade summed across all locally-detected platforms (needs 2+ active); empty windows are skipped.",
      },
      dry_run: {
        type: "boolean",
        description:
          "build + sign but do NOT publish — returns the exact payload that would be POSTed (token counts only), so you can inspect before submitting",
      },
    },
  },
  outputSchema: SUBMIT_OUTPUT,
};

export async function handleSubmitVerified(args, ctx) {
  // The enrolled, signed publish path → /api/v1/snapshots (only verified rows rank).
  const id = ctx.opts.identity || ensureIdentity();
  if (!id.codename || !id.operator_id) {
    return {
      status: "not_enrolled",
      detail: "Run `npx sigrank-mcp enroll` to bind this device first.",
    };
  }
  const platform = args?.platform || "claude";

  // MULTI: the combined cross-platform cascade. The dashboard already SUMS every
  // active platform's pillars (a "claude+codex" row) but never submitted it — this
  // is that missing submission. Aggregate every locally-detected platform's pillars
  // per window and publish as platform='multi' = the operator's TOTAL usage. Empty
  // windows are skipped so a no-activity window never lands as a degenerate row.
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
        codename: id.codename,
        operator_id: id.operator_id,
        status: "skipped",
        reason: "need_2_platforms",
        detail: `multi needs 2+ active platforms; found ${detected.length} (${detected.map((d) => d.platform).join(", ") || "none"}).`,
        windows: [],
      };
    }
    const winKeys = args?.window
      ? [args.window]
      : ["7d", "30d", "90d", "all"];
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
        continue; // skip empty window
      const report = _computeReportBlock(sum);
      const r = await submitSignedWindow(wk, sum, msgs, id, {
        apiBase: ctx.apiBase,
        fetchImpl: ctx.doFetch,
        platform: "multi",
        now: ctx.opts.now,
        dryRun: !!args?.dry_run,
        report,
      });
      out.push({ window: wk, pillars: sum, ...r });
    }
    return {
      platform: "multi",
      codename: id.codename,
      operator_id: id.operator_id,
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
    // Compute the cascade report block (mode + badges + health) for this window.
    // Pure math, computed locally, submitted alongside the 4 token pillars.
    const report = _computeReportBlock(w.pillars);
    const r = await submitSignedWindow(w.window, w.pillars, w.messages, id, {
      apiBase: ctx.apiBase,
      fetchImpl: ctx.doFetch,
      platform: pulled.platform,
      now: ctx.opts.now,
      dryRun: !!args?.dry_run,
      report,
    });
    out.push({ window: w.window, pillars: w.pillars, ...r });
  }
  return {
    platform: pulled.platform,
    codename: id.codename,
    operator_id: id.operator_id,
    generatedAt: pulled.generatedAt,
    windows: out,
  };
}
