/**
 * cli.mjs — SigRank terminal UI.
 *
 * Default (no command): full unified view — all platforms, all windows, token pillars,
 *   board position, [S] submit prompt.
 *
 * Commands:
 *   npx sigrank                      full unified view (default)
 *   npx sigrank board                live leaderboard, refreshes every 30s
 *   npx sigrank board --window 7d    board for a specific window
 *   npx sigrank board --once         print once and exit (no live refresh)
 *   npx sigrank compare              raw pillar comparison: ccusage vs tokenpull vs token-dashboard
 *   npx sigrank watch                RT tune meter — ALL active platforms × all windows
 *   npx sigrank watch --platform X   watch one platform only (optional filter)
 *   npx sigrank watch --window 7d    watch one window only (optional filter)
 *
 * Color palette mirrors the SigRank web dark theme:
 *   gold = class TRANSMITTER headline + rank #1
 *   cyan = active metrics / your row highlight
 *   dim  = secondary data, separators
 *   red  = negative movement / delta
 *   green = positive movement
 */

import { callTool, DEFAULT_API_BASE, pullActivePlatforms } from "./tools.mjs";
import { classify } from "./cascade.mjs";
import { ensureIdentity, keystorePath } from "./keystore.mjs";
import { submitSignedWindow } from "./submit.mjs";
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// Resolve local node_modules/.bin for bundled deps (ccusage, tokscale)
const _pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const _localBin = path.join(_pkgRoot, "node_modules", ".bin");
const _envPath = `${_localBin}${process.env.PATH ? ":" + process.env.PATH : ""}`;

// ASYNC FIX (2026-06-27): execFile wrapped in a Promise — replaces execSync for
// defense-in-depth (shell injection prevention). execFile passes args as an
// array, so no shell parsing occurs — even if platform contained special chars,
// they'd be treated as literal arguments, not shell commands.
// BIN FIX (2026-06-27): PATH includes local node_modules/.bin so bundled deps
// are found even when sigrank isn't globally installed.
function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
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

// ── ANSI helpers (no chalk dep) ────────────────────────────────────────────
const ESC = "\x1b[";
const c = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  gold: `${ESC}33m`,
  boldGold: `${ESC}1;33m`,
  cyan: `${ESC}36m`,
  boldCyan: `${ESC}1;36m`,
  green: `${ESC}32m`,
  red: `${ESC}31m`,
  white: `${ESC}97m`,
  boldWhite: `${ESC}1;97m`,
  magenta: `${ESC}35m`,
  blue: `${ESC}34m`,
};
const paint = (color, str) => `${color}${str}${c.reset}`;
const bold = (str) => paint(c.bold, str);
const dim = (str) => paint(c.dim, str);
const gold = (str) => paint(c.boldGold, str);
const cyan = (str) => paint(c.boldCyan, str);
const green = (str) => paint(c.green, str);
const red = (str) => paint(c.red, str);

// ── Class tier → color ─────────────────────────────────────────────────────
const CLASS_COLOR = {
  TRANSMITTER: (s) => paint(c.boldGold, s),
  "ARCH+": (s) => paint(c.boldCyan, s),
  ARCH: (s) => paint(c.cyan, s),
  POWER: (s) => paint(c.boldWhite, s),
  BASE: (s) => paint(c.white, s),
  SEEKER: (s) => paint(c.magenta, s),
  REFINER: (s) => paint(c.blue, s),
  BEARER: (s) => paint(c.dim, s),
  IGNITER: (s) => paint(c.dim, s),
};
const colorClass = (cls) => (CLASS_COLOR[cls] ?? ((s) => s))(cls);

// ── Terminal utils ──────────────────────────────────────────────────────────
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const CURSOR_UP = (n) => `${ESC}${n}A`;
const ERASE_LINE = `${ESC}2K`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const termWidth = () => process.stdout.columns || 80;
const write = (s) => process.stdout.write(s);
const writeln = (s = "") => process.stdout.write(s + "\n");

// Right-pad or truncate to exact width (ANSI-escape-aware via strip helper)
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
function padEnd(s, w) {
  const vis = stripAnsi(s).length;
  return vis >= w ? s : s + " ".repeat(w - vis);
}
function padStart(s, w) {
  const vis = stripAnsi(s).length;
  return vis >= w ? s : " ".repeat(w - vis) + s;
}
function trunc(s, w) {
  const stripped = stripAnsi(s);
  if (stripped.length <= w) return s;
  // truncate the raw string, not the escape-aware one — safe for plain strings
  return s.slice(0, w - 1) + "…";
}

// ── Number formatters ───────────────────────────────────────────────────────
const fmtYield = (y) => {
  if (y == null) return "—";
  if (y >= 10000) return `${(y / 1000).toFixed(1)}K`;
  if (y >= 1000) return `${(y / 1000).toFixed(2)}K`;
  return y.toFixed(1);
};
const fmtLev = (l) => {
  if (l == null) return "—";
  if (l >= 1000) return `${(l / 1000).toFixed(1)}K`;
  return l.toFixed(0);
};
const fmtPct = (n) => (n != null ? `${(n * 100).toFixed(0)}%` : "—");
const fmtSNR = (n) => (n != null ? `${(n * 100).toFixed(1)}%` : "—");
const fmtMove = (n) => {
  if (n == null || n === 0) return dim("  —");
  return n > 0 ? green(`+${n}`) : red(`${n}`);
};
const fmtTokens = (n) => {
  if (n == null) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

// ── Header / footer ─────────────────────────────────────────────────────────
function renderHeader(title, subtitle = "") {
  const w = termWidth();
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const right = dim(`signalaf.com  ${ts}`);
  const rightVis = stripAnsi(right).length;
  const leftVis = stripAnsi(title).length;
  const gap = Math.max(1, w - leftVis - rightVis);
  writeln();
  writeln(`  ${title}${" ".repeat(gap)}${right}`);
  if (subtitle) writeln(`  ${dim(subtitle)}`);
  writeln(`  ${dim("─".repeat(w - 4))}`);
}

function renderFooter(hint = "") {
  const w = termWidth();
  writeln(`  ${dim("─".repeat(w - 4))}`);
  if (hint) writeln(`  ${dim(hint)}`);
  writeln();
}

// ── BOARD command ────────────────────────────────────────────────────────────

const BOARD_COLS = [
  { key: "rank", label: "#", w: 4, align: "r" },
  { key: "codename", label: "Operator", w: 20, align: "l" },
  { key: "class_tier", label: "Class", w: 13, align: "l" },
  { key: "yield_", label: "Υ Yield", w: 9, align: "r" },
  { key: "compression_ratio", label: "SNR", w: 6, align: "r" },
  { key: "session_depth", label: "Depth", w: 6, align: "r" },
  { key: "token_throughput", label: "Tokens", w: 8, align: "r" },
  { key: "movement_7d", label: "7d Δ", w: 6, align: "r" },
];

function renderBoardRow(entry, highlight = false) {
  const rank = entry.rank === 1 ? gold(`#${entry.rank}`) : `#${entry.rank}`;
  const name = highlight
    ? cyan(trunc(entry.codename, 19))
    : trunc(entry.codename, 19);
  const cls = colorClass(entry.class_tier ?? "—");
  const yld = entry.yield_ != null ? fmtYield(entry.yield_) : "—";
  const snr = fmtSNR(entry.compression_ratio);
  const dep =
    entry.session_depth != null ? entry.session_depth.toFixed(1) : "—";
  const tok = fmtTokens(entry.token_throughput);
  const mv = fmtMove(entry.movement_7d);

  const cols = [
    padStart(rank, 4),
    padEnd(name, 20),
    padEnd(cls, 13),
    padStart(yld, 9),
    padStart(snr, 6),
    padStart(dep, 6),
    padStart(tok, 8),
    padStart(mv, 6),
  ];
  const prefix = highlight ? `${c.boldCyan}▶${c.reset} ` : "  ";
  writeln(prefix + cols.join("  "));
}

function renderBoardHeader(window = "30d") {
  renderHeader(
    `${gold("⊙ SigRank")} ${bold("Leaderboard")}`,
    `window: ${window}  ·  sorted by Υ Yield  ·  top 25 operators`,
  );
  // column headers
  const headers = BOARD_COLS.map((col) =>
    col.align === "r"
      ? padStart(dim(col.label), col.w)
      : padEnd(dim(col.label), col.w),
  );
  writeln(`    ${headers.join("  ")}`);
  writeln(`  ${dim("·".repeat(termWidth() - 4))}`);
}

async function fetchBoard(window = "30d") {
  const res = await fetch(
    `${DEFAULT_API_BASE}/api/v1/leaderboard?window=${window}&metric=yield_`,
    {
      headers: { accept: "application/json" },
    },
  );
  if (!res.ok) throw new Error(`Board API → HTTP ${res.status}`);
  return res.json();
}

async function runBoard({ window = "30d", once = false, refresh = 30 } = {}) {
  let lines = 0;

  const draw = async () => {
    let data;
    try {
      data = await fetchBoard(window);
    } catch (e) {
      writeln(red(`  ✗ Could not reach signalaf.com: ${e.message}`));
      return;
    }

    if (!once && lines > 0) {
      // move cursor up and redraw in-place
      write(CURSOR_UP(lines));
    }

    const out = [];
    const push = (s = "") => out.push(s);

    push();
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    const right = `signalaf.com  ${ts}`;
    const title = `⊙ SigRank Leaderboard`;
    const w = termWidth();
    const gap = Math.max(1, w - 2 - title.length - right.length);
    push(
      `  ${gold("⊙ SigRank")} ${bold("Leaderboard")}${" ".repeat(gap)}${dim(right)}`,
    );
    push(
      `  ${dim(`window: ${data.window ?? window}  ·  ${data.total_operators ?? data.entries?.length ?? 0} operators`)}`,
    );
    push(`  ${dim("─".repeat(w - 4))}`);

    // column header row
    const headers = BOARD_COLS.map((col) =>
      col.align === "r"
        ? padStart(dim(col.label), col.w)
        : padEnd(dim(col.label), col.w),
    ).join("  ");
    push(`    ${headers}`);
    push(`  ${dim("·".repeat(w - 4))}`);

    const entries = data.entries ?? [];
    for (const entry of entries) {
      const rank = entry.rank === 1 ? gold(`#${entry.rank}`) : `#${entry.rank}`;
      const name = trunc(entry.codename ?? "—", 19);
      const cls = colorClass(entry.class_tier ?? "—");
      const yld = entry.yield_ != null ? fmtYield(entry.yield_) : "—";
      const snr = fmtSNR(entry.compression_ratio);
      const dep =
        entry.session_depth != null ? entry.session_depth.toFixed(1) : "—";
      const tok = fmtTokens(entry.token_throughput);
      const mv = fmtMove(entry.movement_7d);
      const cols = [
        padStart(rank, 4),
        padEnd(name, 20),
        padEnd(cls, 13),
        padStart(yld, 9),
        padStart(snr, 6),
        padStart(dep, 6),
        padStart(tok, 8),
        padStart(mv, 6),
      ];
      push(`  ${cols.join("  ")}`);
    }

    push(`  ${dim("─".repeat(w - 4))}`);
    if (!once)
      push(`  ${dim(`auto-refresh every ${refresh}s  ·  ctrl+c to exit`)}`);
    push();

    // write all at once to minimize flicker
    const rendered = out.join("\n");
    write(rendered);
    lines = out.length;
  };

  if (!once) write(HIDE_CURSOR);
  try {
    await draw();
    if (!once) {
      const iv = setInterval(draw, refresh * 1000);
      await new Promise((resolve) => {
        process.on("SIGINT", () => {
          clearInterval(iv);
          resolve();
        });
      });
    }
  } finally {
    if (!once) write(SHOW_CURSOR + "\n");
  }
}

// ── COMPARE command ───────────────────────────────────────────────────────────
// Side-by-side: ccusage (JSON) vs tokenpull vs token-dashboard (SQLite)
//
// NOTE (P3 2026-06-27): These sync verifier readers (ccusagePillars / tokscalePillars /
// tokenDashPillars / appPillars) are INTENTIONALLY separate from tokenpull.mjs
// `freshVerifierPillars()`. The compare command uses cached/file-based data sources
// (tokscale_report.json, direct db read with windowed+model-filtered queries) for a
// quick side-by-side, while freshVerifierPillars runs all three live (bunx tokscale,
// scan+read tokendash) for the dashboard. Merging them would change compare's data
// source and lose the windowed tokendash breakdown. ccusagePillars IS functionally
// identical to _freshCcusage and could be consolidated in a future pass if compare
// switches to live data — but that's a behavior change, not a refactor.

async function ccusagePillars(platform = "claude") {
  // ccusage <platform> daily --json → sum by window
  try {
    const raw = await execFileAsync(
      "ccusage",
      [platform, "daily", "--json"],
      15000,
    );
    const data = JSON.parse(raw);
    const rows = data.daily ?? data; // ccusage may return {daily:[...]} or [...]

    const now = Date.now();
    const cutoff = { "7d": 7, "30d": 30, "90d": 90 };
    const result = {};

    for (const [win, days] of Object.entries(cutoff)) {
      const since = new Date(now - days * 86400000);
      let input = 0,
        output = 0,
        cacheCreate = 0,
        cacheRead = 0;
      for (const row of rows) {
        const d = new Date(row.date ?? row.day ?? row.week ?? "1970-01-01");
        if (d >= since) {
          input += row.inputTokens ?? row.input_tokens ?? 0;
          output += row.outputTokens ?? row.output_tokens ?? 0;
          cacheCreate +=
            row.cacheCreationTokens ?? row.cache_create_tokens ?? 0;
          cacheRead += row.cacheReadTokens ?? row.cache_read_tokens ?? 0;
        }
      }
      result[win] = { input, output, cacheCreate, cacheRead };
    }
    // all-time = sum everything
    let input = 0,
      output = 0,
      cacheCreate = 0,
      cacheRead = 0;
    for (const row of rows) {
      input += row.inputTokens ?? row.input_tokens ?? 0;
      output += row.outputTokens ?? row.output_tokens ?? 0;
      cacheCreate += row.cacheCreationTokens ?? row.cache_create_tokens ?? 0;
      cacheRead += row.cacheReadTokens ?? row.cache_read_tokens ?? 0;
    }
    result["all"] = { input, output, cacheCreate, cacheRead };
    return result;
  } catch {
    return null;
  }
}

async function tokscalePillars(platform = "claude") {
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
      const p = rows.reduce(
        (acc, e) => ({
          input: acc.input + (Number(e.input) || 0),
          output: acc.output + (Number(e.output) || 0),
          cacheCreate: acc.cacheCreate + (Number(e.cacheWrite) || 0),
          cacheRead: acc.cacheRead + (Number(e.cacheRead) || 0),
        }),
        { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      );
      return { all: p };
    }
  } catch {
    /* fall through to file-based read */
  }
  // Fallback: read saved tokscale_report.json — all-time only (no timestamps in export)
  const reportPath = path.join(os.homedir(), "tokscale_report.json");
  if (!existsSync(reportPath)) return null;
  try {
    const data = JSON.parse(readFileSync(reportPath, "utf8"));
    const entries = data.entries ?? [];
    const rows = entries.filter(
      (e) =>
        e.client === platform &&
        e.model !== "<synthetic>" &&
        e.model !== "unknown" &&
        (e.input > 0 || e.output > 0),
    );
    if (rows.length === 0) return null;
    const p = rows.reduce(
      (acc, e) => ({
        input: acc.input + (e.input ?? 0),
        output: acc.output + (e.output ?? 0),
        cacheCreate: acc.cacheCreate + (e.cacheWrite ?? 0),
        cacheRead: acc.cacheRead + (e.cacheRead ?? 0),
      }),
      { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    );
    // tokscale export has no timestamps → only all-time available
    return { all: p };
  } catch {
    return null;
  }
}

function appPillars() {
  // App numbers from screenshots — all-time, per model (no cache fields)
  // Hard-coded from 2026-06-23 screenshot capture (update when re-screenshotted)
  return {
    all: {
      input: 6_378_000, // sum of all models: 5.6M + 102.1K + 92.9K + 130.3K + 418.9K + 33.5K
      output: 38_682_400, // sum: 19.6M + 6.5M + 5.4M + 6.6M + 292.4K + 290.4K
      cacheCreate: null, // not shown in App UI
      cacheRead: null, // not shown in App UI
    },
    _note:
      "App UI — all-time, per-model sum from screenshots 2026-06-23. No cache fields. Update when re-screenshotted.",
    _perModel: [
      { model: "claude-opus-4-8", input: 5_600_000, output: 19_600_000 },
      { model: "claude-sonnet-4-5", input: 102_100, output: 6_500_000 },
      { model: "claude-sonnet-4-6", input: 92_900, output: 5_400_000 },
      { model: "claude-opus-4-7", input: 130_300, output: 6_600_000 },
      { model: "claude-fable-5", input: 418_900, output: 292_400 },
      { model: "claude-haiku-4-5", input: 33_500, output: 290_400 },
    ],
  };
}

async function tokenDashPillars() {
  const dbPath = path.join(os.homedir(), ".claude", "token-dashboard.db");
  if (!existsSync(dbPath)) return null;
  // Read directly with sqlite3 — no python script needed (bundled dep).
  // Windowed queries using sqlite3's datetime() function.
  const cf =
    "(model LIKE '%claude%' OR model LIKE '%fable%' OR model LIKE '%sonnet%' OR model LIKE '%opus%' OR model LIKE '%haiku%')";
  try {
    const wins = [
      ["7d", "datetime('now','-7 days')"],
      ["30d", "datetime('now','-30 days')"],
      ["90d", "datetime('now','-90 days')"],
    ];
    const sql = (cutoff) =>
      `SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens+cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages WHERE timestamp>=${cutoff} AND ${cf}`;
    const allSql = `SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens+cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages WHERE ${cf}`;
    const [d7, d30, d90, dAll] = await Promise.all([
      execFileAsync("sqlite3", [dbPath, sql(wins[0][1])], 5000),
      execFileAsync("sqlite3", [dbPath, sql(wins[1][1])], 5000),
      execFileAsync("sqlite3", [dbPath, sql(wins[2][1])], 5000),
      execFileAsync("sqlite3", [dbPath, allSql], 5000),
    ]);
    const parse = (raw) => {
      const [i, o, cw, cr] = raw.trim().split("|").map(Number);
      return {
        input: i || 0,
        output: o || 0,
        cacheCreate: cw || 0,
        cacheRead: cr || 0,
      };
    };
    return {
      "7d": parse(d7),
      "30d": parse(d30),
      "90d": parse(d90),
      all: parse(dAll),
    };
  } catch {
    return null;
  }
}

function fmtDelta(a, b) {
  if (a == null || b == null) return dim("  —");
  const d = b - a;
  if (d === 0) return dim("  =");
  const pct =
    a !== 0 ? `${d > 0 ? "+" : ""}${((d / a) * 100).toFixed(1)}%` : "";
  const abs = `${d > 0 ? "+" : ""}${fmtTokens(Math.abs(d))}`;
  const label = `${abs} ${pct}`;
  return d > 0 ? green(label) : red(label);
}

// Compute cascade metrics from raw pillars (mirrors bridge.ts computeCascadeMetrics)
function cascadeFromPillars(p) {
  if (!p) return null;
  const i = p.input ?? 0;
  const o = p.output ?? 0;
  const cw = p.cacheCreate ?? 0;
  const cr = p.cacheRead ?? 0;
  if (i === 0 && o === 0) return null;
  const safeI = Math.max(i, 1);
  const total = i + o + cw + cr;
  const velocity = o / safeI;
  const leverage = cr / safeI;
  const yield_ = leverage * velocity;
  const snr = i + o > 0 ? o / (i + o) : 0;
  // dev10x = log10(T × C × R) — only when all four pillars present
  let dev10x = null;
  if (cw > 0 && o > 0 && i > 0 && cr > 0) {
    const T = o / i,
      C = cw / o,
      R = cr / cw;
    dev10x = Math.log10(T * C * R);
  }
  // efficiency = ((cr+cw+o)/i) / 4.0
  const efficiency = (cr + cw + o) / safeI / 4.0;
  const cls = classify(yield_, dev10x);
  return {
    yield: yield_,
    velocity,
    leverage,
    snr,
    dev10x,
    efficiency,
    class: cls,
    total,
  };
}

async function runCompare({ platform = "claude" } = {}) {
  write(HIDE_CURSOR);

  // Pull all five sources in parallel (verifiers now async via execFile)
  writeln(`  ${dim("reading all 5 sources…")}`);
  const [ccPillars, tpData, tdPillars, tsPillars, apPillars] =
    await Promise.all([
      ccusagePillars(platform).catch(() => null),
      callTool("tokenpull", { platform }).catch(() => null),
      (platform === "claude"
        ? tokenDashPillars()
        : Promise.resolve(null)
      ).catch(() => null),
      tokscalePillars(platform).catch(() => null),
      Promise.resolve(platform === "claude" ? appPillars() : null),
    ]);
  write(CURSOR_UP(1) + ERASE_LINE);

  const w = termWidth();
  const WINS = ["7d", "30d", "90d", "all"];
  const WIN_LABEL = { "7d": "7d", "30d": "30d", "90d": "90d", all: "all-time" };

  // build tokenpull pillar lookup
  const tpPillars = {};
  for (const win of tpData?.windows ?? []) {
    tpPillars[win.window] = win.pillars;
  }

  // sources: name, color, pillars-by-window, note
  const SOURCES = [
    {
      name: "tokenpull",
      color: cyan,
      pillars: tpPillars,
      note: "JSONL deduped by msg id · canon source",
    },
    {
      name: "ccusage",
      color: (s) => paint(c.green, s),
      pillars: ccPillars ?? {},
      note: "ccusage claude subcommand · monthly only",
    },
    {
      name: "token-dash",
      color: (s) => paint(c.magenta, s),
      pillars: tdPillars ?? {},
      note: "SQLite — double-counts sessions · use with caution",
    },
    {
      name: "tokscale",
      color: (s) => paint(c.blue, s),
      pillars: tsPillars ?? {},
      note: "all-time only · partial export (~5% of opus-4-8)",
    },
    {
      name: "App",
      color: gold,
      pillars: apPillars ?? {},
      note: "screenshots 2026-06-23 · no cache fields · update manually",
    },
  ];

  writeln();
  writeln(
    `  ${gold("⊙ SigRank")} ${bold("Source Comparison")}  ${dim(`platform: ${platform}`)}  ${dim("tokenpull · ccusage · token-dash · tokscale")}`,
  );
  writeln(`  ${dim("─".repeat(w - 4))}`);

  // ── PILLARS TABLE ──────────────────────────────────────────────────────────
  const PILLARS = [
    { key: "input", label: "Input" },
    { key: "output", label: "Output" },
    { key: "cacheCreate", label: "Cache Write" },
    { key: "cacheRead", label: "Cache Read" },
  ];

  for (const { key, label } of PILLARS) {
    writeln();
    writeln(`  ${bold(label)}`);
    const hcols = [
      padEnd(dim("Source"), 14),
      ...WINS.map((win) => padStart(dim(WIN_LABEL[win]), 13)),
    ];
    writeln(`    ${hcols.join("  ")}`);
    writeln(`  ${dim("·".repeat(Math.min(w - 4, 14 + WINS.length * 15)))}`);

    for (const src of SOURCES) {
      const vals = WINS.map((win) => {
        const p = src.pillars[win];
        const v = p?.[key];
        if (v == null) return padStart(dim("—"), 13);
        return padStart(fmtTokens(v), 13);
      });
      writeln(`    ${padEnd(src.color(src.name), 14)}  ${vals.join("  ")}`);
    }
  }

  // ── SIGNATURE TABLE ────────────────────────────────────────────────────────
  writeln();
  writeln(`  ${dim("─".repeat(w - 4))}`);
  writeln(
    `  ${bold("Cascade Signature")}  ${dim("per source · all windows where data available")}`,
  );
  writeln();

  const SIG_METRICS = [
    { key: "yield", label: "Υ Yield", fmt: (v) => fmtYield(v), w: 9 },
    { key: "velocity", label: "Vel", fmt: (v) => v.toFixed(2), w: 6 },
    { key: "leverage", label: "Lev", fmt: (v) => `${fmtLev(v)}×`, w: 7 },
    { key: "snr", label: "SNR", fmt: (v) => fmtSNR(v), w: 6 },
    { key: "dev10x", label: "10x", fmt: (v) => v.toFixed(2), w: 5 },
    { key: "efficiency", label: "Eff", fmt: (v) => v.toFixed(1), w: 6 },
    { key: "class", label: "Class", fmt: (v) => colorClass(v), w: 12 },
  ];

  // header
  const sigHdr = [
    padEnd(dim("Source"), 14),
    padEnd(dim("Window"), 8),
    ...SIG_METRICS.map((m) => padStart(dim(m.label), m.w)),
  ];
  writeln(`    ${sigHdr.join("  ")}`);
  writeln(`  ${dim("·".repeat(Math.min(w - 4, 80)))}`);

  for (const src of SOURCES) {
    const availWins = WINS.filter((win) => src.pillars[win] != null);
    if (availWins.length === 0) {
      writeln(`    ${padEnd(src.color(src.name), 14)}  ${dim("no data")}`);
      continue;
    }
    let first = true;
    for (const win of availWins) {
      const p = src.pillars[win];
      // For tokenpull, use the pre-computed cascade from the tool if available
      let cas;
      if (src.name === "tokenpull") {
        const tpWin = tpData?.windows?.find((ww) => ww.window === win);
        cas = tpWin?.cascade
          ? {
              yield: tpWin.cascade.yield,
              velocity: tpWin.cascade.velocity,
              leverage: tpWin.cascade.leverage,
              snr: tpWin.cascade.snr,
              dev10x: tpWin.cascade.dev10x,
              efficiency: null,
              class: tpWin.cascade.class,
            }
          : cascadeFromPillars(p);
      } else {
        cas = cascadeFromPillars(p);
      }

      const srcLabel = first
        ? src.color(src.name)
        : " ".repeat(stripAnsi(src.name).length);
      const winLabel = win === "all" ? bold("all-time") : win;
      const sigCols = SIG_METRICS.map((m) => {
        const v = cas?.[m.key];
        return padStart(v != null ? m.fmt(v) : dim("—"), m.w);
      });
      writeln(
        `    ${padEnd(srcLabel, 14)}  ${padEnd(winLabel, 8)}  ${sigCols.join("  ")}`,
      );
      first = false;
    }
  }

  // ── NOTES ─────────────────────────────────────────────────────────────────
  writeln();
  writeln(`  ${dim("─".repeat(w - 4))}`);
  for (const src of SOURCES) {
    writeln(`  ${src.color(src.name.padEnd(12))}  ${dim(src.note)}`);
  }
  writeln(
    `  ${dim("Eff = ((cacheRead+cacheWrite+output)/input)/4.0 vs AA baseline")}`,
  );
  writeln(
    `  ${dim("App has no cache fields → Υ/Lev/Eff/10x unavailable from App source")}`,
  );
  writeln();
  write(SHOW_CURSOR);
}

// ── WATCH command ─────────────────────────────────────────────────────────────
//
// A5: by default (no --platform / --window) the watcher auto-loads EVERYTHING — every
// active platform (input+output > 0) × every window (7d/30d/90d/all), refreshed each tick.
// --platform / --window remain OPTIONAL filters for back-compat (focus one cell). The
// refresh loop + --submit behavior are preserved; submit publishes whichever windows are
// shown whenever their Υ changes.

const WATCH_WINDOWS = ["7d", "30d", "90d", "all"];

// Detect which platforms have real local data (input+output > 0 in any window) via tokenpull.
// Returns an array of pull results (the same shape tokenpullAny yields), one per active platform.
async function detectActivePulls() {
  // Unified: one loader for me / watch / the TUI Dashboard (was a separate tokenpullAny loop).
  return pullActivePlatforms();
}

async function runWatch({
  platform,
  window: win,
  refresh = 30,
  submit = false,
} = {}) {
  let lines = 0;
  const id = submit ? ensureIdentity() : null;
  const enrolled = !!(
    id &&
    id.codename &&
    id.operator_id &&
    id.private_key_pkcs8_b64
  );

  // Filters: when provided, narrow the grid; when absent, watch all active × all windows.
  const winFilter = typeof win === "string" && win ? win : null;
  const platFilter = typeof platform === "string" && platform ? platform : null;
  const windows = winFilter ? [winFilter] : WATCH_WINDOWS;

  // Per-cell Υ memory (key = `${platform}|${window}`) so each cell tracks its own change.
  const prevY = new Map();
  const lastSubmitMsg = new Map();

  write(HIDE_CURSOR);

  const draw = async () => {
    // Re-detect each tick so a platform that just started writing logs appears automatically.
    let pulls = await detectActivePulls().catch(() => []);
    if (platFilter) pulls = pulls.filter((d) => d.platform === platFilter);

    if (lines > 0) write(CURSOR_UP(lines));

    const out = [];
    const push = (s = "") => out.push(s);
    const w = termWidth();
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });

    const scopeLabel =
      (platFilter || "all active platforms") +
      "  ·  " +
      (winFilter ? `window: ${winFilter}` : "all windows");

    push();
    push(
      `  ${gold("⊙ SigRank")} ${bold("Watch")}  ${dim(`${scopeLabel}  ·  ${ts}`)}`,
    );
    push(`  ${dim("─".repeat(w - 4))}`);

    if (pulls.length === 0) {
      push();
      push(
        `  ${dim("no active platforms detected — run some sessions, this will pick them up automatically")}`,
      );
      push();
    }

    for (const d of pulls) {
      const plat = d.platform;
      const byWin = {};
      for (const ww of d.windows || []) byWin[ww.window] = ww;
      push();
      push(`  ${cyan(plat)}${d.estimated ? dim(" (est)") : ""}`);
      for (const wk of windows) {
        const ww = byWin[wk];
        const cas = ww ? cascadeFromPillars(ww.pillars) : null;
        const key = `${plat}|${wk}`;
        const prev = prevY.get(key);
        const yNow = cas?.yield ?? null;
        const changed = prev !== undefined && prev !== yNow;

        // --submit: publish this cell on first observation + whenever its Υ changes.
        if (
          submit &&
          enrolled &&
          ww &&
          yNow != null &&
          (prev === undefined || changed)
        ) {
          try {
            const r = await submitSignedWindow(
              wk,
              ww.pillars,
              ww.messages,
              id,
              { platform: plat },
            );
            lastSubmitMsg.set(
              key,
              r.status === "received"
                ? green(`✓ tier=${r.verification_tier || "—"}`)
                : red(`✗ ${r.reason || r.status}`),
            );
          } catch (e) {
            lastSubmitMsg.set(key, red(`✗ ${e.message}`));
          }
        }
        prevY.set(key, yNow);

        const winLabel = wk === "all" ? "all-time" : wk;
        const yDisplay =
          cas?.yield != null ? gold(fmtYield(cas.yield)) : dim("—");
        const indicator = changed ? green(" ▲") : dim(" ·");
        const metrics = cas
          ? `${dim("SNR")} ${fmtSNR(cas.snr)}  ${dim("Lev")} ${cas.leverage != null ? fmtLev(cas.leverage) + "×" : "—"}  ${dim("Vel")} ${cas.velocity != null ? cas.velocity.toFixed(2) : "—"}  ${colorClass(cas.class ?? "—")}`
          : dim("no data");
        const submitNote =
          submit && enrolled ? "  " + (lastSubmitMsg.get(key) || dim("…")) : "";
        push(
          `    ${padEnd(winLabel, 8)}  ${bold("Υ")} ${yDisplay}${indicator}  ${metrics}${submitNote}`,
        );
      }
    }

    push();
    push(`  ${dim("─".repeat(w - 4))}`);
    if (submit && !enrolled) {
      push(
        `  ${red("not enrolled — run `npx sigrank enroll` to auto-submit")}`,
      );
    }
    push(
      `  ${dim(`polling every ${refresh}s  ·  ${submit ? "auto-submit ON  ·  " : ""}tokens stay on your machine  ·  ctrl+c to exit`)}`,
    );
    push();

    write(out.join("\n"));
    lines = out.length;
  };

  try {
    await draw();
    const iv = setInterval(draw, refresh * 1000);
    await new Promise((resolve) => {
      process.on("SIGINT", () => {
        clearInterval(iv);
        resolve();
      });
    });
  } finally {
    write(SHOW_CURSOR + "\n");
  }
}

// ── UNIFIED DEFAULT VIEW ──────────────────────────────────────────────────────
// npx sigrank (no args) — pulls everything at once:
//   - all platforms in parallel (only shows ones with data)
//   - all 4 windows per platform
//   - token pillars table (transparency layer)
//   - comparison sources (ccusage, tokscale, token-dashboard) if available
//   - live board position
//   - [S] submit  [B] board  [Q] quit

const ALL_PLATFORMS = [
  "claude",
  "codex",
  "amp",
  "gemini",
  "kimi",
  "qwen",
  "goose",
  "kilo",
  "hermes",
  "droid",
  "codebuff",
  "copilot",
  "openclaw",
  "pi",
];

async function runSigRank() {
  write(HIDE_CURSOR);
  const w = termWidth();

  // ── 1. Show immediate header so screen isn't blank ────────────────────────
  writeln();
  writeln(`  ${gold("⊙ SigRank")}  ${bold("Operator Dashboard")}`);
  writeln(`  ${dim("reading local data…")}`);

  const { tokenpullAny, freshVerifierPillars } =
    await import("./tokenpull.mjs");

  // Local sources first (fast) — board fetch with 5s timeout runs in parallel
  const boardPromise = Promise.race([
    callTool("get_leaderboard", {}).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);

  // FIX A1-CLI (2026-06-27): verifiers (ccusage/tokscale/tokendash) are fetched
  // ON-DEMAND for ACTIVE platforms only — not synchronously for all 15 platforms
  // upfront (which blocked Dashboard paint up to ~40s, same class of bug as TUI
  // FIX A1). The sync ccusagePillars()/tokscalePillars()/tokenDashPillars() loop
  // over ALL_PLATFORMS is replaced by parallel freshVerifierPillars() calls after
  // we know which platforms actually have local data.
  const [platformResults] = await Promise.all([
    Promise.allSettled(ALL_PLATFORMS.map((p) => tokenpullAny(p))),
  ]);

  const boardData = await boardPromise;

  // filter to platforms with actual data
  const active = [];
  for (let i = 0; i < ALL_PLATFORMS.length; i++) {
    const r = platformResults[i];
    if (r.status !== "fulfilled") continue;
    const d = r.value;
    const all = d.windows?.find((w) => w.window === "all");
    if (!all) continue;
    const total = (all.pillars.input ?? 0) + (all.pillars.output ?? 0);
    if (total === 0) continue;
    active.push(d);
  }

  // Fetch verifiers on-demand for active platforms only (parallel, never throws).
  // tdPillars (token-dashboard) is claude-only and pulled from the claude fresh result.
  const verifierMap = {};
  let tdPillars = null;
  if (active.length > 0) {
    const fresh = await Promise.all(
      active.map((d) =>
        freshVerifierPillars(d.platform).catch(() => ({
          ccusage: null,
          tokscale: null,
          tokendash: null,
        })),
      ),
    );
    for (let i = 0; i < active.length; i++) {
      const f = fresh[i];
      verifierMap[active[i].platform] = { cc: f.ccusage, ts: f.tokscale };
      if (active[i].platform === "claude" && f.tokendash)
        tdPillars = f.tokendash;
    }
  }

  // clear the 3 loading lines (blank + header + "reading…")
  write(
    CURSOR_UP(3) +
      ERASE_LINE +
      CURSOR_UP(1) +
      ERASE_LINE +
      CURSOR_UP(1) +
      ERASE_LINE,
  );

  // ── 2. Header ─────────────────────────────────────────────────────────────
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const header = `  ${gold("⊙ SigRank")}  ${bold("Operator Dashboard")}`;
  const right = dim(`signalaf.com  ${ts}`);
  const gap = Math.max(
    1,
    w - stripAnsi(header).length - stripAnsi(right).length,
  );
  writeln();
  writeln(`${header}${" ".repeat(gap)}${right}`);

  const platformSummary = active
    .map((d) => {
      const all = d.windows.find((w) => w.window === "all");
      return `${cyan(d.platform)} ${dim(`${d.files ?? "?"} files · ${(all?.messages ?? 0).toLocaleString()} msgs`)}`;
    })
    .join("  ");
  writeln(
    `  ${dim("Detected:")}  ${platformSummary || dim("no local data found")}`,
  );
  writeln(`  ${dim("─".repeat(w - 4))}`);

  // ── 3. Cascade table — all platforms × all windows ─────────────────────────
  writeln();
  writeln(`  ${bold("Your Cascade")}`);
  const CH = [
    padEnd(dim("Platform"), 10),
    padEnd(dim("Win"), 5),
    padStart(dim("Input"), 8),
    padStart(dim("Output"), 8),
    padStart(dim("CacheW"), 8),
    padStart(dim("CacheR"), 9),
    padStart(dim("Υ Yield"), 9),
    padStart(dim("SNR"), 7),
    padStart(dim("Leverage"), 10),
    padStart(dim("Vel"), 6),
    padStart(dim("10x"), 6),
    padEnd(dim("Class"), 13),
  ];
  writeln(`    ${CH.join("  ")}`);
  writeln(`  ${dim("·".repeat(Math.min(w - 4, 110)))}`);

  const WINS = ["7d", "30d", "90d", "all"];

  // helper to render one platform/combined row
  const renderCascadeRow = (label, labelColorFn, winKey, p, est = false) => {
    const cas = cascadeFromPillars(p);
    if (!cas) return;
    const clsFn = CLASS_COLOR[cas.class] ?? ((s) => s);
    const cols = [
      padEnd(labelColorFn(label), 10),
      padEnd(dim(winKey), 5),
      padStart(est ? dim("~") + fmtTokens(p.input) : fmtTokens(p.input), 8),
      padStart(fmtTokens(p.output), 8),
      padStart(
        p.cacheCreate > 0
          ? est
            ? dim("~") + fmtTokens(p.cacheCreate)
            : fmtTokens(p.cacheCreate)
          : dim("—"),
        8,
      ),
      padStart(p.cacheRead > 0 ? fmtTokens(p.cacheRead) : dim("—"), 9),
      padStart(
        cas.yield != null
          ? cas.yield > 10000
            ? gold(fmtYield(cas.yield))
            : fmtYield(cas.yield)
          : "—",
        9,
      ),
      padStart(fmtSNR(cas.snr), 7),
      padStart(cas.leverage != null ? `${fmtLev(cas.leverage)}×` : "—", 10),
      padStart(cas.velocity != null ? cas.velocity.toFixed(2) : "—", 6),
      padStart(cas.dev10x != null ? cas.dev10x.toFixed(2) : "—", 6),
      padEnd(clsFn(cas.class), 13),
    ];
    writeln(`    ${cols.join("  ")}`);
  };

  // per-platform rows
  for (const d of active) {
    const isFirst = (winKey) =>
      winKey === "7d" ||
      (winKey === "30d" &&
        !d.windows?.find(
          (w) => w.window === "7d" && w.pillars.input + w.pillars.output > 0,
        ));
    for (const winKey of WINS) {
      const wdata = d.windows?.find((ww) => ww.window === winKey);
      if (!wdata) continue;
      renderCascadeRow(
        d.platform,
        (s) => (isFirst(winKey) ? cyan(s) : dim(s)),
        winKey,
        wdata.pillars,
        d.estimated === true,
      );
    }
    writeln();
  }

  // combined row (only when 2+ platforms active)
  if (active.length > 1) {
    const combinedLabel = active.map((d) => d.platform).join("+");
    const hasEstimated = active.some((d) => d.estimated === true);
    let isFirstWin = true;
    for (const winKey of WINS) {
      const combinedP = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
      let hasData = false;
      for (const d of active) {
        const wdata = d.windows?.find((ww) => ww.window === winKey);
        if (!wdata) continue;
        const p = wdata.pillars;
        if (p.input + p.output === 0) continue;
        combinedP.input += p.input ?? 0;
        combinedP.output += p.output ?? 0;
        combinedP.cacheCreate += p.cacheCreate ?? 0;
        combinedP.cacheRead += p.cacheRead ?? 0;
        hasData = true;
      }
      if (!hasData) continue;
      renderCascadeRow(
        combinedLabel,
        (s) => (isFirstWin ? bold(cyan(s)) : dim(s)),
        winKey,
        combinedP,
        hasEstimated,
      );
      isFirstWin = false;
    }
    writeln();
  }

  // ── 4. Token Pillars — per-platform verification + combined ──────────────
  writeln(`  ${dim("─".repeat(w - 4))}`);
  writeln();
  writeln(
    `  ${bold("Token Pillars")}  ${dim("(all-time · per-platform verification)")}`,
  );

  const PCOLS = [
    padEnd(dim("Source"), 14),
    padStart(dim("Input"), 10),
    padStart(dim("Output"), 10),
    padStart(dim("Cache Write"), 12),
    padStart(dim("Cache Read"), 12),
    padStart(dim("Total"), 10),
  ];
  writeln(`    ${PCOLS.join("  ")}`);
  writeln(`  ${dim("·".repeat(Math.min(w - 4, 74)))}`);

  const printPillarRow = (label, colorFn, p, note = "") => {
    if (!p) return;
    const i = p.input ?? 0;
    const o = p.output ?? 0;
    const cw = p.cacheCreate ?? 0;
    const cr = p.cacheRead ?? 0;
    const total = i + o + cw + cr;
    const cols = [
      padEnd(colorFn(label), 14),
      padStart(fmtTokens(i), 10),
      padStart(fmtTokens(o), 10),
      padStart(cw > 0 ? fmtTokens(cw) : dim("—"), 12),
      padStart(cr > 0 ? fmtTokens(cr) : dim("—"), 12),
      padStart(fmtTokens(total), 10),
    ];
    writeln(`    ${cols.join("  ")}${note ? "  " + dim(note) : ""}`);
  };

  // ── Per-platform blocks ─────────────────────────────────────────────────
  for (const d of active) {
    const all = d.windows?.find((ww) => ww.window === "all");
    if (!all) continue;
    const v = verifierMap[d.platform] ?? {};
    const estMarker = d.estimated ? dim("  ~ estimated") : "";
    printPillarRow(d.platform, cyan, all.pillars, `tokenpull${estMarker}`);
    if (d.estimated) {
      // show the estimation formula inline
      const ratio = d.ioRatio != null ? d.ioRatio.toFixed(3) : "?";
      writeln(
        `    ${dim(`  ~ input = output × ioRatio(${ratio})   cacheCreate = uncached − input   cacheRead = exact`)}`,
      );
    }
    if (v.cc?.all)
      printPillarRow(
        "  ccusage",
        (s) => paint(c.green, s),
        v.cc.all,
        "ccusage CLI",
      );
    if (d.platform === "claude" && tdPillars?.all)
      printPillarRow(
        "  token-dash",
        (s) => paint(c.magenta, s),
        tdPillars.all,
        "token-dashboard.db",
      );
    if (v.ts?.all)
      printPillarRow(
        "  tokscale",
        (s) => paint(c.blue, s),
        v.ts.all,
        "tokscale_report.json",
      );
    if (d.estimated && (v.cc?.all || v.ts?.all)) {
      writeln(
        `    ${dim("  ^ verifiers show raw uncached input (input_tokens − cached) — different field than estimated input above")}`,
      );
    }
    writeln();
  }

  // ── Combined (if more than one platform) ───────────────────────────────
  if (active.length > 1) {
    const combined = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    for (const d of active) {
      const all = d.windows?.find((ww) => ww.window === "all");
      if (!all) continue;
      combined.input += all.pillars.input ?? 0;
      combined.output += all.pillars.output ?? 0;
      combined.cacheCreate += all.pillars.cacheCreate ?? 0;
      combined.cacheRead += all.pillars.cacheRead ?? 0;
    }
    // sum verifiers across all active platforms
    const ccCombined = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    const tsCombined = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    let hasCc = false,
      hasTs = false;
    for (const d of active) {
      const v = verifierMap[d.platform] ?? {};
      if (v.cc?.all) {
        ccCombined.input += v.cc.all.input ?? 0;
        ccCombined.output += v.cc.all.output ?? 0;
        ccCombined.cacheCreate += v.cc.all.cacheCreate ?? 0;
        ccCombined.cacheRead += v.cc.all.cacheRead ?? 0;
        hasCc = true;
      }
      if (v.ts?.all) {
        tsCombined.input += v.ts.all.input ?? 0;
        tsCombined.output += v.ts.all.output ?? 0;
        tsCombined.cacheCreate += v.ts.all.cacheCreate ?? 0;
        tsCombined.cacheRead += v.ts.all.cacheRead ?? 0;
        hasTs = true;
      }
    }
    printPillarRow(
      "combined",
      (s) => bold(s),
      combined,
      active.map((d) => d.platform).join("+"),
    );
    if (hasCc)
      printPillarRow(
        "  ccusage",
        (s) => paint(c.green, s),
        ccCombined,
        "ccusage CLI",
      );
    if (tdPillars?.all)
      printPillarRow(
        "  token-dash",
        (s) => paint(c.magenta, s),
        tdPillars.all,
        "token-dashboard.db",
      );
    if (hasTs)
      printPillarRow(
        "  tokscale",
        (s) => paint(c.blue, s),
        tsCombined,
        "tokscale_report.json",
      );
  }

  // ── 5. Board position ─────────────────────────────────────────────────────
  writeln();
  writeln(`  ${dim("─".repeat(w - 4))}`);
  writeln();
  writeln(
    `  ${bold("Board")}  ${dim("30d window · signalaf.com · sorted by Υ Yield")}`,
  );

  const entries = boardData?.operators ?? boardData?.entries ?? boardData ?? [];
  if (Array.isArray(entries) && entries.length > 0) {
    const top5 = entries.slice(0, 5);
    // header
    const BH = [
      padStart(dim("#"), 4),
      padEnd(dim("Codename"), 20),
      padEnd(dim("Class"), 13),
      padStart(dim("Υ Yield"), 9),
      padStart(dim("SNR"), 6),
      padStart(dim("Depth"), 6),
      padStart(dim("Tokens"), 8),
      padStart(dim("Force"), 6),
      padStart(dim("Pct"), 5),
      padStart(dim("7d↕"), 5),
    ];
    writeln(`    ${BH.join("  ")}`);
    writeln(`  ${dim("·".repeat(Math.min(w - 4, 92)))}`);
    for (const e of top5) {
      const rank = e.rank === 1 ? gold(`#${e.rank}`) : `#${e.rank}`;
      const name = padEnd(trunc(e.codename ?? "—", 20), 20);
      const cls = padEnd(colorClass(e.class_tier ?? "—"), 13);
      const yld = padStart(e.yield_ != null ? fmtYield(e.yield_) : "—", 9);
      const snr = padStart(
        e.compression_ratio != null ? fmtSNR(e.compression_ratio) : "—",
        6,
      );
      const depth = padStart(
        e.session_depth != null ? e.session_depth.toFixed(1) : "—",
        6,
      );
      const tok = padStart(
        e.token_throughput != null ? fmtTokens(e.token_throughput) : "—",
        8,
      );
      const force = padStart(
        e.signal_force != null ? e.signal_force.toFixed(1) : "—",
        6,
      );
      const pct = padStart(e.percentile != null ? `${e.percentile}%` : "—", 5);
      const mv7 = padStart(fmtMove(e.movement_7d), 5);
      writeln(
        `    ${padStart(rank, 4)}  ${name}  ${cls}  ${yld}  ${snr}  ${depth}  ${tok}  ${force}  ${pct}  ${mv7}`,
      );
    }
    if (entries.length > 5)
      writeln(
        `  ${dim(`  … ${entries.length - 5} more operators on signalaf.com`)}`,
      );
  } else {
    writeln(`  ${dim("  board unavailable")}`);
  }

  // ── 6. Footer / submit prompt ────────────────────────────────────────────
  writeln();
  writeln(`  ${dim("─".repeat(w - 4))}`);
  writeln(
    `  ${dim("[S]")} submit to board   ${dim("[B]")} open board in browser   ${dim("[Q]")} quit`,
  );
  writeln();

  // ── 7. Keypress handler ───────────────────────────────────────────────────
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    await new Promise((resolve) => {
      process.stdin.on("data", async (key) => {
        const k = key.toLowerCase();
        if (k === "q" || key === "\u0003") {
          // q or ctrl+c
          resolve();
        } else if (k === "b") {
          // ASYNC FIX (2026-06-27): execFile instead of dynamic execSync import
          execFile(
            "open",
            ["https://signalaf.com"],
            { stdio: "ignore" },
            () => {},
          );
          resolve();
        } else if (k === "s") {
          const id = ensureIdentity();
          const enrolled = !!(
            id.codename &&
            id.operator_id &&
            id.private_key_pkcs8_b64
          );
          process.stdin.setRawMode(false);
          write(SHOW_CURSOR);
          if (enrolled) {
            // VERIFIED path (D7 §7): signed submit from the enrolled device. No codename
            // prompt — it comes from the keystore. Only signed submissions rank on the board.
            writeln();
            writeln(
              `  ${dim("Publishing verified runs for")} ${cyan(id.codename)}${dim("…")}`,
            );
            write(HIDE_CURSOR);
            try {
              for (const d of active) {
                for (const ww of d.windows ?? []) {
                  const r = await submitSignedWindow(
                    ww.window,
                    ww.pillars,
                    ww.messages,
                    id,
                    { platform: d.platform },
                  );
                  const ok = r.status === "received";
                  writeln(
                    `    ${ok ? green("✓") : red("✗")}  ${d.platform}  ${ww.window}${ok ? dim(` tier=${r.verification_tier || "—"}`) : dim(` ${r.reason || r.status}`)}`,
                  );
                }
              }
              writeln();
              writeln(
                `  ${green("✓")} Published. Reload ${cyan(`signalaf.com/user/${id.codename}`)}`,
              );
            } catch (e) {
              writeln(red(`  ✗ ${e.message}`));
            }
            resolve();
            return;
          }
          // NOT enrolled → the anonymous paste path (preview-only; does NOT rank) + a hint.
          writeln();
          writeln(
            `  ${dim("Not enrolled — run")} ${bold("npx sigrank enroll")} ${dim("to rank as a verified operator. Anonymous paste below:")}`,
          );
          process.stdout.write("  Codename: ");
          let codename = "";
          process.stdin.on("data", async function onData(chunk) {
            if (chunk === "\r" || chunk === "\n") {
              process.stdin.removeListener("data", onData);
              codename = codename.trim();
              if (!codename) {
                writeln(red("  ✗ codename required"));
                resolve();
                return;
              }
              writeln();
              writeln(
                `  ${dim("Submitting all windows for")} ${cyan(codename)}${dim("…")}`,
              );
              write(HIDE_CURSOR);
              try {
                for (const d of active) {
                  const apiBase = DEFAULT_API_BASE;
                  const WINDOW_TYPE = {
                    "7d": "7d",
                    "30d": "30d",
                    "90d": "90d",
                    all: "all_time",
                  };
                  for (const ww of d.windows ?? []) {
                    const rawPaste = `${ww.pillars.input} ${ww.pillars.output} ${ww.pillars.cacheCreate} ${ww.pillars.cacheRead}`;
                    const windowType = WINDOW_TYPE[ww.window] || ww.window;
                    const now = new Date();
                    const ddmmyy = `${String(now.getDate()).padStart(2, "0")}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getFullYear()).slice(-2)}`;
                    const content_hash = `sha256:${codename}|${windowType}|${rawPaste}|${ddmmyy}`;
                    const res = await fetch(`${apiBase}/api/v1/ingest-paste`, {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                        accept: "application/json",
                      },
                      body: JSON.stringify({
                        codename,
                        raw_paste: rawPaste,
                        window_type: windowType,
                        telemetry: { platform: { primary: d.platform } },
                        content_hash,
                        submitted_ddmmyy: ddmmyy,
                        submitted_at: now.toISOString(),
                      }),
                    }).catch(() => null);
                    const ok = res?.ok ?? false;
                    const status = ok ? green("✓") : red("✗");
                    writeln(
                      `    ${status}  ${d.platform}  ${ww.window}${!ok ? dim(` HTTP ${res?.status ?? "err"}`) : ""}`,
                    );
                  }
                }
                writeln();
                writeln(
                  `  ${green("✓")} Submitted. Visit ${cyan(`signalaf.com/user/${codename}`)}`,
                );
              } catch (e) {
                writeln(red(`  ✗ ${e.message}`));
              }
              resolve();
            } else if (chunk === "\u007f") {
              // backspace
              if (codename.length > 0) {
                codename = codename.slice(0, -1);
                process.stdout.write("\b \b");
              }
            } else {
              codename += chunk;
              process.stdout.write(chunk);
            }
          });
          process.stdin.resume();
        }
      });
    });
  }

  write(SHOW_CURSOR);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// ── HELP ─────────────────────────────────────────────────────────────────────

async function showHelp() {
  const { createRequire } = await import("module");
  const pkg = createRequire(import.meta.url)("./package.json");
  writeln();
  writeln(`  ${gold("⊙ SigRank")} ${bold("CLI")}  ${dim("v" + pkg.version)}`);
  writeln();
  writeln(`  ${bold("Default (no args)")}`);
  writeln(
    `    ${cyan("sigrank")}              unified dashboard: cascade + token pillars + board`,
  );
  writeln();
  writeln(`  ${bold("Commands")}`);
  writeln(
    `    ${cyan("enroll")}                   sign in: paste a connect code (get one at signalaf.com → Settings)`,
  );
  writeln(
    `    ${cyan("submit")}                   publish your verified runs to the board (sign in first)`,
  );
  writeln(
    `    ${cyan("board")}                    live leaderboard (refreshes every 30s)`,
  );
  writeln(
    `    ${cyan("board --window 7d")}        board for a specific window (7d, 30d, 90d, all)`,
  );
  writeln(`    ${cyan("board --once")}             print once and exit`);
  writeln(
    `    ${cyan("compare")}                  raw pillar audit: tokenpull vs ccusage vs token-dash vs tokscale`,
  );
  writeln(
    `    ${cyan("compare --platform codex")} compare for a specific platform`,
  );
  writeln(
    `    ${cyan("tui")}                      full tabbed TUI: Dashboard / Compare / Board / Watch`,
  );
  writeln(
    `    ${cyan("tui --platform codex")}     TUI with a different default platform`,
  );
  writeln(
    `    ${cyan("watch")}                    live tune meter — ALL active platforms × all windows, every 30s`,
  );
  writeln(
    `    ${cyan("watch --platform codex")}   watch only one platform (optional filter)`,
  );
  writeln(
    `    ${cyan("watch --window 7d")}        watch only one window (optional filter)`,
  );
  writeln();
  writeln(`  ${bold("Options")}`);
  writeln(
    `    ${dim("--window")}    7d · 30d · 90d · all  (default: 30d for board; all windows for watch)`,
  );
  writeln(
    `    ${dim("--platform")}  claude · codex · amp · gemini · opencode · goose · …`,
  );
  writeln(`    ${dim("--refresh")}   poll interval in seconds (default: 30)`);
  writeln(`    ${dim("--once")}      print once and exit (board only)`);
  writeln();
  writeln(`  ${bold("For AI clients (not typeable)")}`);
  writeln(
    `    ${dim("In a piped/non-TTY context, sigrank is an MCP stdio server.")}`,
  );
  writeln(
    `    ${dim("AI clients (Claude, Cursor, …) call its tools automatically — these are")}`,
  );
  writeln(`    ${dim("NOT shell commands. Humans use the commands above.")}`);
  writeln();
  writeln(`  ${bold("Examples")}`);
  writeln(`    ${dim("sigrank")}                        # unified dashboard`);
  writeln(`    ${dim("sigrank board")}                  # live leaderboard`);
  writeln(
    `    ${dim("sigrank compare")}                # pillar audit (claude)`,
  );
  writeln(`    ${dim("sigrank compare --platform codex")}`);
  writeln(`    ${dim("sigrank watch --window 7d --refresh 60")}`);
  writeln(`    ${dim("sigrank board --window all --once")}`);
  writeln();
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────────

// ── enroll: bind this device to your operator via a web connect code (D7 §4.5) ──
async function runEnroll({ label } = {}) {
  const id = ensureIdentity();
  writeln();
  writeln(`  ${gold("⊙ SigRank")} ${bold("Connect this device")}`);
  writeln(`  ${dim(`device ${id.device_id}`)}`);
  if (id.codename && id.operator_id) {
    writeln(
      `  ${dim(`already enrolled as ${id.codename} — re-enrolling a bound device is rejected this slice.`)}`,
    );
  }
  writeln(
    `  ${dim("Get a code at signalaf.com → Settings → Connect a device.")}`,
  );
  writeln();

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let code;
  try {
    code = (await rl.question("  Paste your connect code: ")).trim();
  } finally {
    rl.close();
  }
  if (!code) {
    writeln(red("  ✗ No code entered."));
    process.exitCode = 1;
    return;
  }

  let out;
  try {
    out = await callTool("enroll", {
      code,
      device_label: typeof label === "string" ? label : undefined,
    });
  } catch (e) {
    writeln(red(`  ✗ ${e.message}`));
    process.exitCode = 1;
    return;
  }

  if (out.status === "enrolled") {
    writeln();
    writeln(
      `  ${green("✓")} Signed in as ${cyan(out.codename || "(operator)")}.`,
    );
    writeln(
      `  ${dim("Your runs now cascade to the board. Publish with ")}${bold("npx sigrank submit")}${dim(" (one-shot) or ")}${bold("npx sigrank watch --submit")}${dim(" (continuous).")}`,
    );
    writeln(`  ${dim(`identity: ${keystorePath()}`)}`);
    return;
  }

  const msg =
    {
      code_invalid:
        "That code is invalid, expired, or already used — generate a fresh one.",
      device_already_enrolled:
        'This device is already enrolled. Need a new key? Click "New key" at signalaf.com → Settings, then paste it here.',
      bad_request: "The code or device key was malformed.",
      rate_limited: "Too many attempts — wait a few minutes and retry.",
      persistence_unavailable:
        "Enrollment is temporarily unavailable — try again shortly.",
    }[out.reason] || `Enrollment failed (${out.reason || "unknown"}).`;
  writeln(red(`  ✗ ${msg}`));
  process.exitCode = 1;
}

// ── submit: publish your verified (signed) runs to the board (D7 §5/§8) ─────────
async function runSubmit({ platform = "claude", window } = {}) {
  const id = ensureIdentity();
  if (!id.codename || !id.operator_id) {
    writeln(
      red("  ✗ This device is not enrolled. Run `npx sigrank enroll` first."),
    );
    process.exitCode = 1;
    return;
  }
  writeln();
  writeln(
    `  ${gold("⊙ SigRank")} ${bold("Publishing verified runs")}  ${dim(`as ${id.codename}`)}`,
  );
  writeln(`  ${dim("reading local token logs + signing…")}`);

  let out;
  try {
    out = await callTool("submit_verified", {
      platform,
      window: typeof window === "string" ? window : undefined,
      dry_run: process.argv.includes("--dry-run"),
    });
  } catch (e) {
    writeln(red(`  ✗ ${e.message}`));
    process.exitCode = 1;
    return;
  }
  if (out.status === "not_enrolled") {
    writeln(red("  ✗ Not enrolled — run `npx sigrank enroll`."));
    process.exitCode = 1;
    return;
  }

  writeln();
  let anyRanked = false;
  let anyReceivedNotRanked = false;
  for (const w of out.windows || []) {
    const label = String(w.window).padEnd(8);
    if (w.status === "dry_run") {
      writeln(
        `  ${gold("◇")} ${bold(label)} ${gold("DRY RUN")} ${dim("· nothing sent")}`,
      );
    } else if (w.ranked) {
      anyRanked = true;
      writeln(
        `  ${green("✓")} ${bold(label)} ${green("RANKED")} ${dim("· live on the board")}`,
      );
    } else if (w.status === "received") {
      anyReceivedNotRanked = true;
      writeln(
        `  ${gold("⚠")} ${bold(label)} ${gold("received · NOT ranked")} ${dim(`(tier=${w.verification_tier || "—"})`)}`,
      );
    } else {
      writeln(
        `  ${red("✗")} ${bold(label)} ${dim(w.reason || w.status || "failed")}`,
      );
    }
  }
  writeln();
  if (anyRanked) {
    writeln(
      `  ${dim("Your board row:")}  ${cyan(`signalaf.com/user/${id.codename}`)}`,
    );
  } else if (anyReceivedNotRanked) {
    writeln(
      `  ${gold("Received, but NOT ranked")} ${dim("— this device is unenrolled or revoked. Re-enroll to rank:")}  ${cyan("npx sigrank enroll")}`,
    );
  }
}

export async function runCli(argv) {
  const args = argv.slice(2); // strip 'node' + script path
  const cmd = args[0];

  // parse --key value AND --key=value flags. E4: validate against the known set and warn
  // (don't crash) on anything unknown, so a typo'd flag is visible instead of silently ignored.
  const KNOWN_FLAGS = new Set([
    "window",
    "platform",
    "refresh",
    "once",
    "submit",
    "compare",
    "label",
    "dry-run",
  ]);
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    let key, val;
    const eq = body.indexOf("=");
    if (eq !== -1) {
      // --flag=value form
      key = body.slice(0, eq);
      val = body.slice(eq + 1);
    } else {
      // --flag [value] form: consume the next token as the value unless it's another flag
      key = body;
      val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    }
    if (!key) continue;
    if (!KNOWN_FLAGS.has(key)) {
      writeln(
        dim(
          `  (ignoring unknown flag --${key}; known: ${[...KNOWN_FLAGS].join(", ")})`,
        ),
      );
      continue;
    }
    flags[key] = val;
  }

  try {
    if (cmd === "board") {
      await runBoard({
        window: flags.window ?? "30d",
        once: flags.once === true || flags.once === "true",
        refresh: Number(flags.refresh) || 30,
      });
    } else if (cmd === "compare") {
      await runCompare({ platform: flags.platform ?? "claude" });
    } else if (cmd === "tui") {
      const { runTui } = await import("./tui.mjs");
      await runTui({
        platform: flags.platform ?? "claude",
        window: flags.window ?? "7d",
      });
    } else if (cmd === "watch") {
      // A5: no --platform/--window → watch ALL active platforms × ALL windows. Pass the raw
      // flags through (undefined = no filter) so runWatch's auto-all mode engages by default;
      // a provided flag narrows the grid (back-compat).
      await runWatch({
        platform:
          typeof flags.platform === "string" ? flags.platform : undefined,
        window: typeof flags.window === "string" ? flags.window : undefined,
        refresh: Number(flags.refresh) || 30,
        submit: flags.submit === true || flags.submit === "true",
      });
    } else if (cmd === "enroll") {
      await runEnroll({ label: flags.label });
    } else if (cmd === "submit") {
      await runSubmit({
        platform: flags.platform ?? "claude",
        window: flags.window,
      });
    } else if (cmd === "--help" || cmd === "-h" || cmd === "help") {
      await showHelp();
    } else if (cmd === "--version" || cmd === "-v") {
      const { createRequire } = await import("module");
      const req = createRequire(import.meta.url);
      const pkg = req("./package.json");
      writeln(pkg.version);
    } else if (!cmd || cmd === "start" || cmd === "run") {
      // default: full unified view
      await runSigRank();
    } else {
      // unknown command: show help + exit non-zero so typos fail loudly (index.mjs now
      // routes ALL arg'd invocations here instead of falling through to the MCP server)
      writeln(red(`\n  ✗ unknown command: ${cmd}`));
      await showHelp();
      process.exit(2);
    }
  } catch (e) {
    write(SHOW_CURSOR);
    writeln(red(`\n  ✗ ${e.message}`));
    process.exit(1);
  }
}
