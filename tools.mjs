/**
 * tools.mjs — the SigRank MCP tool table + dispatcher, transport-free so it can be
 * unit-tested without spawning the stdio server (index.mjs imports from here).
 *
 * callTool() takes an opts bag with an injectable { apiBase, fetchImpl } so tests can
 * exercise the read/write network paths against a fake fetch — no live calls, no
 * writes to production. Pure cascade math lives in ./cascade.mjs; the deterministic
 * narration card in ./narrate.mjs. Token-only, no transcript content.
 */

import {
  cascade,
  parsePillars,
  detectMode,
  qualityScore,
  MODE_EXPECTED_YIELD,
} from "./cascade.mjs";
import { computeBadges } from "./badges.mjs";
import { narrate } from "./narrate.mjs";
import {
  tokenpull as pullLocal,
  tokenpullCodex as pullCodex,
  tokenpullAny,
} from "./tokenpull.mjs";
import { ALL_PLATFORMS } from "./adapters.mjs";
import { ensureIdentity, recordEnrollment } from "./keystore.mjs";
import { submitSignedWindow } from "./submit.mjs";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve local node_modules/.bin for bundled deps (ccusage, tokscale)
const _pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const _localBin = path.join(_pkgRoot, "node_modules", ".bin");
const _envPath = `${_localBin}${process.env.PATH ? ":" + process.env.PATH : ""}`;

// ASYNC FIX (2026-06-27): execFile wrapped in a Promise — replaces execSync for
// defense-in-depth (shell injection prevention + non-blocking). The platform param
// is enum-validated at the MCP schema level, but execFile also prevents shell
// interpolation attacks by passing args as an array (no shell parsing).
// BIN FIX (2026-06-27): PATH includes local node_modules/.bin so bundled deps
// are found even when sigrank isn't globally installed.
function execFileAsync(cmd, args, timeoutMs) {
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

// ── Verifier readers (sync, on-device, token-only) ────────────────────────────
// These mirror the implementations in cli.mjs / tui.mjs without the circular import.
//
// NOTE (P3 2026-06-27): Intentionally separate from tokenpull.mjs `freshVerifierPillars()`.
// The MCP `tokenpull_compare` tool uses these file-based/cached readers (tokscale_report.json,
// direct db read) for a quick comparison, while freshVerifierPillars runs all sources live
// (bunx tokscale, scan+read tokendash) for the TUI/CLI dashboard. Different data sources =
// different behavior; do NOT merge without understanding the trade-off.

async function _ccusagePillars(platform = "claude") {
  try {
    const raw = await execFileAsync(
      "ccusage",
      [platform, "daily", "--json"],
      15000,
    );
    const rows = JSON.parse(raw)?.daily ?? JSON.parse(raw);
    const now = Date.now();
    const result = {};
    for (const [win, days] of Object.entries({
      "7d": 7,
      "30d": 30,
      "90d": 90,
    })) {
      const since = new Date(now - days * 86400000);
      let i = 0,
        o = 0,
        cw = 0,
        cr = 0;
      for (const r of rows) {
        if (new Date(r.date ?? r.day ?? "1970") >= since) {
          i += r.inputTokens ?? r.input_tokens ?? 0;
          o += r.outputTokens ?? r.output_tokens ?? 0;
          cw += r.cacheCreationTokens ?? r.cache_create_tokens ?? 0;
          cr += r.cacheReadTokens ?? r.cache_read_tokens ?? 0;
        }
      }
      result[win] = { input: i, output: o, cacheCreate: cw, cacheRead: cr };
    }
    let i = 0,
      o = 0,
      cw = 0,
      cr = 0;
    for (const r of rows) {
      i += r.inputTokens ?? r.input_tokens ?? 0;
      o += r.outputTokens ?? r.output_tokens ?? 0;
      cw += r.cacheCreationTokens ?? r.cache_create_tokens ?? 0;
      cr += r.cacheReadTokens ?? r.cache_read_tokens ?? 0;
    }
    result["all"] = { input: i, output: o, cacheCreate: cw, cacheRead: cr };
    return result;
  } catch {
    return null;
  }
}

async function _tokenDashPillars() {
  const dbPath = path.join(os.homedir(), ".claude", "token-dashboard.db");
  if (!existsSync(dbPath)) return null;
  try {
    const raw = await execFileAsync(
      "sqlite3",
      [
        dbPath,
        "SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages",
      ],
      5000,
    );
    const [i, o, cw, cr] = raw.trim().split("|").map(Number);
    return {
      all: {
        input: i || 0,
        output: o || 0,
        cacheCreate: cw || 0,
        cacheRead: cr || 0,
      },
    };
  } catch {
    return null;
  }
}

async function _tokscalePillars(platform = "claude") {
  // Try the bundled tokscale CLI first (fresh data), fall back to saved report file.
  try {
    const raw = await execFileAsync("tokscale", ["models", "--json"], 60000);
    const data = JSON.parse(raw);
    const entries = Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data)
        ? data
        : [];
    const rows = entries.filter(
      (e) =>
        e &&
        e.client === platform &&
        e.model !== "<synthetic>" &&
        e.model !== "unknown" &&
        ((Number(e.input) || 0) > 0 || (Number(e.output) || 0) > 0),
    );
    if (rows.length) {
      const acc = rows.reduce(
        (a, e) => ({
          input: a.input + (Number(e.input) || 0),
          output: a.output + (Number(e.output) || 0),
          cacheCreate: a.cacheCreate + (Number(e.cacheWrite) || 0),
          cacheRead: a.cacheRead + (Number(e.cacheRead) || 0),
        }),
        { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      );
      return { all: acc };
    }
  } catch {
    /* fall through to file-based read */
  }
  // Fallback: read saved tokscale_report.json if it exists
  const p = path.join(os.homedir(), "tokscale_report.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const rows = (data.entries ?? []).filter(
      (e) =>
        e.client === platform &&
        e.model !== "<synthetic>" &&
        e.model !== "unknown" &&
        (e.input > 0 || e.output > 0),
    );
    if (!rows.length) return null;
    const acc = rows.reduce(
      (a, e) => ({
        input: a.input + (e.input ?? 0),
        output: a.output + (e.output ?? 0),
        cacheCreate: a.cacheCreate + (e.cacheWrite ?? 0),
        cacheRead: a.cacheRead + (e.cacheRead ?? 0),
      }),
      { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    );
    return { all: acc };
  } catch {
    return null;
  }
}

// Every board upload from the MCP is hashed + timestamped (ddmmyy) — provenance + dedup.
function uploadStamp(content) {
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
async function pullByPlatform(platform, opts = {}) {
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

export const DEFAULT_API_BASE =
  process.env.SIGRANK_API_BASE || "https://signalaf.com";
/** Default network timeout in ms (override via opts.fetchTimeout or SIGRANK_FETCH_TIMEOUT). */
export const DEFAULT_FETCH_TIMEOUT =
  Number(process.env.SIGRANK_FETCH_TIMEOUT) || 10_000;
/** Max accepted length for a single paste/string arg (chars). Token counts are tiny; anything
 *  past this is malformed or abusive — reject cleanly before parsing/POSTing (E2 hardening). */
const MAX_INPUT = 1_000_000;

/** Resolve this package's version for the User-Agent stamp (best-effort). */
function agentVersionStamp() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
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
function curlFetch(url, init = {}, timeoutMs = 10_000) {
  const args = ["-s", "-S", "-w", "\n__HTTP_STATUS__%{http_code}", "--max-time", String(Math.ceil(timeoutMs / 1000))];
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
    json: async () => { try { return JSON.parse(bodyText); } catch { return {}; } },
    text: async () => bodyText,
  };
}

// ── Smithery quality: output schemas + annotations ──────────────────────────
// MCP tool annotations hint to clients about side-effects, read-only status, etc.
const ANNOTATIONS = {
  readOnlyHint: { readOnlyHint: true },
  destructiveHint: { destructiveHint: false },
  idempotentHint: { idempotentHint: true },
  openWorldHint: { openWorldHint: false },
};

// Common output schema for cascade results (rank_paste, simulate_change, etc.)
const CASCADE_OUTPUT = {
  type: "object",
  properties: {
    yield_: {
      type: "number",
      description:
        "Υ Yield — the headline efficiency metric (Cache Reads × Output / Input²)",
    },
    snr: { type: "number", description: "Signal-to-noise ratio" },
    leverage: {
      type: "number",
      description: "Cr/I — cache reads divided by input",
    },
    velocity: { type: "number", description: "O/I — output divided by input" },
    tenx_dev: { type: "number", description: "10xDEV score" },
    class: {
      type: "string",
      enum: ["Burner", "Builder", "10xer"],
      description: "Operator class tier",
    },
    card: {
      type: "string",
      description: "Deterministic prose summary of the cascade result",
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Parse or data warnings if any",
    },
  },
  required: ["yield_", "class"],
};

const LEADERBOARD_OUTPUT = {
  type: "object",
  properties: {
    operators: {
      type: "array",
      description: "Array of ranked operators sorted by yield",
      items: {
        type: "object",
        properties: {
          codename: { type: "string", description: "Public display name" },
          yield_: { type: "number", description: "Υ Yield metric" },
          leverage: { type: "number", description: "Cr/I ratio" },
          velocity: { type: "number", description: "O/I ratio" },
          class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
          rank: { type: "integer", description: "1-based rank position" },
        },
      },
    },
  },
};

const OPERATOR_OUTPUT = {
  type: "object",
  properties: {
    codename: { type: "string", description: "Operator display name" },
    yield_: { type: "number", description: "Υ Yield metric" },
    leverage: { type: "number", description: "Cr/I ratio" },
    velocity: { type: "number", description: "O/I ratio" },
    class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
    rank: { type: "integer", description: "1-based rank position" },
    windows: {
      type: "array",
      description: "Per-window breakdowns (7d, 30d, 90d, all-time)",
      items: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["7d", "30d", "90d", "all_time"] },
          pillars: {
            type: "object",
            properties: {
              input: { type: "integer" },
              output: { type: "integer" },
              cacheCreate: { type: "integer" },
              cacheRead: { type: "integer" },
            },
          },
        },
      },
    },
  },
};

const BEST_OPERATOR_OUTPUT = {
  type: "object",
  properties: {
    top_operators: {
      type: "array",
      description: "Top N operators ranked by yield",
      items: {
        type: "object",
        properties: {
          codename: { type: "string", description: "Public display name" },
          yield_: { type: "number", description: "Υ Yield metric" },
          leverage: { type: "number", description: "Cr/I ratio" },
          velocity: { type: "number", description: "O/I ratio" },
          class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
          rank: { type: "integer", description: "1-based rank position" },
          behavioral_framing: {
            type: "string",
            description: "Plain-language interpretation of the operator's cascade in power-user terms",
          },
        },
      },
    },
    total_operators: { type: "integer", description: "Total operators on the board" },
    summary: {
      type: "string",
      description: "One-line summary of the top operator's achievement in behavioral terms",
    },
  },
};

const COMPARE_SELF_OUTPUT = {
  type: "object",
  properties: {
    your_metrics: {
      type: "object",
      description: "Your cascade metrics",
      properties: {
        codename: { type: "string" },
        yield_: { type: "number", description: "Υ Yield metric" },
        leverage: { type: "number", description: "Cr/I ratio" },
        velocity: { type: "number", description: "O/I ratio" },
        class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        rank: { type: "integer", description: "1-based rank position" },
      },
    },
    power_user_assessment: {
      type: "string",
      description: "Behavioral interpretation: are you an AI power user? Maps class tier to power-user language.",
    },
    comparison: {
      type: "object",
      description: "How you compare to board averages and archetypes",
      properties: {
        your_yield_vs_avg: { type: "string", description: "Your yield vs board average" },
        your_class_meaning: { type: "string", description: "What your class tier means in power-user terms" },
        percentile: { type: "number", description: "Your percentile rank (0-100)" },
      },
    },
    suggestion: {
      type: "string",
      description: "One actionable suggestion to improve your cascade efficiency",
    },
  },
};

const COMPARE_OPERATORS_OUTPUT = {
  type: "object",
  properties: {
    operator_a: {
      type: "object",
      description: "First operator's metrics",
      properties: {
        codename: { type: "string" },
        yield_: { type: "number" },
        leverage: { type: "number" },
        velocity: { type: "number" },
        class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        rank: { type: "integer" },
      },
    },
    operator_b: {
      type: "object",
      description: "Second operator's metrics",
      properties: {
        codename: { type: "string" },
        yield_: { type: "number" },
        leverage: { type: "number" },
        velocity: { type: "number" },
        class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
        rank: { type: "integer" },
      },
    },
    verdict: {
      type: "string",
      description: "Who is more efficient and why, in behavioral terms",
    },
    yield_delta: { type: "number", description: "Yield difference (A - B)" },
  },
};

const SUBMIT_OUTPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ok", "error", "skipped"],
      description: "Submission status",
    },
    preview: CASCADE_OUTPUT,
    server_response: {
      type: "object",
      description: "Server-side response including new rank if accepted",
    },
    reason: {
      type: "string",
      description: "Error or skip reason if status is not ok",
    },
  },
};

const TOKENPULL_OUTPUT = {
  type: "object",
  properties: {
    platform: { type: "string", description: "Source platform name" },
    generatedAt: { type: "string", description: "ISO timestamp of the pull" },
    windows: {
      type: "array",
      description: "Per-window token usage + cascade results",
      items: {
        type: "object",
        properties: {
          window: { type: "string", enum: ["7d", "30d", "90d", "all"] },
          pillars: {
            type: "object",
            properties: {
              input: { type: "integer" },
              output: { type: "integer" },
              cacheCreate: { type: "integer" },
              cacheRead: { type: "integer" },
            },
          },
          messages: {
            type: "integer",
            description: "Number of messages in window",
          },
          estimated: {
            type: "boolean",
            description: "True if cacheCreate was estimated",
          },
          cascade: CASCADE_OUTPUT,
        },
      },
    },
  },
};

const ENROLL_OUTPUT = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["enrolled", "error"],
      description: "Enrollment result",
    },
    codename: { type: "string", description: "Operator codename if enrolled" },
    operator_id: { type: "string", description: "Operator ID if enrolled" },
    device_id: { type: "string", description: "Local device ID" },
    trust_status: { type: "string", description: "Trust level of the device" },
    reason: { type: "string", description: "Error reason if status is error" },
  },
};

const COMPARE_OUTPUT = {
  type: "object",
  properties: {
    platform: { type: "string" },
    sources: {
      type: "array",
      description: "Side-by-side comparison of each token source",
      items: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Source name (tokenpull, ccusage, token-dash, tokscale)",
          },
          pillars: { type: "object" },
          cascade: CASCADE_OUTPUT,
          delta_pct: {
            type: "object",
            description: "Delta % vs tokenpull baseline",
          },
        },
      },
    },
  },
};

const SIMULATE_OUTPUT = {
  type: "object",
  properties: {
    current: CASCADE_OUTPUT,
    simulated: CASCADE_OUTPUT,
    yield_delta: {
      type: "number",
      description: "Υ Yield change (simulated - current)",
    },
    class_change: {
      type: "string",
      description: "Class tier change description",
    },
    metric_diffs: {
      type: "object",
      description: "Per-metric before/after diffs",
    },
  },
};

const DIAGNOSE_OUTPUT = {
  type: "object",
  properties: {
    pillars: { type: "object", description: "The 4 raw token pillars" },
    cascade: CASCADE_OUTPUT,
    diagnosis: {
      type: "array",
      description: "Ranked list of efficiency leaks found, worst first",
      items: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            description: "Which metric is underperforming",
          },
          severity: {
            type: "string",
            enum: ["critical", "warning", "info"],
            description: "How bad the leak is",
          },
          finding: { type: "string", description: "What the analysis found" },
          recommendation: {
            type: "string",
            description: "What to do about it",
          },
          estimated_yield_impact: {
            type: "string",
            description: "Estimated Υ improvement if fixed",
          },
        },
      },
    },
    summary: {
      type: "string",
      description: "One-line summary of the operator's cascade health",
    },
  },
};

const SUGGEST_OUTPUT = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      description: "Ranked recommendations, highest Υ impact first",
      items: {
        type: "object",
        properties: {
          rank: { type: "number", description: "1-based rank by Υ impact" },
          action: { type: "string", description: "What to change" },
          pillar: { type: "string", description: "Which pillar to adjust" },
          delta: { type: "string", description: "How much to change it" },
          simulated_yield: {
            type: "number",
            description: "Projected Υ after the change",
          },
          yield_delta: { type: "number", description: "Υ change vs current" },
          class_after: {
            type: "string",
            description: "Projected class after the change",
          },
          rationale: { type: "string", description: "Why this helps" },
        },
      },
    },
    current_yield: {
      type: "number",
      description: "Current Υ before any changes",
    },
    current_class: { type: "string", description: "Current class tier" },
    best_single_change: {
      type: "string",
      description: "The single highest-impact change",
    },
  },
};

export const TOOLS = [
  {
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
  },
  {
    name: "get_leaderboard",
    description:
      "Fetches the live public SigRank leaderboard from signalaf.com. Reads all ranked operators sorted by yield (Υ = Cache Reads × Output / Input²) and returns an array of operator summaries. Each entry contains: codename (public display name), yield (Υ, the headline efficiency metric), leverage ratio (Cr/I = cache reads divided by input), velocity (O/I = output divided by input), class tier (Burner / Builder / 10xer), and rank position (integer, 1-based). Returns an empty array if no operators have submitted yet. Use this to see where operators stand overall, to find specific codenames for get_operator lookups, or to display the current rankings. Do NOT use this to check your own rank if you already know your codename — use get_operator instead for a single-operator profile with per-window breakdowns. After calling this, follow up with get_operator to get detailed metrics for any operator of interest.",
    annotations: { title: "Get leaderboard", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
    inputSchema: {
      type: "object",
      properties: {},
      description:
        "This tool takes no parameters. It always fetches the full public leaderboard.",
    },
    outputSchema: LEADERBOARD_OUTPUT,
  },
  {
    name: "get_operator",
    description:
      "Fetches one operator's live profile from the SigRank board by their codename. Reads the operator's current submission data from signalaf.com and returns their detailed metrics: yield (Υ), leverage ratio (Cr/I), velocity (O/I), class tier (Burner / Builder / 10xer), rank position (integer, 1-based), and per-window breakdowns for each time range (7d, 30d, 90d, all-time) with the four canonical pillars (input, output, cacheCreate, cacheRead) per window. Returns an error if the codename is not found on the board. Use this to look up any operator who has submitted to the board — codenames are public and visible on the leaderboard. Do NOT use this to browse all operators — use get_leaderboard for that. After calling this, you can use simulate_change to model what would happen if the operator adjusted their token mix.",
    annotations: { title: "Get operator profile", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
    inputSchema: {
      type: "object",
      properties: {
        codename: {
          type: "string",
          description:
            'The operator\'s public codename as shown on the SigRank leaderboard. Case-insensitive — "Ghost Falcon" and "ghost falcon" are equivalent. Must match a codename that exists on the board; returns an error if not found. To discover valid codenames, call get_leaderboard first.',
        },
      },
      required: ["codename"],
      description:
        "Requires the operator's codename. No other parameters are accepted.",
    },
    outputSchema: OPERATOR_OUTPUT,
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    name: "rank_windows",
    description:
      "Rank all four time windows (7d/30d/90d/all-time) in one call from a dashboard paste — paste the full table from ccusage, tokscale, or the Claude Max usage dashboard and get the cascade (Υ, SNR, Leverage, Velocity, 10xDEV, class, card) for each window. Each window is parsed and scored independently. Named keys required (input/output/cacheCreate/cacheRead); positional order is NOT safe here (dashboards list cache_read before cache_create — see WINDOWED_PROFILES gotcha). Omit windows you don't have — partial input is allowed (1–4 windows). Does NOT submit to the board; use tokenpull_submit for zero-paste publishing.",
    annotations: {
      title: "Rank all time windows",
      ...ANNOTATIONS.readOnlyHint,
      ...ANNOTATIONS.idempotentHint,
      ...ANNOTATIONS.openWorldHint,
    },
    inputSchema: {
      type: "object",
      properties: {
        "7d": {
          type: "string",
          description:
            "ccusage/tokscale paste or JSON for the 7-day window (optional)",
        },
        "30d": {
          type: "string",
          description:
            "ccusage/tokscale paste or JSON for the 30-day window (optional)",
        },
        "90d": {
          type: "string",
          description:
            "ccusage/tokscale paste or JSON for the 90-day window (optional)",
        },
        all: {
          type: "string",
          description:
            "ccusage/tokscale paste or JSON for the all-time window (optional)",
        },
        source_tool: {
          type: "string",
          enum: [
            "ccusage",
            "tokscale",
            "claude_max",
            "token_dashboard",
            "other",
          ],
          description:
            "which token reader produced the paste (for cross-tool variance tracking)",
        },
      },
      // at least one window paste is required (runtime check backs this up)
      anyOf: [
        { required: ["7d"] },
        { required: ["30d"] },
        { required: ["90d"] },
        { required: ["all"] },
      ],
    },
    outputSchema: {
      type: "object",
      properties: {
        windows: {
          type: "array",
          description: "Cascade results per window",
          items: {
            type: "object",
            properties: {
              window: { type: "string", enum: ["7d", "30d", "90d", "all"] },
              ...CASCADE_OUTPUT.properties,
            },
          },
        },
      },
    },
  },
  {
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
  },
  {
    name: "tokenpull_compare",
    description:
      "Pull token usage from ALL four local sources in parallel — tokenpull (JSONL canon), ccusage CLI, token-dashboard SQLite, and tokscale report — and return them side-by-side with delta % vs tokenpull as the baseline. Also computes the cascade (Υ, SNR, Leverage, class) for each source so you can see how each verifier scores. Useful for validating your numbers before submitting, or understanding discrepancies between tools. Claude only for token-dash; codex and others use tokenpull + ccusage + tokscale. Token-only, on-device.",
    annotations: { title: "Compare token sources", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ALL_PLATFORMS,
          description:
            "platform to compare (default: claude). token-dash and App only available for claude.",
        },
      },
    },
    outputSchema: COMPARE_OUTPUT,
  },
  {
    name: "enroll",
    description:
      'Bind THIS device to your SigRank operator so your signed token runs cascade to the live board. Paste the key from signalaf.com → Settings → "New key" (or "Generate connect code"). On first run it generates + stores a local ed25519 keypair (~/.sigrank-mcp/identity.json); only the PUBLIC key is ever sent. Need a new key? Click "New key" at signalaf.com → Settings, then paste it here.',
    annotations: {
      title: "Enroll device identity",
      ...ANNOTATIONS.destructiveHint,
      ...ANNOTATIONS.idempotentHint,
      ...ANNOTATIONS.openWorldHint,
    },
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "the key / connect code (SIGR-XXXXX-XXXXX-XXXXX) from Settings → New key (or Generate connect code)",
        },
        device_label: {
          type: "string",
          description:
            "optional label for this device (default: hostname · agent version)",
        },
      },
      required: ["code"],
    },
    outputSchema: ENROLL_OUTPUT,
  },
  {
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
  },
  {
    name: "simulate_change",
    description:
      "The first PRESCRIPTIVE SigRank tool — 'what if I changed my token mix?' Takes your current 4 pillars (input/output/cacheCreate/cacheRead) and one or more proposed changes, runs the canonical cascade on BOTH the current and simulated values, and returns the exact Υ Yield delta, class change, and per-metric diffs. This is the 'show me the payoff before I do the work' primitive: no network, no submission, pure local math. Use it to answer 'would increasing my cache-read by 50k tokens actually move my class?' before you change your workflow. Accepts the current pillars as JSON or 4 numbers (same as rank_paste) plus a `changes` object with any of the 4 pillar names mapped to new absolute values OR relative deltas (e.g. {cacheRead: '+50000'} or {input: 800000}).",
    annotations: {
      title: "Simulate metric change",
      ...ANNOTATIONS.readOnlyHint,
      ...ANNOTATIONS.idempotentHint,
      ...ANNOTATIONS.openWorldHint,
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            'Current token pillars — ccusage JSON or "input output cacheCreate cacheRead" (same format as rank_paste).',
        },
        changes: {
          type: "object",
          description:
            "Proposed changes to apply. Keys: input, output, cacheCreate, cacheRead. Values are either absolute numbers (replace) or strings starting with +/- for relative deltas (add/subtract). Omitted pillars are unchanged.",
          properties: {
            input: {
              type: ["number", "string"],
              description:
                'new input token count (absolute) or "+/-N" for a relative delta',
            },
            output: {
              type: ["number", "string"],
              description:
                'new output token count (absolute) or "+/-N" for a relative delta',
            },
            cacheCreate: {
              type: ["number", "string"],
              description:
                'new cache-create token count (absolute) or "+/-N" for a relative delta',
            },
            cacheRead: {
              type: ["number", "string"],
              description:
                'new cache-read token count (absolute) or "+/-N" for a relative delta',
            },
          },
        },
      },
      required: ["text", "changes"],
    },
    outputSchema: SIMULATE_OUTPUT,
  },
  {
    name: "diagnose_cascade",
    description:
      "Analyzes your token cascade and diagnoses where you're leaking efficiency. Takes your 4 pillars (input/output/cacheCreate/cacheRead) and produces a ranked list of efficiency leaks with severity (critical/warning/info), findings, and recommendations. Checks: cache leverage (are you rereading what you wrote?), velocity (are you generating enough output per input?), SNR (is your signal drowning in noise?), cache creation ratio (are you over-committing?), input bloat (is fresh input too high?), and 10xDEV (is the full cascade compounding?). Each finding includes an estimated Υ impact. Pure local math — no network, no submission. Use this BEFORE simulate_change to understand what's wrong, then use simulate_change to test fixes. Accepts the same input formats as rank_paste (JSON or 4 whitespace numbers).",
    annotations: {
      title: "Diagnose cascade breakdown",
      ...ANNOTATIONS.readOnlyHint,
      ...ANNOTATIONS.idempotentHint,
      ...ANNOTATIONS.openWorldHint,
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            'Token pillars — ccusage JSON or "input output cacheCreate cacheRead" (same format as rank_paste).',
        },
      },
      required: ["text"],
    },
    outputSchema: DIAGNOSE_OUTPUT,
  },
  {
    name: "suggest_improvements",
    description:
      "Generates ranked, simulated improvement suggestions for your token cascade. Takes your 4 pillars, tests multiple improvement strategies (increase cache reads, reduce fresh input, increase output, optimize cache creation), simulates each with the canonical cascade engine, and returns them ranked by Υ yield impact. Each suggestion includes: the action, which pillar to change, how much to change it, the projected Υ after the change, the yield delta, the projected class tier, and a rationale. Also returns the single highest-impact change (best_single_change). Pure local math — no network, no submission. Use this after diagnose_cascade to get actionable next steps, then use simulate_change to fine-tune before committing. Accepts the same input formats as rank_paste.",
    annotations: {
      title: "Suggest improvements",
      ...ANNOTATIONS.readOnlyHint,
      ...ANNOTATIONS.idempotentHint,
      ...ANNOTATIONS.openWorldHint,
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            'Token pillars — ccusage JSON or "input output cacheCreate cacheRead" (same format as rank_paste).',
        },
      },
      required: ["text"],
    },
    outputSchema: SUGGEST_OUTPUT,
  },
  {
    name: "self_improve",
    description:
      "Runs the full self-improvement cycle in one call: (1) gets your current token pillars — either from the provided text or by running tokenpull on your local logs, (2) diagnoses where you're leaking efficiency (diagnose_cascade), (3) generates ranked improvement suggestions (suggest_improvements), (4) simulates the top suggestion (simulate_change), and (5) returns the complete cycle: diagnosis + suggestions + the simulated impact of the best change. This is the 'one-click optimize' tool — call it at the end of a session to see what to improve next time. If you provide pillars in `text`, it skips the tokenpull step. If you omit `text`, it runs tokenpull first (requires local ccusage logs). Pure local math — no network, no submission. The `scope` parameter adds mode detection (BUILD/EDIT/DEBUG/MAINTAIN/IDLE) and scoped analysis: 'daily' (default — current behavior + mode), 'weekly' (compound into weekly snapshots + report artifact), 'trend' (30d/90d trajectory analysis).",
    annotations: {
      title: "Self-improve plan",
      ...ANNOTATIONS.readOnlyHint,
      ...ANNOTATIONS.idempotentHint,
      ...ANNOTATIONS.openWorldHint,
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            'Optional: token pillars — ccusage JSON or "input output cacheCreate cacheRead". If omitted, runs tokenpull to get current pillars from local logs.',
        },
        window: {
          type: "string",
          enum: ["7d", "30d", "90d", "all"],
          description:
            "Which time window to pull when running tokenpull (default: 30d). Ignored if `text` is provided.",
        },
        scope: {
          type: "string",
          enum: ["daily", "weekly", "trend"],
          description:
            'Analysis scope: "daily" (default — current behavior + mode detection), "weekly" (compound daily rows into weekly snapshots + report artifact with badges), "trend" (30d/90d trajectory + phase patterns). Daily modes never leave the machine — only weekly distribution goes in submitted reports.',
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        pillars: {
          type: "object",
          description: "The 4 raw token pillars used",
        },
        current_cascade: CASCADE_OUTPUT,
        diagnosis: {
          type: "array",
          description: "Efficiency leaks found (from diagnose_cascade)",
        },
        suggestions: {
          type: "array",
          description: "Ranked improvements (from suggest_improvements)",
        },
        best_simulation: {
          type: "object",
          description: "Simulated result of the top suggestion",
        },
        cycle_summary: {
          type: "string",
          description: "One-line summary of the full cycle",
        },
        // Scope-specific fields
        mode: {
          type: "object",
          description:
            "Detected mode { mode, confidence } — present when scope is daily/weekly/trend",
        },
        quality_score: {
          type: "number",
          description: "Yield relative to mode expectation (daily scope)",
        },
        assessment: {
          type: "string",
          description: "One-line assessment for daily scope",
        },
        advice: {
          type: "string",
          description: "Advice for next session (daily scope)",
        },
        report: {
          type: "object",
          description: "Weekly report artifact (weekly scope)",
        },
        trend: { type: "object", description: "Trend analysis (trend scope)" },
      },
    },
  },
  {
    name: "get_best_operator",
    description:
      "Returns the top N operators on the SigRank leaderboard with behavioral framing in power-user language. Wraps get_leaderboard and adds plain-language interpretation of each top operator's cascade: what their yield, leverage, and velocity mean in terms of AI power-user behavior (cache reuse, input economy, output productivity). Use this when users ask 'who is the best AI user?' or 'who tops the SigRank leaderboard?' or 'show me the AI user leaderboard'. Do NOT use get_leaderboard if you want the raw array without interpretation — use this for the power-user framing. Intent: BEST_OPERATOR.",
    annotations: { title: "Get best operator", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
    inputSchema: {
      type: "object",
      properties: {
        n: {
          type: "integer",
          description:
            "Number of top operators to return (default: 5, max: 20). Returns the top N by yield.",
          minimum: 1,
          maximum: 20,
        },
      },
      description:
        "Optional: how many top operators to return. Defaults to 5.",
    },
    outputSchema: BEST_OPERATOR_OUTPUT,
  },
  {
    name: "compare_self",
    description:
      "Compares an operator's metrics against board averages and power-user archetypes, returning a behavioral assessment. Accepts either a codename (fetches from the board) or raw token pillars (computes locally). Returns: your yield/leverage/velocity/class/rank, a power-user assessment mapping your class tier to AI power-user language, comparison vs board averages (your percentile), and one actionable suggestion to improve. Use this when users ask 'how do I measure up to other AI users?' or 'am I a power user?' or 'compare me to others'. Intent: COMPARE_SELF.",
    annotations: { title: "Compare self to board", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
    inputSchema: {
      type: "object",
      properties: {
        codename: {
          type: "string",
          description:
            "Your codename on the SigRank leaderboard. If provided, fetches your live profile from the board. Case-insensitive.",
        },
        text: {
          type: "string",
          description:
            'Alternative: raw token pillars to score locally (ccusage JSON or "input output cacheCreate cacheRead"). Use this if you are not on the board yet but want to see how you would compare.',
        },
      },
      description:
        "Provide either `codename` (to fetch from the board) or `text` (to score locally). At least one is required.",
    },
    outputSchema: COMPARE_SELF_OUTPUT,
  },
  {
    name: "compare_operators",
    description:
      "Compares two operators side-by-side with a behavioral verdict. Fetches both profiles from the board and returns their yield, leverage, velocity, class, and rank side-by-side, plus a verdict explaining who is more efficient and why in power-user language. Use this when users ask 'compare operator X vs Y' or 'who is more efficient' or 'how do two AI users compare'. Intent: COMPARE_OPERATORS.",
    annotations: { title: "Compare two operators", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
    inputSchema: {
      type: "object",
      properties: {
        codename_a: {
          type: "string",
          description:
            "First operator's codename from the SigRank leaderboard. Case-insensitive.",
        },
        codename_b: {
          type: "string",
          description:
            "Second operator's codename from the SigRank leaderboard. Case-insensitive.",
        },
      },
      required: ["codename_a", "codename_b"],
      description:
        "Requires both codenames. Both must exist on the board.",
    },
    outputSchema: COMPARE_OPERATORS_OUTPUT,
  },
  {
    name: "describe_power_user",
    description:
      "Returns an explanatory description of what makes an AI power user, anchored in SigRank's metrics and operator classes. Explains the yield metric, leverage, velocity, and how class tiers (Burner/Builder/10xer) map to power-user behavior patterns. Use this when users ask 'what is an AI power user?' or 'what makes a good AI user?' or 'describe advanced AI user behavior'. Intent: DESCRIBE_POWER_USER (Informational).",
    annotations: { title: "Describe power user", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.idempotentHint },
    inputSchema: {
      type: "object",
      properties: {},
      description:
        "This tool takes no parameters. It returns a static explanatory response about AI power users.",
    },
    outputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What is an AI power user" },
        metrics_explained: {
          type: "object",
          description: "How SigRank metrics map to power-user behavior",
          properties: {
            yield_: { type: "string", description: "What yield measures in power-user terms" },
            leverage: { type: "string", description: "What leverage means for power users" },
            velocity: { type: "string", description: "What velocity means for power users" },
          },
        },
        class_tiers: {
          type: "array",
          description: "Operator class tiers and their power-user meaning",
          items: {
            type: "object",
            properties: {
              class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
              meaning: { type: "string" },
            },
          },
        },
        link: { type: "string", description: "URL to learn more" },
      },
    },
  },
  {
    name: "optimize_efficiency",
    description:
      "Returns actionable suggestions for improving your token cascade efficiency, tied to your current metrics. Accepts either a codename (fetches from board) or raw token pillars (computes locally). Returns: your current metrics, ranked efficiency suggestions tied to cascade shape (increase cache reuse, reduce input, increase output), and references to power-user practices. Use this when users ask 'how can I use AI more efficiently?' or 'reduce token burn' or 'optimize token usage' or 'stop tokenmaxxing'. Intent: OPTIMIZE_EFFICIENCY (Informational + Transactional).",
    annotations: { title: "Optimize efficiency", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.idempotentHint },
    inputSchema: {
      type: "object",
      properties: {
        codename: {
          type: "string",
          description:
            "Your codename on the SigRank leaderboard. If provided, fetches your live profile from the board.",
        },
        text: {
          type: "string",
          description:
            'Alternative: raw token pillars to score locally (ccusage JSON or "input output cacheCreate cacheRead"). Use this if you are not on the board yet.',
        },
      },
      description:
        "Provide either `codename` (to fetch from the board) or `text` (to score locally). At least one is required.",
    },
    outputSchema: {
      type: "object",
      properties: {
        your_metrics: {
          type: "object",
          description: "Your current cascade metrics",
          properties: {
            yield_: { type: "number" },
            leverage: { type: "number" },
            velocity: { type: "number" },
            class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
          },
        },
        suggestions: {
          type: "array",
          description: "Ranked efficiency suggestions",
          items: {
            type: "object",
            properties: {
              action: { type: "string", description: "What to change" },
              why: { type: "string", description: "Why this helps your yield" },
              power_user_practice: { type: "string", description: "The power-user practice this maps to" },
            },
          },
        },
        summary: { type: "string", description: "One-line summary of your efficiency status" },
      },
    },
  },
];

// tokenpull window key → the board's window_type enum.
const WINDOW_TYPE = { "7d": "7d", "30d": "30d", "90d": "90d", all: "all_time" };

// E3: client-side auto-submit cooldown for watch_tokenpull. The server already dedups
// identical snapshots (exact hash → 422), but a noisy poll loop with submit:true could still
// churn the network/board with near-identical rows. Cap auto-submit to once per WATCH_SUBMIT_COOLDOWN_MS
// per platform+window (in-memory, per process). Keyed by platform:window so different
// platforms/windows don't block each other, and only armed on a non-error submit so a
// network failure doesn't lock out retries for 5 minutes.
const WATCH_SUBMIT_COOLDOWN_MS = 5 * 60 * 1000;
const _lastWatchSubmitAt = new Map();

// ── Shared active-platform loader ───────────────────────────────────────────
// THE single data path for "show my cascade across platforms" — used by `me`,
// `watch`, and the TUI Dashboard so they can't drift apart again. Pulls each
// target platform via the tokenpull tool (enriched: pillars + cascade + card),
// keeps only platforms with real local data, and sorts claude → codex → rest.
// Pass `platforms` to scope it (e.g. ['claude'] for a fast first paint).
export async function pullActivePlatforms({ platforms } = {}, opts = {}) {
  // If the caller specified explicit platforms, use those.
  if (platforms && platforms.length) {
    return _pullExplicit(platforms, opts);
  }
  // Auto-detect: run tokscale once to discover all active clients, then pull
  // only those. This is much faster than trying all 17 adapters (most fail
  // silently on a machine that doesn't have that tool installed).
  //
  // Flow: tokscale surfaces ALL clients → map to our platform names →
  // ccusage is primary for Claude (more accurate) → other platforms use
  // their adapters. Anything in tokscale NOT in ccusage gets included.
  const detected = await _tokscaleDetectClients().catch(() => null);
  if (detected && detected.length > 0) {
    return _pullExplicit(detected, opts);
  }
  // Fallback: tokscale not installed or failed → try all adapters (old behavior)
  return _pullExplicit(ALL_PLATFORMS, opts);
}

/** Run `tokscale models --json` and return the list of our platform names. */
async function _tokscaleDetectClients() {
  const raw = await execFileAsync("tokscale", ["models", "--json"], 60000);
  const data = JSON.parse(raw);
  const entries = Array.isArray(data?.entries)
    ? data.entries
    : Array.isArray(data)
      ? data
      : [];
  if (!entries.length) return [];
  // Map tokscale client names → our platform names
  const TOKSCALE_CLIENT_MAP = {
    claude: "claude",
    "devin-cli": "devin",
    codex: "codex",
    copilot: "copilot",
    gemini: "gemini",
    amp: "amp",
    kimi: "kimi",
    qwen: "qwen",
    goose: "goose",
    kilo: "kilo",
    hermes: "hermes",
    droid: "droid",
    codebuff: "codebuff",
    opencode: "opencode",
    openclaw: "openclaw",
    pi: "pi",
    cline: "other", // no native adapter yet
    "antigravity-cli": "other", // no native adapter yet
  };
  const clients = new Set();
  for (const e of entries) {
    if (!e || !e.client) continue;
    if (e.model === "<synthetic>" || e.model === "unknown") continue;
    const input = Number(e.input) || 0;
    const output = Number(e.output) || 0;
    if (input + output === 0) continue;
    const platform = TOKSCALE_CLIENT_MAP[e.client] || "other";
    clients.add(platform);
  }
  return [...clients];
}

/** Pull a specific set of platforms in parallel, filter to active ones. */
async function _pullExplicit(platforms, opts = {}) {
  const settled = await Promise.allSettled(
    platforms.map((p) => callTool("tokenpull", { platform: p }, opts)),
  );
  const active = settled
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .filter((d) =>
      (d.windows || []).some(
        (w) => (w.pillars?.input ?? 0) + (w.pillars?.output ?? 0) > 0,
      ),
    );
  const rank = (p) =>
    p === "claude" ? -2 : p === "codex" ? -1 : ALL_PLATFORMS.indexOf(p);
  active.sort((a, b) => rank(a.platform) - rank(b.platform));
  return active;
}

export async function callTool(name, args, opts = {}) {
  const apiBase = opts.apiBase || DEFAULT_API_BASE;
  const timeoutMs = opts.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT;
  const rawFetch = opts.fetchImpl || fetch;

  // Wrap every fetch with an AbortController timeout so a hung network call never
  // blocks the MCP client indefinitely. Vercel's bot protection (security
  // checkpoint) blocks Node's fetch via TLS fingerprinting — no UA fix helps.
  // When fetch gets a 403 Vercel challenge, fall back to curl (which passes).
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
        if (text.includes("Vercel Security Checkpoint") || text.includes("x-vercel-challenge")) {
          // Fall back to curl transport
          return curlFetch(url, init, timeoutMs);
        }
        // Real 403 from the API — return a mock response object
        return {
          ok: false,
          status: 403,
          json: async () => { try { return JSON.parse(text); } catch { return {}; } },
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

  // Helper: attach _parseWarnings from pillars onto the cascade result so they
  // are always visible in the tool output for review.
  const withParseWarnings = (pillars, cascadeResult) => {
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
  };

  if (name === "rank_paste") {
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
  if (name === "get_leaderboard") {
    const params = new URLSearchParams({ metric: "yield_" });
    if (args?.limit) params.set("limit", String(args.limit));
    if (args?.window) params.set("window", args.window);
    return fetchJson(`/api/v1/leaderboard?${params}`);
  }
  if (name === "get_operator") {
    const codename = String(args?.codename || "").trim();
    if (!codename)
      throw new Error("get_operator requires a non-empty `codename` argument.");
    return fetchJson(`/api/v1/operators/${encodeURIComponent(codename)}`);
  }

  if (name === "enroll") {
    // Redeem a web connect code → bind this device. Generates/loads the local keypair;
    // sends ONLY the public key. operator binding happens server-side from the code row.
    const code = String(args?.code || "").trim();
    if (!code)
      throw new Error(
        "enroll requires a `code` — paste your connect code from signalaf.com → Settings → Connect a device.",
      );
    const id = opts.identity || ensureIdentity();
    const deviceLabel = String(
      args?.device_label || `${os.hostname()} · ${id.agent_version}`,
    ).slice(0, 120);
    const res = await doFetch(`${apiBase}/api/v1/devices/enroll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        code,
        device_id: id.device_id,
        public_key: id.public_key,
        device_label: deviceLabel,
        agent_version: id.agent_version,
      }),
    });
    let ack;
    try {
      ack = await res.json();
    } catch {
      ack = {};
    }
    if (res.status === 201 && ack.status === "enrolled") {
      // Persist the binding locally (skipped when a test injects opts.identity → no keystore write).
      if (!opts.identity)
        recordEnrollment({
          codename: ack.codename,
          operator_id: ack.operator_id,
        });
      return {
        status: "enrolled",
        codename: ack.codename ?? null,
        operator_id: ack.operator_id ?? null,
        device_id: id.device_id,
        trust_status: ack.trust_status ?? "trusted",
      };
    }
    // Recovery: if the server says device_already_enrolled but includes the
    // codename/operator_id, the device IS bound server-side — record it locally
    // and return enrolled instead of erroring. This handles the case where the
    // local binding was lost (partial write, version transition) but the device
    // is still enrolled server-side.
    if (
      ack.reason === "device_already_enrolled" &&
      ack.codename &&
      ack.operator_id
    ) {
      if (!opts.identity)
        recordEnrollment({
          codename: ack.codename,
          operator_id: ack.operator_id,
        });
      return {
        status: "enrolled",
        codename: ack.codename,
        operator_id: ack.operator_id,
        device_id: id.device_id,
        trust_status: ack.trust_status ?? "trusted",
        recovered: true,
      };
    }
    return {
      status: "error",
      httpStatus: res.status,
      reason: ack.reason || ack.status || `http_${res.status}`,
      detail: ack.detail ?? null,
    };
  }

  if (name === "submit_verified") {
    // The enrolled, signed publish path → /api/v1/snapshots (only verified rows rank).
    const id = opts.identity || ensureIdentity();
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
        const r = await pullByPlatform(p, opts).catch(() => null);
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
          apiBase,
          fetchImpl: doFetch,
          platform: "multi",
          now: opts.now,
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

    const pulled = await pullByPlatform(platform, opts);
    const targets = args?.window
      ? pulled.windows.filter((w) => w.window === args.window)
      : pulled.windows;
    const out = [];
    for (const w of targets) {
      // Compute the cascade report block (mode + badges + health) for this window.
      // Pure math, computed locally, submitted alongside the 4 token pillars.
      const report = _computeReportBlock(w.pillars);
      const r = await submitSignedWindow(w.window, w.pillars, w.messages, id, {
        apiBase,
        fetchImpl: doFetch,
        platform: pulled.platform,
        now: opts.now,
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

  if (name === "submit_paste") {
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

    // Submit the RAW paste so the server re-parses + re-scores authoritatively — the
    // MCP's local cascade is only a preview; the board stays the single source of truth.
    const stamp = uploadStamp({
      codename,
      pillars: c.pillars,
      source: "web_paste",
    });
    const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        codename,
        raw_paste: String(args?.text || ""),
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
    const ranked = !!(
      res.ok &&
      ack.verification_tier === "verified" &&
      ack.persisted === true
    );
    return {
      ...c,
      card,
      ranked,
      submission: { ...stamp, httpStatus: res.status, ranked, ...ack },
    };
  }

  if (name === "tokenpull") {
    // Local read → 4 windows of pillars → cascade each. Token-only, on-device.
    const platform = args?.platform || "claude";

    // MULTI: sum every locally-detected platform's pillars per window. Same logic as
    // submit_verified's multi flow — Devin (cloud, via tokscale) is included.
    if (platform === "multi") {
      const detected = [];
      for (const p of ALL_PLATFORMS) {
        const r = await pullByPlatform(p, opts).catch(() => null);
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

    const pulled = await pullByPlatform(platform, opts);
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

  if (name === "tokenpull_submit") {
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
        const r = await pullByPlatform(p, opts).catch(() => null);
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
        const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
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

    const pulled = await pullByPlatform(platform, opts);
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
      const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
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
      // with submit_verified (submit.mjs). An unenrolled/revoked device gets 202 but is NEVER ranked.
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

  if (name === "rank_windows") {
    // Score up to 4 named window pastes independently. Named-key parsing only —
    // positional is unsafe here because dashboards list cache_read before cache_create
    // (the WINDOWED_PROFILES swap gotcha). Each window goes through parsePillars →
    // cascade → narrate individually; results are collected into a windows[] array
    // in the same shape as tokenpull output for easy follow-up with tokenpull_submit.
    const WINDOW_KEYS = ["7d", "30d", "90d", "all"];
    const sourceTool = args?.source_tool || null;
    // E2: reject any oversized window paste up front (token tables are tiny).
    for (const wk of WINDOW_KEYS) {
      const v = args?.[wk];
      if (typeof v === "string" && v.length > MAX_INPUT) {
        return {
          status: "error",
          reason: "input_too_large",
          detail: `window '${wk}' exceeds ${MAX_INPUT} chars (${v.length}). Paste only the token-count table.`,
        };
      }
    }
    const windows = [];
    for (const wk of WINDOW_KEYS) {
      const text = args?.[wk];
      if (!text || typeof text !== "string" || !text.trim()) continue;
      const pillars = parsePillars(text);
      const c = withParseWarnings(pillars, cascade(pillars));
      const card = narrate(c, `${wk} window`);
      windows.push({ window: wk, pillars, cascade: c, card });
    }
    if (windows.length === 0) {
      throw new Error(
        "rank_windows requires at least one window paste (7d, 30d, 90d, or all).",
      );
    }
    return {
      windows,
      source_tool: sourceTool,
      note: "Local preview only — use tokenpull_submit to publish to the board.",
    };
  }

  if (name === "watch_tokenpull") {
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

    const pulled = await pullByPlatform(platform, opts);
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
      const id = opts.identity || ensureIdentity();
      if (id.codename && id.operator_id && id.private_key_pkcs8_b64) {
        // E3: client-side cooldown — at most one auto-submit per platform+window per 5 min.
        // Prevents a fast poll loop from churning the board even before the server's
        // hash-dedup kicks in. Armed only on a non-error outcome so failed submits retry.
        const clockNow = typeof opts.now === "number" ? opts.now : Date.now();
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
              apiBase,
              fetchImpl: doFetch,
              platform: pulled.platform,
              now: opts.now,
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

  if (name === "tokenpull_compare") {
    const platform = args?.platform || "claude";
    const WINS = ["7d", "30d", "90d", "all"];

    // Pull all four sources in parallel (verifiers are now async via execFile)
    const [tpResult, ccPillars, tdPillars, tsPillars] = await Promise.all([
      pullByPlatform(platform, opts).catch(() => null),
      _ccusagePillars(platform).catch(() => null),
      (platform === "claude"
        ? _tokenDashPillars()
        : Promise.resolve(null)
      ).catch(() => null),
      _tokscalePillars(platform).catch(() => null),
    ]);

    // Build tokenpull window lookup
    const tpByWin = {};
    for (const w of tpResult?.windows ?? []) tpByWin[w.window] = w.pillars;

    // Helper: delta % vs tokenpull baseline
    const delta = (val, base) =>
      base > 0 ? +(((val - base) / base) * 100).toFixed(1) : null;

    // Build per-source per-window comparison
    const SOURCES = [
      {
        source: "tokenpull",
        note: "JSONL deduped by msg id — canon source",
        byWin: tpByWin,
      },
      {
        source: "ccusage",
        note: "ccusage CLI — monthly only",
        byWin: ccPillars ?? {},
      },
      {
        source: "token-dash",
        note: "token-dashboard SQLite — all-time only",
        byWin: tdPillars ?? {},
      },
      {
        source: "tokscale",
        note: "tokscale_report.json — all-time only",
        byWin: tsPillars ?? {},
      },
    ];

    const comparison = {};
    for (const win of WINS) {
      const baseP = tpByWin[win];
      comparison[win] = SOURCES.filter((s) => s.byWin[win] != null).map((s) => {
        const p = s.byWin[win];
        const cas = cascade(p);
        const entry = {
          source: s.source,
          note: s.note,
          pillars: p,
          cascade: {
            yield: cas.yield,
            snr: cas.snr,
            leverage: cas.leverage,
            velocity: cas.velocity,
            dev10x: cas.dev10x,
            class: cas.class,
          },
        };
        if (s.source !== "tokenpull" && baseP) {
          entry.delta_vs_tokenpull = {
            input: delta(p.input, baseP.input),
            output: delta(p.output, baseP.output),
            cacheCreate: delta(p.cacheCreate, baseP.cacheCreate),
            cacheRead: delta(p.cacheRead, baseP.cacheRead),
          };
        }
        return entry;
      });
    }

    // Sources available summary
    const available = SOURCES.filter(
      (s) => Object.keys(s.byWin).length > 0,
    ).map((s) => s.source);

    return {
      platform,
      estimated: tpResult?.estimated ?? false,
      generatedAt: tpResult?.generatedAt ?? new Date().toISOString(),
      sources_available: available,
      sources_missing: SOURCES.map((s) => s.source).filter(
        (s) => !available.includes(s),
      ),
      comparison,
    };
  }

  if (name === "simulate_change") {
    // The first prescriptive tool — "what if I changed my token mix?"
    // Pure local math: parse current pillars, apply proposed changes, run the
    // cascade on both, return the delta. No network, no submission.
    if (!args?.text)
      throw new Error(
        "simulate_change requires a non-empty `text` argument (current pillars).",
      );
    if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
      return {
        status: "error",
        reason: "input_too_large",
        detail: `text exceeds ${MAX_INPUT} chars.`,
      };
    }
    if (!args?.changes || typeof args.changes !== "object") {
      throw new Error(
        "simulate_change requires a `changes` object with at least one pillar change.",
      );
    }

    const currentPillars = parsePillars(args.text);
    const current = withParseWarnings(currentPillars, cascade(currentPillars));

    // Apply changes: each pillar is either an absolute number (replace) or a
    // string starting with +/- (relative delta). Omitted pillars are unchanged.
    const PILLAR_KEYS = ["input", "output", "cacheCreate", "cacheRead"];
    const simulated = { ...currentPillars };
    const appliedChanges = {};

    for (const key of PILLAR_KEYS) {
      if (args.changes[key] == null) continue;
      const raw = args.changes[key];
      let newVal;

      if (typeof raw === "number") {
        newVal = raw;
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
          // Relative delta: add/subtract from current value
          const delta = Number(trimmed);
          if (!Number.isFinite(delta)) {
            return {
              status: "error",
              reason: "invalid_change",
              detail: `changes.${key}: "${raw}" is not a valid relative delta.`,
            };
          }
          newVal = currentPillars[key] + delta;
        } else {
          // Absolute value as a string
          newVal = Number(trimmed);
        }
      } else {
        return {
          status: "error",
          reason: "invalid_change",
          detail: `changes.${key}: expected number or string, got ${typeof raw}.`,
        };
      }

      if (!Number.isFinite(newVal)) {
        return {
          status: "error",
          reason: "invalid_change",
          detail: `changes.${key}: result is not a finite number.`,
        };
      }
      // Clamp to non-negative — token counts can't be negative
      if (newVal < 0) {
        return {
          status: "error",
          reason: "invalid_change",
          detail: `changes.${key}: result ${newVal} is negative — token counts must be >= 0.`,
        };
      }

      simulated[key] = newVal;
      appliedChanges[key] = {
        from: currentPillars[key],
        to: newVal,
        delta: newVal - currentPillars[key],
      };
    }

    if (Object.keys(appliedChanges).length === 0) {
      return {
        status: "error",
        reason: "no_changes",
        detail: "No pillar changes specified in the `changes` object.",
      };
    }

    const simulatedResult = cascade(simulated);

    // Compute deltas for every cascade metric
    const metricDelta = (curr, sim) => {
      if (curr == null && sim == null) return null;
      if (curr == null) return { from: null, to: sim, delta: null };
      if (sim == null) return { from: curr, to: null, delta: null };
      return { from: curr, to: sim, delta: Number((sim - curr).toFixed(4)) };
    };

    const classChanged = current.class !== simulatedResult.class;

    return {
      current: {
        pillars: currentPillars,
        yield: current.yield,
        snr: current.snr,
        leverage: current.leverage,
        velocity: current.velocity,
        dev10x: current.dev10x,
        class: current.class,
      },
      simulated: {
        pillars: {
          input: simulated.input,
          output: simulated.output,
          cacheCreate: simulated.cacheCreate,
          cacheRead: simulated.cacheRead,
        },
        yield: simulatedResult.yield,
        snr: simulatedResult.snr,
        leverage: simulatedResult.leverage,
        velocity: simulatedResult.velocity,
        dev10x: simulatedResult.dev10x,
        class: simulatedResult.class,
      },
      changes: appliedChanges,
      deltas: {
        yield: metricDelta(current.yield, simulatedResult.yield),
        snr: metricDelta(current.snr, simulatedResult.snr),
        leverage: metricDelta(current.leverage, simulatedResult.leverage),
        velocity: metricDelta(current.velocity, simulatedResult.velocity),
        dev10x: metricDelta(current.dev10x, simulatedResult.dev10x),
      },
      class_changed: classChanged,
      ...(classChanged
        ? { class_transition: `${current.class} → ${simulatedResult.class}` }
        : {}),
      ...(simulatedResult.warnings
        ? { simulated_warnings: simulatedResult.warnings }
        : {}),
      note: "Local simulation only — no submission. The actual score depends on server-side RS.xx weights and class thresholds.",
    };
  }

  if (name === "diagnose_cascade") {
    if (!args?.text)
      throw new Error(
        "diagnose_cascade requires a non-empty `text` argument (token pillars).",
      );
    if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
      return {
        status: "error",
        reason: "input_too_large",
        detail: `text exceeds ${MAX_INPUT} chars.`,
      };
    }

    const p = parsePillars(args.text);
    const result = withParseWarnings(p, cascade(p));
    const { input: i, output: o, cacheCreate: cw, cacheRead: cr } = p;
    const diagnosis = [];

    // Cache leverage check — the #1 cascade efficiency signal
    const leverage = result.leverage;
    if (leverage !== null) {
      if (leverage < 10) {
        diagnosis.push({
          metric: "cache_leverage",
          severity: "critical",
          finding: `Cache leverage is ${leverage}× — you're reading only ${leverage}× your fresh input from cache. TRANSMITTER-class operators hit 200×+.`,
          recommendation:
            "Increase context reuse: load prior session context, use longer conversation threads, reference earlier outputs.",
          estimated_yield_impact: `+${Math.round((1 - leverage / 50) * 100)}% Υ potential`,
        });
      } else if (leverage < 50) {
        diagnosis.push({
          metric: "cache_leverage",
          severity: "warning",
          finding: `Cache leverage is ${leverage}× — decent but below the ARCH+ threshold (~100×+).`,
          recommendation:
            "Push cache reads higher by reusing prior context more aggressively.",
          estimated_yield_impact: `+${Math.round((1 - leverage / 100) * 50)}% Υ potential`,
        });
      }
    }

    // Velocity check — output per input
    const velocity = result.velocity;
    if (velocity !== null) {
      if (velocity < 0.5) {
        diagnosis.push({
          metric: "velocity",
          severity: "critical",
          finding: `Velocity is ${velocity} — generating only ${velocity}× your input as output. You're reading more than you produce.`,
          recommendation:
            "Increase output: ask the agent to generate more code/text per turn, reduce over-reading.",
          estimated_yield_impact: `+${Math.round((0.5 - velocity) * 100)}% Υ per 0.1 velocity gain`,
        });
      } else if (velocity < 1.0) {
        diagnosis.push({
          metric: "velocity",
          severity: "warning",
          finding: `Velocity is ${velocity} — below 1.0 (output < input). Healthy operators hit 1.5×+.`,
          recommendation:
            "Generate more output per input token — larger edits, more complete responses.",
          estimated_yield_impact: `+${Math.round((1 - velocity) * 30)}% Υ potential`,
        });
      }
    }

    // SNR check — signal-to-noise
    const snr = result.snr;
    if (snr !== null && snr < 0.3) {
      diagnosis.push({
        metric: "snr",
        severity: "warning",
        finding: `SNR is ${snr} — less than 30% of your token flow is output. Input is dominating.`,
        recommendation:
          "Reduce fresh input (reuse context) or increase output generation.",
        estimated_yield_impact:
          "Indirect — improves both velocity and leverage",
      });
    }

    // Cache creation ratio — are you over-committing?
    if (cw > 0 && o > 0) {
      const commitRatio = cw / o;
      if (commitRatio > 20) {
        diagnosis.push({
          metric: "cache_creation",
          severity: "info",
          finding: `Cache creation is ${commitRatio.toFixed(1)}× your output — high commitment. This is fine if you're rereading it (check leverage), but wasteful if not.`,
          recommendation:
            "Ensure you're rereading committed context. If leverage is low, you're writing cache you never read.",
          estimated_yield_impact: "Cost reduction, not Υ directly",
        });
      }
    }

    // Input bloat — is fresh input too high relative to total?
    const total = i + o + cw + cr;
    if (total > 0) {
      const inputPct = (i / total) * 100;
      if (inputPct > 10) {
        diagnosis.push({
          metric: "input_bloat",
          severity: "warning",
          finding: `Fresh input is ${inputPct.toFixed(1)}% of your total token flow — high. Efficient operators keep input under 1% by leaning on cache.`,
          recommendation:
            "Reduce fresh input by reusing prior context instead of re-pasting it.",
          estimated_yield_impact: `+${Math.round((inputPct - 1) * 5)}% Υ potential`,
        });
      }
    }

    // 10xDEV check — is the full cascade compounding?
    if (result.dev10x === null && cw === 0) {
      diagnosis.push({
        metric: "10xdev",
        severity: "critical",
        finding:
          "No cache creation — the cascade cannot compound. You're operating in a non-compounding mode (like ChatGPT without prompt caching).",
        recommendation:
          "Switch to a platform with prompt caching (Claude Code) or enable caching if available.",
        estimated_yield_impact: "Enables the full cascade — potentially 10×+ Υ",
      });
    } else if (result.dev10x !== null && result.dev10x < 1.0) {
      diagnosis.push({
        metric: "10xdev",
        severity: "info",
        finding: `10xDEV is ${result.dev10x} — below 1.0 (BASE threshold). The cascade is compounding but not strongly.`,
        recommendation:
          "Improve both leverage AND velocity — 10xDEV = log10(transmission × commitment × reuse).",
        estimated_yield_impact: "Class tier improvement",
      });
    }

    // Sort by severity (critical > warning > info)
    const sevOrder = { critical: 0, warning: 1, info: 2 };
    diagnosis.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

    const healthScore = diagnosis.filter(
      (d) => d.severity === "critical",
    ).length;
    const summary =
      healthScore === 0
        ? `Cascade is healthy — Υ ${result.yield}, class ${result.class}. ${diagnosis.length} minor optimizations available.`
        : `Cascade has ${healthScore} critical leak${healthScore > 1 ? "s" : ""} — Υ ${result.yield}, class ${result.class}. Fix the critical items first.`;

    return {
      pillars: p,
      cascade: {
        yield_: result.yield,
        snr: result.snr,
        leverage: result.leverage,
        velocity: result.velocity,
        tenx_dev: result.dev10x,
        class: result.class,
        warnings: result.warnings,
      },
      diagnosis,
      summary,
    };
  }

  if (name === "suggest_improvements") {
    if (!args?.text)
      throw new Error(
        "suggest_improvements requires a non-empty `text` argument (token pillars).",
      );
    if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
      return {
        status: "error",
        reason: "input_too_large",
        detail: `text exceeds ${MAX_INPUT} chars.`,
      };
    }

    const p = parsePillars(args.text);
    const current = withParseWarnings(p, cascade(p));
    const { input: i, output: o, cacheCreate: cw, cacheRead: cr } = p;

    // Generate candidate improvements, simulate each, rank by Υ impact
    const candidates = [];

    // Strategy 1: Increase cache reads (the #1 lever)
    const crBoosts = cr > 0 ? [1.5, 2, 3, 5] : [];
    for (const mult of crBoosts) {
      const sim = cascade({ ...p, cacheRead: Math.round(cr * mult) });
      if (sim.yield !== null) {
        candidates.push({
          action: `Increase cache reads by ${Math.round((mult - 1) * 100)}%`,
          pillar: "cacheRead",
          delta: `+${Math.round(cr * (mult - 1)).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
          class_after: sim.class,
          rationale:
            "Cache reads are the strongest Υ multiplier. More reuse = higher leverage = higher yield.",
        });
      }
    }
    // For zero-cache operators, suggest enabling caching with a starter amount
    if (cr === 0 && cw === 0) {
      const starterAmounts = [
        Math.round(i * 10),
        Math.round(i * 50),
        Math.round(i * 100),
      ];
      for (const amt of starterAmounts) {
        const sim = cascade({
          ...p,
          cacheCreate: Math.round(amt * 0.5),
          cacheRead: amt,
        });
        if (sim.yield !== null && sim.yield > 0) {
          candidates.push({
            action: `Enable caching with ${amt.toLocaleString()} cache reads`,
            pillar: "cacheRead",
            delta: `+${amt.toLocaleString()}`,
            simulated_yield: sim.yield,
            yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
            class_after: sim.class,
            rationale:
              "You have no cache — enabling it unlocks the cascade. Start by reusing prior context.",
          });
        }
      }
    }

    // Strategy 2: Reduce fresh input (Υ = Cr·O/I² — input is squared in the denominator)
    const inputReductions = [0.9, 0.75, 0.5];
    for (const mult of inputReductions) {
      const newInput = Math.round(i * mult);
      if (newInput < 1) continue;
      const sim = cascade({ ...p, input: newInput });
      if (sim.yield !== null) {
        candidates.push({
          action: `Reduce fresh input by ${Math.round((1 - mult) * 100)}%`,
          pillar: "input",
          delta: `-${Math.round(i * (1 - mult)).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
          class_after: sim.class,
          rationale:
            "Input is squared in the Υ denominator (Υ = Cr·O/I²). Reducing input has a quadratic payoff.",
        });
      }
    }

    // Strategy 3: Increase output
    const outputBoosts = [1.25, 1.5, 2];
    for (const mult of outputBoosts) {
      const sim = cascade({ ...p, output: Math.round(o * mult) });
      if (sim.yield !== null) {
        candidates.push({
          action: `Increase output by ${Math.round((mult - 1) * 100)}%`,
          pillar: "output",
          delta: `+${Math.round(o * (mult - 1)).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
          class_after: sim.class,
          rationale:
            "Output is a linear multiplier in Υ. More output per session = higher yield.",
        });
      }
    }

    // Strategy 4: Optimize cache creation (reduce if over-committing)
    if (cw > o * 10) {
      const sim = cascade({ ...p, cacheCreate: Math.round(o * 5) });
      if (sim.yield !== null) {
        candidates.push({
          action: "Reduce cache creation to 5× output",
          pillar: "cacheCreate",
          delta: `-${Math.round(cw - o * 5).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number((sim.yield - (current.yield ?? 0)).toFixed(2)),
          class_after: sim.class,
          rationale:
            "You're over-committing cache (cw >> output). Trimming to a healthy ratio reduces cost without hurting yield.",
        });
      }
    }

    // Sort by yield_delta descending, take top 8
    candidates.sort((a, b) => b.yield_delta - a.yield_delta);
    const top = candidates
      .slice(0, 8)
      .map((c, idx) => ({ rank: idx + 1, ...c }));

    const best = top[0];
    return {
      suggestions: top,
      current_yield: current.yield,
      current_class: current.class,
      best_single_change: best
        ? `${best.action} (Υ ${current.yield} → ${best.simulated_yield}, +${best.yield_delta} yield, class ${best.class_after})`
        : "No improvements found — your cascade is already optimized.",
    };
  }

  if (name === "self_improve") {
    // The full self-improvement cycle: pull → diagnose → suggest → simulate.
    // If text is provided, use it as pillars. If not, run tokenpull first.
    let pillars;
    let pulledFrom = "provided";

    if (args?.text) {
      if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
        return {
          status: "error",
          reason: "input_too_large",
          detail: `text exceeds ${MAX_INPUT} chars.`,
        };
      }
      pillars = parsePillars(args.text);
    } else {
      // Run tokenpull to get current pillars from local logs
      const windowType = args?.window || "30d";
      try {
        const pullResult = await callTool(
          "tokenpull",
          { window: windowType },
          opts,
        );
        if (pullResult?.status === "error" || !pullResult?.windows?.length) {
          return {
            status: "error",
            reason: "tokenpull_failed",
            detail:
              "Could not pull pillars from local logs. Provide pillars via `text` argument instead.",
            pull_result: pullResult,
          };
        }
        // Use the first window's pillars
        const w = pullResult.windows[0];
        pillars = w.pillars;
        pulledFrom = `tokenpull ${w.window || windowType}`;
      } catch (e) {
        return {
          status: "error",
          reason: "tokenpull_error",
          detail: String(e.message || e),
          hint: "Provide pillars via `text` argument instead.",
        };
      }
    }

    const currentResult = withParseWarnings(pillars, cascade(pillars));
    const { input: i, output: o, cacheCreate: cw, cacheRead: cr } = pillars;

    // ── Step 1: Diagnose ──────────────────────────────────────────────
    const diagnosis = [];
    const leverage = currentResult.leverage;
    if (leverage !== null && leverage < 10) {
      diagnosis.push({
        metric: "cache_leverage",
        severity: "critical",
        finding: `Cache leverage is ${leverage}× — TRANSMITTER-class operators hit 200×+.`,
        recommendation:
          "Increase context reuse: load prior session context, use longer threads.",
      });
    } else if (leverage !== null && leverage < 50) {
      diagnosis.push({
        metric: "cache_leverage",
        severity: "warning",
        finding: `Cache leverage is ${leverage}× — below ARCH+ threshold (~100×+).`,
        recommendation: "Push cache reads higher by reusing prior context.",
      });
    }

    const velocity = currentResult.velocity;
    if (velocity !== null && velocity < 0.5) {
      diagnosis.push({
        metric: "velocity",
        severity: "critical",
        finding: `Velocity is ${velocity} — generating only ${velocity}× input as output.`,
        recommendation: "Increase output per turn, reduce over-reading.",
      });
    } else if (velocity !== null && velocity < 1.0) {
      diagnosis.push({
        metric: "velocity",
        severity: "warning",
        finding: `Velocity is ${velocity} — below 1.0. Healthy operators hit 1.5×+.`,
        recommendation: "Generate more output per input token.",
      });
    }

    if (currentResult.dev10x === null && cw === 0) {
      diagnosis.push({
        metric: "10xdev",
        severity: "critical",
        finding: "No cache creation — cascade cannot compound.",
        recommendation:
          "Switch to a platform with prompt caching (Claude Code).",
      });
    }

    const total = i + o + cw + cr;
    if (total > 0 && (i / total) * 100 > 10) {
      diagnosis.push({
        metric: "input_bloat",
        severity: "warning",
        finding: `Fresh input is ${((i / total) * 100).toFixed(1)}% of total flow — efficient operators keep it under 1%.`,
        recommendation: "Reduce fresh input by reusing prior context.",
      });
    }

    // ── Step 2: Suggest (generate + simulate candidates) ──────────────
    const candidates = [];
    // If cacheRead is 0, suggest absolute amounts instead of percentage boosts
    const crBoosts = cr > 0 ? [1.5, 2, 3, 5] : [];
    for (const mult of crBoosts) {
      const sim = cascade({ ...pillars, cacheRead: Math.round(cr * mult) });
      if (sim.yield !== null)
        candidates.push({
          action: `Increase cache reads by ${Math.round((mult - 1) * 100)}%`,
          pillar: "cacheRead",
          delta: `+${Math.round(cr * (mult - 1)).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number(
            (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
          ),
          class_after: sim.class,
          rationale: "Cache reads are the strongest Υ multiplier.",
        });
    }
    // For zero-cache operators, suggest enabling caching with a starter amount
    if (cr === 0 && cw === 0) {
      const starterAmounts = [
        Math.round(i * 10),
        Math.round(i * 50),
        Math.round(i * 100),
      ];
      for (const amt of starterAmounts) {
        const sim = cascade({
          ...pillars,
          cacheCreate: Math.round(amt * 0.5),
          cacheRead: amt,
        });
        if (sim.yield !== null && sim.yield > 0)
          candidates.push({
            action: `Enable caching with ${amt.toLocaleString()} cache reads`,
            pillar: "cacheRead",
            delta: `+${amt.toLocaleString()}`,
            simulated_yield: sim.yield,
            yield_delta: Number(
              (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
            ),
            class_after: sim.class,
            rationale:
              "You have no cache — enabling it unlocks the cascade. Start by reusing prior context.",
          });
      }
    }
    for (const mult of [0.9, 0.75, 0.5]) {
      const newInput = Math.round(i * mult);
      if (newInput < 1) continue;
      const sim = cascade({ ...pillars, input: newInput });
      if (sim.yield !== null)
        candidates.push({
          action: `Reduce fresh input by ${Math.round((1 - mult) * 100)}%`,
          pillar: "input",
          delta: `-${Math.round(i * (1 - mult)).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number(
            (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
          ),
          class_after: sim.class,
          rationale: "Input is squared in Υ denominator — quadratic payoff.",
        });
    }
    for (const mult of [1.25, 1.5, 2]) {
      const sim = cascade({ ...pillars, output: Math.round(o * mult) });
      if (sim.yield !== null)
        candidates.push({
          action: `Increase output by ${Math.round((mult - 1) * 100)}%`,
          pillar: "output",
          delta: `+${Math.round(o * (mult - 1)).toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number(
            (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
          ),
          class_after: sim.class,
          rationale: "Output is a linear multiplier in Υ.",
        });
    }
    candidates.sort((a, b) => b.yield_delta - a.yield_delta);
    const suggestions = candidates
      .slice(0, 8)
      .map((c, idx) => ({ rank: idx + 1, ...c }));

    // ── Step 3: Simulate the top suggestion ───────────────────────────
    const best = suggestions[0];
    let bestSimulation = null;
    if (best) {
      const simPillars = { ...pillars };
      const delta = parseInt(best.delta.replace(/[+\-,]/g, ""), 10);
      if (best.pillar === "cacheRead") simPillars.cacheRead = cr + delta;
      else if (best.pillar === "input")
        simPillars.input = Math.max(i - delta, 1);
      else if (best.pillar === "output") simPillars.output = o + delta;
      const simResult = cascade(simPillars);
      bestSimulation = {
        action: best.action,
        current_yield: currentResult.yield,
        simulated_yield: simResult.yield,
        yield_delta: best.yield_delta,
        current_class: currentResult.class,
        simulated_class: simResult.class,
        class_changed: currentResult.class !== simResult.class,
      };
    }

    // ── Step 4: Cycle summary ─────────────────────────────────────────
    const criticalCount = diagnosis.filter(
      (d) => d.severity === "critical",
    ).length;
    const cycleSummary = best
      ? `Pulled from ${pulledFrom}. Υ ${currentResult.yield} (${currentResult.class}). ${criticalCount} critical, ${diagnosis.length - criticalCount} other findings. Best: ${best.action} → Υ ${best.simulated_yield} (+${best.yield_delta}).`
      : `Pulled from ${pulledFrom}. Υ ${currentResult.yield} (${currentResult.class}). ${diagnosis.length} findings. No improvements suggested — cascade is optimized.`;

    // ── Step 5: Scope-specific analysis ───────────────────────────────
    const scope = args?.scope || "daily";
    const modeInfo = currentResult.mode; // { mode, confidence }
    const scopeResult = {};

    if (scope === "daily") {
      // Daily: mode + quality score + assessment + advice
      const qs = qualityScore(currentResult.yield ?? 0, modeInfo.mode);
      const expected = MODE_EXPECTED_YIELD[modeInfo.mode] ?? 0;
      const assessment = _dailyAssessment(
        modeInfo.mode,
        currentResult.yield,
        qs,
        expected,
      );
      const advice = _dailyAdvice(modeInfo.mode, currentResult.yield, qs);
      scopeResult.mode = modeInfo;
      scopeResult.quality_score = Math.round(qs * 100) / 100;
      scopeResult.assessment = assessment;
      scopeResult.advice = advice;
    }

    if (scope === "weekly" || scope === "trend") {
      // Pull daily rows from ccusage to build weekly snapshots
      const dailyRows = await _pullDailyRows(opts);
      const weeklySnapshots = _compoundWeekly(dailyRows);
      const modeDistribution = _modeDistribution(weeklySnapshots);
      const modeWeightedYield = _modeWeightedYield(weeklySnapshots);

      // Compute badges
      const historyForBadges = weeklySnapshots.map((w) => ({
        date: w.weekStart,
        mode: w.mode,
        yield: w.yield,
        pillars: w.pillars,
      }));
      const badges = computeBadges({
        pillars,
        cascade: currentResult,
        history: historyForBadges,
        isVerified: false, // set by submit_verified
        rank: null, // server-side
      });

      if (scope === "weekly") {
        scopeResult.mode = modeInfo;
        // Strip dailyModes from weekly_snapshots — privacy boundary (daily modes never leave the machine)
        const safeSnapshots = weeklySnapshots.map(
          ({ dailyModes, ...rest }) => rest,
        );
        scopeResult.report = {
          current_mode: modeInfo.mode,
          mode_confidence: modeInfo.confidence,
          mode_distribution: modeDistribution,
          mode_weighted_yield: modeWeightedYield,
          peak_yield: _peakYield(weeklySnapshots),
          health_score: _healthScore(weeklySnapshots, modeWeightedYield),
          weekly_snapshots: safeSnapshots,
          badges,
        };
      }

      if (scope === "trend") {
        const yield7d = _yieldForDays(weeklySnapshots, 7);
        const yield30d = _yieldForDays(weeklySnapshots, 30);
        const yield90d = _yieldForDays(weeklySnapshots, 90);
        const trajectory = _trajectory(yield7d, yield30d, yield90d);
        scopeResult.mode = modeInfo;
        scopeResult.trend = {
          yield_7d: yield7d,
          yield_30d: yield30d,
          yield_90d: yield90d,
          trajectory,
          mode_distribution: modeDistribution,
          phase_pattern: _phasePattern(weeklySnapshots),
        };
      }
    }

    return {
      pillars,
      current_cascade: {
        yield_: currentResult.yield,
        snr: currentResult.snr,
        leverage: currentResult.leverage,
        velocity: currentResult.velocity,
        tenx_dev: currentResult.dev10x,
        class: currentResult.class,
        mode: modeInfo,
        warnings: currentResult.warnings,
      },
      diagnosis,
      suggestions,
      best_simulation: bestSimulation,
      cycle_summary: cycleSummary,
      ...scopeResult,
    };
  }

  // ── Intent-based tools (get_best_operator, compare_self, compare_operators) ──
  // These wrap existing primitives with behavioral framing in power-user language.
  // See artifacts/004_sigrank-mcp-intent-tools-spec.md for the intent taxonomy.

  if (name === "get_best_operator") {
    const rawN = args?.n;
    const n = Math.min(20, Math.max(1, rawN == null ? 5 : Number(rawN)));
    const board = await fetchJson("/api/v1/leaderboard?metric=yield_");
    const ops = (board.operators || board || []).slice(0, n);
    const total = Array.isArray(board.operators || board)
      ? (board.operators || board).length
      : 0;

    const top = ops.map((op) => ({
      ...op,
      behavioral_framing: _behavioralFraming(op),
      competitive: _competitiveLayer(op, board),
    }));

    const best = top[0];
    const summary = best
      ? `${best.codename} tops the SigRank leaderboard at Υ ${best.yield_?.toLocaleString?.() || best.yield_} — ${_behavioralFraming(best)}`
      : "No operators on the board yet.";

    return {
      top_operators: top,
      total_operators: total,
      summary,
      cta: "Check my rank",
      shareable_url: best ? `${DEFAULT_API_BASE}/operator/${encodeURIComponent(best.codename)}` : null,
    };
  }

  if (name === "compare_self") {
    const codename = String(args?.codename || "").trim();
    const text = String(args?.text || "").trim();

    if (!codename && !text)
      throw new Error(
        "compare_self requires either `codename` (to fetch from the board) or `text` (raw token pillars to score locally).",
      );

    let yourMetrics;
    if (codename) {
      yourMetrics = await fetchJson(
        `/api/v1/operators/${encodeURIComponent(codename)}`,
      );
    } else {
      if (text.length > MAX_INPUT) {
        return {
          error: "input_too_large",
          detail: `text exceeds ${MAX_INPUT} chars.`,
        };
      }
      const pillars = parsePillars(text);
      const c = withParseWarnings(pillars, cascade(pillars));
      yourMetrics = {
        codename: "you (local)",
        yield_: c.yield,
        leverage: c.leverage,
        velocity: c.velocity,
        class: c.class,
        rank: null,
      };
    }

    // Fetch board for comparison
    const board = await fetchJson("/api/v1/leaderboard?metric=yield_");
    const allOps = board.operators || board || [];
    const yields = allOps.map((o) => o.yield_ || 0).sort((a, b) => a - b);
    const avgYield = yields.length
      ? yields.reduce((s, y) => s + y, 0) / yields.length
      : 0;
    const yourYield = yourMetrics.yield_ || 0;
    const percentile = yields.length
      ? Math.round(
          (yields.filter((y) => y < yourYield).length / yields.length) * 100,
        )
      : 0;

    const klass = yourMetrics.class || "Burner";
    const powerUserAssessment = _powerUserAssessment(klass, yourMetrics);
    const classMeaning = _classMeaning(klass);

    const yieldVsAvg = yields.length
      ? yourYield > avgYield
        ? `${(yourYield / avgYield).toFixed(1)}× the board average`
        : `${((yourYield / avgYield) * 100).toFixed(0)}% of the board average`
      : "board has no other operators";

    const suggestion = _improvementSuggestion(klass, yourMetrics);

    // Competitive layer per SHARED_DESIGN_DECISIONS.md §3/§4/§5
    const competitive = _competitiveLayer(yourMetrics, board);
    const competitiveSummary = _competitiveSummary(yourMetrics, board);

    return {
      your_metrics: yourMetrics,
      power_user_assessment: powerUserAssessment,
      comparison: {
        your_yield_vs_avg: yieldVsAvg,
        your_class_meaning: classMeaning,
        percentile,
        rank: competitive.rank,
        total_operators: competitive.total_operators,
        class_tier: competitive.class_tier,
        delta_from_average: competitive.delta_from_average,
        delta_from_top: competitive.delta_from_top,
      },
      competitive_summary: competitiveSummary,
      shareable_url: competitive.shareable_url,
      suggestion,
      cta: "See where I stand",
    };
  }

  if (name === "compare_operators") {
    const nameA = String(args?.codename_a || "").trim();
    const nameB = String(args?.codename_b || "").trim();
    if (!nameA || !nameB)
      throw new Error(
        "compare_operators requires both `codename_a` and `codename_b`.",
      );

    const [opA, opB, board] = await Promise.all([
      fetchJson(`/api/v1/operators/${encodeURIComponent(nameA)}`),
      fetchJson(`/api/v1/operators/${encodeURIComponent(nameB)}`),
      fetchJson("/api/v1/leaderboard?metric=yield_"),
    ]);

    const yieldA = opA.yield_ || 0;
    const yieldB = opB.yield_ || 0;
    const delta = yieldA - yieldB;

    const winner = yieldA > yieldB ? opA : opB;
    const loser = yieldA > yieldB ? opB : opA;
    const verdict = `${winner.codename} is more token-efficient (${winner.yield_?.toLocaleString?.() || winner.yield_} vs ${loser.yield_?.toLocaleString?.() || loser.yield_} Υ). ${_behavioralFraming(winner)} ${loser.codename} ${_classMeaning(loser.class).toLowerCase()}`;

    return {
      operator_a: {
        codename: opA.codename,
        yield_: opA.yield_,
        leverage: opA.leverage,
        velocity: opA.velocity,
        class: opA.class,
        rank: opA.rank,
        competitive: _competitiveLayer(opA, board),
      },
      operator_b: {
        codename: opB.codename,
        yield_: opB.yield_,
        leverage: opB.leverage,
        velocity: opB.velocity,
        class: opB.class,
        rank: opB.rank,
        competitive: _competitiveLayer(opB, board),
      },
      verdict,
      yield_delta: delta,
      cta: "Compare me to others",
    };
  }

  if (name === "describe_power_user") {
    return {
      description:
        "An AI power user isn't someone who sends the most tokens — it's someone who compounds signal. " +
        "Power users build workflows where cached context does the heavy lifting, fresh input stays lean, " +
        "and output per session is high. SigRank quantifies this with the yield metric (Υ = cache_read × output / input²).",
      metrics_explained: {
        yield_: "Yield (Υ) measures how well you compound signal, not how much you burn. High yield = your cached context is doing work for you.",
        leverage: "Leverage (Cr/I) measures how much you reuse prior work vs starting fresh. High leverage = you're building on cached results, not re-explaining everything.",
        velocity: "Velocity (O/I) measures how much output you get per token spent. High velocity = you're productive, not just active.",
      },
      class_tiers: [
        { class: "10xer", meaning: "AI power user archetype — disciplined, system-level reuse, high output per input. Leverage > 10×, high velocity." },
        { class: "Builder", meaning: "Building momentum — moderate cache reuse, approaching power-user patterns. Growing leverage and velocity." },
        { class: "Burner", meaning: "Early-stage — tokens burned more than compounded. Low leverage, low velocity. The shift: reuse prior context." },
      ],
      link: "https://signalaf.com/score — check your class tier and yield",
      shareable_url: `${DEFAULT_API_BASE}/score`,
      cta: "Learn the scoring",
    };
  }

  if (name === "optimize_efficiency") {
    const codename = String(args?.codename || "").trim();
    const text = String(args?.text || "").trim();

    if (!codename && !text)
      throw new Error(
        "optimize_efficiency requires either `codename` (to fetch from the board) or `text` (raw token pillars to score locally).",
      );

    let metrics;
    if (codename) {
      metrics = await fetchJson(
        `/api/v1/operators/${encodeURIComponent(codename)}`,
      );
    } else {
      if (text.length > MAX_INPUT) {
        return { error: "input_too_large", detail: `text exceeds ${MAX_INPUT} chars.` };
      }
      const pillars = parsePillars(text);
      const c = withParseWarnings(pillars, cascade(pillars));
      metrics = {
        codename: "you (local)",
        yield_: c.yield,
        leverage: c.leverage,
        velocity: c.velocity,
        class: c.class,
      };
    }

    const klass = metrics.class || "Burner";
    const l = metrics.leverage || 0;
    const v = metrics.velocity || 0;
    const y = metrics.yield_ || 0;

    // Build ranked suggestions based on current cascade shape
    const suggestions = [];

    if (l < 5) {
      suggestions.push({
        action: "Increase cache reuse — reuse prompts, templates, and workflows instead of starting from scratch",
        why: "Your leverage is " + l.toFixed(1) + "×, meaning most of your context is fresh input. Each reused cached token multiplies your yield because input² is in the denominator.",
        power_user_practice: "Power users build template libraries and workflow patterns they invoke repeatedly, letting cached context accumulate.",
      });
    }
    if (v < 1) {
      suggestions.push({
        action: "Increase output per session — produce more, don't just read",
        why: "Your velocity is " + v.toFixed(2) + ", meaning you're consuming more input than producing output. Yield rewards output production.",
        power_user_practice: "Power users maximize output per session — they ask AI to generate, transform, and produce, not just explain.",
      });
    }
    if (l >= 5 && v >= 1 && klass !== "10xer") {
      suggestions.push({
        action: "Extend session length to compound cached context further",
        why: "Your leverage (" + l.toFixed(1) + "×) and velocity (" + v.toFixed(2) + ") are solid. Longer sessions with consistent context will push your yield higher.",
        power_user_practice: "Power users maintain long, context-rich sessions where the cache grows and compounds.",
      });
    }
    if (suggestions.length === 0) {
      suggestions.push({
        action: "Maintain your cascade architecture — you're at the top tier",
        why: "Your yield (" + y.toLocaleString() + "), leverage (" + l.toFixed(1) + "×), and velocity (" + v.toFixed(2) + ") are all strong. Keep doing what you're doing.",
        power_user_practice: "Power users don't rest on their metrics — they experiment with new workflow patterns and measure the impact.",
      });
    }

    const summary = `Your Υ Yield is ${y.toLocaleString()} (${klass}). ${_improvementSuggestion(klass, metrics)}`;

    // Competitive layer per SHARED_DESIGN_DECISIONS.md §3/§4/§5
    const board = await fetchJson("/api/v1/leaderboard?metric=yield_");
    const competitive = _competitiveLayer(metrics, board);
    const competitiveSummary = _competitiveSummary(metrics, board);

    return {
      your_metrics: {
        yield_: y,
        leverage: l,
        velocity: v,
        class: klass,
      },
      competitive: {
        rank: competitive.rank,
        total_operators: competitive.total_operators,
        percentile: competitive.percentile,
        class_tier: competitive.class_tier,
        delta_from_average: competitive.delta_from_average,
        delta_from_top: competitive.delta_from_top,
      },
      competitive_summary: competitiveSummary,
      shareable_url: competitive.shareable_url,
      suggestions,
      summary,
      cta: "Improve my score",
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── Intent tool helpers — behavioral framing in power-user language ──────────

/**
 * Competitive layer for tool responses per SHARED_DESIGN_DECISIONS.md §3/§4/§5.
 * Every tool response that includes operator data must show:
 *   rank, percentile, class_tier, delta_from_average, delta_from_top, shareable_url
 * Response style: factual + competitive ("You rank #12 of 47 operators...")
 */
function _competitiveLayer(op, board) {
  const allOps = Array.isArray(board?.operators || board) ? (board.operators || board) : [];
  const yields = allOps.map((o) => o.yield_ || 0).sort((a, b) => a - b);
  const yourYield = op.yield_ || 0;
  const total = allOps.length;

  // Rank: find operator's position (1-based)
  let rank = op.rank || null;
  if (!rank && total > 0) {
    const sorted = [...allOps].sort((a, b) => (b.yield_ || 0) - (a.yield_ || 0));
    const idx = sorted.findIndex((o) => o.codename === op.codename);
    rank = idx >= 0 ? idx + 1 : null;
  }

  // Percentile: % of operators with yield below this operator
  const percentile = total > 0
    ? Math.round((yields.filter((y) => y < yourYield).length / total) * 100)
    : 0;

  // Delta from average
  const avgYield = total > 0 ? yields.reduce((s, y) => s + y, 0) / total : 0;
  const deltaFromAvg = avgYield > 0
    ? { absolute: Math.round(yourYield - avgYield),
        percent: Math.round(((yourYield - avgYield) / avgYield) * 100) }
    : { absolute: 0, percent: 0 };

  // Delta from top operator
  const topYield = total > 0 ? Math.max(...yields) : 0;
  const deltaFromTop = topYield > 0
    ? { absolute: Math.round(topYield - yourYield),
        percent: Math.round(((topYield - yourYield) / topYield) * 100) }
    : { absolute: 0, percent: 0 };

  // Shareable URL
  const shareableUrl = op.codename && op.codename !== "you (local)"
    ? `${DEFAULT_API_BASE}/operator/${encodeURIComponent(op.codename)}`
    : null;

  return {
    rank,
    total_operators: total,
    percentile,
    class_tier: op.class || "Burner",
    delta_from_average: deltaFromAvg,
    delta_from_top: deltaFromTop,
    shareable_url: shareableUrl,
  };
}

/** Factual + competitive summary line per SHARED_DESIGN_DECISIONS.md §4 */
function _competitiveSummary(op, board) {
  const cl = _competitiveLayer(op, board);
  const parts = [];

  if (cl.rank && cl.total_operators > 0) {
    parts.push(`You rank #${cl.rank} of ${cl.total_operators} operators.`);
  }

  const topOp = (board?.operators || board || []).reduce(
    (best, o) => ((o.yield_ || 0) > (best?.yield_ || 0) ? o : best),
    null,
  );
  if (topOp && topOp.codename) {
    parts.push(`Top operator is ${topOp.codename} with Υ ${(topOp.yield_ || 0).toLocaleString()}.`);
  }

  if (cl.delta_from_average.percent !== 0) {
    const dir = cl.delta_from_average.percent > 0 ? "above" : "below";
    parts.push(`You're ${Math.abs(cl.delta_from_average.percent)}% ${dir} average.`);
  }

  if (cl.delta_from_top.percent > 0) {
    parts.push(`${cl.delta_from_top.percent}% below top.`);
  }

  return parts.join(" ");
}

function _behavioralFraming(op) {
  const y = op.yield_ || 0;
  const l = op.leverage || 0;
  const v = op.velocity || 0;
  const klass = op.class || "Burner";

  if (klass === "10xer")
    return `Disciplined, system-level reuse: ${l.toFixed(1)}× leverage means heavy cache reuse over fresh input, ${v.toFixed(2)} velocity means more output per token spent. This is the AI power-user archetype.`;
  if (klass === "Builder")
    return `Building cascade momentum: moderate cache reuse (${l.toFixed(1)}× leverage) with ${v.toFixed(2)} output velocity. Approaching power-user patterns — increase cache reuse to push into 10xer territory.`;
  return `Early-stage cascade: ${v.toFixed(2)} output velocity with ${l.toFixed(1)}× leverage. Tokens are being burned more than compounded. Focus on reusing prior context (templates, prompts, workflows) to build leverage.`;
}

function _powerUserAssessment(klass, metrics) {
  const l = metrics.leverage || 0;
  const v = metrics.velocity || 0;
  if (klass === "10xer")
    return `You are an AI power user. Your SigRank class (10xer) indicates you reuse prior work heavily (${l.toFixed(1)}× leverage), get more out of each token (${v.toFixed(2)} velocity), and keep input lean. This is consistent with AI power-user behavior: iterative, efficient, multi-use patterns.`;
  if (klass === "Builder")
    return `You are becoming an AI power user. Your Builder class shows growing cache reuse (${l.toFixed(1)}× leverage) and ${v.toFixed(2)} output velocity. You're building the habits — increase context reuse to push into 10xer territory.`;
  return `You are not yet an AI power user. Your Burner class means tokens are being spent without compounding. The power-user shift: reuse prior context (prompts, templates, cached results) instead of starting fresh each time. Your leverage (${l.toFixed(1)}×) is the key metric to improve.`;
}

function _classMeaning(klass) {
  if (klass === "10xer")
    return "AI power user archetype — disciplined, system-level reuse, high output per input.";
  if (klass === "Builder")
    return "Building momentum — moderate reuse, approaching power-user patterns.";
  return "Early-stage — tokens burned more than compounded. Focus on cache reuse.";
}

function _improvementSuggestion(klass, metrics) {
  const l = metrics.leverage || 0;
  const v = metrics.velocity || 0;
  if (klass === "10xer")
    return v < 1
      ? "Your leverage is excellent but velocity is under 1.0 — you're reading more cache than producing output. Push for more output per session."
      : "You're at the top tier. Maintain your cache architecture and experiment with longer sessions to compound yield further.";
  if (klass === "Builder")
    return l < 5
      ? "Increase cache reuse: reuse prompts, templates, and workflows instead of starting from scratch. Each reused token multiplies your yield."
      : "Your leverage is solid. Focus on output velocity — produce more per session to push your yield up.";
  return "Start by reusing prior context. Instead of fresh prompts each time, build on cached results. Even a 2× increase in cache_read will dramatically improve your yield because input² is in the denominator.";
}

// ── self_improve scope helpers ──────────────────────────────────────────────

/** Pull daily rows from ccusage to build mode history. Returns array of { date, pillars, yield, mode }. */
async function _pullDailyRows(opts = {}) {
  try {
    const raw = await execFileAsync(
      "ccusage",
      ["claude", "daily", "--json"],
      15000,
    );
    const rows = JSON.parse(raw)?.daily ?? JSON.parse(raw);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const pillars = {
          input: r.inputTokens ?? r.input_tokens ?? 0,
          output: r.outputTokens ?? r.output_tokens ?? 0,
          cacheCreate: r.cacheCreationTokens ?? r.cache_create_tokens ?? 0,
          cacheRead: r.cacheReadTokens ?? r.cache_read_tokens ?? 0,
        };
        const cas = cascade(pillars);
        const mode = detectMode(pillars);
        return {
          date: r.date ?? r.day ?? null,
          pillars,
          yield: cas.yield ?? 0,
          mode: mode.mode,
          mode_confidence: mode.confidence,
        };
      })
      .filter((r) => r.date);
  } catch {
    return [];
  }
}

/** Compound daily rows into weekly snapshots. Each week = 7 days, starting Monday. */
function _compoundWeekly(dailyRows) {
  if (!dailyRows || dailyRows.length === 0) return [];
  // Group by ISO week (week starts Monday)
  const weeks = new Map();
  for (const row of dailyRows) {
    const d = new Date(row.date);
    const day = d.getDay() || 7; // Sunday=0 → 7
    const monday = new Date(d);
    monday.setDate(d.getDate() - day + 1);
    const weekKey = monday.toISOString().slice(0, 10);
    if (!weeks.has(weekKey)) {
      weeks.set(weekKey, { weekStart: weekKey, days: [] });
    }
    weeks.get(weekKey).days.push(row);
  }
  // Compound each week
  return Array.from(weeks.values())
    .map((w) => {
      const pillars = w.days.reduce(
        (acc, d) => ({
          input: acc.input + d.pillars.input,
          output: acc.output + d.pillars.output,
          cacheCreate: acc.cacheCreate + d.pillars.cacheCreate,
          cacheRead: acc.cacheRead + d.pillars.cacheRead,
        }),
        { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      );
      const cas = cascade(pillars);
      const mode = detectMode(pillars);
      return {
        weekStart: w.weekStart,
        pillars,
        yield: cas.yield ?? 0,
        mode: mode.mode,
        mode_confidence: mode.confidence,
        dayCount: w.days.length,
        dailyModes: w.days.map((d) => d.mode), // stays local — not in submitted report
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** Compute mode distribution from weekly snapshots (weekly granularity = privacy boundary). */
function _modeDistribution(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return {};
  const counts = { BUILD: 0, EDIT: 0, DEBUG: 0, MAINTAIN: 0, IDLE: 0 };
  for (const w of weeklySnapshots) {
    counts[w.mode] = (counts[w.mode] || 0) + 1;
  }
  const total = weeklySnapshots.length;
  const dist = {};
  for (const [mode, count] of Object.entries(counts)) {
    if (count > 0) dist[mode] = Math.round((count / total) * 100) / 100;
  }
  return dist;
}

/** Mode-weighted yield — average yield weighted by mode distribution. */
function _modeWeightedYield(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  const total = weeklySnapshots.length;
  const sum = weeklySnapshots.reduce((acc, w) => acc + (w.yield || 0), 0);
  return Math.round(sum / total);
}

/** Peak yield across all weekly snapshots. */
function _peakYield(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  return Math.max(...weeklySnapshots.map((w) => w.yield || 0));
}

/** Health score (0-100) — weighted composite of consistency, momentum, quality. */
function _healthScore(weeklySnapshots, modeWeightedYield) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  // Simplified Phase 1 formula:
  //  40% — consistency (how often in MAINTAIN)
  //  30% — momentum (recent yield vs older yield)
  //  30% — quality (mode-weighted yield relative to MAINTAIN expected)
  const dist = _modeDistribution(weeklySnapshots);
  const maintainShare = dist.MAINTAIN || 0;
  const consistency = Math.min(maintainShare, 1) * 40;

  // Momentum: compare last 3 weeks to first 3 weeks
  const recent = weeklySnapshots.slice(-3);
  const older = weeklySnapshots.slice(0, 3);
  const recentAvg =
    recent.reduce((a, w) => a + (w.yield || 0), 0) / (recent.length || 1);
  const olderAvg =
    older.reduce((a, w) => a + (w.yield || 0), 0) / (older.length || 1);
  const momentumRatio = olderAvg > 0 ? recentAvg / olderAvg : 1;
  const momentum = (Math.min(momentumRatio, 2) / 2) * 30;

  // Quality: mode-weighted yield vs MAINTAIN expected (5000)
  const quality = Math.min(modeWeightedYield / 5000, 1) * 30;

  return Math.round(consistency + momentum + quality);
}

/** Yield for the last N days (from weekly snapshots — approximates by summing recent weeks). */
function _yieldForDays(weeklySnapshots, days) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  const weeksNeeded = Math.ceil(days / 7);
  const recent = weeklySnapshots.slice(-weeksNeeded);
  if (recent.length === 0) return 0;
  const sum = recent.reduce((a, w) => a + (w.yield || 0), 0);
  return Math.round(sum / recent.length); // average weekly yield
}

/** Trajectory description from 7d/30d/90d yields. */
function _trajectory(y7, y30, y90) {
  if (y90 === 0) return "insufficient_data";
  const r7v30 = y30 > 0 ? y7 / y30 : 1;
  const r30v90 = y90 > 0 ? y30 / y90 : 1;
  if (r7v30 > 1.2 && r30v90 > 1.0) return "accelerating";
  if (r7v30 > 1.2) return "recent_surge";
  if (r7v30 < 0.8 && r30v90 < 0.8) return "declining";
  if (r7v30 < 0.8) return "recent_dip";
  if (r30v90 > 1.1) return "steady_growth";
  return "stable";
}

/** Phase pattern description from mode distribution over time. */
function _phasePattern(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length < 2)
    return "insufficient_data";
  const modes = weeklySnapshots.map((w) => w.mode);
  const transitions = [];
  for (let i = 1; i < modes.length; i++) {
    if (modes[i] !== modes[i - 1]) {
      transitions.push(`${modes[i - 1]}→${modes[i]}`);
    }
  }
  if (transitions.length === 0) return `consistent_${modes[0].toLowerCase()}`;
  // Check for smooth transitions (BUILD→MAINTAIN without DEBUG)
  const smooth = transitions.every((t) => !t.includes("DEBUG"));
  if (smooth && transitions.some((t) => t === "BUILD→MAINTAIN"))
    return "smooth_ramp";
  if (transitions.filter((t) => t.includes("DEBUG")).length > 2)
    return "erratic";
  return "cyclical";
}

/** Daily assessment string. */
function _dailyAssessment(mode, yieldVal, qualityScoreVal, expectedYield) {
  const qsPct = Math.round(qualityScoreVal * 100);
  if (mode === "IDLE")
    return "You're idle — no significant token activity today.";
  if (mode === "MAINTAIN") {
    if (qualityScoreVal >= 0.5)
      return `You're in MAINTAIN mode. Yield ${yieldVal} is ${qsPct}% of MAINTAIN norm. The cascade is compounding.`;
    return `You're in MAINTAIN mode but yield ${yieldVal} is only ${qsPct}% of expected (${expectedYield}). You may be coasting — push for more output.`;
  }
  if (mode === "BUILD") {
    if (qualityScoreVal >= 0.5)
      return `You're in BUILD mode. Yield ${yieldVal} is ${qsPct}% of BUILD norm. Greenfield work — expected to be low.`;
    return `You're in BUILD mode. Yield ${yieldVal} is ${qsPct}% of expected (${expectedYield}). Building is slow — keep going.`;
  }
  if (mode === "EDIT") {
    if (qualityScoreVal >= 0.5)
      return `You're in EDIT mode. Yield ${yieldVal} is ${qsPct}% of EDIT norm. Fresh input but producing — good.`;
    return `You're in EDIT mode. Yield ${yieldVal} is ${qsPct}% of expected (${expectedYield}). Push for more output per input.`;
  }
  if (mode === "DEBUG") {
    if (qualityScoreVal >= 0.5)
      return `You're in DEBUG mode. Yield ${yieldVal} is ${qsPct}% of DEBUG norm. Investigating — yield is expected to be low.`;
    return `You're in DEBUG mode. Yield ${yieldVal} is ${qsPct}% of expected (${expectedYield}). Debugging is slow — consider loading prior context.`;
  }
  return `Mode: ${mode}. Yield: ${yieldVal}. Quality: ${qsPct}%.`;
}

/** Daily advice string. */
function _dailyAdvice(mode, yieldVal, qs) {
  if (mode === "MAINTAIN" && qs >= 0.5)
    return "Keep the cascade going. Don't reset context — let it compound.";
  if (mode === "MAINTAIN")
    return "You're in MAINTAIN but underperforming. Push the agent for more output per turn.";
  if (mode === "BUILD")
    return "When you're done building, load prior context to transition to MAINTAIN. The cascade rewards reuse.";
  if (mode === "EDIT")
    return "You're producing but using fresh input. Try to reuse prior context to boost leverage.";
  if (mode === "DEBUG")
    return "When you're done debugging, load prior context to return to MAINTAIN. Don't let the debug phase drag on.";
  if (mode === "IDLE")
    return "No activity detected. Start a session to build your cascade.";
  return "Keep working — the cascade will compound as you build context.";
}

/**
 * Compute the cascade report block for a submission payload.
 * Pure math — mode detection + badges + health score from the current pillars.
 * The server stores this as-is (does NOT recompute modes).
 * Weekly granularity is the privacy boundary — no daily modes in the report.
 */
function _computeReportBlock(pillars) {
  const cas = cascade(pillars);
  const modeInfo = detectMode(pillars);
  const badges = computeBadges({
    pillars,
    cascade: cas,
    history: [], // no history available at submit time — badges computed from current pillars only
    isVerified: true, // submit_verified is the signed agent path
    rank: null,
  });
  return {
    current_mode: modeInfo.mode,
    mode_confidence: modeInfo.confidence,
    mode_distribution: { [modeInfo.mode]: 1.0 }, // single-window submission
    mode_weighted_yield: cas.yield ?? 0,
    peak_yield: cas.yield ?? 0,
    health_score: _healthScore(
      [{ mode: modeInfo.mode, yield: cas.yield ?? 0 }],
      cas.yield ?? 0,
    ),
    badges,
  };
}
