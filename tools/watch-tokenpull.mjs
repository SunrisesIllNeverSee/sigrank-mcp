/**
 * tools/watch-tokenpull.mjs — watch_tokenpull tool.
 */

import { cascade } from "../analytics/cascade.mjs";
import { narrate } from "../presentation/narrate.mjs";
import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { ensureIdentity } from "../identity/keystore.mjs";
import { submitSignedWindow } from "../submit/index.mjs";
import { TOKENPULL_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import {
  pullByPlatform,
  WATCH_SUBMIT_COOLDOWN_MS,
  _lastWatchSubmitAt,
} from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "watch_tokenpull",
  description:
    "One poll per call: pulls your local token logs and returns the current cascade for the watched window — the tool never blocks or loops. Re-call at your desired cadence to watch for changes (interval_s is advisory only and echoed back as poll_interval_s). With submit:true (and an enrolled device) each call may also sign + publish the watched window to the board, rate-limited to once per 5 min per platform+window; default is preview-only (no submit).",
  annotations: {
    title: "Watch token pull",
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: ALL_PLATFORMS,
        description: "platform to watch (default: claude)",
      },
      interval_s: {
        type: "number",
        description:
          "advisory poll cadence in seconds (default: 60, min: 10) — echoed back as poll_interval_s; does not make the call block or loop",
      },
      window: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        description:
          "which window to watch (default: 7d — most sensitive to recent activity)",
      },
      submit: {
        type: "boolean",
        description:
          "auto-submit the watched window to the board as a VERIFIED operator each poll (requires `enroll`; default false = preview only)",
      },
    },
  },
  outputSchema: TOKENPULL_OUTPUT,
};

export async function handleWatchTokenpull(args, ctx) {
  // Poll the local token logs at a configurable interval and return the cascade
  // diff whenever new sessions appear. One poll cycle per MCP call — the client
  // is responsible for re-calling at the desired cadence (MCP tools are stateless;
  // a persistent background watcher lives outside the tool boundary).
  //
  // With submit:true + an enrolled device, this also signs + POSTs the watched window
  // to the verified ingest path each poll (the server dedups identical re-submits).
  const platform = args?.platform || "claude";
  const watchWindow = args?.window || "7d";
  const intervalS = Math.max(10, Number(args?.interval_s) || 60);

  const pulled = await pullByPlatform(platform, ctx.opts);
  const win = pulled.windows.find((w) => w.window === watchWindow);
  if (!win)
    throw new Error(
      `watch_tokenpull: window '${watchWindow}' not found in pull result.`,
    );

  const c = cascade(win.pillars);
  const card = narrate(c, `${watchWindow} ${platform}`);

  // AUTH.WIRE (D7 §7): when submit is on AND the device is enrolled, sign + POST the
  // watched window to the verified ingest path. Default OFF = preview only. The server
  // dedups identical re-submits (exact snapshot_hash → 422), so re-calling is safe.
  let auth_submit = null;
  if (args?.submit === true) {
    const id = ctx.opts.identity || ensureIdentity();
    if (id.codename && id.operator_id && id.private_key_pkcs8_b64) {
      // E3: client-side cooldown — at most one auto-submit per platform+window per 5 min.
      // Prevents a fast poll loop from churning the board even before the server's
      // hash-dedup kicks in. Armed only on a non-error outcome so failed submits retry.
      const clockNow = typeof ctx.opts.now === "number" ? ctx.opts.now : Date.now();
      const cdKey = `${pulled.platform}:${watchWindow}`;
      const last = _lastWatchSubmitAt.get(cdKey);
      if (last != null && clockNow - last < WATCH_SUBMIT_COOLDOWN_MS) {
        const waitS = Math.ceil(
          (WATCH_SUBMIT_COOLDOWN_MS - (clockNow - last)) / 1000,
        );
        auth_submit = {
          status: "cooldown",
          detail: `auto-submit for '${cdKey}' on cooldown — next in ~${waitS}s (max once / 5 min).`,
          retry_after_s: waitS,
        };
      } else {
        auth_submit = await submitSignedWindow(
          watchWindow,
          win.pillars,
          win.messages,
          id,
          {
            apiBase: ctx.apiBase,
            fetchImpl: ctx.doFetch,
            platform: pulled.platform,
            now: ctx.opts.now,
          },
        );
        if (auth_submit?.status !== "error")
          _lastWatchSubmitAt.set(cdKey, clockNow);
      }
    } else {
      auth_submit = {
        status: "not_enrolled",
        detail: "Run `npx sigrank-mcp enroll` to auto-submit verified runs.",
      };
    }
  }
  return {
    platform: pulled.platform,
    window: watchWindow,
    pillars: win.pillars,
    messages: win.messages,
    cascade: c,
    card,
    generatedAt: pulled.generatedAt,
    poll_interval_s: intervalS,
    auth_submit,
    note: "One snapshot per call — re-call at your poll interval to detect changes.",
  };
}
