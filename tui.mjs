/**
 * tui.mjs — SigRank full tabbed TUI.
 *
 * Tabs: [1] Dashboard  [2] Compare  [3] Board  [4] Watch
 * Navigation: ← → arrow keys, 1-4 number keys, or tab letter shortcuts.
 * No external dependencies — pure ANSI/Node.js stdin raw mode.
 *
 * Architecture:
 *   - State machine: activeTab + per-tab data cache.
 *   - On tab switch: clear screen, redraw active tab.
 *   - Board + Watch tabs auto-refresh on a timer.
 *   - Dashboard + Compare load once, refresh on [R].
 */

import { callTool, DEFAULT_API_BASE, pullActivePlatforms } from "./tools.mjs";
import { ALL_PLATFORMS } from "./adapters.mjs";
import { freshVerifierPillars } from "./tokenpull.mjs";
import { isSignedIn, isCodeChar } from "./connect.mjs";
import { loadIdentity, clearIdentity } from "./keystore.mjs";
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

// Version read from package.json (single source of truth — matches cli.mjs;
// never hardcode, that's what caused the version drift).
const VERSION = (() => {
  try {
    return createRequire(import.meta.url)("./package.json").version;
  } catch {
    return "?";
  }
})();

// ── ANSI ───────────────────────────────────────────────────────────────────
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
  bgDim: `${ESC}48;5;236m`, // dark grey bg for active tab
  bgCyan: `${ESC}48;5;23m`, // dark teal bg for active tab
};
const paint = (col, s) => `${col}${s}${c.reset}`;
const bold = (s) => paint(c.bold, s);
const dim = (s) => paint(c.dim, s);
const gold = (s) => paint(c.boldGold, s);
const cyan = (s) => paint(c.boldCyan, s);
const hdr = (s) => paint(c.boldCyan, s); // table column-header label color (readability)
const green = (s) => paint(c.green, s);
const red = (s) => paint(c.red, s);

const CLEAR = `${ESC}H${ESC}2J`; // home + erase visible area
const CLEAR_SB = `${ESC}3J`; // clear scrollback/saved lines (prevents scroll-up past TUI)
const ENTER_ALT = `${ESC}?1049h`; // enter alternate screen buffer
const EXIT_ALT = `${ESC}?1049l`; // exit alternate screen buffer (restores original)
const HIDE = `${ESC}?25l`;
const SHOW = `${ESC}?25h`;
const UP = (n) => `${ESC}${n}A`;
const ERLINE = `${ESC}2K`;
const GOTO = (r, col = 1) => `${ESC}${r};${col}H`; // absolute cursor position

const W = () => process.stdout.columns || 100;
// FIX 0b: safe default 24 (not 40) when rows is undefined (non-TTY / IDE terminals).
// A 40-row assumption into a 24-row window scrolls the alt-screen → footer smears off.
const H = () => process.stdout.rows || 24;

// ── Screen buffer: collect lines, then paint only what fits ─────────────
// Render functions call write/writeln as before; the buffer captures them.
// flushScreen() paints to the real terminal using absolute cursor positioning
// so the TUI never scrolls — it's a locked frame like tokscale.
let _screenBuf = null; // null = direct mode (unbuffered); string[] = buffered
const write = (s) => {
  if (_screenBuf) {
    const parts = s.split("\n");
    if (parts.length === 1) {
      _screenBuf[_screenBuf.length - 1] += s;
    } else {
      _screenBuf[_screenBuf.length - 1] += parts[0];
      for (let i = 1; i < parts.length; i++) _screenBuf.push(parts[i]);
    }
  } else {
    process.stdout.write(s);
  }
};
const writeln = (s = "") => {
  if (_screenBuf) {
    _screenBuf[_screenBuf.length - 1] += s;
    _screenBuf.push("");
  } else {
    process.stdout.write(s + "\n");
  }
};

let _footerBuf = null; // footer lines pinned to bottom
function startBuffer() {
  _screenBuf = [""];
  _footerBuf = null;
}
function setFooter(lines) {
  _footerBuf = lines;
}
function flushScreen() {
  if (!_screenBuf) return;
  const lines = _screenBuf;
  const footer = _footerBuf || [];
  _screenBuf = null;
  _footerBuf = null;
  const h = H();
  const w = W();
  // FIX 0b: footer is SACROSANCT. Clamp CONTENT to h - footer.length first, then
  // always append every footer line. The footer must NEVER be the thing dropped
  // (it was — footer painted last, clamp cut the tail = footer first → lost hints
  // + lost lower cascade rows, together, because they're the same tail of the frame).
  const contentRows = Math.max(0, h - footer.length);
  const content = lines.slice(0, contentRows);
  const frame = [...content, ...footer];
  const maxRows = Math.min(frame.length, h);
  let out = "";
  for (let i = 0; i < maxRows; i++) {
    out += GOTO(i + 1) + ERLINE + ansiTrunc(frame[i], w);
  }
  // Clear any rows below the frame left over from a taller previous frame.
  for (let i = maxRows; i < h; i++) {
    out += GOTO(i + 1) + ERLINE;
  }
  process.stdout.write(out);
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
// ANSI-aware truncate: cut to `w` VISIBLE columns while keeping color escapes
// intact (escapes don't count toward width, and we never slice mid-sequence).
// Replaces raw `.slice(0, w)`, which corrupts color codes + miscounts width.
function ansiTrunc(s, w) {
  if (stripAnsi(s).length <= w) return s;
  let out = "",
    vis = 0,
    i = 0;
  while (i < s.length && vis < w) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    vis++;
    i++;
  }
  return out + "\x1b[0m"; // reset so a cut mid-color doesn't bleed into next line
}
function padEnd(s, w) {
  const v = stripAnsi(s).length;
  return v >= w ? s : s + " ".repeat(w - v);
}
function padStart(s, w) {
  const v = stripAnsi(s).length;
  return v >= w ? s : " ".repeat(w - v) + s;
}
function trunc(s, w) {
  return stripAnsi(s).length <= w ? s : s.slice(0, w - 1) + "…";
}
function hr(ch = "─") {
  return dim(ch.repeat(Math.max(0, W() - 4)));
}

// ── Number formatters ───────────────────────────────────────────────────────
const fmtY = (y) =>
  y == null
    ? "—"
    : y >= 10000
      ? `${(y / 1000).toFixed(1)}K`
      : y >= 1000
        ? `${(y / 1000).toFixed(2)}K`
        : y.toFixed(1);
const fmtLev = (l) =>
  l == null ? "—" : l >= 1000 ? `${(l / 1000).toFixed(1)}K` : l.toFixed(0);
const fmtSNR = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const fmtTok = (n) =>
  n == null
    ? "—"
    : n >= 1e9
      ? `${(n / 1e9).toFixed(1)}B`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)}M`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)}K`
          : String(n);
const fmtMov = (n) =>
  n == null || n === 0 ? dim("—") : n > 0 ? green(`+${n}`) : red(`${n}`);

// ── Class tier colors ────────────────────────────────────────────────────────
const CLS = {
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
const colorCls = (cls) => (CLS[cls] ?? ((s) => s))(cls);

// ── Cascade math (inline, no dep) ───────────────────────────────────────────
function cascadeFrom(p) {
  if (!p) return null;
  const i = p.input ?? 0,
    o = p.output ?? 0,
    cr = p.cacheRead ?? 0;
  if (i === 0 || o === 0) return null;
  const leverage = cr / i;
  const velocity = o / i;
  const yld = leverage * velocity;
  const dev10x =
    i > 0 && o > 0 && (p.cacheCreate ?? 0) > 0 && cr > 0
      ? Math.log10(cr / i)
      : null;
  const snr = o / (i + o);

  let cls = "IGNITER";
  if (yld >= 1000 || dev10x >= 3) cls = "TRANSMITTER";
  else if (dev10x != null && dev10x >= 1.45) cls = "ARCH+";
  else if (dev10x != null && dev10x >= 1.35) cls = "ARCH";
  else if (dev10x != null && dev10x >= 1.2) cls = "POWER";
  else if (dev10x != null && dev10x >= 1.0) cls = "BASE";
  else if (dev10x != null && dev10x >= 0) cls = "SEEKER";
  else if (dev10x != null && dev10x >= -0.3) cls = "REFINER";

  return { yield: yld, snr, leverage, velocity, dev10x, class: cls };
}

// ── Unicode bar chart (no dep) ───────────────────────────────────────────────
const BLOCKS = " ▏▎▍▌▋▊▉█";

// Linear bar — use when all values are the same order of magnitude.
function barChart(values, labels, opts = {}) {
  const { width = 30, colorFn = (s) => s, maxVal } = opts;
  const max = maxVal ?? Math.max(...values.filter(Number.isFinite), 1);
  const lines = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    const pct = Math.min(v / max, 1);
    const full = Math.floor(pct * width);
    const frac = Math.floor((pct * width - full) * 8);
    const bar = colorFn("█".repeat(full) + (frac > 0 ? BLOCKS[frac] : ""));
    const lbl = padEnd(dim(labels[i] ?? ""), 10);
    const val = padStart(fmtTok(v), 8);
    lines.push(`    ${lbl}  ${padEnd(bar, width)}  ${val}`);
  }
  return lines;
}

// Log-scale bar — use when values span multiple orders of magnitude (e.g. token pillars
// where cacheRead >> input). Maps log10(v) to bar width so each 10x = same visual step.
// minLog floor prevents zero/tiny values from going negative.
function logBar(v, maxLog, width = 40, colorCode = c.cyan) {
  if (!v || v <= 0) return { bar: dim("·".repeat(width)), pct: 0 };
  const log = Math.log10(v);
  const pct = Math.min(log / maxLog, 1);
  const full = Math.floor(pct * width);
  const frac = Math.floor((pct * width - full) * 8);
  const bar = paint(
    colorCode,
    "█".repeat(full) + (frac > 0 ? BLOCKS[frac] : ""),
  );
  return { bar, pct };
}

// ── Sparkline (no dep) ────────────────────────────────────────────────────────
const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return dim("no data");
  const min = Math.min(...valid),
    max = Math.max(...valid);
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return dim("·");
      const idx = max === min ? 7 : Math.round(((v - min) / (max - min)) * 7);
      return SPARK[idx];
    })
    .join("");
}

// ── Data sources ─────────────────────────────────────────────────────────────
// (0.12.1 FIX 4) The local verifier readers (ccusage / tokscale / token-dashboard)
// moved to `freshVerifierPillars()` in tokenpull.mjs — FRESH on-demand pulls used by
// the Compare tab (#9). The old in-tui copies were dead after A1 removed the Dashboard
// verifierMap loop and #9 routed Compare through the fresh helper; removed here.
// (tools.mjs keeps its own `_ccusagePillars`/`_tokscalePillars`/`_tokenDashPillars` —
// still used by the `tokenpull_compare` MCP tool.)

async function loadDashboardData() {
  const boardPromise = Promise.race([
    fetch(`${DEFAULT_API_BASE}/api/v1/leaderboard?window=30d&metric=yield_`, {
      headers: { accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 5000)),
  ]);

  // FIX 0 + unify (0.14): progressive load via the SHARED loader (pullActivePlatforms) — paint the
  // primary platform (claude) FAST, then fill the rest in fillDashboardRest. This is the SAME loader
  // `me` and `watch` use, so the three views can't drift apart. (Verifier comparison still runs
  // FRESH + on-demand in the Compare tab — see loadCompareData — never on this Dashboard path.)
  const active = await pullActivePlatforms({ platforms: ["claude"] }).catch(
    () => [],
  );

  const boardData = await boardPromise;
  return {
    active,
    verifierMap: {},
    tdPillars: null,
    boardData,
    _loading: true,
    _remaining: ALL_PLATFORMS.filter((p) => p !== "claude"),
  };
}

/** FIX 0: fill the remaining platforms after the primary render. Mutates dashData.active. */
async function fillDashboardRest(dashData) {
  if (!dashData?._remaining) return false;
  // Unify: fill the remaining platforms through the SAME shared loader.
  const rest = await pullActivePlatforms({
    platforms: dashData._remaining,
  }).catch(() => []);
  for (const d of rest) {
    if (!dashData.active.find((a) => a.platform === d.platform))
      dashData.active.push(d);
  }
  // stable display order: claude → codex → rest (matches the shared loader)
  const rank = (p) =>
    p === "claude" ? -2 : p === "codex" ? -1 : ALL_PLATFORMS.indexOf(p);
  dashData.active.sort((a, b) => rank(a.platform) - rank(b.platform));
  dashData._loading = false;
  dashData._remaining = null;
  return true;
}

// #9 / C1 (2026-06-27): Compare pulls the three external verifier sources FRESH + on-demand
// (ccusage + tokscale models + a token-dashboard rescan), via tokenpull.freshVerifierPillars —
// NOT the old stale snapshot readers (static tokscale_report.json / 3-day-old db). This runs ONLY
// when the Compare tab opens (it's a 5–60s scan), never on the Dashboard load path. Scoped to the
// current platform. tokenpull (the canonical board/cascade source) stays the fast/fresh tpData.
async function loadCompareData(platform = "claude") {
  const tpData = await callTool("tokenpull", { platform }).catch(() => null);
  // Fresh pull — { ccusage, tokscale, tokendash }, each null or window-keyed pillars.
  const fresh = await freshVerifierPillars(platform).catch(() => ({
    ccusage: null,
    tokscale: null,
    tokendash: null,
  }));
  return {
    tpData,
    cc: fresh.ccusage,
    ts: fresh.tokscale,
    td: fresh.tokendash,
    platform,
  };
}

// #8 (2026-06-27): the Board tab shows ALL SUBMISSIONS ranked (raw submission rows), not operator
// aggregates. Try the NEW GET /api/v1/submissions first; if it's not deployed yet (non-200 / 404),
// FALL BACK to the existing /api/v1/leaderboard so nothing breaks pre-deploy. The return is tagged
// with `_source` ('submissions' | 'leaderboard') so renderBoard picks the right column layout.
async function loadBoardData(window = "30d") {
  // Primary: submissions endpoint (ranked submission rows).
  try {
    const res = await fetch(
      `${DEFAULT_API_BASE}/api/v1/submissions?window=${window}&metric=yield_`,
      {
        headers: { accept: "application/json" },
      },
    );
    if (res.ok) {
      const data = await res.json();
      return { ...data, _source: "submissions" };
    }
  } catch {
    /* fall through to leaderboard */
  }
  // Fallback: existing leaderboard endpoint + current render (pre-deploy safety).
  try {
    const res = await fetch(
      `${DEFAULT_API_BASE}/api/v1/leaderboard?window=${window}&metric=yield_`,
      {
        headers: { accept: "application/json" },
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { ...data, _source: "leaderboard" };
  } catch {
    return null;
  }
}

// ── TAB BAR ──────────────────────────────────────────────────────────────────
const TABS = [
  { key: "1", label: "Dashboard", short: "D" },
  { key: "2", label: "Trends", short: "T" }, // every metric across windows (sub-views: You/Platform/Field)
  { key: "3", label: "Compare", short: "C" },
  { key: "4", label: "Board", short: "B" },
  { key: "5", label: "Watch", short: "W" }, // in-TUI landing panel; [Enter] launches the watcher
  { key: "6", label: "Connect", short: "N" }, // sign in / switch device — the whole app is the TUI
];

// Three Degrees of Leverage — reference values pulled from signalaf.com/wiki (2026-06-25).
// base = AI avg (modeled 7:2:1 baseline) · field = SigRank avg (wild field median) · top = best operator.
// STATIC for now; goes live (field/top computed from the board) once there's real user volume.
const TD = {
  base: { yield: 1.57, snr: 0.33, vel: 0.5, lev: 3.2, d10: 0.5 },
  field: { yield: 1.51, snr: 0.07, vel: 0.08, lev: 22.3, d10: 1.35 },
  top: { yield: 745.4, snr: 0.63, vel: 1.7, lev: 438.6, d10: 2.64 },
};

function renderTabBar(activeIdx) {
  const w = W();
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });

  // logo
  const logo = `  ${gold("⊙ SigRank")}`;
  // tabs
  const tabStr = TABS.map((t, i) => {
    const lbl = ` ${t.key}:${t.label} `;
    return i === activeIdx
      ? `${c.bgCyan}${c.boldCyan}${lbl}${c.reset}`
      : `${c.bgDim}${c.dim}${lbl}${c.reset}`;
  }).join("");
  // right side — version (single source of truth) · site · clock
  const right = dim(
    `${gold("v" + VERSION)}${c.reset}${c.dim}  ·  signalaf.com  ·  ${ts}`,
  );

  const logoVis = stripAnsi(logo).length;
  const tabsVis = TABS.reduce((a, t) => a + t.label.length + 4, 0);
  const rightVis = stripAnsi(right).length;
  const gap = Math.max(1, w - logoVis - tabsVis - rightVis - 2);

  writeln(`${logo}  ${tabStr}${" ".repeat(gap)}${right}`);
  writeln(`  ${hr()}`);
}

// ── GRAPHICS helpers ─────────────────────────────────────────────────────────

// Horizontal stacked bar: input | cacheW | cacheR | output
function tokenBar(p, width = 40) {
  if (!p) return dim("  no data");
  const total =
    (p.input ?? 0) +
    (p.output ?? 0) +
    (p.cacheCreate ?? 0) +
    (p.cacheRead ?? 0);
  if (total === 0) return dim("  no data");
  const seg = (val, colorCode) => {
    const w = Math.round((val / total) * width);
    return w > 0 ? paint(colorCode, "█".repeat(w)) : "";
  };
  const bar =
    seg(p.input, c.cyan) +
    seg(p.cacheCreate, c.blue) +
    seg(p.cacheRead, c.boldGold) +
    seg(p.output, c.green);
  return bar;
}

// Generalized cascade-metric sparkline across windows (7d→30d→90d→all).
// pick: (cas) => number · fmt: (v) => string. Used by the Trends tab for every metric.
// FIX G1: window headers are rendered once at the top of each metric block (mirror
// renderCompare's column layout). metricSpark/yieldSpark now return sparkline + RIGHT-
// ALIGNED values in fixed COL_W columns — NO per-value `w:` prefix (the header row
// carries the window labels). Null windows render a dim `—` (columns stay aligned).
const TREND_COL_W = 10;
const TREND_WINS = ["7d", "30d", "90d", "all"];

function trendHeader() {
  return (
    padEnd(dim(""), 12) +
    TREND_WINS.map((w) => padStart(dim(w), TREND_COL_W)).join("  ")
  );
}

function metricSpark(d, pick, fmt) {
  const vals = TREND_WINS.map((w) => {
    const wd = d.windows?.find((x) => x.window === w);
    if (!wd) return null;
    const cas = cascadeFrom(wd.pillars);
    return cas ? pick(cas, wd.pillars) : null; // pick gets (cascade, pillars)
  });
  const cols = vals.map((v) =>
    v != null ? padStart(fmt(v), TREND_COL_W) : padStart(dim("—"), TREND_COL_W),
  );
  return sparkline(vals) + `  ${cols.join("  ")}`;
}

// Yield sparkline across windows
function yieldSpark(d) {
  const vals = TREND_WINS.map((w) => {
    const wd = d.windows?.find((x) => x.window === w);
    if (!wd) return null;
    const cas = cascadeFrom(wd.pillars);
    return cas?.yield ?? null;
  });
  const cols = vals.map((v) =>
    v != null
      ? padStart(fmtY(v), TREND_COL_W)
      : padStart(dim("—"), TREND_COL_W),
  );
  return sparkline(vals) + `  ${cols.join("  ")}`;
}

// ── TAB 1: DASHBOARD ─────────────────────────────────────────────────────────

// SCROLL-VIEW (2026-06-27): section-scoped scroll for the cascade table.
// The cascade section gets a real scroll viewport — up/down arrows scroll just
// the cascade rows while the rest of the dashboard (header, token composition,
// board, footer) stays pinned. This replaces the misleading "+N more — resize /
// scroll" text (A3) which implied scroll existed but didn't (alt-screen locked
// frame = no terminal scroll). The scroll is IN-SECTION only, on the Dashboard tab.

const DASH_WINS = ["7d", "30d", "90d", "all"];

// Count how many cascade rows the active platforms would produce (every window
// with data across all active platforms). This is the "total wanted" count.
function cascadeScrollableCount(active) {
  return active.reduce(
    (n, d) =>
      n +
      DASH_WINS.filter((wk) => {
        const wd = d.windows?.find((x) => x.window === wk);
        return wd && wd.pillars.input + wd.pillars.output > 0;
      }).length,
    0,
  );
}

// Compute the max cascade rows that fit in the current terminal height budget.
// Mirrors the calculation in renderDashboard (budget - used - sectionsBelow).
function maxCascadeRowsFor(active) {
  const budget = H() - 4; // 2 tab bar + 2 footer
  const platformCount = active.length;
  const barLines = 4 + platformCount + (platformCount > 1 ? 1 : 0);
  const boardLines = 17;
  const sectionsBelow = barLines + boardLines;
  // used before cascade = header(2) + blank(1) + title(1) + blank(1) + col-header(1) + separator(1) = 7
  const usedBeforeCascade = 7;
  return Math.max(8, budget - usedBeforeCascade - sectionsBelow);
}

function renderDashboard(data, status = "", scrollOffset = 0) {
  const w = W();
  const budget = H() - 4; // 2 tab bar + 2 footer
  const WINS = ["7d", "30d", "90d", "all"];
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };

  // A2 (2026-06-27): tolerate null/empty dashData so the FIRST paint can happen BEFORE the
  // initial load resolves (loadAll renders an empty frame + "reading your cascade…" immediately,
  // then re-renders with real data). Guard the destructure: no data → header + status + return.
  if (!data || !Array.isArray(data.active)) {
    emit();
    emit(`  ${bold("Your Cascade")}  ${dim("all platforms · all windows")}`);
    emit();
    emit(`  ${dim("  reading token logs… (press [R] to refresh)")}`);
    if (status && used < budget) emit(`  ${dim(status)}`);
    return;
  }

  const { active } = data;

  // Responsive: the full 12-col table is ~124 wide. On terminals narrower than
  // that, drop the two derived columns (Vel, 10x) and tighten the inter-column
  // gap from 2 spaces to 1, so the core pillars + Υ/SNR/Lev/Class still fit.
  const narrow = w < 124;
  const gap = narrow ? " " : "  ";
  const renderRow = (label, colorFn, winKey, p, est = false) => {
    const cas = cascadeFrom(p);
    if (!cas) return;
    const clsFn = CLS[cas.class] ?? ((s) => s);
    const cols = [
      padEnd(colorFn(label), 12),
      padEnd(dim(winKey), 5),
      padStart(est ? dim("~") + fmtTok(p.input) : fmtTok(p.input), 8),
      padStart(fmtTok(p.output), 8),
      padStart(
        (p.cacheCreate ?? 0) > 0
          ? est
            ? dim("~") + fmtTok(p.cacheCreate)
            : fmtTok(p.cacheCreate)
          : dim("—"),
        8,
      ),
      padStart((p.cacheRead ?? 0) > 0 ? fmtTok(p.cacheRead) : dim("—"), 9),
      padStart(cas.yield > 10000 ? gold(fmtY(cas.yield)) : fmtY(cas.yield), 9),
      padStart(fmtSNR(cas.snr), 7),
      padStart(fmtLev(cas.leverage) + "×", 7),
      ...(narrow
        ? []
        : [
            padStart(cas.velocity?.toFixed(2) ?? "—", 6),
            padStart(cas.dev10x?.toFixed(2) ?? "—", 6),
          ]),
      padEnd(clsFn(cas.class), 13),
    ];
    emit(`    ${cols.join(gap)}`);
  };

  // ── Cascade table
  emit();
  emit(`  ${bold("Your Cascade")}  ${dim("all platforms · all windows")}`);
  emit();

  // header (matches renderRow's responsive column set + gap)
  const CH = [
    padEnd(hdr("Platform"), 12),
    padEnd(hdr("Win"), 5),
    padStart(hdr("Input"), 8),
    padStart(hdr("Output"), 8),
    padStart(hdr("CacheW"), 8),
    padStart(hdr("CacheR"), 9),
    padStart(hdr("Υ Yield"), 9),
    padStart(hdr("SNR"), 7),
    padStart(hdr("Lev"), 7),
    ...(narrow ? [] : [padStart(hdr("Vel"), 6), padStart(hdr("10x"), 6)]),
    padEnd(hdr("Class"), 13),
  ];
  emit(`    ${CH.join(gap)}`);
  emit(`  ${dim("·".repeat(Math.max(0, Math.min(w - 4, narrow ? 96 : 114))))}`);

  if (active.length === 0) {
    emit(
      `  ${dim("  reading token logs… (14 platforms, ~5s · press [R] to refresh)")}`,
    );
  }

  // Calculate how many cascade rows we can fit — reserve space for lower sections.
  // (Υ-trend section moved to the Trends tab; its old `sparkLines` reservation is gone,
  // which is what was starving codex's cascade rows after the Your-Read/Three-Degrees panels landed.)
  const platformCount = active.length;
  const barLines = 4 + platformCount + (platformCount > 1 ? 1 : 0); // Token Composition: hr + header + platforms + combined + note
  // Your Read (hr+header+~3 wins+1 gap = 6) + Three Degrees (blank+hr+header+col-header+5 rows+note = 10) + status
  const boardLines = 17;
  const sectionsBelow = barLines + boardLines;
  const maxCascadeRows = Math.max(8, budget - used - sectionsBelow);

  // SCROLL-VIEW (2026-06-27): Build the full list of cascade rows first, then
  // slice by [scrollOffset, scrollOffset + maxCascadeRows]. This gives a real
  // in-section scroll viewport — up/down arrows scroll just the cascade rows
  // while the rest of the dashboard stays pinned. Replaces the A3 "+N more —
  // resize / scroll" text which implied scroll existed but didn't.
  let firstWin = {};
  const allCascadeRows = []; // flat list: { platform, winKey, pillars, estimated }
  for (const d of active) {
    firstWin[d.platform] = WINS.find((wk) => {
      const wd = d.windows?.find((w) => w.window === wk);
      return wd && wd.pillars.input + wd.pillars.output > 0;
    });
    for (const wk of WINS) {
      const wd = d.windows?.find((x) => x.window === wk);
      if (!wd || wd.pillars.input + wd.pillars.output === 0) continue;
      allCascadeRows.push({
        platform: d.platform,
        winKey: wk,
        pillars: wd.pillars,
        estimated: d.estimated,
      });
    }
  }

  const totalWanted = allCascadeRows.length;
  const canScroll = totalWanted > maxCascadeRows;
  // Clamp scroll offset to valid range [0, totalWanted - maxCascadeRows]
  const maxOffset = Math.max(0, totalWanted - maxCascadeRows);
  const effectiveOffset = Math.min(scrollOffset, maxOffset);
  const visibleRows = allCascadeRows.slice(
    effectiveOffset,
    effectiveOffset + maxCascadeRows,
  );

  // ▲ indicator: rows above the current viewport
  if (canScroll && effectiveOffset > 0) {
    emit(
      `  ${dim(`  ▲ ${effectiveOffset} row${effectiveOffset > 1 ? "s" : ""} above`)}`,
    );
  }

  // Render the visible slice — group by platform (emit a blank line between platforms)
  let lastPlatform = null;
  for (const row of visibleRows) {
    if (lastPlatform !== null && row.platform !== lastPlatform) emit();
    renderRow(
      row.platform,
      (s) => (row.winKey === firstWin[row.platform] ? cyan(s) : dim(s)),
      row.winKey,
      row.pillars,
      row.estimated,
    );
    lastPlatform = row.platform;
  }
  if (visibleRows.length > 0) emit();

  // ▼ indicator: rows below the current viewport
  const rowsBelow = totalWanted - effectiveOffset - visibleRows.length;
  if (canScroll && rowsBelow > 0) {
    emit(
      `  ${dim(`  ▼ ${rowsBelow} row${rowsBelow > 1 ? "s" : ""} below · ↑↓ scroll`)}${effectiveOffset > 0 ? dim(` · ${effectiveOffset}/${maxOffset}`) : ""}`,
    );
  }

  // combined
  if (active.length > 1 && used < budget - sectionsBelow) {
    const lbl = active.map((d) => d.platform).join("+");
    const hasEst = active.some((d) => d.estimated);
    let fst = true;
    for (const wk of WINS) {
      const cp = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
      let any = false;
      for (const d of active) {
        const wd = d.windows?.find((x) => x.window === wk);
        if (!wd || wd.pillars.input + wd.pillars.output === 0) continue;
        cp.input += wd.pillars.input ?? 0;
        cp.output += wd.pillars.output ?? 0;
        cp.cacheCreate += wd.pillars.cacheCreate ?? 0;
        cp.cacheRead += wd.pillars.cacheRead ?? 0;
        any = true;
      }
      if (!any) continue;
      renderRow(lbl, (s) => (fst ? bold(cyan(s)) : dim(s)), wk, cp, hasEst);
      fst = false;
    }
    emit();
  }

  // (Υ Trend moved to the dedicated Trends tab [2] — every metric, with sub-views.)

  // ── Token bar charts (skip if no room)
  if (used < budget - boardLines) {
    emit(`  ${hr()}`);
    emit(
      `  ${bold("Token Composition")}  ${dim("█")}${paint(c.cyan, "I")}${dim(" in  █")}${paint(c.blue, "W")}${dim(" cW  █")}${paint(c.boldGold, "R")}${dim(" cR  █")}${paint(c.green, "O")}${dim(" out")}`,
    );
    for (const d of active) {
      if (used >= budget - boardLines) break;
      const all = d.windows?.find((w) => w.window === "all");
      if (!all) continue;
      emit(
        `    ${padEnd(cyan(d.platform), 10)}  ${tokenBar(all.pillars, 50)}  ${dim(fmtTok((all.pillars.input ?? 0) + (all.pillars.output ?? 0) + (all.pillars.cacheCreate ?? 0) + (all.pillars.cacheRead ?? 0)))}`,
      );
    }
    if (active.length > 1) {
      const cp = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
      for (const d of active) {
        const all = d.windows?.find((w) => w.window === "all");
        if (!all) continue;
        cp.input += all.pillars.input ?? 0;
        cp.output += all.pillars.output ?? 0;
        cp.cacheCreate += all.pillars.cacheCreate ?? 0;
        cp.cacheRead += all.pillars.cacheRead ?? 0;
      }
      emit(
        `    ${padEnd(bold(active.map((d) => d.platform).join("+")), 10)}  ${tokenBar(cp, 50)}  ${dim(fmtTok(cp.input + cp.output + cp.cacheCreate + cp.cacheRead))}`,
      );
    }
  }

  // ── Your insights + the Three Degrees panel (replaces the old top-3 mini board)
  // The user's own cascade (the firstWin/combined row computed above) read against the
  // Three Degrees reference so the Dashboard says "here's you, here's the field, here's the ceiling."
  const you = (() => {
    // Best available cascade for the user: prefer claude's first-window, else any computed row.
    for (const d of active) {
      const wk = firstWin[d.platform];
      const wd = d.windows?.find((x) => x.window === wk);
      const cas = wd && cascadeFrom(wd.pillars);
      if (cas) return cas; // cascadeFrom already returns null for non-compounding rows
    }
    return null;
  })();

  if (used < budget - 8) {
    // ── Custom insights — comparison vs the field + a concrete tip for the weakest metric
    emit(`  ${hr()}`);
    emit(
      `  ${bold("Your Read")}  ${dim("how your cascade sits vs the field")}`,
    );
    if (you) {
      const wins = [],
        gaps = [];
      const chk = (label, val, fieldAvg, top, fmt, tip) => {
        if (val == null) return;
        if (val >= top * 0.9)
          wins.push(`${label} ${fmt(val)} — ${gold("top tier")}`);
        else if (val >= fieldAvg)
          wins.push(`${label} ${fmt(val)} — above field avg`);
        else
          gaps.push({
            label,
            txt: `${label} ${fmt(val)} — below field (${fmt(fieldAvg)}): ${tip}`,
            val,
            fieldAvg,
          });
      };
      chk(
        "Υ Yield",
        you.yield,
        TD.field.yield,
        TD.top.yield,
        fmtY,
        "compound more — reuse cache, raise output",
      );
      chk(
        "SNR",
        you.snr,
        TD.field.snr,
        TD.top.snr,
        fmtSNR,
        "tighten prompts — less input per unit output",
      );
      chk(
        "Leverage",
        you.leverage,
        TD.field.lev,
        TD.top.lev,
        (v) => fmtLev(v) + "×",
        "lean on cache-read — amplify prior context",
      );
      chk(
        "Velocity",
        you.velocity,
        TD.field.vel,
        TD.top.vel,
        (v) => v.toFixed(2),
        "more output per input token",
      );
      for (const w of wins.slice(0, 3)) emit(`    ${paint(c.green, "▲")} ${w}`);
      // weakest gap gets the prescriptive tip
      const weakest = gaps.sort(
        (a, b) => a.val / a.fieldAvg - b.val / b.fieldAvg,
      )[0];
      if (weakest) emit(`    ${paint(c.magenta, "▽")} ${dim(weakest.txt)}`);
      if (!wins.length && !weakest) emit(`    ${dim("  building your read…")}`);
    } else {
      emit(`    ${dim("  reading your cascade… (press [R] to refresh)")}`);
    }

    // ── Three Degrees — AI avg · SigRank avg · Top (live values from signalaf.com)
    emit();
    emit(`  ${hr()}`);
    emit(
      `  ${bold("Three Degrees")}  ${dim("AI avg · SigRank avg · top — signalaf.com/wiki")}`,
    );
    const tdHead = [
      padEnd(hdr("Metric"), 10),
      padStart(hdr("AI avg"), 9),
      padStart(hdr("SigRank avg"), 12),
      padStart(hdr("Top"), 9),
    ];
    emit(`    ${tdHead.join("  ")}`);
    const white = (s) => paint(c.white, s);
    const tdRow = (label, b, f, t, fmt) =>
      emit(
        `    ${padEnd(label, 10)}  ${padStart(white(fmt(b)), 9)}  ${padStart(fmt(f), 12)}  ${padStart(gold(fmt(t)), 9)}`,
      );
    tdRow("Υ Yield", TD.base.yield, TD.field.yield, TD.top.yield, fmtY);
    tdRow("SNR", TD.base.snr, TD.field.snr, TD.top.snr, fmtSNR);
    tdRow("Velocity", TD.base.vel, TD.field.vel, TD.top.vel, (v) =>
      v.toFixed(2),
    );
    tdRow(
      "Leverage",
      TD.base.lev,
      TD.field.lev,
      TD.top.lev,
      (v) => fmtLev(v) + "×",
    );
    tdRow("10xDEV", TD.base.d10, TD.field.d10, TD.top.d10, (v) => v.toFixed(2));
    emit(
      `    ${dim("reference values until live user volume calibrates SigRank avg")}`,
    );
  }

  if (status && used < budget) emit(`  ${dim(status)}`);
}

// ── TAB 2: TRENDS ─────────────────────────────────────────────────────────────
// Every cascade metric (+ rank) as a 7d→30d→90d→all sparkline. Three sub-tabs:
//   You      — your own trajectory (+ rank trend, "calculating" until wired)
//   Platform — per-platform (claude / codex / combined)
//   Field    — board-wide trend (calculating until window-history materializes)
// Switch sub-tabs with [T] (cycles You · Platform · Field). Data: the same `active` the Dashboard loads.
const TREND_SUBTABS = ["You", "Platform", "Field"];
// All leaderboard metrics. Most derive from the per-window cascade (pick takes the
// cascade obj + its pillars); §IGNA (proprietary composite) and $/1M (needs cost data)
// aren't computed client-side yet → rendered "calculating", same honest pattern as Rank.
const AA_EFF_BASELINE = 4.0; // efficiency is measured vs the AA 4.0 baseline (per the wiki)
const TREND_METRICS = [
  {
    label: "∑ Total",
    pick: (c, p) =>
      (p.input ?? 0) +
      (p.output ?? 0) +
      (p.cacheCreate ?? 0) +
      (p.cacheRead ?? 0),
    fmt: fmtTok,
  },
  { label: "Υ Yield", pick: (c) => c.yield, fmt: fmtY },
  { label: "SNR", pick: (c) => c.snr, fmt: fmtSNR },
  { label: "Velocity", pick: (c) => c.velocity, fmt: (v) => v.toFixed(2) },
  { label: "Leverage", pick: (c) => c.leverage, fmt: (v) => fmtLev(v) + "×" },
  { label: "10xDEV", pick: (c) => c.dev10x, fmt: (v) => v.toFixed(2) },
  {
    label: "Eff",
    pick: (c) => (c.yield != null ? c.yield / AA_EFF_BASELINE : null),
    fmt: (v) => v.toFixed(1) + "×",
  },
  {
    label: "§IGNA",
    pick: () => null,
    fmt: () => "—",
    stub: "composite calibrating (needs user volume)",
  },
  // FIX A4 (2026-06-27): operating ratio is INPUT-NORMALIZED `cache : 1 : output` (matches web canon —
  // ThreeDegreesChart / OperatingRatioBar, e.g. "3.5 : 1 : 0.50"), not raw token counts (which also
  // overflowed the Trends columns).
  {
    label: "Op Ratio",
    pick: (c, p) =>
      (p.input ?? 0) > 0
        ? {
            cacheRead: p.cacheRead ?? 0,
            input: p.input ?? 0,
            output: p.output ?? 0,
          }
        : null,
    fmt: (v) => {
      const i = v.input || 1;
      return `${(v.cacheRead / i).toFixed(1)} : 1 : ${(v.output / i).toFixed(2)}`;
    },
  },
  {
    label: "$/1M",
    pick: () => null,
    fmt: () => "—",
    stub: "cost data wires post-ingest",
  },
];
function renderTrends(data, subIdx = 0) {
  const { active } = data ?? {};
  const budget = H() - 4;
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };
  const sub = TREND_SUBTABS[subIdx] ?? "You";

  // sub-tab switcher row
  const subBar = TREND_SUBTABS.map((t, i) =>
    i === subIdx
      ? `${c.bgCyan}${c.boldCyan} ${t} ${c.reset}`
      : `${dim(` ${t} `)}`,
  ).join(" ");
  emit();
  emit(
    `  ${bold("Trends")}  ${dim("every metric across windows (7d → all)")}    ${subBar}`,
  );
  emit(`  ${dim("·".repeat(Math.min(W() - 4, 70)))}`);
  emit();

  if (sub === "You" || sub === "Platform") {
    const rows =
      sub === "You"
        ? active?.length
          ? [{ platform: "you", windows: active[0]?.windows }]
          : [] // primary cascade
        : (active ?? []);
    if (!rows.length) {
      emit(`  ${dim("  reading your cascade… (press [R] to refresh)")}`);
    }
    // A3 (2026-06-27): count metric/rank rows dropped by the height budget so we can show a
    // "+N more — resize / scroll" note instead of silently truncating. Each rendered block wants
    // TREND_METRICS.length metric rows + 1 rank row. (Fit logic below unchanged — observe only.)
    let trendsDropped = 0;
    for (let ri = 0; ri < rows.length; ri++) {
      const d = rows[ri];
      if (used >= budget - 2) {
        trendsDropped += (rows.length - ri) * (TREND_METRICS.length + 1);
        break;
      }
      emit(`  ${bold(sub === "You" ? "Your trajectory" : cyan(d.platform))}`);
      // FIX G1: window column headers (mirror renderCompare) — one header row, then
      // values in fixed-width columns below. No per-value `w:` prefix.
      emit(`    ${trendHeader()}`);
      let mi = 0;
      for (; mi < TREND_METRICS.length; mi++) {
        const m = TREND_METRICS[mi];
        if (used >= budget - 2) break;
        if (m.stub) {
          emit(
            `    ${padEnd(dim(m.label), 10)}  ${dim("▁▁▁▁  calculating… (" + m.stub + ")")}`,
          );
        } else {
          emit(
            `    ${padEnd(cyan(m.label), 10)}  ${metricSpark(d, m.pick, m.fmt)}`,
          );
        }
      }
      trendsDropped += TREND_METRICS.length - mi; // metrics this block couldn't fit
      // rank trend — wired later; honest placeholder for now
      if (used < budget - 1)
        emit(
          `    ${padEnd(dim("Rank"), 10)}  ${dim("▁▁▁▁  calculating… (rank history wires post-ingest)")}`,
        );
      else trendsDropped += 1;
      emit();
    }
    // A3: surface the dropped count instead of hiding it.
    // SCROLL-VIEW (2026-06-27): changed "resize / scroll" → "resize to see more"
    // because these tabs don't have a real scroll viewport (only Dashboard cascade does).
    if (trendsDropped > 0)
      emit(`  ${dim(`  +${trendsDropped} more — resize to see more`)}`);
  } else {
    // Field
    emit(`  ${dim("  Field-wide trends — calculating…")}`);
    emit(
      `  ${dim("  (needs per-window board history; materializes once live ingest lands)")}`,
    );
  }
}

// ── TAB 3: COMPARE ───────────────────────────────────────────────────────────
function renderCompare(data) {
  const { tpData, cc, ts, td, platform } = data;
  const WINS = ["7d", "30d", "90d", "all"];
  const w = W();
  const budget = H() - 4;
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };

  const tpPillars = {};
  for (const win of tpData?.windows ?? []) tpPillars[win.window] = win.pillars;

  const SOURCES = [
    {
      name: "tokenpull",
      color: (s) => paint(c.boldCyan, s),
      pillars: tpPillars,
      note: "JSONL canon",
    },
    {
      name: "ccusage",
      color: (s) => paint(c.green, s),
      pillars: cc ?? {},
      note: "ccusage CLI",
    },
    {
      name: "token-dash",
      color: (s) => paint(c.magenta, s),
      pillars: td ?? {},
      note: "SQLite",
    },
    {
      name: "tokscale",
      color: (s) => paint(c.blue, s),
      pillars: ts ?? {},
      note: "report.json",
    },
  ].filter((s) => Object.keys(s.pillars).length > 0);

  emit();
  emit(
    `  ${bold("Source Comparison")}  ${dim(`platform: ${platform}`)}  ${dim("·  tokenpull vs ccusage vs token-dash vs tokscale")}`,
  );

  if (!tpData) {
    emit(
      `  ${dim("tokenpull: no JSONL data found — check ~/.claude/projects/")}`,
    );
  } else {
    const all = tpPillars["all"];
    if (all) {
      emit(
        `  ${dim("tokenpull all-time:")}  In ${cyan(fmtTok(all.input))}  Out ${green(fmtTok(all.output))}  CW ${paint(c.blue, fmtTok(all.cacheCreate))}  CR ${gold(fmtTok(all.cacheRead))}`,
      );
    }
  }
  emit();

  const COL_W = 11;
  const hcols = [
    padEnd(dim("Source"), 12),
    padEnd(dim("Pillar"), 10),
    ...WINS.map((wn) => padStart(dim(wn), COL_W)),
  ];
  emit(`    ${hcols.join("  ")}`);
  emit(
    `  ${dim("·".repeat(Math.min(w - 4, 12 + 12 + WINS.length * (COL_W + 2))))}`,
  );

  const PILLARS = [
    { key: "input", label: "Input" },
    { key: "output", label: "Output" },
    { key: "cacheWrite", label: "CacheW", dbKey: "cacheCreate" },
    { key: "cacheRead", label: "CacheR" },
  ];

  // Reserve space for cascade metrics below (~8 lines)
  const metricsLines = 6 + SOURCES.length;
  for (const src of SOURCES) {
    let firstRow = true;
    for (const pil of PILLARS) {
      if (used >= budget - metricsLines) break;
      const dbKey = pil.dbKey ?? pil.key;
      const cells = WINS.map((win) => {
        const p = src.pillars[win];
        const val = p?.[dbKey] ?? null;
        if (val == null) return padStart(dim("—"), COL_W);
        const baseVal = tpPillars[win]?.[dbKey];
        if (src.name !== "tokenpull" && baseVal != null && baseVal > 0) {
          const delta = ((val - baseVal) / baseVal) * 100;
          const dStr =
            delta === 0
              ? ""
              : delta > 0
                ? green(` +${delta.toFixed(0)}%`)
                : red(` ${delta.toFixed(0)}%`);
          return padStart(`${fmtTok(val)}${dStr}`, COL_W);
        }
        return padStart(fmtTok(val), COL_W);
      });
      const srcLabel = firstRow
        ? padEnd(src.color(src.name), 12)
        : padEnd(dim(""), 12);
      emit(
        `    ${srcLabel}  ${padEnd(dim(pil.label), 10)}  ${cells.join("  ")}`,
      );
      firstRow = false;
    }
    emit();
  }

  if (used < budget - 4) {
    emit(`  ${hr()}`);
    emit(
      `  ${bold("Cascade Metrics")}  ${dim("all-time · computed from each source")}`,
    );
    const MCH = [
      padEnd(hdr("Source"), 12),
      padStart(hdr("Υ Yield"), 9),
      padStart(hdr("SNR"), 7),
      padStart(hdr("Lev"), 8),
      padStart(hdr("Vel"), 6),
      padStart(hdr("10x"), 6),
      padEnd(hdr("Class"), 13),
    ];
    emit(`    ${MCH.join("  ")}`);
    emit(`  ${dim("·".repeat(Math.min(w - 4, 72)))}`);
    for (const src of SOURCES) {
      if (used >= budget) break;
      const p = src.pillars["all"];
      if (!p) continue;
      const cas = cascadeFrom(p);
      if (!cas) continue;
      const clsFn = CLS[cas.class] ?? ((s) => s);
      const cols = [
        padEnd(src.color(src.name), 12),
        padStart(
          cas.yield > 10000 ? gold(fmtY(cas.yield)) : fmtY(cas.yield),
          9,
        ),
        padStart(fmtSNR(cas.snr), 7),
        padStart(fmtLev(cas.leverage) + "×", 8),
        padStart(cas.velocity?.toFixed(2) ?? "—", 6),
        padStart(cas.dev10x?.toFixed(2) ?? "—", 6),
        padEnd(clsFn(cas.class), 13),
      ];
      emit(`    ${cols.join("  ")}`);
    }
  }
}

// ── TAB 3: BOARD — submissions view (#8) ──────────────────────────────────────
// Renders ALL submissions ranked (raw submission rows from GET /api/v1/submissions), not operator
// aggregates. Columns: rank · codename · platform · window · Υ Yield · op_ratio · class · tokens.
// Field names are read defensively (the endpoint is new) so a slightly different server shape still
// renders. [Y] "just me" filtering + the you-highlight carry over from the leaderboard view.
function renderSubmissions(
  boardData,
  window = "30d",
  filterCodename = null,
  highlightCodename = null,
) {
  const rows =
    boardData?.submissions ??
    boardData?.entries ??
    boardData?.rows ??
    (Array.isArray(boardData) ? boardData : []);
  const w = W();
  const budget = H() - 4;
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };

  // Defensive field readers (server shape is new / not yet pinned).
  const gName = (e) =>
    e.display_name || e.codename || e.operator_codename || "—";
  const gPlat = (e) => e.platform ?? e.platform_primary ?? "—";
  const gWin = (e) => e.window ?? e.window_type ?? "—";
  const gYield = (e) => e.yield_ ?? e.yield ?? e.y ?? null;
  const gOpRatio = (e) => e.op_ratio ?? e.operating_ratio ?? e.opRatio ?? null;
  const gClass = (e) => e.class_tier ?? e.class ?? e.class_ ?? "—";
  const gTokens = (e) => e.tokens ?? e.total_tokens ?? e.token_total ?? null;

  const modeLabel = filterCodename
    ? `${dim(" · just you")}`
    : highlightCodename
      ? `${dim(" · you highlighted")}`
      : "";
  emit();
  emit(
    `  ${bold("Submissions")}  ${dim(`window: ${window}  ·  all submissions ranked by Υ Yield  ·  signalaf.com`)}${modeLabel}`,
  );
  emit();

  if (!Array.isArray(rows) || rows.length === 0) {
    emit(`  ${dim("  no submissions for this window")}`);
    return;
  }

  let sorted = [...rows].sort((a, b) => (gYield(b) ?? 0) - (gYield(a) ?? 0));
  if (filterCodename) {
    sorted = sorted.filter(
      (e) => (gName(e) ?? "").toLowerCase() === filterCodename.toLowerCase(),
    );
    if (sorted.length === 0) {
      emit(`  ${dim(`  you have no submissions in the ${window} window yet`)}`);
      emit(`  ${dim("  press [S] from a read tab to submit your cascade")}`);
      return;
    }
  }

  // op_ratio may arrive as a preformatted string ("3.5 : 1 : 0.50") or a number — render either.
  const fmtOp = (v) =>
    v == null
      ? "—"
      : typeof v === "string"
        ? v
        : typeof v === "number"
          ? v.toFixed(2)
          : String(v);

  const SH = [
    padStart(hdr("#"), 4),
    padEnd(hdr("Codename"), 20),
    padEnd(hdr("Platform"), 10),
    padEnd(hdr("Win"), 6),
    padStart(hdr("Υ Yield"), 9),
    padEnd(hdr("Op Ratio"), 18),
    padEnd(hdr("Class"), 12),
    padStart(hdr("Tokens"), 9),
  ];
  emit(`    ${SH.join("  ")}`);
  emit(`  ${dim("·".repeat(Math.min(w - 4, 100)))}`);

  let shown = 0;
  for (let idx = 0; idx < sorted.length; idx++) {
    if (used >= budget) break;
    const e = sorted[idx];
    const isYou =
      highlightCodename &&
      (gName(e) ?? "").toLowerCase() === highlightCodename.toLowerCase();
    const rk =
      idx === 0
        ? gold(`#${idx + 1}`)
        : idx < 3
          ? cyan(`#${idx + 1}`)
          : `#${idx + 1}`;
    const nmRaw = trunc(gName(e), 20);
    const nm = isYou
      ? `${c.bgCyan}${c.boldCyan}${padEnd(` ${trunc(gName(e), 18)} `, 20)}${c.reset}`
      : padEnd(nmRaw, 20);
    const yv = gYield(e);
    const yld = padStart(
      yv != null ? (yv > 10000 ? gold(fmtY(yv)) : fmtY(yv)) : "—",
      9,
    );
    const cls = padEnd(colorCls(gClass(e)), 12);
    const tk = gTokens(e);
    const youMark = isYou ? ` ${c.bgCyan}${c.boldCyan}YOU${c.reset}` : "";
    emit(
      `    ${padStart(rk, 4)}  ${nm}  ${padEnd(cyan(trunc(gPlat(e), 10)), 10)}  ${padEnd(dim(trunc(gWin(e), 6)), 6)}  ${yld}  ${padEnd(dim(fmtOp(gOpRatio(e))), 18)}  ${cls}  ${padStart(tk != null ? fmtTok(tk) : "—", 9)}${youMark}`,
    );
    shown++;
  }
  // A3-style: if the height budget dropped rows, say so instead of silently truncating.
  // SCROLL-VIEW (2026-06-27): changed "resize / scroll" → "resize to see more"
  // (Board tab doesn't have a real scroll viewport — only Dashboard cascade does).
  const dropped = sorted.length - shown;
  if (dropped > 0 && used < budget)
    emit(`  ${dim(`  +${dropped} more — resize to see more`)}`);
}

// ── TAB 3: BOARD ─────────────────────────────────────────────────────────────
// FIX I2: hybrid board model. `filterCodename` (non-null = "just me" mode) shows
// ONLY the signed-in operator's rows. `highlightCodename` (non-null = global mode)
// highlights the signed-in operator's row in the global board. Both come from the
// signed-in identity's codename; the [Y] key toggles between the two modes.
function renderBoard(
  boardData,
  window = "30d",
  filterCodename = null,
  highlightCodename = null,
) {
  // #8 (2026-06-27): when the data came from the NEW /api/v1/submissions endpoint, render ALL
  // submissions ranked (raw rows). Otherwise fall through to the existing leaderboard render
  // (pre-deploy fallback). loadBoardData tags the payload with `_source`.
  if (boardData?._source === "submissions") {
    renderSubmissions(boardData, window, filterCodename, highlightCodename);
    return;
  }
  const entries = boardData?.entries ?? boardData?.operators ?? boardData ?? [];
  const w = W();
  const budget = H() - 4;
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };

  const modeLabel = filterCodename
    ? `${dim(" · just you")}`
    : highlightCodename
      ? `${dim(" · you highlighted")}`
      : "";
  emit();
  emit(
    `  ${bold("Leaderboard")}  ${dim(`window: ${window}  ·  sorted by Υ Yield  ·  signalaf.com/leaderboard`)}${modeLabel}`,
  );
  emit();

  if (!Array.isArray(entries) || entries.length === 0) {
    emit(`  ${dim("  board unavailable")}`);
    return;
  }

  // FIX I2: "just me" mode — filter to the signed-in operator's rows only.
  let sorted = [...entries].sort((a, b) => (b.yield_ ?? 0) - (a.yield_ ?? 0));
  if (filterCodename) {
    sorted = sorted.filter(
      (e) => (e.codename ?? "").toLowerCase() === filterCodename.toLowerCase(),
    );
    if (sorted.length === 0) {
      emit(`  ${dim(`  you have no ranked rows in the ${window} window yet`)}`);
      emit(`  ${dim("  press [S] from a read tab to submit your cascade")}`);
      return;
    }
  }

  // Per-column top-3 "shadowbox": medal bg-tint (gold/silver/bronze) on the 1st/2nd/3rd
  // best DISTINCT value in each metric column, mirroring the website's podium boxes.
  const MEDAL_BG = { 1: 220, 2: 250, 3: 130 }; // gold · silver · bronze (256-color)
  const top3 = (pick) => {
    const distinct = [
      ...new Set(sorted.map(pick).filter((v) => v != null && isFinite(v))),
    ].sort((a, b) => b - a);
    const m = new Map();
    distinct.slice(0, 3).forEach((v, i) => m.set(v, i + 1));
    return m;
  };
  const pods = {
    yield: top3((e) => e.yield_),
    snr: top3((e) => e.snr ?? e.compression_ratio),
    lev: top3((e) => e.leverage),
    vel: top3((e) => e.velocity),
    d10: top3((e) => e.dev10x),
  };
  // Wrap a padded cell in a medal bg-tint (dark fg on the medal color) when its value places top-3.
  const medal = (map, val, padded) => {
    const place = val == null ? null : map.get(val);
    if (!place) return padded;
    return `${ESC}48;5;${MEDAL_BG[place]}m${ESC}38;5;232m${padded}${c.reset}`;
  };

  const BH = [
    padStart(hdr("#"), 4),
    padEnd(hdr("Codename"), 22),
    padEnd(hdr("Class"), 13),
    padStart(hdr("Υ Yield"), 9),
    padStart(hdr("SNR"), 7),
    padStart(hdr("Lev"), 7),
    padStart(hdr("Vel"), 6),
    padStart(hdr("10x"), 6),
    padStart(hdr("Pct"), 5),
    padStart(hdr("7d↕"), 5),
  ];
  emit(`    ${BH.join("  ")}`);
  emit(`  ${dim("·".repeat(Math.min(w - 4, 98)))}`);

  for (let idx = 0; idx < sorted.length; idx++) {
    if (used >= budget) break;
    const e = sorted[idx];
    // FIX I2: highlight the signed-in operator's row (global mode) with a cyan bg-tint.
    const isYou =
      highlightCodename &&
      (e.codename ?? "").toLowerCase() === highlightCodename.toLowerCase();
    const rk =
      idx === 0
        ? gold(`#${idx + 1}`)
        : idx < 3
          ? cyan(`#${idx + 1}`)
          : `#${idx + 1}`;
    const nmRaw = trunc(e.display_name || e.codename || "—", 22);
    // FIX I2: pad the visible content INSIDE the ANSI codes so the cyan bg fills
    // the full column width (padEnd after reset would leave uncolored trailing spaces).
    const nm = isYou
      ? `${c.bgCyan}${c.boldCyan}${padEnd(` ${nmRaw} `, 22)}${c.reset}`
      : padEnd(nmRaw, 22);
    const cls = padEnd(colorCls(e.class_tier ?? "—"), 13);
    const snrVal = e.snr ?? e.compression_ratio;
    // value cells: pad first, then medal-wrap so the tint fills the whole column width
    const yld = medal(
      pods.yield,
      e.yield_,
      padStart(e.yield_ != null ? fmtY(e.yield_) : "—", 9),
    );
    const snr = medal(
      pods.snr,
      snrVal,
      padStart(snrVal != null ? fmtSNR(snrVal) : "—", 7),
    );
    const lev = medal(
      pods.lev,
      e.leverage,
      padStart(e.leverage != null ? fmtLev(e.leverage) + "×" : "—", 7),
    );
    const vel = medal(
      pods.vel,
      e.velocity,
      padStart(e.velocity != null ? e.velocity.toFixed(2) : "—", 6),
    );
    const d10 = medal(
      pods.d10,
      e.dev10x,
      padStart(e.dev10x != null ? e.dev10x.toFixed(2) : "—", 6),
    );
    const pct = padStart(e.percentile != null ? `${e.percentile}%` : "—", 5);
    const mv = padStart(fmtMov(e.movement_7d), 5);
    const youMark = isYou ? ` ${c.bgCyan}${c.boldCyan}YOU${c.reset}` : "";
    emit(
      `    ${padStart(rk, 4)}  ${nm}  ${cls}  ${yld}  ${snr}  ${lev}  ${vel}  ${d10}  ${pct}  ${mv}${youMark}`,
    );
  }
}

// ── TAB 4: WATCH — landing panel (instructions + why it matters) ─────────────
// Explains what the live watcher does and why it's the point of the agent: it
// re-reads your local logs on an interval and feeds your verified cascade to the
// leaderboard. Launched (in its own window) with [Enter]; interval is tunable.
// A5 (2026-06-27): Watch defaults to ALL active platforms × ALL windows (mirror the cli.mjs watch
// change). `platform`/`win` are OPTIONAL focus filters — null/'all' means "everything". [P]/[W]
// cycle the focus (including back to "all"); the spawned watcher + this copy show everything by default.
function renderWatchInfo(platform, win, refresh) {
  const platLabel =
    !platform || platform === "all" ? "all active platforms" : platform;
  const winLabel = !win || win === "all-windows" ? "all windows" : win;
  const allDefault =
    platLabel === "all active platforms" && winLabel === "all windows";
  writeln();
  writeln(
    `  ${bold("Live Watch")}  ${dim("the agent that keeps your rank current")}`,
  );
  writeln();
  writeln(`  ${dim("What it does")}`);
  writeln(
    `    Re-reads your local token logs for ${cyan(platLabel)} across ${cyan(winLabel)} every`,
  );
  writeln(
    `    ${gold(refresh + "s")} and recomputes each cascade (Υ Yield · SNR · Leverage · class) live, on`,
  );
  writeln(
    `    this machine. ${dim("By default it watches everything — every platform you actually use.")}`,
  );
  writeln();
  writeln(`  ${dim("Why it matters")}`);
  writeln(
    `    Watch is how the board stays ${bold("current")}: each refresh submits your latest`,
  );
  writeln(
    `    verified cascade so ${cyan("signalaf.com/leaderboard")} ${bold("auto-updates")} as you work —`,
  );
  writeln(
    `    no manual re-submit. Tokens never leave your machine; only the metrics post.`,
  );
  writeln();
  writeln(`  ${dim("Settings")}`);
  writeln(
    `    ${dim("Platform")}  ${cyan(platLabel)}     ${dim("Window")}  ${cyan(winLabel)}     ${dim("Refresh")}  ${gold(refresh + "s")}`,
  );
  writeln(
    `    ${dim(allDefault ? "watching everything (default)" : "focused — press [P]/[W] to widen back to all")}`,
  );
  writeln();
  writeln(
    `    ${dim("[Enter]")} launch watcher (new window)   ${dim("[+]/[-]")} refresh ±5s   ${dim("[P]")} platform focus   ${dim("[W]")} window focus`,
  );
  writeln();
}

// ── TAB 6: CONNECT ───────────────────────────────────────────────────────────
// Sign in (paste a connect code) / show signed-in status. The whole app lives in
// the TUI; this replaces every "go run the CLI to enroll" hint. Uses only helpers
// already defined above (bold/dim/cyan/green/red/hr/writeln).
function renderConnect(id, codeBuf = "", msg = "") {
  writeln();
  if (isSignedIn(id)) {
    writeln(`  ${bold("Connect")}  ${dim("your account")}`);
    writeln(`  ${hr()}`);
    writeln(`  ${green("✓")} Signed in as ${cyan(id.codename)}`);
    writeln(`  ${dim(`device ${id.device_id}`)}`);
    writeln();
    writeln(
      `  ${dim("Press")} ${bold("[S]")} ${dim("from any read tab to submit your runs to the board.")}`,
    );
    writeln();
    writeln(
      `  ${dim('Need a new key? Click "New key" at signalaf.com → Settings, then paste it here.')}`,
    );
    writeln(
      `  ${dim("Signed in on the wrong device, or want a fresh start?")} ${bold("[X]")} ${dim("signs out — next paste provisions a fresh device.")}`,
    );
  } else {
    writeln(`  ${bold("Log in to submit to board")}`);
    writeln(`  ${hr()}`);
    writeln(`  ${dim("status:")} ${red("not signed in")}`);
    writeln();
    writeln(`  ${dim("Paste your key, then")} ${bold("[Enter]")}${dim(":")}`);
  }
  writeln(`    ${cyan(">")} ${codeBuf}${dim("▏")}`);
  writeln();
  writeln(
    `  ${dim('Get a key at signalaf.com → Settings → "New key" (or "Generate connect code").')}`,
  );
  if (msg) {
    writeln();
    writeln(`  ${msg}`);
  }
}

// ── TAB 4: WATCH (live grid) ──────────────────────────────────────────────────
// A5 (2026-06-27): renders ALL active platforms × ALL windows by default (mirror the cli.mjs
// watch grid), instead of a single platform/window. `platform`/`win` are OPTIONAL focus filters —
// null/'all'/'all-windows' means "everything". Each row is a (platform, window) cascade cell:
// Υ Yield + SNR/Lev/Vel/class. Iterates active platforms (input+output > 0 in any window).
async function renderWatch(platform = "all", win = "all-windows") {
  const { tokenpullAny } = await import("./tokenpull.mjs");
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
  const platFilter = platform && platform !== "all" ? platform : null;
  const winFilter = win && win !== "all-windows" ? win : null;
  const WINS = winFilter ? [winFilter] : ["7d", "30d", "90d", "all"];
  const w = W();
  const budget = H() - 4;
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };

  // Detect active platforms (any window with input+output > 0), respecting an optional [P] focus.
  const candidates = platFilter ? [platFilter] : ALL_PLATFORMS;
  const settled = await Promise.allSettled(
    candidates.map((p) => tokenpullAny(p)),
  );
  const active = [];
  for (const r of settled) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const d = r.value;
    if (
      (d.windows || []).some((ww) => ww.pillars.input + ww.pillars.output > 0)
    )
      active.push(d);
  }
  // stable display order
  active.sort(
    (a, b) =>
      ALL_PLATFORMS.indexOf(a.platform) - ALL_PLATFORMS.indexOf(b.platform),
  );

  const scopeLabel =
    (platFilter || "all active platforms") +
    " · " +
    (winFilter ? `${winFilter} window` : "all windows");
  emit();
  emit(`  ${bold("Live Watch")}  ${dim(scopeLabel)}`);
  emit(`  ${dim("·".repeat(Math.min(w - 4, 80)))}`);

  if (active.length === 0) {
    emit();
    emit(
      `  ${dim("  no active platforms detected — run some sessions, this picks them up automatically")}`,
    );
    return;
  }

  for (const d of active) {
    if (used >= budget - 1) break;
    const byWin = {};
    for (const ww of d.windows || []) byWin[ww.window] = ww;
    emit();
    emit(`  ${cyan(d.platform)}${d.estimated ? dim(" (est)") : ""}`);
    for (const wk of WINS) {
      if (used >= budget - 1) break;
      const ww = byWin[wk];
      const cas = ww ? cascadeFrom(ww.pillars) : null;
      const winLabel = wk === "all" ? "all-time" : wk;
      if (!cas) {
        emit(`    ${padEnd(dim(winLabel), 9)}  ${dim("no data")}`);
        continue;
      }
      const clsFn = CLS[cas.class] ?? ((s) => s);
      const yDisplay =
        cas.yield > 1000 ? gold(fmtY(cas.yield)) : cyan(fmtY(cas.yield));
      const metrics = `${dim("SNR")} ${fmtSNR(cas.snr)}  ${dim("Lev")} ${cas.leverage != null ? fmtLev(cas.leverage) + "×" : "—"}  ${dim("Vel")} ${cas.velocity != null ? cas.velocity.toFixed(2) : "—"}  ${clsFn(cas.class)}`;
      emit(
        `    ${padEnd(dim(winLabel), 9)}  ${bold("Υ")} ${yDisplay}  ${metrics}`,
      );
    }
  }
}

// ── SUBMIT PREVIEW (FIX I1 / FIX E) — see→confirm→send ───────────────────────
// Renders a platform × window grid of what submit_verified WOULD send, using the
// already-loaded dashData. [Enter] confirms → fires submit_verified per platform;
// [Esc] cancels → back to the read tab. Mirrors the Connect focused-field pattern.
function renderSubmitPreview(dashData, id) {
  const budget = H() - 4;
  let used = 0;
  const emit = (s = "") => {
    if (used < budget) {
      writeln(s);
      used++;
    }
  };
  const WINS = ["7d", "30d", "90d", "all"];
  const COL_W = 14;

  emit();
  emit(`  ${bold("Submit Preview")}  ${dim("what will publish to the board")}`);
  emit(
    `  ${dim(`signed in as ${id?.codename ?? "—"} · device ${id?.device_id?.slice(0, 8) ?? "—"}…`)}`,
  );
  emit();
  // header row: platform | 7d | 30d | 90d | all
  const hcols = [
    padEnd(hdr("Platform"), 12),
    ...WINS.map((w) => padStart(hdr(w), COL_W)),
  ];
  emit(`    ${hcols.join("  ")}`);
  emit(
    `  ${dim("·".repeat(Math.min(W() - 4, 12 + WINS.length * (COL_W + 2))))}`,
  );

  const active = dashData?.active ?? [];
  for (const d of active) {
    if (used >= budget - 3) break;
    const cells = WINS.map((w) => {
      const wd = d.windows?.find((x) => x.window === w);
      if (!wd || wd.pillars.input + wd.pillars.output === 0)
        return padStart(dim("—"), COL_W);
      const cas = cascadeFrom(wd.pillars);
      if (!cas) return padStart(dim("—"), COL_W);
      return padStart(gold(fmtY(cas.yield)), COL_W);
    });
    emit(`    ${padEnd(cyan(d.platform), 12)}  ${cells.join("  ")}`);
  }
  if (active.length === 0) {
    emit(`  ${dim("  no platforms with data — press [R] to refresh")}`);
  }
  emit();
  emit(
    `  ${dim("[Enter]")} confirm + submit all platforms   ${dim("[Esc]")} cancel`,
  );
}

// ── DEBUG: render a tab once (no TTY/alt-screen) + audit each line's visible
// width vs terminal columns. Usage: `node tui.mjs --render [0|1|2]`. Prints a
// width report (>w = would overflow/wrap) then the raw frame. For diagnosing
// layout overflow without an interactive session.
async function renderOnce(tabIdx = 0) {
  const w = W();
  const data = {
    0: await loadDashboardData().catch((e) => ({ error: e.message })),
    1: await loadCompareData("claude").catch(() => null),
    2: await loadBoardData("30d").catch(() => null),
  }[tabIdx];
  startBuffer();
  if (tabIdx === 0) renderDashboard(data, "debug");
  else if (tabIdx === 1) renderCompare(data);
  else if (tabIdx === 2) renderBoard(data, "30d");
  else if (tabIdx === 4) await renderWatch("all", "all-windows");
  else if (tabIdx === 5) renderConnect(loadIdentity(), "", "");
  const lines = _screenBuf || [];
  _screenBuf = null;
  _footerBuf = null;
  process.stdout.write(
    `\n=== WIDTH AUDIT (terminal w=${w}) — lines exceeding w wrap/overflow ===\n`,
  );
  lines.forEach((ln, i) => {
    const vis = stripAnsi(ln).length;
    if (vis > w)
      process.stdout.write(
        `  OVERFLOW line ${i}: visible=${vis} (>${w} by ${vis - w})  «${stripAnsi(ln).slice(0, 60)}…»\n`,
      );
  });
  const maxVis = Math.max(0, ...lines.map((l) => stripAnsi(l).length));
  process.stdout.write(
    `  widest visible line = ${maxVis} (terminal w=${w}) → ${maxVis > w ? "OVERFLOWS" : "fits"}\n`,
  );
  process.stdout.write(`\n=== RAW FRAME (stripAnsi) ===\n`);
  lines.forEach((ln) => process.stdout.write(stripAnsi(ln) + "\n"));
}

// ── OPENING SPLASH ───────────────────────────────────────────────────────────
// Block-letter SIGRANK wordmark that flashes through colors CONTINUOUSLY until a
// key is pressed (owner 2026-06-25: "keep the animation going"). Randomizes the
// mode each launch (moses gold-shimmer / rainbow / chaos per-letter). Centered to
// terminal width. Any key dismisses → the dashboard loads.
const SPLASH_ART = [
  "███████ ██  ██████  ██████   █████  ███    ██ ██   ██",
  "██      ██ ██       ██   ██ ██   ██ ████   ██ ██  ██ ",
  "███████ ██ ██   ███ ██████  ███████ ██ ██  ██ █████  ",
  "     ██ ██ ██    ██ ██   ██ ██   ██ ██  ██ ██ ██  ██ ",
  "███████ ██  ██████  ██   ██ ██   ██ ██   ████ ██   ██",
];
const SPLASH_RULE = "◈  ───────────────────────────────────────────  ◈";
const MOSES_PAL = [220, 178, 214, 208, 222, 230];
const RAINBOW_PAL = [196, 202, 226, 46, 51, 21, 201, 213];
const col256 = (n, s) => `${ESC}38;5;${n}m${s}${c.reset}`;
const stripA = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ctr = (s) => {
  const pad = Math.max(0, Math.floor((W() - stripA(s).length) / 2));
  return " ".repeat(pad) + s;
};

function splashFrame(mode) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const out = ["", "", ctr(dim(SPLASH_RULE)), ""];
  for (const line of SPLASH_ART) {
    if (mode === "chaos") {
      out.push(
        ctr(
          [...line]
            .map((ch) =>
              ch === " " ? " " : col256(Math.floor(Math.random() * 256), ch),
            )
            .join(""),
        ),
      );
    } else {
      const n = mode === "rainbow" ? pick(RAINBOW_PAL) : pick(MOSES_PAL);
      out.push(ctr(col256(n, line)));
    }
  }
  out.push("", ctr(dim(SPLASH_RULE)), "");
  out.push(ctr(bold("For all builders, burners and 10xers")));
  out.push(ctr(dim("signalaf")), "");
  out.push(ctr(`${dim("powered by")}  ${gold("MO§ES™")}`));
  out.push(ctr(dim("$ npx sigrank")), "");
  out.push(ctr(`${gold("▸")} ${dim("press any key")} ${gold("◂")}`));
  return out.join("\n");
}

// Animated splash. Controls: [P] pause/resume the color animation · [Enter] (or
// any other key) enter the TUI · Ctrl-C quit. Mode (moses/rainbow/chaos) varies
// per launch. Frozen frame keeps the last colors so a pause reads as intentional.
function showSplash() {
  const modes = ["moses", "rainbow", "chaos"];
  const mode = modes[Math.floor((Date.now() / 1000) % modes.length)];
  return new Promise((resolve) => {
    let paused = false;
    const interactive = !!process.stdin.isTTY; // can we read raw keypresses to dismiss?
    const hint = () =>
      interactive
        ? `${dim("  [P]")} ${paused ? "resume" : "pause"}    ${dim("[Enter]")} enter`
        : dim("  loading…");
    // FIXED-WINDOW FIX (2026-06-27): paint the splash via the buffered flushScreen
    // path (GOTO positioning), NOT raw write('\n'). Raw \n scrolls the alt-screen
    // buffer, creating scrollback above the TUI — that's why you could scroll up
    // to see what was above it. flushScreen uses absolute cursor positioning so
    // nothing ever scrolls the buffer. This matches how tokscale renders its frame.
    const paint = () => {
      startBuffer();
      const lines = splashFrame(mode).split("\n");
      lines.forEach((ln) => writeln(ln));
      writeln(ctr(hint()));
      setFooter([]);
      flushScreen();
    };
    paint();
    let timer = setInterval(paint, 110);

    // Non-interactive stdin (some IDE/integrated terminals): still SHOW the animated
    // wordmark, but auto-advance after a short run instead of waiting for a key (which
    // would never arrive → hang). ~2.2s of animation, then enter the TUI.
    if (!interactive) {
      setTimeout(() => {
        clearInterval(timer);
        write(CLEAR);
        resolve();
      }, 2200);
      return;
    }

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onKey = (key) => {
      const k = key.toLowerCase();
      if (k === "p") {
        // toggle pause — don't enter
        paused = !paused;
        if (paused) {
          clearInterval(timer);
          timer = null;
          paint();
        } // freeze on current frame
        else {
          timer = setInterval(paint, 110);
        } // resume animating
        return;
      }
      if (timer) clearInterval(timer);
      process.stdin.removeListener("data", onKey);
      if (key === "\x03") {
        write(SHOW);
        write(EXIT_ALT);
        process.exit(0);
      } // Ctrl-C
      resolve(); // Enter / any other key → enter the TUI
    };
    process.stdin.on("data", onKey);
  });
}

// ── MAIN TUI LOOP ─────────────────────────────────────────────────────────────
export async function runTui({
  platform: initPlatform = "claude",
  window: win = "7d",
} = {}) {
  // FIX J: platform is mutable — [P] cycles it on Compare + Watch tabs. Was a const
  // param (permanently locked to 'claude'); now a let so the user can switch + [S]
  // submits the selected platform (needed for Phase 4 multi-platform submit).
  let platform = initPlatform;
  // Debug render mode — non-interactive, dumps a tab + width audit, then exits.
  const ri = process.argv.indexOf("--render");
  if (ri !== -1) {
    const tab = parseInt(process.argv[ri + 1] ?? "0", 10) || 0;
    await renderOnce(tab);
    return;
  }

  write(ENTER_ALT); // switch to alternate screen — original terminal state preserved on exit
  write(CLEAR_SB); // FIXED-WINDOW (2026-06-27): clear scrollback so nothing is above the TUI
  write(HIDE);
  write(CLEAR);

  // Opening splash — animated SIGRANK wordmark.
  // Gate on stdOUT.isTTY (can we draw the animation?), matching the launch guard —
  // NOT stdin.isTTY, which was skipping the splash in terminals whose input isn't a
  // raw TTY (some IDE/integrated terminals). showSplash() itself auto-advances when
  // stdin can't be read raw, so it never hangs. (Skippable with --no-splash.)
  if (!process.argv.includes("--no-splash") && process.stdout.isTTY) {
    await showSplash();
    write(CLEAR);
  }

  // ── State
  let activeTab = 0;
  let dashData = null;
  let compareData = null;
  let boardData = null;
  let boardWindow = "30d";
  // A5 (2026-06-27): Watch defaults to "all" focus — all active platforms × all windows. [P]/[W]
  // optionally narrow the focus and cycle back to 'all'. ('all-windows' is the window sentinel so
  // it never collides with the real 'all' window bucket in the cli watcher's optional --window.)
  let watchPlatform = "all";
  let watchWindow = "all-windows";
  let watchRefresh = 30; // [5] Watch poll interval (seconds) — [+]/[-] adjust
  let trendSub = 0; // [2] Trends sub-view index (You/Platform/Field) — [T] cycles
  let loading = true;
  let status = "loading…";
  let refreshTimer = null;
  let codeBuf = ""; // [6] Connect tab in-place code field buffer
  let connectMsg = ""; // [6] Connect last-action message (signed in / invalid code)
  let submitMsg = ""; // [S] in-place submit result, shown in the read-tab footer
  let submitPreview = false; // FIX I1: [S] opens a preview grid before sending (see→confirm→send)
  let boardYouOnly = false; // FIX I2: [Y] toggles the Board to "just me" (hybrid model)
  let cascadeScroll = 0; // SCROLL-VIEW (2026-06-27): cascade-section scroll offset (Dashboard only)

  // ── Redraw (buffered: renders into memory, then paints as a locked frame)
  const redraw = async () => {
    startBuffer();
    renderTabBar(activeTab);

    const hint = `  ${dim("← → or 1-6")} switch tabs   ${dim("[R]")} refresh   ${dim("[Q]")} quit`;
    const submitHint = `   ${dim("[S]")} submit to board · ${dim("[C]")} sign in`;
    // Read-tab footer: hr + hint, plus the in-place submit result line when present.
    const readFooter = (hintLine) =>
      submitMsg
        ? [`  ${hr()}`, hintLine, `  ${submitMsg}`]
        : [`  ${hr()}`, hintLine];

    // FIX I1: submit preview is a focused overlay — renders INSTEAD of the tab
    // content, with its own footer. [Enter] sends, [Esc] cancels.
    if (submitPreview) {
      renderSubmitPreview(dashData, loadIdentity());
      setFooter([
        `  ${hr()}`,
        `  ${dim("[Enter]")} submit all platforms   ${dim("[Esc]")} cancel   ${dim("[Q]")} quit`,
      ]);
      flushScreen();
      return;
    }

    if (activeTab === 0) {
      // Dashboard
      if (!dashData) {
        writeln(`\n  ${dim("loading dashboard…")}`);
      } else {
        renderDashboard(dashData, status, cascadeScroll);
      }
      // SCROLL-VIEW: show ↑↓ hint only when there are cascade rows to scroll
      const scrollHint =
        dashData && Array.isArray(dashData.active)
          ? cascadeScrollableCount(dashData.active) >
            maxCascadeRowsFor(dashData.active)
            ? `   ${dim("↑↓ scroll cascade")}`
            : ""
          : "";
      setFooter(readFooter(`${hint}${scrollHint}${submitHint}`));
    } else if (activeTab === 1) {
      // Trends
      if (!dashData) {
        writeln(`\n  ${dim("loading trends…")}`);
      } else {
        renderTrends(dashData, trendSub);
      }
      setFooter(readFooter(`${hint}   ${dim("[T]")} view${submitHint}`));
    } else if (activeTab === 2) {
      // Compare
      if (!compareData) {
        // #9 (2026-06-27): Compare runs a FRESH on-demand pull of the external verifier sources
        // (ccusage + tokscale + token-dashboard rescan) — it can take several seconds. Show a clear
        // spinner line while it runs, instead of a bare "loading…".
        writeln(
          `\n  ${bold("Source Comparison")}  ${dim(`platform: ${platform}`)}`,
        );
        writeln(
          `\n  ${gold("◇")} ${dim(`pulling fresh sources… (ccusage · tokscale · token-dash — this can take several seconds)`)}`,
        );
      } else {
        renderCompare(compareData);
      }
      setFooter(
        readFooter(`${hint}   ${dim("[P]")} switch platform${submitHint}`),
      );
    } else if (activeTab === 3) {
      // Board
      if (!boardData) {
        writeln(`\n  ${dim(`loading board (${boardWindow})…`)}`);
      } else {
        // FIX I2: hybrid board model — global board + your row highlighted, [Y]
        // toggles "just me" (your placements only). Pass the signed-in codename so
        // renderBoard can highlight/filter.
        const id = loadIdentity();
        renderBoard(
          boardData,
          boardWindow,
          boardYouOnly ? id?.codename : null,
          id?.codename ?? null,
        );
      }
      const youHint = isSignedIn(loadIdentity())
        ? `   ${dim("[Y]")} ${boardYouOnly ? "all" : "just me"}`
        : "";
      setFooter(
        readFooter(`${hint}   ${dim("[W]")} window${youHint}${submitHint}`),
      );
    } else if (activeTab === 4) {
      // Watch
      renderWatchInfo(watchPlatform, watchWindow, watchRefresh);
      setFooter(readFooter(`${hint}${submitHint}`));
    } else if (activeTab === 5) {
      // Connect
      const connectId = loadIdentity();
      renderConnect(connectId, codeBuf, connectMsg);
      const signOutHint = isSignedIn(connectId)
        ? `   ${dim("[X]")} sign out`
        : "   " + dim("[X]") + " reset device";
      setFooter([
        `  ${hr()}`,
        `  ${dim("[Enter]")} sign in   ${dim("[Esc]")} clear/back${signOutHint}   ${dim("← →")} tabs   ${dim("[Q]")} quit`,
      ]);
    }
    flushScreen();
  };

  // ── Initial data load
  const loadAll = async () => {
    // A2 (2026-06-27): paint the frame + a clear "reading your cascade…" status IMMEDIATELY,
    // BEFORE the await — so the very first thing on screen is the table header + a live status,
    // not a blank "loading dashboard…". renderDashboard tolerates this empty dashData (guarded).
    status = "reading your cascade…";
    dashData = { active: [], _loading: true };
    await redraw();
    // FIX 0: progressive Dashboard load — claude first (fast), render it, THEN fill
    // the other 13 platforms in the background + redraw. The user sees their cascade
    // within ~1 read instead of a 7s blank "loading dashboard…".
    dashData = await loadDashboardData().catch((e) => {
      status = `dashboard error: ${e.message}`;
      return null;
    });
    status = `last refreshed ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
    await redraw();
    // Keep a "filling other platforms…" status visible while fillDashboardRest runs.
    // #9 (2026-06-27): Compare is NO LONGER eagerly loaded here — loadCompareData now runs the
    // FRESH verifier pull (ccusage + tokscale + token-dash rescan, 5–60s), which would re-introduce
    // a slow Dashboard load path. Compare loads lazily ON-DEMAND when the Compare tab is opened.
    // Board still preloads (fast, cached) in parallel with the platform fill.
    if (dashData?._remaining) {
      status = "claude ready · filling other platforms…";
      await redraw();
    }
    [, boardData] = await Promise.all([
      dashData?._remaining
        ? fillDashboardRest(dashData)
        : Promise.resolve(false),
      loadBoardData(boardWindow).catch(() => null),
    ]);
    status = `last refreshed ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
    await redraw();
  };

  // Always restore terminal on unexpected exit
  const cleanup = () => {
    write(SHOW);
    write(EXIT_ALT);
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  // FIX 0b: re-render on terminal resize so the frame refits the new dimensions.
  process.stdout.on("resize", () => {
    redraw().catch(() => {});
  });

  // Soft-landing: if not signed in, open on the Connect tab (a prompt, not a gate —
  // the user can still tab away to read Board/Dashboard while signed out).
  if (!isSignedIn(loadIdentity())) activeTab = 5;

  // auto-refresh board every 30s
  const startAutoRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      if (activeTab === 3) {
        // Board tab (now index 3)
        boardData = await loadBoardData(boardWindow).catch(() => null);
        await redraw();
      }
    }, 30000);
  };

  // Draw the first frame, then load data in the background. Keyboard handling
  // must be installed before this work completes: pullActivePlatforms() and the
  // board request can take several seconds, and awaiting them here left a fully
  // rendered TUI that silently discarded every key (including Ctrl-C in raw
  // mode) until startup finished.
  await redraw();
  const initialLoad = loadAll().catch(async (e) => {
    status = `dashboard error: ${e.message}`;
    await redraw();
  });
  startAutoRefresh();

  // ── Keyboard
  if (!process.stdin.isTTY) {
    await initialLoad;
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Esc-sequence buffer: some terminals (SSH, tmux, certain emulators) split an
  // arrow key (\x1b[C) into two data events: \x1b then [C. Without buffering, the
  // lone \x1b triggers the Esc handler (clearing the code buffer / leaving the tab)
  // before the [C arrives. We hold \x1b for 25ms; if more bytes follow, we
  // reassemble and deliver the full sequence. If nothing follows, it's a real Esc.
  let escBuf = null;
  let escTimer = null;
  const ESC_HOLD_MS = 25;

  await new Promise((resolve) => {
    const handleKey = async (key) => {
      const k = key.toLowerCase();

      if (k === "q" || k === "\x03") {
        if (refreshTimer) clearInterval(refreshTimer);
        // Startup data work may still be in flight now that input is available
        // immediately. Use the same hard cleanup as SIGINT/SIGTERM so pending
        // fetch timeouts or platform readers cannot keep the CLI alive or redraw
        // over the restored terminal after the user quits.
        cleanup();
        return;
      }

      // ── Connect tab is a FOCUSED code field (the one modal tab). Printable code
      // chars feed the buffer; Enter signs in; Esc clears or leaves; arrows switch.
      // Sits AFTER the quit block (so Q/Ctrl-C always escape) and BEFORE everything
      // else (so single-letter hotkeys don't fire while you're typing a code).
      if (activeTab === 5) {
        if (key === "\r" || key === "\n") {
          // [Enter] → sign in
          const code = codeBuf.trim();
          if (!code) {
            connectMsg = dim("paste a connect code first");
            await redraw();
            return;
          }
          connectMsg = dim("signing in…");
          await redraw();
          try {
            const out = await callTool("enroll", { code });
            if (out.status === "enrolled") {
              connectMsg = out.recovered
                ? `${green("✓")} recovered account: ${cyan(out.codename || "(operator)")} ${dim("(device was already bound)")}`
                : `${green("✓")} signed in as ${cyan(out.codename || "(operator)")}`;
              codeBuf = "";
            } else {
              const reasons = {
                code_invalid:
                  "that code is invalid, expired, or already used — generate a fresh one.",
                device_already_enrolled:
                  'this device is already bound. Press [X] to reset the device, then paste a fresh code from signalaf.com → Settings → "New key".',
                bad_request: "the code or device key was malformed.",
                rate_limited:
                  "too many attempts — wait a few minutes and retry.",
                persistence_unavailable:
                  "sign-in is temporarily unavailable — try again shortly.",
              };
              connectMsg = `${red("✗")} ${reasons[out.reason] || `sign-in failed (${out.reason || "unknown"}).`}`;
              codeBuf = ""; // auto-clear on failure — the code is consumed/invalid
            }
          } catch (e) {
            connectMsg = `${red("✗")} ${e.message}`;
            codeBuf = ""; // auto-clear on error too
          }
          await redraw();
          return;
        }
        if (key === "\x1b") {
          // [Esc] → clear, or leave when empty
          if (codeBuf) {
            codeBuf = "";
            connectMsg = "";
          } else {
            activeTab = 0;
          }
          await redraw();
          return;
        }
        if (key === "\x1b[C") {
          activeTab = Math.min(5, activeTab + 1);
          await redraw();
          return;
        } // → tab
        if (key === "\x1b[D") {
          activeTab = Math.max(0, activeTab - 1);
          await redraw();
          return;
        } // ← tab
        if (key === "\x7f" || key === "\b") {
          codeBuf = codeBuf.slice(0, -1);
          await redraw();
          return;
        } // backspace
        // [X] sign out / reset — only when the code field is empty (so 'x'/'X' typed
        // mid-code still feeds the buffer — codes can contain X). The auto-clear on
        // sign-in failure (above) ensures the buffer is empty after a failed attempt,
        // so X works immediately when the user wants to reset. Drops the local
        // credential so a server-revoked OR server-enrolled-but-locally-unbound device
        // stops holding a stale device_id, and the next enroll provisions a fresh
        // device_id (escapes the Frankenstein-identity / 409-re-enroll deadlock).
        if (k === "x" && !codeBuf) {
          const wasSignedIn = isSignedIn(loadIdentity());
          clearIdentity();
          codeBuf = "";
          connectMsg = wasSignedIn
            ? `${green("✓")} signed out — paste a new code to sign in`
            : `${green("✓")} device reset — paste a new code to sign in`;
          await redraw();
          return;
        }
        // A typed code char (len 1) or a pasted code (one multi-char chunk). Exclude any
        // escape sequence (↑/↓/etc.) so stray control bytes never pollute the buffer.
        if (!key.startsWith("\x1b") && (key.length > 1 || isCodeChar(key))) {
          codeBuf += key.split("").filter(isCodeChar).join("");
          await redraw();
          return;
        }
        return; // swallow any other key while focused (never falls through to global hotkeys)
      }

      // FIX I1: submit preview is a focused overlay (like Connect). [Enter] sends
      // all platforms, [Esc] cancels. Intercepts keys BEFORE the tab/ESC handlers.
      if (submitPreview) {
        if (key === "\r" || key === "\n") {
          // [Enter] → confirm + submit all platforms
          submitPreview = false;
          submitMsg = dim("submitting…");
          await redraw();
          const id = loadIdentity();
          if (!isSignedIn(id)) {
            submitMsg = `${red("✗")} sign in to submit`;
            activeTab = 5;
            await redraw();
            return;
          }
          // FIX I1: submit every active platform (data already loaded for the Dashboard).
          // Each platform is a separate submit_verified call → its own (platform, window) slot.
          const platforms = (dashData?.active ?? []).map((d) => d.platform);
          let totalVerified = 0,
            totalReceived = 0,
            hadFail = false,
            didMulti = false;
          for (const p of platforms) {
            try {
              const out = await callTool("submit_verified", { platform: p });
              const ws = out.windows || [];
              const received = ws.filter((w) => w.status === "received");
              const verified = received.filter(
                (w) => w.verification_tier === "verified",
              );
              totalReceived += received.length;
              totalVerified += verified.length;
              if (received.length > 0 && verified.length < received.length)
                hadFail = true;
            } catch {
              hadFail = true;
            }
          }
          // MULTI: the combined cross-platform cascade (claude+codex+… summed). Only
          // meaningful with 2+ active platforms; submit_verified('multi') aggregates them.
          if (platforms.length >= 2) {
            try {
              const out = await callTool("submit_verified", {
                platform: "multi",
              });
              const ws = out.windows || [];
              const received = ws.filter((w) => w.status === "received");
              const verified = received.filter(
                (w) => w.verification_tier === "verified",
              );
              totalReceived += received.length;
              totalVerified += verified.length;
              if (received.length > 0 && verified.length < received.length)
                hadFail = true;
              if (received.length > 0) didMulti = true;
            } catch {
              hadFail = true;
            }
          }
          if (totalReceived && !hadFail && totalVerified === totalReceived) {
            submitMsg = `${green("✓")} submitted · ${totalVerified} window${totalVerified > 1 ? "s" : ""} across ${platforms.length} platform${platforms.length > 1 ? "s" : ""}${didMulti ? " + combined" : ""} · verified`;
          } else if (hadFail && totalReceived) {
            submitMsg = `${red("✗")} device not verified — sign in again ([C])`;
          } else if (totalReceived === 0) {
            submitMsg = `${red("✗")} nothing to submit — no windows with data`;
          } else {
            submitMsg = `${red("✗")} submit failed`;
          }
          await redraw();
          return;
        }
        if (key === "\x1b") {
          // [Esc] → cancel
          submitPreview = false;
          await redraw();
          return;
        }
        return; // swallow all other keys while the preview is open
      }

      // ESC → go back to Dashboard from any tab
      if (key === "\x1b" && activeTab !== 0) {
        activeTab = 0;
        await redraw();
        return;
      }

      // SCROLL-VIEW (2026-06-27): ↑/↓ (or j/k) scroll the cascade section on the
      // Dashboard tab ONLY. The rest of the dashboard stays pinned. Only active
      // when there are more cascade rows than fit in the viewport.
      if (activeTab === 0 && dashData && Array.isArray(dashData.active)) {
        const total = cascadeScrollableCount(dashData.active);
        const maxRows = maxCascadeRowsFor(dashData.active);
        if (total > maxRows) {
          const maxOff = total - maxRows;
          if (key === "\x1b[A" || k === "k") {
            // ↑ / k → scroll up
            cascadeScroll = Math.max(0, cascadeScroll - 1);
            await redraw();
            return;
          }
          if (key === "\x1b[B" || k === "j") {
            // ↓ / j → scroll down
            cascadeScroll = Math.min(maxOff, cascadeScroll + 1);
            await redraw();
            return;
          }
          if (key === "\x1b[5~") {
            // PageUp → scroll up by viewport
            cascadeScroll = Math.max(0, cascadeScroll - maxRows);
            await redraw();
            return;
          }
          if (key === "\x1b[6~") {
            // PageDown → scroll down by viewport
            cascadeScroll = Math.min(maxOff, cascadeScroll + maxRows);
            await redraw();
            return;
          }
        }
      }

      // tab switching (6 tabs: 0=Dashboard 1=Trends 2=Compare 3=Board 4=Watch 5=Connect)
      let switched = false;
      if (key === "\x1b[C") {
        activeTab = Math.min(5, activeTab + 1);
        switched = true;
      }
      if (key === "\x1b[D") {
        activeTab = Math.max(0, activeTab - 1);
        switched = true;
      }
      if (k === "1") {
        activeTab = 0;
        switched = true;
      }
      if (k === "2") {
        activeTab = 1;
        switched = true;
      }
      if (k === "3") {
        activeTab = 2;
        switched = true;
      }
      if (k === "4") {
        activeTab = 3;
        switched = true;
      }
      if (k === "5") {
        activeTab = 4;
        switched = true;
      } // Watch = an in-TUI landing panel
      if (k === "6") {
        activeTab = 5;
        switched = true;
      } // Connect = sign in / switch device
      if (k === "c" && activeTab !== 5) {
        activeTab = 5;
        switched = true;
      } // [C] → Connect from any read tab

      // SCROLL-VIEW: reset cascade scroll when leaving the Dashboard tab
      if (switched && activeTab !== 0) cascadeScroll = 0;

      // #9 (2026-06-27): Compare loads its FRESH verifier pull ON-DEMAND when the tab opens
      // (NOT on the Dashboard load path — that pull is a 5–60s scan). Paint the "pulling fresh
      // sources…" spinner first (compareData null → redraw shows it), then run the pull + re-render.
      // ASYNC FIX (2026-06-27): with execFile (async), the event loop keeps running during the
      // pull — key presses are NOT blocked. Guard: only render the result if the user is still
      // on the Compare tab (they may have switched away during the pull).
      if (switched && activeTab === 2 && !compareData) {
        submitMsg = "";
        await redraw(); // show the spinner line before the (slow) fresh pull
        const result = await loadCompareData(platform).catch(() => null);
        if (activeTab === 2) {
          // still on Compare? render the result
          compareData = result;
          await redraw();
        }
        return;
      }

      // Trends tab: [T] cycles the sub-view (You · Platform · Field)
      if (activeTab === 1 && k === "t") {
        trendSub = (trendSub + 1) % 3;
        await redraw();
        return;
      }

      // Watch tab: [+]/[-] tune the refresh interval (5–600s), [Enter] launches the watcher
      if (activeTab === 4 && (k === "+" || k === "=")) {
        watchRefresh = Math.min(600, watchRefresh + 5);
        await redraw();
        return;
      }
      if (activeTab === 4 && (k === "-" || k === "_")) {
        watchRefresh = Math.max(5, watchRefresh - 5);
        await redraw();
        return;
      }

      // FIX J: [P] cycles platform on Compare + Watch tabs (was a dead hinted key).
      // Compare reloads compareData for the new platform; Watch just re-renders.
      const CYCLE_PLATFORMS = [
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
      if (k === "p" && (activeTab === 2 || activeTab === 4)) {
        if (activeTab === 2) {
          // Compare: real platforms only (no 'all' — Compare is per-platform by design).
          const idx = CYCLE_PLATFORMS.indexOf(platform);
          platform = CYCLE_PLATFORMS[(idx + 1) % CYCLE_PLATFORMS.length];
          // #9: clearing compareData makes redraw show the "pulling fresh sources…" spinner
          // for the new platform while the fresh on-demand verifier pull runs.
          compareData = null;
          status = `loading ${platform}…`;
          await redraw();
          // ASYNC FIX: guard — only render if still on Compare (user may have switched away)
          const result = await loadCompareData(platform).catch(() => null);
          if (activeTab === 2) {
            compareData = result;
            status = `last refreshed ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
          }
        } else {
          // A5: Watch [P] cycles 'all' → claude → codex → … → 'all' (optional focus; default 'all').
          const WATCH_PLAT_CYCLE = ["all", ...CYCLE_PLATFORMS];
          const idx = WATCH_PLAT_CYCLE.indexOf(watchPlatform);
          watchPlatform = WATCH_PLAT_CYCLE[(idx + 1) % WATCH_PLAT_CYCLE.length];
        }
        await redraw();
        return;
      }

      // FIX J / A5: [W] cycles window FOCUS on the Watch tab. 'all-windows' (default) → 7d → 30d →
      // 90d → all → back to 'all-windows'. Board tab's [W] (activeTab === 3) is handled below.
      if (k === "w" && activeTab === 4) {
        const WATCH_WIN_CYCLE = ["all-windows", "7d", "30d", "90d", "all"];
        const idx = WATCH_WIN_CYCLE.indexOf(watchWindow);
        watchWindow = WATCH_WIN_CYCLE[(idx + 1) % WATCH_WIN_CYCLE.length];
        await redraw();
        return;
      }

      if (activeTab === 4 && (key === "\r" || key === "\n")) {
        // A5 (2026-06-27): launch the live watcher in its own window. By default (focus = 'all')
        // pass NO --platform/--window so the cli watcher auto-loads ALL active platforms × ALL
        // windows. Only add a filter flag when the user has set an explicit [P]/[W] focus.
        try {
          let watchCmd = "sigrank watch";
          if (watchPlatform && watchPlatform !== "all")
            watchCmd += ` --platform ${watchPlatform}`;
          if (watchWindow && watchWindow !== "all-windows")
            watchCmd += ` --window ${watchWindow}`;
          watchCmd += ` --refresh ${watchRefresh}`;
          // ASYNC FIX (2026-06-27): execFile instead of execSync — no shell
          // interpolation. osascript args passed as array (defense-in-depth).
          execFile(
            "osascript",
            ["-e", `tell application "Terminal" to do script "${watchCmd}"`],
            { stdio: "ignore" },
            () => {},
          );
          const scope =
            (!watchPlatform || watchPlatform === "all") &&
            (!watchWindow || watchWindow === "all-windows")
              ? "all platforms × all windows"
              : "focused";
          status = `watcher launched (${scope}, ${watchRefresh}s) in a new window`;
        } catch {
          status = "could not open Terminal.app — run: sigrank watch";
        }
        await redraw();
        return;
      }

      if (k === "r") {
        status = "refreshing…";
        cascadeScroll = 0; // SCROLL-VIEW: reset scroll on refresh
        // #9: on the Compare tab, [R] re-runs the FRESH verifier pull for the current platform
        // (loadAll no longer touches Compare). Clearing compareData shows the spinner first.
        if (activeTab === 2) {
          compareData = null;
          await redraw();
          // ASYNC FIX: guard — only render if still on Compare
          const result = await loadCompareData(platform).catch(() => null);
          if (activeTab === 2) {
            compareData = result;
            status = `last refreshed ${new Date().toLocaleTimeString("en-US", { hour12: false })}`;
            await redraw();
          }
          return;
        }
        await redraw();
        await loadAll();
        return;
      }

      if (k === "s" && activeTab !== 5) {
        // FIX I1/E: [S] opens a submit PREVIEW (see→confirm→send) instead of firing
        // blind. The preview shows a platform × window grid of what will publish;
        // [Enter] sends all platforms, [Esc] cancels. (On the Connect tab, 's' is a
        // code char handled by the focused field above.)
        const id = loadIdentity();
        if (!isSignedIn(id)) {
          // not signed in → open Connect, never error
          activeTab = 5;
          connectMsg = dim("sign in to submit to board");
          await redraw();
          return;
        }
        submitPreview = true;
        submitMsg = "";
        await redraw();
        return;
      }

      // FIX I2: [Y] toggles the Board between global+highlighted and "just me"
      // (hybrid model — owner decision 2026-06-26). Only when signed in.
      if (k === "y" && activeTab === 3 && isSignedIn(loadIdentity())) {
        boardYouOnly = !boardYouOnly;
        await redraw();
        return;
      }

      if (k === "w" && activeTab === 3) {
        // Board tab (now index 3)
        const windows = ["7d", "30d", "90d", "all"];
        const idx = windows.indexOf(boardWindow);
        boardWindow = windows[(idx + 1) % windows.length];
        boardData = await loadBoardData(boardWindow).catch(() => null);
      }

      if (switched) submitMsg = ""; // submit result is tied to the tab it was sent from
      if (switched || k === "w") await redraw();
    };

    // Buffered stdin listener: reassembles split Esc sequences before dispatch.
    process.stdin.on("data", (chunk) => {
      // If we have a pending \x1b held from a previous chunk, combine it with
      // this chunk to reassemble the full escape sequence (\x1b + [C = \x1b[C).
      if (escBuf) {
        clearTimeout(escTimer);
        const combined = escBuf + chunk;
        escBuf = null;
        escTimer = null;
        // If the combined result is \x1b followed by more \x1b (rare), just
        // deliver the first as Esc and re-buffer the second. Otherwise deliver
        // the combined sequence.
        if (combined.length > 1) {
          handleKey(combined);
          return;
        }
        // combined is still just \x1b (chunk was empty?) → fall through to hold
      }

      // Fast path: chunk doesn't start with \x1b → deliver immediately.
      if (chunk[0] !== "\x1b") {
        handleKey(chunk);
        return;
      }
      // Chunk starts with \x1b and is longer than 1 byte → complete escape
      // sequence → deliver immediately.
      if (chunk.length > 1) {
        handleKey(chunk);
        return;
      }
      // Chunk is exactly \x1b → hold for ESC_HOLD_MS to see if more bytes follow.
      escBuf = chunk;
      escTimer = setTimeout(() => {
        handleKey(escBuf);
        escBuf = null;
        escTimer = null;
      }, ESC_HOLD_MS);
    });
  });

  process.stdin.setRawMode(false);
  process.stdin.pause();
  writeln();
}

// Direct-run entry (e.g. `node tui.mjs --render 0`). Normal launch is via cli.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  runTui().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
