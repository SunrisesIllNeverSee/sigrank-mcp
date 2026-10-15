/**
 * adapters/otel.mjs — the `otel` pillar source.
 *
 * Reads live Claude Code pillars from the local sigrank-otel collector instead of
 * re-walking ~/.claude/projects transcripts. Contract (owned by the collector):
 *
 *   GET http://127.0.0.1:<port>/api/pillars?window=7d|30d|90d|all
 *   → 200 { source:"otel-cc", window, sinceMs, total:{input,output,cacheRead,cacheWrite,requests},
 *           models:{ <model>: {same fields} } }
 *
 * `input` is LOGGED API input tokens (the canonical pillar), never typed input.
 * Platform = claude only. Base URL: opts.otelUrl → SIGRANK_OTEL_URL → http://127.0.0.1:4318.
 *
 * Source modes (`--source` / tool arg `source`):
 *   auto        (default) probe the collector (≤300 ms); use it when reachable, else transcripts
 *   otel        collector required — an unreachable/malformed collector is an error
 *   transcripts never probe; current behaviour
 *
 * All-or-nothing: if ANY of the four windows fails (timeout, non-200, bad JSON, bad shape)
 * the whole pull falls back, so a result never mixes otel and transcript windows.
 * Token-math is untouched: the collector's totals map 1:1 onto the four pillars
 * (cacheWrite → cacheCreate) and `requests` becomes the window's message count.
 */

import { WINDOWS } from "./tokenpull.mjs";

export const OTEL_DEFAULT_URL = "http://127.0.0.1:4318";
export const OTEL_PROBE_TIMEOUT_MS = 300;
export const OTEL_FETCH_TIMEOUT_MS = 2000;
export const OTEL_SOURCE_TAG = "otel-cc";
export const SOURCE_MODES = ["auto", "otel", "transcripts"];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Normalize a --source value. null/''/true → 'auto'. Throws on anything unknown. */
export function normalizeSource(s) {
  if (s == null || s === "" || s === true) return "auto";
  const v = String(s).toLowerCase();
  if (!SOURCE_MODES.includes(v))
    throw new Error(
      `Unknown source "${s}". Valid: ${SOURCE_MODES.join(", ")}`,
    );
  return v;
}

/** Resolve the collector base URL. Loopback http(s) only — the collector is local. */
export function otelBaseUrl(opts = {}) {
  const raw = (opts.otelUrl || process.env.SIGRANK_OTEL_URL || OTEL_DEFAULT_URL)
    .toString()
    .trim()
    .replace(/\/+$/, "");
  const u = new URL(raw); // throws on garbage → caller treats as unavailable
  if (!/^https?:$/.test(u.protocol) || !LOOPBACK.has(u.hostname))
    throw new Error(
      `SIGRANK_OTEL_URL must be a loopback http URL (got ${u.protocol}//${u.hostname})`,
    );
  return raw;
}

const nonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validate one /api/pillars body → {pillars, messages} or throw with a reason. */
function _parseWindow(body, windowKey) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("malformed body");
  if (body.window != null && body.window !== windowKey)
    throw new Error(`window mismatch (${body.window} ≠ ${windowKey})`);
  const t = body.total;
  if (!t || typeof t !== "object") throw new Error("missing total");
  for (const k of ["input", "output", "cacheRead", "cacheWrite"])
    if (!nonNeg(t[k])) throw new Error(`bad total.${k}`);
  const requests = t.requests == null ? 0 : t.requests;
  if (!nonNeg(requests)) throw new Error("bad total.requests");
  return {
    window: windowKey,
    pillars: {
      input: Math.round(t.input),
      output: Math.round(t.output),
      cacheCreate: Math.round(t.cacheWrite),
      cacheRead: Math.round(t.cacheRead),
    },
    messages: Math.round(requests),
    sinceMs: nonNeg(body.sinceMs) ? body.sinceMs : null,
    _source: typeof body.source === "string" ? body.source : null,
  };
}

async function _getWindow(base, windowKey, timeoutMs, fetchImpl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `${base}/api/pillars?window=${encodeURIComponent(windowKey)}`,
      { headers: { accept: "application/json" }, signal: ac.signal },
    );
    if (!res || res.status !== 200) throw new Error(`HTTP ${res?.status}`);
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new Error("malformed JSON");
    }
    return _parseWindow(body, windowKey);
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the four windows from the collector. Never throws — returns
 * { ok:true, result } (a tokenpull-shaped result tagged source:'otel-cc') or
 * { ok:false, url, reason }.
 */
export async function tokenpullOtel(opts = {}) {
  let base;
  try {
    base = otelBaseUrl(opts);
  } catch (e) {
    return { ok: false, url: null, reason: e.message };
  }
  const fetchImpl = opts.otelFetch || fetch;
  const probeMs = opts.otelProbeTimeoutMs ?? OTEL_PROBE_TIMEOUT_MS;
  const fetchMs = opts.otelFetchTimeoutMs ?? OTEL_FETCH_TIMEOUT_MS;
  const keys = WINDOWS.map((w) => w.key);
  try {
    // Probe on the first window with the short timeout; only then pull the rest.
    const first = await _getWindow(base, keys[0], probeMs, fetchImpl);
    const rest = await Promise.all(
      keys.slice(1).map((k) => _getWindow(base, k, fetchMs, fetchImpl)),
    );
    const rows = [first, ...rest];
    const nowMs =
      opts.now == null
        ? Date.now()
        : typeof opts.now === "number"
          ? opts.now
          : Date.parse(opts.now);
    const all = rows.find((r) => r.window === "all");
    return {
      ok: true,
      result: {
        platform: "claude",
        source: OTEL_SOURCE_TAG,
        root: base,
        generatedAt: new Date(nowMs).toISOString(),
        files: 0,
        totalMessages: all ? all.messages : 0,
        excludedTooling: [],
        windows: rows.map(({ window, pillars, messages, sinceMs }) => ({
          window,
          pillars,
          messages,
          sinceMs,
        })),
      },
    };
  } catch (e) {
    return { ok: false, url: base, reason: e?.message || String(e) };
  }
}

/**
 * Source-aware pull. `transcriptsPull` is a thunk for the existing adapter path.
 * Only platform 'claude' is otel-backed; every other platform is always transcripts.
 * Returns the pull result with `source` set ('otel-cc' | 'transcripts') and, on an
 * auto-mode fallback, `otelFallback: '<reason>'` so the UI can say why.
 */
export async function pullWithSource(platform, opts = {}, transcriptsPull) {
  const mode = normalizeSource(opts.source);
  const tag = (r, extra = {}) =>
    r && typeof r === "object" ? { ...r, source: "transcripts", ...extra } : r;
  // Test injection: a mock adapter means "these are the transcripts" — never probe a
  // real collector that may be running on the dev machine unless a URL is injected too.
  const skipProbe = opts.adapter && !opts.otelUrl;
  if ((platform || "claude") !== "claude" || mode === "transcripts" || (skipProbe && mode === "auto"))
    return tag(await transcriptsPull());
  const o = await tokenpullOtel(opts);
  if (o.ok) return o.result;
  if (mode === "otel")
    throw new Error(
      `source otel: sigrank-otel collector unavailable at ${o.url || "(invalid URL)"} (${o.reason}). Start the collector or use --source auto|transcripts.`,
    );
  return tag(await transcriptsPull(), { otelFallback: o.reason });
}

/** Human marker for watch/TUI rows. */
export function sourceMarker(pulled) {
  if (!pulled) return null;
  if (pulled.source === OTEL_SOURCE_TAG) return "source: otel (live)";
  if (pulled.source === "transcripts") return "source: transcripts";
  return null;
}
