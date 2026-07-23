/**
 * tokscale_analytics.mjs — seven analytics built on the tokscale CLI's JSON API.
 *
 * tokscale is a local, single-user token-telemetry CLI (bundled as a dep). It reads
 * AI coding-tool session logs from this machine and emits JSON for several
 * subcommands. This module wraps those subcommands and derives the analytics the
 * SigRank MCP server exposes as tools:
 *
 *   1. tokscaleMarketShare()             — AI tool market share (per-client share of tokens/cost/messages)
 *   2. tokscaleDeveloperProfile()        — per-developer usage profile across all detected tools
 *   3. tokscaleModelTrends()             — model adoption trends over time (month-over-month)
 *   4. tokscaleCostAnalysis()            — cost analysis per developer per model
 *   5. tokscaleDeviceProfile()           — device fingerprinting (installed tools, active days/hours, sessions)
 *   6. tokscaleMcpUsage()                — MCP server usage patterns
 *   7. tokscaleCompetitiveIntel(target)  — competitive intelligence for a given AI tool/company
 *
 * Design notes:
 *   - Self-contained execFileAsync (same pattern as tools.mjs) to avoid a circular import.
 *     execFile — never execSync — so the event loop stays responsive and shell injection
 *     is structurally impossible (args are an array, no shell parsing).
 *   - All filesystem paths in the output are redacted: os.homedir() → "~". tokscale's
 *     `clients` and `report` subcommands emit absolute session paths that would leak the
 *     local username; we never surface raw absolute paths.
 *   - Every tokscale subcommand call is wrapped in try/catch returning null on failure,
 *     so a single failing subcommand degrades gracefully instead of nuking the whole report.
 *   - `<synthetic>` and `unknown` models are filtered everywhere — they are tokscale
 *     bookkeeping, not real model usage.
 *   - Token-only: tokscale reads usage counts from log metadata, never message content.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve local node_modules/.bin for the bundled tokscale binary.
const _pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const _localBin = path.join(_pkgRoot, "node_modules", ".bin");
const _envPath = `${_localBin}${process.env.PATH ? ":" + process.env.PATH : ""}`;

// execFile wrapped in a Promise — non-blocking, no shell, args as array.
// Mirrors the helper in tools.mjs / tokenpull.mjs. maxBuffer 10 MB matches the
// existing readers; the `report` payload can be large but stays well under that.
function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
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

// tokscale subcommand timeouts. `models` is fast (~5s); `graph` and `report`
// walk every session log and can take ~30s on a heavy machine. 60s ceiling.
const T_MODELS = 60_000;
const T_MONTHLY = 60_000;
const T_CLIENTS = 30_000;
const T_GRAPH = 60_000;
const T_REPORT = 60_000;

const HOME = os.homedir();

/** Redact the local home directory prefix to "~" so no absolute path leaks. */
export function redactPath(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === HOME) return "~";
  if (p.startsWith(HOME + "/")) return "~" + p.slice(HOME.length);
  if (p.startsWith(HOME + path.sep)) return "~" + p.slice(HOME.length);
  return p;
}

/** Coerce a tokscale numeric field to a safe integer-ish number. */
export function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Map tokscale's client slugs to canonical platform names (mirrors tools.mjs).
// `synthetic` → null (filtered). unmapped slugs → "other".
const TOKSCALE_CLIENT_MAP = {
  claude: "claude", codex: "codex", "devin-cli": "devin",
  "devin-desktop": "devin", gemini: "gemini", amp: "amp",
  kimi: "kimi", qwen: "qwen", goose: "goose", kilo: "kilo",
  kilocode: "kilo", hermes: "hermes", droid: "droid",
  codebuff: "codebuff", copilot: "copilot", opencode: "opencode",
  openclaw: "openclaw", pi: "pi",
  cursor: "other", roocode: "other", mux: "other", crush: "other",
  antigravity: "other", "antigravity-cli": "other", zed: "other",
  kiro: "other", trae: "other", warp: "other", cline: "other",
  gjc: "other", grok: "other", jcode: "other", commandcode: "other",
  micode: "other", junie: "other", zcode: "other",
  opencodereview: "other", codebuddy: "other", workbuddy: "other",
  synthetic: null,
};

/** Human-readable label for a tokscale client slug. */
const CLIENT_LABELS = {
  claude: "Claude Code", codex: "Codex CLI", "devin-cli": "Devin CLI",
  "devin-desktop": "Devin Desktop", gemini: "Gemini CLI", amp: "Amp",
  kimi: "Kimi", qwen: "Qwen", goose: "Goose", kilo: "Kilo",
  kilocode: "Kilo Code", hermes: "Hermes", droid: "Droid",
  codebuff: "Codebuff", copilot: "GitHub Copilot", opencode: "OpenCode",
  openclaw: "OpenClaw", pi: "Pi",
  cursor: "Cursor", roocode: "Roo Code", mux: "Mux", crush: "Crush",
  antigravity: "Antigravity", "antigravity-cli": "Antigravity CLI",
  zed: "Zed", kiro: "Kiro", trae: "Trae", warp: "Warp", cline: "Cline",
  gjc: "GJC", grok: "Grok", jcode: "JCode", commandcode: "Command Code",
  micode: "MiCode", junie: "Junie", zcode: "ZCode",
  opencodereview: "OpenCode Review", codebuddy: "CodeBuddy",
  workbuddy: "WorkBuddy",
};

/** True for tokscale bookkeeping models that are not real model usage. */
export function isBookkeepingModel(m) {
  return m === "<synthetic>" || m === "unknown" || !m;
}

// ── Raw tokscale subcommand readers (each null-safe on failure) ──────────────

async function _models() {
  try {
    const raw = await execFileAsync("tokscale", ["models", "--json", "--no-spinner"], T_MODELS);
    const data = JSON.parse(raw);
    const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
    return entries.filter((e) => e && e.client && !isBookkeepingModel(e.model));
  } catch {
    return null;
  }
}

async function _monthly() {
  try {
    const raw = await execFileAsync("tokscale", ["monthly", "--json", "--no-spinner"], T_MONTHLY);
    const data = JSON.parse(raw);
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return null;
  }
}

async function _clients() {
  try {
    const raw = await execFileAsync("tokscale", ["clients", "--json"], T_CLIENTS);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function _graph() {
  try {
    const raw = await execFileAsync("tokscale", ["graph", "--no-spinner"], T_GRAPH);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function _report() {
  try {
    const raw = await execFileAsync(
      "tokscale",
      ["report", "--json", "--no-summarize"],
      T_REPORT,
    );
    // tokscale prints a non-JSON status line ("N new sessions added to wiki")
    // before the JSON array. Strip everything up to the first '['.
    const idx = raw.indexOf("[");
    const jsonText = idx >= 0 ? raw.slice(idx) : raw;
    const data = JSON.parse(jsonText);
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}

// ── Shared aggregation helpers ───────────────────────────────────────────────

/** Sum the four token pillars from a tokscale models entry. */
function totalTokens(e) {
  return num(e.input) + num(e.output) + num(e.cacheRead) + num(e.cacheWrite) + num(e.reasoning);
}

/** Round to 2 decimals — for cost and percentage fields. */
function r2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/** Round to 4 decimals — for per-token cost rates. */
function r4(x) {
  return Math.round((Number(x) || 0) * 10000) / 10000;
}

// ── 1. AI tool market share analysis ─────────────────────────────────────────

/**
 * Aggregate tokscale `models` by client (AI tool) and compute each tool's share of
 * total tokens, cost, and messages. Returns tools sorted by token share descending.
 */
export async function tokscaleMarketShare() {
  const entries = await _models();
  if (entries === null) {
    return { error: "tokscale models --json unavailable", tools: [] };
  }
  if (!entries.length) return { tools: [], totals: { tokens: 0, cost: 0, messages: 0 } };

  const byClient = {};
  let totalTok = 0, totalCost = 0, totalMsg = 0;
  for (const e of entries) {
    const tok = totalTokens(e);
    const cost = num(e.cost);
    const msg = num(e.messageCount);
    if (tok === 0 && cost === 0 && msg === 0) continue;
    const key = e.client;
    if (!byClient[key]) {
      byClient[key] = { client: key, label: CLIENT_LABELS[key] || key, tokens: 0, cost: 0, messages: 0, models: new Set() };
    }
    byClient[key].tokens += tok;
    byClient[key].cost += cost;
    byClient[key].messages += msg;
    byClient[key].models.add(e.model);
    totalTok += tok;
    totalCost += cost;
    totalMsg += msg;
  }

  const tools = Object.values(byClient).map((t) => ({
    client: t.client,
    label: t.label,
    tokens: t.tokens,
    cost: r2(t.cost),
    messages: t.messages,
    model_count: t.models.size,
    share_tokens: totalTok > 0 ? r2((t.tokens / totalTok) * 100) : 0,
    share_cost: totalCost > 0 ? r2((t.cost / totalCost) * 100) : 0,
    share_messages: totalMsg > 0 ? r2((t.messages / totalMsg) * 100) : 0,
  }));

  tools.sort((a, b) => b.tokens - a.tokens);

  return {
    tools,
    totals: {
      tokens: totalTok,
      cost: r2(totalCost),
      messages: totalMsg,
      tool_count: tools.length,
    },
  };
}

// ── 2. Per-developer usage profiles across 20+ tools ─────────────────────────

/**
 * Build a per-developer usage profile: for each detected AI tool, the developer's
 * model mix, token pillars, cost, message count, and performance. Combines
 * `models` (usage) with `clients` (session counts + scan locations) and `report`
 * (per-session workspace breakdown). All paths redacted.
 */
export async function tokscaleDeveloperProfile() {
  const [entries, clients, report] = await Promise.all([_models(), _clients(), _report()]);

  if (entries === null) {
    return { error: "tokscale models --json unavailable", tools: [] };
  }
  if (!entries.length) return { tools: [], summary: { tool_count: 0, total_cost: 0 } };

  // Per-client model detail from `models`.
  const byClient = {};
  for (const e of entries) {
    const tok = totalTokens(e);
    const cost = num(e.cost);
    const msg = num(e.messageCount);
    if (tok === 0 && cost === 0 && msg === 0) continue;
    const key = e.client;
    if (!byClient[key]) {
      byClient[key] = {
        client: key,
        label: CLIENT_LABELS[key] || key,
        platform: TOKSCALE_CLIENT_MAP[key] ?? "other",
        tokens: 0, cost: 0, messages: 0,
        cache_read: 0, cache_write: 0, input: 0, output: 0, reasoning: 0,
        models: [],
        session_count: 0,
        workspaces: new Set(),
      };
    }
    const c = byClient[key];
    c.tokens += tok;
    c.cost += cost;
    c.messages += msg;
    c.input += num(e.input);
    c.output += num(e.output);
    c.cache_read += num(e.cacheRead);
    c.cache_write += num(e.cacheWrite);
    c.reasoning += num(e.reasoning);
    const perf = e.performance || {};
    c.models.push({
      model: e.model,
      provider: e.provider || null,
      tokens: tok,
      cost: r2(cost),
      messages: msg,
      input: num(e.input),
      output: num(e.output),
      cache_read: num(e.cacheRead),
      cache_write: num(e.cacheWrite),
      ms_per_1k_tokens: perf.msPer1KTokens ?? null,
      token_coverage: perf.tokenCoverage ?? null,
    });
  }

  // Enrich with session counts + scan paths from `clients`.
  if (clients?.clients) {
    for (const cl of clients.clients) {
      const key = cl.client;
      if (byClient[key]) {
        byClient[key].session_count = num(cl.messageCount);
        byClient[key].sessions_path = redactPath(cl.sessionsPath);
        byClient[key].sessions_path_exists = !!cl.sessionsPathExists;
        byClient[key].headless_supported = !!cl.headlessSupported;
      }
    }
  }

  // Enrich with workspace breakdown from `report` (per-session task data).
  if (report) {
    for (const s of report) {
      const key = s.client;
      if (byClient[key] && s.workspace_label) {
        byClient[key].workspaces.add(s.workspace_label);
      }
    }
  }

  const tools = Object.values(byClient).map((c) => {
    c.models.sort((a, b) => b.tokens - a.tokens);
    return {
      client: c.client,
      label: c.label,
      platform: c.platform,
      tokens: c.tokens,
      cost: r2(c.cost),
      messages: c.messages,
      input: c.input,
      output: c.output,
      cache_read: c.cache_read,
      cache_write: c.cache_write,
      reasoning: c.reasoning,
      cache_read_pct: c.tokens > 0 ? r2((c.cache_read / c.tokens) * 100) : 0,
      session_count: c.session_count,
      sessions_path: c.sessions_path || null,
      sessions_path_exists: c.sessions_path_exists ?? null,
      headless_supported: c.headless_supported ?? null,
      workspace_count: c.workspaces.size,
      workspaces: [...c.workspaces].sort(),
      models: c.models,
    };
  });

  tools.sort((a, b) => b.tokens - a.tokens);

  const totalCost = tools.reduce((s, t) => s + t.cost, 0);
  const totalTok = tools.reduce((s, t) => s + t.tokens, 0);

  return {
    tools,
    summary: {
      tool_count: tools.length,
      total_cost: r2(totalCost),
      total_tokens: totalTok,
      total_messages: tools.reduce((s, t) => s + t.messages, 0),
      avg_cost_per_tool: tools.length > 0 ? r2(totalCost / tools.length) : 0,
      dominant_tool: tools[0]?.client || null,
    },
  };
}

// ── 3. Model adoption trends over time ───────────────────────────────────────

/**
 * Track model adoption month-over-month using `monthly` (per-month model lists +
 * aggregates) cross-referenced with `graph` contributions (per-day per-client×model
 * breakdown). Returns: per-month model adoption with first-seen / last-seen dates,
 * token trajectory, and a model-level adoption timeline.
 */
export async function tokscaleModelTrends() {
  const [monthly, graph] = await Promise.all([_monthly(), _graph()]);

  if (monthly === null && graph === null) {
    return { error: "tokscale monthly/graph unavailable", months: [], models: [] };
  }

  // Per-month summary from `monthly`.
  const months = [];
  if (monthly && monthly.length) {
    for (const m of monthly) {
      const models = (m.models || []).filter((x) => !isBookkeepingModel(x));
      months.push({
        month: m.month,
        models: models.sort(),
        model_count: models.length,
        input: num(m.input),
        output: num(m.output),
        cache_read: num(m.cacheRead),
        cache_write: num(m.cacheWrite),
        messages: num(m.messageCount),
        cost: r2(m.cost),
      });
    }
    months.sort((a, b) => (a.month < b.month ? -1 : 1));
  }

  // Per-model adoption timeline from `graph` contributions (per-day × client × model).
  const modelTimeline = {}; // model → { firstSeen, lastSeen, days, tokens, cost, messages }
  if (graph?.contributions) {
    for (const day of graph.contributions) {
      const date = day.date;
      if (!date) continue;
      for (const c of day.clients || []) {
        const model = c.modelId;
        if (isBookkeepingModel(model)) continue;
        if (!modelTimeline[model]) {
          modelTimeline[model] = {
            model,
            first_seen: date,
            last_seen: date,
            days: 0,
            tokens: 0,
            cost: 0,
            messages: 0,
            clients: new Set(),
          };
        }
        const t = modelTimeline[model];
        if (date < t.first_seen) t.first_seen = date;
        if (date > t.last_seen) t.last_seen = date;
        t.days += 1;
        const tok = num(c.tokens?.input) + num(c.tokens?.output) + num(c.tokens?.cacheRead) + num(c.tokens?.cacheWrite) + num(c.tokens?.reasoning);
        t.tokens += tok;
        t.cost += num(c.cost);
        t.messages += num(c.messages);
        if (c.client) t.clients.add(c.client);
      }
    }
  }

  const models = Object.values(modelTimeline).map((t) => ({
    model: t.model,
    first_seen: t.first_seen,
    last_seen: t.last_seen,
    active_days: t.days,
    tokens: t.tokens,
    cost: r2(t.cost),
    messages: t.messages,
    client_count: t.clients.size,
    clients: [...t.clients].sort(),
  }));
  models.sort((a, b) => b.tokens - a.tokens);

  // Adoption curve: for each month, how many NEW models appeared (first_seen's
  // year-month == this month). first_seen is a full date ("2026-02-17"); m.month
  // is "2026-02", so compare the 7-char prefix.
  const adoptionCurve = months.map((m) => {
    const newModels = models
      .filter((x) => (x.first_seen || "").slice(0, 7) === m.month)
      .map((x) => x.model);
    return { month: m.month, new_models: newModels, new_model_count: newModels.length, total_models: m.model_count };
  });

  return {
    months,
    models,
    adoption_curve: adoptionCurve,
    date_range: graph?.meta?.dateRange ?? null,
  };
}

// ── 4. Cost analysis per developer per model ─────────────────────────────────

/**
 * Cost analysis: per-client × per-model cost breakdown with per-token rates,
 * cost share, and cost efficiency ranking. Built from `models`.
 */
export async function tokscaleCostAnalysis() {
  const entries = await _models();
  if (entries === null) {
    return { error: "tokscale models --json unavailable", entries: [], totals: {} };
  }
  if (!entries.length) return { entries: [], client_rollup: [], totals: { total_cost: 0 } };

  const rows = entries.map((e) => {
    const tok = totalTokens(e);
    const cost = num(e.cost);
    return {
      client: e.client,
      label: CLIENT_LABELS[e.client] || e.client,
      model: e.model,
      provider: e.provider || null,
      tokens: tok,
      cost: r2(cost),
      messages: num(e.messageCount),
      cost_per_million_tokens: tok > 0 ? r4((cost / tok) * 1_000_000) : 0,
      cost_per_message: num(e.messageCount) > 0 ? r4(cost / num(e.messageCount)) : 0,
      input: num(e.input),
      output: num(e.output),
      cache_read: num(e.cacheRead),
      cache_write: num(e.cacheWrite),
    };
  });

  rows.sort((a, b) => b.cost - a.cost);

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalTok = rows.reduce((s, r) => s + r.tokens, 0);
  const totalMessages = rows.reduce((s, r) => s + r.messages, 0);

  // Attach cost share to each row now that the total is known.
  for (const r of rows) {
    r.share_cost = totalCost > 0 ? r2((r.cost / totalCost) * 100) : 0;
  }

  // Per-client cost rollup.
  const byClient = {};
  for (const r of rows) {
    if (!byClient[r.client]) {
      byClient[r.client] = { client: r.client, label: r.label, cost: 0, tokens: 0, messages: 0, models: 0 };
    }
    byClient[r.client].cost += r.cost;
    byClient[r.client].tokens += r.tokens;
    byClient[r.client].messages += r.messages;
    byClient[r.client].models += 1;
  }
  const clientRollup = Object.values(byClient).map((c) => ({
    ...c,
    cost: r2(c.cost),
    cost_per_million_tokens: c.tokens > 0 ? r4((c.cost / c.tokens) * 1_000_000) : 0,
    share_cost: totalCost > 0 ? r2((c.cost / totalCost) * 100) : 0,
  }));
  clientRollup.sort((a, b) => b.cost - a.cost);

  const cheapest = rows.filter((r) => r.tokens > 0).sort((a, b) => a.cost_per_million_tokens - b.cost_per_million_tokens)[0];

  return {
    entries: rows,
    client_rollup: clientRollup,
    totals: {
      total_cost: r2(totalCost),
      total_tokens: totalTok,
      total_messages: totalMessages,
      avg_cost_per_million_tokens: totalTok > 0 ? r4((totalCost / totalTok) * 1_000_000) : 0,
      most_expensive_model: rows[0] ? { model: rows[0].model, client: rows[0].client, cost: rows[0].cost } : null,
      cheapest_per_token: cheapest
        ? { model: cheapest.model, cost_per_million_tokens: cheapest.cost_per_million_tokens }
        : null,
    },
  };
}

// ── 5. Device fingerprinting (installed tools, machines, active times) ──────

/**
 * Device profile: which AI tools are installed on this machine, where their session
 * logs live (redacted), how many sessions/messages each has, when the machine was
 * active, session concurrency, and longest continuous session. Combines `clients`
 * and `graph` (which already embeds timeMetrics, so no separate time-metrics call
 * is needed — avoids parallel tokscale cache-lock contention). All paths redacted.
 */
export async function tokscaleDeviceProfile() {
  // Run sequentially: tokscale uses a shared cache and parallel invocations can
  // conflict on the lock file. `graph` embeds timeMetrics so we save one call.
  const clients = await _clients();
  const graph = await _graph();
  const timeMetrics = graph?.timeMetrics ?? null;

  if (clients === null && graph === null) {
    return { error: "tokscale clients/graph unavailable" };
  }

  const installed = [];
  if (clients?.clients) {
    for (const cl of clients.clients) {
      installed.push({
        client: cl.client,
        label: CLIENT_LABELS[cl.client] || cl.client,
        sessions_path: redactPath(cl.sessionsPath),
        sessions_path_exists: !!cl.sessionsPathExists,
        message_count: num(cl.messageCount),
        headless_supported: !!cl.headlessSupported,
        headless_message_count: num(cl.headlessMessageCount),
      });
    }
  }

  // Active days + per-day activity from `graph` contributions.
  let activeDays = 0;
  let totalDays = 0;
  const dailyActivity = [];
  if (graph?.contributions) {
    totalDays = graph.contributions.length;
    for (const day of graph.contributions) {
      const tok = num(day.totals?.tokens);
      const msg = num(day.totals?.messages);
      if (tok > 0 || msg > 0) activeDays += 1;
      dailyActivity.push({
        date: day.date,
        tokens: tok,
        cost: r2(day.totals?.cost),
        messages: msg,
        active_time_ms: num(day.activeTimeMs),
        client_count: (day.clients || []).length,
      });
    }
  }

  // Hourly activity heatmap from `graph` summary (which days of week / hours are hot).
  // We derive day-of-week from the contribution dates.
  const dowBuckets = [0, 0, 0, 0, 0, 0, 0]; // Sun-Sat
  for (const d of dailyActivity) {
    if (!d.date) continue;
    const dow = new Date(d.date + "T00:00:00Z").getUTCDay();
    if (Number.isFinite(dow)) dowBuckets[dow] += d.tokens;
  }
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDayOfWeek = dayNames.map((name, i) => ({ day: name, tokens: dowBuckets[i] }));

  const installedCount = installed.filter((i) => i.sessions_path_exists).length;

  return {
    installed_tools: installed,
    installed_tool_count: installed.length,
    active_tool_count: installedCount,
    date_range: graph?.meta?.dateRange ?? null,
    activity: {
      total_days: totalDays,
      active_days: activeDays,
      active_day_pct: totalDays > 0 ? r2((activeDays / totalDays) * 100) : 0,
      daily: dailyActivity,
      by_day_of_week: byDayOfWeek,
    },
    sessions: timeMetrics
      ? {
          session_count: num(timeMetrics.sessionCount),
          total_active_time_ms: num(timeMetrics.totalActiveTimeMs),
          total_active_time_hours: r2(num(timeMetrics.totalActiveTimeMs) / 3_600_000),
          longest_continuous_ms: num(timeMetrics.longestContinuousMs),
          longest_continuous_hours: r2(num(timeMetrics.longestContinuousMs) / 3_600_000),
          max_concurrent_sessions: num(timeMetrics.maxConcurrentSessions),
        }
      : null,
    summary: graph?.summary
      ? {
          total_tokens: num(graph.summary.totalTokens),
          total_cost: r2(graph.summary.totalCost),
          average_cost_per_day: r2(graph.summary.averagePerDay),
          max_cost_single_day: r2(graph.summary.maxCostInSingleDay),
        }
      : null,
  };
}

// ── 6. MCP server usage patterns ─────────────────────────────────────────────

/**
 * MCP server usage: which MCP servers tokscale detected, plus a cross-reference of
 * when they were active (derived from `graph` mcpServers + contributions timeline).
 * tokscale's `graph` exposes mcpServers as a flat list of detected server names.
 */
export async function tokscaleMcpUsage() {
  const graph = await _graph();
  if (graph === null) {
    return { error: "tokscale graph unavailable", servers: [] };
  }

  const servers = Array.isArray(graph.mcpServers) ? graph.mcpServers : [];
  const contributions = graph.contributions || [];

  // tokscale does not currently tag individual contributions with the MCP server
  // that was active per session, so we report the detected set + the overall
  // activity window during which MCP servers were present.
  const dateRange = graph.meta?.dateRange ?? null;
  const activeDays = contributions.filter(
    (c) => num(c.totals?.tokens) > 0 || num(c.totals?.messages) > 0,
  ).length;

  return {
    servers: servers.map((name) => ({ name, detected: true })),
    server_count: servers.length,
    detection_window: dateRange,
    active_days_in_window: activeDays,
    note: servers.length === 0
      ? "No MCP servers detected by tokscale. MCP server usage tracking requires a tokscale version that records per-session MCP server attribution."
      : "tokscale reports detected MCP servers as a set. Per-session MCP server attribution is not yet exposed in the graph payload; the detection window reflects the full activity span.",
  };
}

// ── 7. Competitive intelligence for any AI tool company ──────────────────────

/**
 * Competitive intelligence for a single AI tool (by tokscale client slug or
 * canonical platform name). Returns the target tool's market share, model mix,
 * cost efficiency, performance, and a head-to-head comparison against every other
 * detected tool. Built from `models`.
 *
 * @param {string} target — tokscale client slug (e.g. "claude", "codex",
 *   "devin-cli") or canonical platform name (e.g. "devin", "other").
 */
export async function tokscaleCompetitiveIntel(target) {
  const entries = await _models();
  if (entries === null) {
    return { error: "tokscale models --json unavailable" };
  }
  if (!entries.length) return { target: target || null, found: false, competitors: [] };

  // Normalize the target: accept either a raw tokscale slug or a canonical
  // platform name from TOKSCALE_CLIENT_MAP.
  const targetSlug = String(target || "").trim().toLowerCase();
  if (!targetSlug) {
    return { error: "target is required (a tokscale client slug like 'claude' or 'codex')" };
  }

  // Build a reverse map: canonical platform → tokscale slugs.
  const platformToSlugs = {};
  for (const [slug, platform] of Object.entries(TOKSCALE_CLIENT_MAP)) {
    if (platform === null) continue;
    if (!platformToSlugs[platform]) platformToSlugs[platform] = [];
    platformToSlugs[platform].push(slug);
  }

  // Resolve which tokscale slugs match the target.
  let targetSlugs = [];
  if (TOKSCALE_CLIENT_MAP[targetSlug] !== undefined && TOKSCALE_CLIENT_MAP[targetSlug] !== null) {
    // Target is a canonical platform name → match all slugs mapping to it.
    targetSlugs = platformToSlugs[TOKSCALE_CLIENT_MAP[targetSlug]] || [];
  } else {
    // Target is a raw slug (may or may not be in the map).
    targetSlugs = [targetSlug];
  }

  // Aggregate per-client.
  const byClient = {};
  let totalTok = 0, totalCost = 0, totalMsg = 0;
  for (const e of entries) {
    const tok = totalTokens(e);
    const cost = num(e.cost);
    const msg = num(e.messageCount);
    if (tok === 0 && cost === 0 && msg === 0) continue;
    const key = e.client;
    if (!byClient[key]) {
      byClient[key] = {
        client: key,
        label: CLIENT_LABELS[key] || key,
        tokens: 0, cost: 0, messages: 0,
        input: 0, output: 0, cache_read: 0, cache_write: 0,
        models: new Map(),
      };
    }
    const c = byClient[key];
    c.tokens += tok; c.cost += cost; c.messages += msg;
    c.input += num(e.input); c.output += num(e.output);
    c.cache_read += num(e.cacheRead); c.cache_write += num(e.cacheWrite);
    const m = c.models.get(e.model) || { model: e.model, tokens: 0, cost: 0, messages: 0 };
    m.tokens += tok; m.cost += cost; m.messages += msg;
    c.models.set(e.model, m);
    totalTok += tok; totalCost += cost; totalMsg += msg;
  }

  const targetEntries = targetSlugs
    .map((s) => byClient[s])
    .filter(Boolean);

  if (!targetEntries.length) {
    const allClients = Object.keys(byClient).sort();
    return {
      target: targetSlug,
      found: false,
      note: `No usage found for "${targetSlug}". Detected clients: ${allClients.join(", ")}`,
      detected_clients: allClients,
    };
  }

  // Merge target slugs into one aggregate.
  const targetAgg = {
    client: targetSlugs.join("|"),
    label: CLIENT_LABELS[targetSlugs[0]] || targetSlugs[0],
    tokens: targetEntries.reduce((s, c) => s + c.tokens, 0),
    cost: targetEntries.reduce((s, c) => s + c.cost, 0),
    messages: targetEntries.reduce((s, c) => s + c.messages, 0),
    input: targetEntries.reduce((s, c) => s + c.input, 0),
    output: targetEntries.reduce((s, c) => s + c.output, 0),
    cache_read: targetEntries.reduce((s, c) => s + c.cache_read, 0),
    cache_write: targetEntries.reduce((s, c) => s + c.cache_write, 0),
    models: new Map(),
  };
  for (const c of targetEntries) {
    for (const m of c.models.values()) {
      const ex = targetAgg.models.get(m.model) || { model: m.model, tokens: 0, cost: 0, messages: 0 };
      ex.tokens += m.tokens; ex.cost += m.cost; ex.messages += m.messages;
      targetAgg.models.set(m.model, ex);
    }
  }

  const targetModels = [...targetAgg.models.values()].map((m) => ({
    ...m,
    cost: r2(m.cost),
    share_of_target_tokens: targetAgg.tokens > 0 ? r2((m.tokens / targetAgg.tokens) * 100) : 0,
  }));
  targetModels.sort((a, b) => b.tokens - a.tokens);

  const competitors = Object.values(byClient)
    .filter((c) => !targetSlugs.includes(c.client))
    .map((c) => ({
      client: c.client,
      label: c.label,
      tokens: c.tokens,
      cost: r2(c.cost),
      messages: c.messages,
      model_count: c.models.size,
      share_tokens: totalTok > 0 ? r2((c.tokens / totalTok) * 100) : 0,
      share_cost: totalCost > 0 ? r2((c.cost / totalCost) * 100) : 0,
      cost_per_million_tokens: c.tokens > 0 ? r4((c.cost / c.tokens) * 1_000_000) : 0,
    }));
  competitors.sort((a, b) => b.tokens - a.tokens);

  const targetCostPerM = targetAgg.tokens > 0 ? r4((targetAgg.cost / targetAgg.tokens) * 1_000_000) : 0;
  const targetCachePct = targetAgg.tokens > 0 ? r2((targetAgg.cache_read / targetAgg.tokens) * 100) : 0;

  // Rank the target against competitors.
  const allRanked = [
    { client: targetAgg.client, label: targetAgg.label, tokens: targetAgg.tokens, cost: targetAgg.cost },
    ...competitors.map((c) => ({ client: c.client, label: c.label, tokens: c.tokens, cost: c.cost })),
  ].sort((a, b) => b.tokens - a.tokens);
  const targetRank = allRanked.findIndex((c) => c.client === targetAgg.client) + 1;

  return {
    target: targetAgg.client,
    label: targetAgg.label,
    found: true,
    rank_by_tokens: targetRank,
    total_tools_detected: allRanked.length,
    target_profile: {
      tokens: targetAgg.tokens,
      cost: r2(targetAgg.cost),
      messages: targetAgg.messages,
      input: targetAgg.input,
      output: targetAgg.output,
      cache_read: targetAgg.cache_read,
      cache_write: targetAgg.cache_write,
      cache_read_pct: targetCachePct,
      model_count: targetAgg.models.size,
      cost_per_million_tokens: targetCostPerM,
      share_tokens: totalTok > 0 ? r2((targetAgg.tokens / totalTok) * 100) : 0,
      share_cost: totalCost > 0 ? r2((targetAgg.cost / totalCost) * 100) : 0,
      share_messages: totalMsg > 0 ? r2((targetAgg.messages / totalMsg) * 100) : 0,
      models: targetModels,
    },
    competitors,
    market_totals: {
      tokens: totalTok,
      cost: r2(totalCost),
      messages: totalMsg,
      tool_count: Object.keys(byClient).length,
    },
  };
}
