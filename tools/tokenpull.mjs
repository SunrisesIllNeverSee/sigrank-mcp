/**
 * tools/tokenpull.mjs — tokenpull tool.
 */

import { cascade } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { TOKENPULL_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { pullByPlatform } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "tokenpull",
  description:
    "Pull your LOCAL token usage from the platform's session logs and rank it across the four windows (7d/30d/90d/all-time) with the cascade — zero paste. Token-only: reads usage counts not message content. The numbers stay on your machine unless you submit them. Some platforms may have partial data (estimated=true when cacheCreate isn't available) or a dataGap note when the log format doesn't expose raw token counts.",
  annotations: { title: "Pull local token usage", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: [...ALL_PLATFORMS, "multi"],
        description: `source platform (default: claude). Supported: ${ALL_PLATFORMS.join(", ")}, multi. 'multi' = combined cascade summed across all locally-detected platforms (needs 2+ active). 'devin' reads from ~/.local/share/devin/cli/sessions.db (SQLite, all windows). 'codex' is estimated via io_ratio. 'other' reads from a user-supplied JSON file (set SIGRANK_OTHER_PATH). Some platforms need setup (e.g. copilot requires COPILOT_OTEL_ENABLED=true).`,
      },
    },
  },
  outputSchema: TOKENPULL_OUTPUT,
};

export async function handleTokenpull(args, ctx) {
  // Local read → 4 windows of pillars → cascade each. Token-only, on-device.
  const platform = args?.platform || "claude";

  // MULTI: sum every locally-detected platform's pillars per window. Same logic as
  // submit_verified's multi flow — Devin (cloud, via tokscale) is included.
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
        status: "skipped",
        reason: "need_2_platforms",
        detail: `multi needs 2+ active platforms; found ${detected.length} (${detected.map((d) => d.platform).join(", ") || "none"}).`,
        windows: [],
      };
    }
    const winKeys = ["7d", "30d", "90d", "all"];
    const windows = [];
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
      windows.push({
        window: wk,
        messages: msgs,
        pillars: sum,
        cascade: c,
        card: narrate(c, `${wk} multi`),
      });
    }
    return {
      platform: "multi",
      estimated: true,
      sources: detected.map((d) => d.platform),
      windows,
    };
  }

  const pulled = await pullByPlatform(platform, ctx.opts);
  const windows = pulled.windows.map((w) => {
    const c = cascade(w.pillars);
    return {
      window: w.window,
      messages: w.messages,
      pillars: w.pillars,
      cascade: c,
      card: narrate(c, `${w.window} ${platform}`),
    };
  });
  return {
    platform: pulled.platform,
    estimated: pulled.estimated || false,
    ...(pulled.ioRatio ? { ioRatio: pulled.ioRatio } : {}),
    generatedAt: pulled.generatedAt,
    files: pulled.files,
    totalMessages: pulled.totalMessages,
    windows,
  };
}
