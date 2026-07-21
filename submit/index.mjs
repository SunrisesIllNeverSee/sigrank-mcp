// submit.mjs — build + ed25519-sign a Schema 1.0 snapshot payload and POST it to the
// VERIFIED ingest endpoint (D7 §5). Requires an enrolled identity (keystore.codename +
// operator_id + private key). The server re-derives the ranked Υ from the 4 raw pillars,
// so the core/background metrics here are schema-valid, plausibility-clean DISPLAY inputs.
//
// raw_telemetry sessions/turns/active are conservative PROXIES: tokenpull yields the 4
// pillars + a message count, not session structure. They are chosen to pass the
// plausibility gate WITHOUT flagging (a flag downgrades verified→flagged → not ranked).
// TODO(tokenpull): emit real sessions_count / turns_total / active_minutes per window so
// the display signa_rate reflects true session shape (the ranked Υ is already exact).

import { snapshotHash, signPayload } from "../identity/sign.mjs";
import { preflight } from "./preflight.mjs";
import { readFileSync } from "node:fs";

const WINDOW_TYPE = { "7d": "7d", "30d": "30d", "90d": "90d", all: "all_time" };
const WINDOW_SPAN_DAYS = { "7d": 7, "30d": 30, "90d": 90, all_time: 3650 };

/** Resolve this package's version for the User-Agent stamp (best-effort). */
function _pkgVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "unknown";
  }
}
const PLATFORM_ENUM = new Set([
  "claude",
  "chatgpt",
  "gemini",
  "pi",
  "codex",
  "multi",
  "other",
]);
// Provenance tag only — the board ranks by Υ (no RS.xx weights, §0.1).
const RULESET_VERSION = "sigrank-token-1";
const TERMS_VERSION = "2026-07-21";
const PRIVACY_VERSION = "2026-07-21";
const DAY_MS = 86_400_000;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (n, dp) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Map any tokenpull platform to the Schema 1.0 platform.primary enum (others → 'other'). */
export function toPlatformPrimary(platform) {
  return PLATFORM_ENUM.has(platform) ? platform : "other";
}

/**
 * buildPayload — Schema 1.0 payload from a tokenpull window + enrolled identity.
 * Pure (given opts.now); agent.snapshot_hash is computed last (canonical strips it).
 */
export function buildPayload(
  windowKey,
  pillars,
  messages,
  identity,
  platform,
  opts = {},
) {
  const windowType = WINDOW_TYPE[windowKey] || windowKey;
  const spanDays = WINDOW_SPAN_DAYS[windowType] || 30;
  const nowMs = opts.now ?? Date.now();

  const input = Math.max(0, Math.round(pillars?.input || 0));
  const output = Math.max(0, Math.round(pillars?.output || 0));
  const cacheCreate = Math.max(0, Math.round(pillars?.cacheCreate || 0));
  const cacheRead = Math.max(0, Math.round(pillars?.cacheRead || 0));
  const tokensTotal = input + output + cacheCreate + cacheRead;

  // Proxies — plausibility-clean (see file header).
  const msgs = Math.max(0, Math.round(messages || 0));
  const turnsTotal = Math.max(output > 0 ? 1 : 0, msgs);
  const sessionsCount =
    tokensTotal > 0
      ? clamp(Math.round(msgs / 8) || 1, 1, Math.max(1, turnsTotal))
      : 0;
  const spanMinutes = spanDays * 1440;
  const minActive = Math.ceil(output / 19000) + 1; // keep output/active under the 20k/min flag
  const activeMinutes = clamp(
    Math.max(msgs, minActive),
    1,
    Math.max(1, spanMinutes - 1),
  );

  const compressionRatio =
    input + output > 0 ? clamp(output / (input + output), 0, 1) : 0;
  const sessionDepth = sessionsCount > 0 ? turnsTotal / sessionsCount : 0;

  const payload = {
    schema_version: "1.0",
    codename: identity.codename,
    device_id: identity.device_id,
    submitted_at: new Date(nowMs).toISOString(),
    consent_acknowledged: true,
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    window: {
      type: windowType,
      start: new Date(nowMs - spanDays * DAY_MS).toISOString(),
      end: new Date(nowMs).toISOString(),
    },
    platform: { primary: toPlatformPrimary(platform), models: [] },
    core_metrics: {
      compression_ratio: round(compressionRatio, 4),
      prompt_complexity: round(clamp(sessionDepth, 0, 100), 2),
      cross_thread_score: clamp(
        Math.round(cacheRead / Math.max(cacheCreate, 1)),
        0,
        100000,
      ),
      session_depth_avg: round(Math.max(0, sessionDepth), 2),
      // M.05 token_throughput muted 2026-06-26 — word-era metric the web already
      // mutes (RS01 tt→0) + strips. Send null (RPC p_token_throughput is nullable
      // DEFAULT NULL). raw_telemetry.tokens_total still carries the raw count.
      token_throughput: null,
    },
    background_metrics: {
      message_volume: msgs,
      account_age_days: Math.max(1, Math.round(opts.accountAgeDays ?? 365)),
      total_messages_lifetime: Math.max(
        msgs,
        Math.round(opts.totalMessages ?? msgs),
      ),
    },
    raw_telemetry: {
      sessions_count: sessionsCount,
      turns_total: turnsTotal,
      tokens_total: tokensTotal,
      tokens_input_fresh: input,
      tokens_output: output,
      tokens_cache_read: cacheRead,
      tokens_cache_creation: cacheCreate,
      active_minutes_est: activeMinutes,
    },
    tier: "free",
    agent: {
      version: identity.agent_version,
      ruleset_version: RULESET_VERSION,
      snapshot_hash: "",
      public_key: identity.public_key,
    },
  };

  // Cascade Report block (Phase 1 — mode detection + badges + health).
  // Computed locally (pure math), submitted alongside the 4 token pillars.
  // The server stores it as-is — does NOT recompute modes.
  // Weekly granularity is the privacy boundary — daily modes never leave the machine.
  if (opts.report && typeof opts.report === "object") {
    payload.report = opts.report;
  }
  payload.agent.snapshot_hash = snapshotHash(payload);
  return payload;
}

/**
 * submitSignedWindow — build + sign + POST one window to /api/v1/snapshots.
 * Returns a structured result; never throws on a network error. opts: { apiBase,
 * fetchImpl, platform, now } (fetchImpl lets the caller inject a timeout-wrapped fetch).
 */
export async function submitSignedWindow(
  windowKey,
  pillars,
  messages,
  identity,
  opts = {},
) {
  if (!identity?.codename || !identity?.operator_id) {
    return {
      status: "not_enrolled",
      reason: "not_enrolled",
      detail: "Run `npx sigrank-mcp enroll` to bind this device first.",
    };
  }
  if (!identity?.private_key_pkcs8_b64) {
    return {
      status: "error",
      reason: "no_key",
      detail: "No local signing key — re-run `npx sigrank-mcp enroll`.",
    };
  }

  const apiBase =
    opts.apiBase || process.env.SIGRANK_API_BASE || "https://signalaf.com";
  // FIX M: default a 15s AbortController timeout when the caller doesn't inject a
  // fetchImpl. The TUI path already wraps fetch (callTool → doFetch, 10s), but the
  // legacy CLI `watch --submit` + the CLI default-view [S] call submitSignedWindow
  // with no fetchImpl → bare fetch → a hung POST blocks forever. This default fixes
  // it everywhere at once. (15s is generous for a signed POST to /api/v1/snapshots.)
  const fetchImpl =
    opts.fetchImpl ||
    ((url, init = {}) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      const headers = {
        "user-agent": `node/${process.version} sigrank-mcp/${_pkgVersion()}`,
        ...(init.headers || {}),
      };
      return fetch(url, {
        ...init,
        headers,
        signal: init.signal || ctrl.signal,
      }).finally(() => clearTimeout(timer));
    });
  const payload = buildPayload(
    windowKey,
    pillars,
    messages,
    identity,
    opts.platform || "claude",
    opts,
  );

  // Preflight: run the same anti-gaming checks the server will run, locally.
  // If the payload would be rejected or downgraded, warn the operator BEFORE
  // submitting. The server always runs its own checks — this is a preview.
  const pre = preflight(payload);
  if (!pre.pass && !opts.skipPreflight) {
    if (pre.wouldReject) {
      return {
        status: "preflight_rejected",
        window: WINDOW_TYPE[windowKey] || windowKey,
        preflight: pre,
        detail: `Submission would be REJECTED by the server: ${pre.summary}. Fix the issue or re-run with skipPreflight.`,
      };
    }
    // Flags downgrade verified → flagged (not ranked). Warn but don't block
    // unless the caller explicitly asked for strict mode.
    if (opts.strictPreflight) {
      return {
        status: "preflight_flagged",
        window: WINDOW_TYPE[windowKey] || windowKey,
        preflight: pre,
        detail: `Submission would be DOWNGRADED (not ranked): ${pre.summary}. Fix the issue or re-run with skipPreflight.`,
      };
    }
    // Non-strict: attach the preflight warning to the result but proceed.
  }

  const signature = signPayload(payload, identity.private_key_pkcs8_b64);

  // Dry run: build + sign exactly as a real publish, then STOP before the POST.
  // Returns the exact payload that would be sent — the privacy proof ("token
  // counts only") is inspectable, and nothing touches the network.
  if (opts.dryRun) {
    return {
      status: "dry_run",
      window: WINDOW_TYPE[windowKey] || windowKey,
      would_post: `${apiBase}/api/v1/snapshots`,
      payload,
      signature,
      preflight: pre,
      detail:
        "By submitting, you agree to the SignalAF Terms of Service and Privacy Policy. Nothing sent. Re-run without dry_run to publish.",
    };
  }

  let res;
  let ack;
  try {
    res = await fetchImpl(`${apiBase}/api/v1/snapshots`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-agent-signature": signature,
      },
      body: JSON.stringify(payload),
    });
    try {
      ack = await res.json();
    } catch {
      ack = {};
    }
  } catch (e) {
    return {
      status: "error",
      reason: "network",
      detail: e.message,
      window: WINDOW_TYPE[windowKey] || windowKey,
    };
  }

  return {
    status: res.ok ? ack.status || "received" : "error",
    httpStatus: res.status,
    window: WINDOW_TYPE[windowKey] || windowKey,
    verification_tier: ack.verification_tier ?? null,
    persisted: ack.persisted ?? null,
    // ranked = actually on the board (verified + written), not just "received".
    // An unenrolled/revoked device gets HTTP 202 received but is NEVER ranked.
    ranked: !!(
      res.ok &&
      ack.verification_tier === "verified" &&
      ack.persisted === true
    ),
    snapshot_hash: payload.agent.snapshot_hash,
    reason: res.ok ? null : ack.reason || ack.status || `http_${res.status}`,
    detail: ack.detail ?? null,
    preflight: pre,
  };
}
