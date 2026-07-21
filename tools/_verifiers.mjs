/**
 * tools/_verifiers.mjs — on-device verifier readers for tokenpull_compare.
 *
 * Mirrors the implementations in presentation/cli.mjs + presentation/tui.mjs
 * without circular imports. Used by the tokenpull_compare tool for quick
 * side-by-side comparison across local token sources.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileAsync } from "./_helpers.mjs";

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

export { _ccusagePillars, _tokenDashPillars, _tokscalePillars };
