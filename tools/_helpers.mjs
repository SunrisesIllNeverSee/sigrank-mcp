/**
 * tools/_helpers.mjs — shared helpers for the SigRank MCP tool suite.
 *
 * Transport-free utilities used across multiple tool handlers:
 * exec wrapper, curl fallback, fetch builder, upload stamp, platform pull,
 * parse-warning merge, and watch-tokenpull cooldown state.
 */

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tokenpull as pullLocal,
  tokenpullCodex as pullCodex,
  tokenpullAny,
} from "../adapters/tokenpull.mjs";

// Resolve local node_modules/.bin for bundled deps (ccusage, tokscale)
const _pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const _localBin = path.join(_pkgRoot, "..", "node_modules", ".bin");
const _envPath = `${_localBin}${process.env.PATH ? ":" + process.env.PATH : ""}`;

export const DEFAULT_API_BASE =
  process.env.SIGRANK_API_BASE || "https://signalaf.com";
/** Default network timeout in ms (override via opts.fetchTimeout or SIGRANK_FETCH_TIMEOUT). */
export const DEFAULT_FETCH_TIMEOUT =
  Number(process.env.SIGRANK_FETCH_TIMEOUT) || 10_000;
/** Max accepted length for a single paste/string arg (chars). Token counts are tiny; anything
 *  past this is malformed or abusive — reject cleanly before parsing/POSTing (E2 hardening). */
export const MAX_INPUT = 1_000_000;

// E3: client-side auto-submit cooldown for watch_tokenpull. The server already dedups
// identical snapshots (exact hash → 422), but a noisy poll loop with submit:true could still
// churn the network/board with near-identical rows. Cap auto-submit to once per WATCH_SUBMIT_COOLDOWN_MS
// per platform+window (in-memory, per process). Keyed by platform:window so different
// platforms/windows don't block each other, and only armed on a non-error submit so a
// network failure doesn't lock out retries for 5 minutes.
export const WATCH_SUBMIT_COOLDOWN_MS = 5 * 60 * 1000;
export const _lastWatchSubmitAt = new Map();

// ASYNC FIX (2026-06-27): execFile wrapped in a Promise — replaces execSync for
// defense-in-depth (shell injection prevention + non-blocking). The platform param
// is enum-validated at the MCP schema level, but execFile also prevents shell
// interpolation attacks by passing args as an array (no shell parsing).
// BIN FIX (2026-06-27): PATH includes local node_modules/.bin so bundled deps
// are found even when sigrank isn't globally installed.
export function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // NOTE: execFile does not accept a `stdio` option (it always pipes + buffers
    // stdout/stderr against maxBuffer) — a previous `stdio` key here was silently ignored.
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: _envPath },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.toString());
      },
    );
  });
}

/** Resolve this package's version for the User-Agent stamp (best-effort). */
export function agentVersionStamp() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "unknown";
  }
}

/**
 * curl-based fetch fallback for when Node's fetch is blocked by Vercel's bot
 * protection (TLS fingerprinting). Returns a Response-like object with .ok,
 * .status, .json(), .text(). Uses execFileSync for synchronous curl execution.
 */
export function curlFetch(url, init = {}, timeoutMs = 10_000) {
  const args = [
    "-s",
    "-S",
    "-w",
    "\n__HTTP_STATUS__%{http_code}",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
  ];
  if (init.method) args.push("-X", init.method);
  const headers = init.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  if (init.body) {
    args.push("-d", init.body);
  }
  args.push(url);
  let stdout;
  try {
    stdout = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs + 2000,
    });
  } catch (e) {
    throw new Error(`curl transport failed: ${e.message}`);
  }
  // Parse the status code from the trailer
  const statusMatch = stdout.match(/__HTTP_STATUS__(\d+)$/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const bodyText = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      try {
        return JSON.parse(bodyText);
      } catch {
        return {};
      }
    },
    text: async () => bodyText,
  };
}

// Every board upload from the MCP is hashed + timestamped (ddmmyy) — provenance + dedup.
export function uploadStamp(content) {
  const hash = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ddmmyy =
    p(d.getUTCDate()) +
    p(d.getUTCMonth() + 1) +
    String(d.getUTCFullYear()).slice(-2);
  return {
    content_hash: hash,
    submitted_ddmmyy: ddmmyy,
    submitted_at: d.toISOString(),
  };
}

// Pull a platform's local usage → 4 windows of canonical pillars. Routes through
// tokenpullAny() which handles Claude (native), Codex (estimated io_ratio), and all
// other adapters from the registry. opts.adapter overrides for tests.
export async function pullByPlatform(platform, opts = {}) {
  if (opts.adapter) {
    // Test injection: bypass registry and use the mock adapter directly
    if (platform === "codex") {
      let ioRatio = 2.0;
      try {
        const c = await pullLocal({});
        const all = c.windows.find((w) => w.window === "all");
        if (all && all.pillars.output > 0)
          ioRatio = all.pillars.input / all.pillars.output;
      } catch {
        /* no Claude data → Alpha 2.0 */
      }
      return pullCodex({ ioRatio, adapter: opts.adapter, now: opts.now });
    }
    return pullLocal({ adapter: opts.adapter, now: opts.now });
  }
  return tokenpullAny(platform || "claude", opts);
}

/**
 * Build a fetch wrapper with timeout + curl fallback + User-Agent stamp.
 * Returns { doFetch, fetchJson } bound to the given opts.
 */
export function buildFetch(opts = {}) {
  const apiBase = opts.apiBase || DEFAULT_API_BASE;
  const timeoutMs = opts.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT;
  const rawFetch = opts.fetchImpl || fetch;

  const doFetch = async (url, init = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const headers = {
      "user-agent": `node/${process.version} sigrank-mcp/${agentVersionStamp()}`,
      ...(init.headers || {}),
    };
    try {
      const res = await rawFetch(url, { ...init, headers, signal: ac.signal });
      // Detect Vercel security checkpoint (403 + HTML body, not JSON)
      if (res.status === 403) {
        const text = await res.text();
        if (
          text.includes("Vercel Security Checkpoint") ||
          text.includes("x-vercel-challenge")
        ) {
          // Fall back to curl transport
          return curlFetch(url, init, timeoutMs);
        }
        // Real 403 from the API — return a mock response object
        return {
          ok: false,
          status: 403,
          json: async () => {
            try {
              return JSON.parse(text);
            } catch {
              return {};
            }
          },
          text: async () => text,
        };
      }
      return res;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      // Network error — try curl as fallback
      try {
        return await curlFetch(url, init, timeoutMs);
      } catch {
        throw e;
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchJson = async (path) => {
    const res = await doFetch(`${apiBase}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`SigRank API ${path} → HTTP ${res.status}`);
    return res.json();
  };

  return { apiBase, doFetch, fetchJson };
}

// Helper: attach _parseWarnings from pillars onto the cascade result so they
// are always visible in the tool output for review.
export function withParseWarnings(pillars, cascadeResult) {
  if (pillars._parseWarnings && pillars._parseWarnings.length > 0) {
    const existing = cascadeResult.warnings || [];
    return {
      ...cascadeResult,
      warnings: [
        ...existing,
        ...pillars._parseWarnings.map((w) => `parse:${w}`),
      ],
    };
  }
  return cascadeResult;
}

// tokenpull window key → the board's window_type enum.
export const WINDOW_TYPE = { "7d": "7d", "30d": "30d", "90d": "90d", all: "all_time" };
