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

import { callTool, DEFAULT_API_BASE } from './tools.mjs'
import { isSignedIn, isCodeChar } from './connect.mjs'
import { loadIdentity } from './keystore.mjs'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

// Version read from package.json (single source of truth — matches cli.mjs;
// never hardcode, that's what caused the version drift).
const VERSION = (() => {
  try { return createRequire(import.meta.url)('./package.json').version } catch { return '?' }
})()

// ── ANSI ───────────────────────────────────────────────────────────────────
const ESC = '\x1b['
const c = {
  reset:     `${ESC}0m`,
  bold:      `${ESC}1m`,
  dim:       `${ESC}2m`,
  gold:      `${ESC}33m`,
  boldGold:  `${ESC}1;33m`,
  cyan:      `${ESC}36m`,
  boldCyan:  `${ESC}1;36m`,
  green:     `${ESC}32m`,
  red:       `${ESC}31m`,
  white:     `${ESC}97m`,
  boldWhite: `${ESC}1;97m`,
  magenta:   `${ESC}35m`,
  blue:      `${ESC}34m`,
  bgDim:     `${ESC}48;5;236m`,  // dark grey bg for active tab
  bgCyan:    `${ESC}48;5;23m`,   // dark teal bg for active tab
}
const paint  = (col, s) => `${col}${s}${c.reset}`
const bold   = (s) => paint(c.bold, s)
const dim    = (s) => paint(c.dim, s)
const gold   = (s) => paint(c.boldGold, s)
const cyan   = (s) => paint(c.boldCyan, s)
const hdr    = (s) => paint(c.boldCyan, s)  // table column-header label color (readability)
const green  = (s) => paint(c.green, s)
const red    = (s) => paint(c.red, s)

const CLEAR      = `${ESC}H${ESC}2J`   // home + erase visible area
const ENTER_ALT  = `${ESC}?1049h`       // enter alternate screen buffer
const EXIT_ALT   = `${ESC}?1049l`       // exit alternate screen buffer (restores original)
const HIDE       = `${ESC}?25l`
const SHOW       = `${ESC}?25h`
const UP         = (n) => `${ESC}${n}A`
const ERLINE     = `${ESC}2K`
const GOTO       = (r, col = 1) => `${ESC}${r};${col}H`   // absolute cursor position

const W      = () => process.stdout.columns || 100
const H      = () => process.stdout.rows    || 40

// ── Screen buffer: collect lines, then paint only what fits ─────────────
// Render functions call write/writeln as before; the buffer captures them.
// flushScreen() paints to the real terminal using absolute cursor positioning
// so the TUI never scrolls — it's a locked frame like tokscale.
let _screenBuf = null    // null = direct mode (unbuffered); string[] = buffered
const write  = (s) => { if (_screenBuf) { const parts = s.split('\n'); if (parts.length === 1) { _screenBuf[_screenBuf.length-1] += s } else { _screenBuf[_screenBuf.length-1] += parts[0]; for (let i=1;i<parts.length;i++) _screenBuf.push(parts[i]) } } else { process.stdout.write(s) } }
const writeln = (s = '') => { if (_screenBuf) { _screenBuf[_screenBuf.length-1] += s; _screenBuf.push('') } else { process.stdout.write(s + '\n') } }

let _footerBuf = null    // footer lines pinned to bottom
function startBuffer() { _screenBuf = ['']; _footerBuf = null }
function setFooter(lines) { _footerBuf = lines }
function flushScreen() {
  if (!_screenBuf) return
  const lines = _screenBuf
  const footer = _footerBuf || []
  _screenBuf = null
  _footerBuf = null
  const h = H()
  const w = W()
  // Footer FLOWS right after content (not pinned to the terminal bottom). This
  // avoids both the tall-terminal gap and the short-terminal cutoff the pinned
  // layout caused. Content + footer are clamped together to the terminal height
  // so a frame never scrolls the alt-screen (which would smear old rows).
  const frame = [...lines, ...footer]
  const maxRows = Math.min(frame.length, h)
  let out = ''
  for (let i = 0; i < maxRows; i++) {
    out += GOTO(i + 1) + ERLINE + ansiTrunc(frame[i], w)
  }
  // Clear any rows below the frame left over from a taller previous frame.
  for (let i = maxRows; i < h; i++) {
    out += GOTO(i + 1) + ERLINE
  }
  process.stdout.write(out)
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, '') }
// ANSI-aware truncate: cut to `w` VISIBLE columns while keeping color escapes
// intact (escapes don't count toward width, and we never slice mid-sequence).
// Replaces raw `.slice(0, w)`, which corrupts color codes + miscounts width.
function ansiTrunc(s, w) {
  if (stripAnsi(s).length <= w) return s
  let out = '', vis = 0, i = 0
  while (i < s.length && vis < w) {
    if (s[i] === '\x1b') {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/)
      if (m) { out += m[0]; i += m[0].length; continue }
    }
    out += s[i]; vis++; i++
  }
  return out + '\x1b[0m' // reset so a cut mid-color doesn't bleed into next line
}
function padEnd(s, w)  { const v = stripAnsi(s).length; return v >= w ? s : s + ' '.repeat(w - v) }
function padStart(s,w) { const v = stripAnsi(s).length; return v >= w ? s : ' '.repeat(w - v) + s }
function trunc(s, w)   { return stripAnsi(s).length <= w ? s : s.slice(0, w - 1) + '…' }
function hr(ch = '─')  { return dim(ch.repeat(Math.max(0, W() - 4))) }

// ── Number formatters ───────────────────────────────────────────────────────
const fmtY   = (y) => y == null ? '—' : y >= 10000 ? `${(y/1000).toFixed(1)}K` : y >= 1000 ? `${(y/1000).toFixed(2)}K` : y.toFixed(1)
const fmtLev = (l) => l == null ? '—' : l >= 1000 ? `${(l/1000).toFixed(1)}K` : l.toFixed(0)
const fmtSNR = (n) => n == null ? '—' : `${(n*100).toFixed(1)}%`
const fmtTok = (n) => n == null ? '—' : n >= 1e9 ? `${(n/1e9).toFixed(1)}B` : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : String(n)
const fmtMov = (n) => (n == null || n === 0) ? dim('—') : n > 0 ? green(`+${n}`) : red(`${n}`)

// ── Class tier colors ────────────────────────────────────────────────────────
const CLS = {
  TRANSMITTER: (s) => paint(c.boldGold,  s),
  'ARCH+':     (s) => paint(c.boldCyan,  s),
  ARCH:        (s) => paint(c.cyan,      s),
  POWER:       (s) => paint(c.boldWhite, s),
  BASE:        (s) => paint(c.white,     s),
  SEEKER:      (s) => paint(c.magenta,   s),
  REFINER:     (s) => paint(c.blue,      s),
  BEARER:      (s) => paint(c.dim,       s),
  IGNITER:     (s) => paint(c.dim,       s),
}
const colorCls = (cls) => (CLS[cls] ?? ((s) => s))(cls)

// ── Cascade math (inline, no dep) ───────────────────────────────────────────
function cascadeFrom(p) {
  if (!p) return null
  const i = p.input ?? 0, o = p.output ?? 0, cr = p.cacheRead ?? 0
  if (i === 0 || o === 0) return null
  const leverage = cr / i
  const velocity = o / i
  const yld = leverage * velocity
  const dev10x = (i > 0 && o > 0 && (p.cacheCreate ?? 0) > 0 && cr > 0)
    ? Math.log10(cr / i) : null
  const snr = o / (i + o)

  let cls = 'IGNITER'
  if      (yld >= 1000 || dev10x >= 3)    cls = 'TRANSMITTER'
  else if (dev10x != null && dev10x >= 1.45) cls = 'ARCH+'
  else if (dev10x != null && dev10x >= 1.35) cls = 'ARCH'
  else if (dev10x != null && dev10x >= 1.2)  cls = 'POWER'
  else if (dev10x != null && dev10x >= 1.0)  cls = 'BASE'
  else if (dev10x != null && dev10x >= 0)    cls = 'SEEKER'
  else if (dev10x != null && dev10x >= -0.3) cls = 'REFINER'

  return { yield: yld, snr, leverage, velocity, dev10x, class: cls }
}

// ── Unicode bar chart (no dep) ───────────────────────────────────────────────
const BLOCKS = ' ▏▎▍▌▋▊▉█'

// Linear bar — use when all values are the same order of magnitude.
function barChart(values, labels, opts = {}) {
  const { width = 30, colorFn = (s) => s, maxVal } = opts
  const max = maxVal ?? Math.max(...values.filter(Number.isFinite), 1)
  const lines = []
  for (let i = 0; i < values.length; i++) {
    const v    = values[i] ?? 0
    const pct  = Math.min(v / max, 1)
    const full = Math.floor(pct * width)
    const frac = Math.floor((pct * width - full) * 8)
    const bar  = colorFn('█'.repeat(full) + (frac > 0 ? BLOCKS[frac] : ''))
    const lbl  = padEnd(dim(labels[i] ?? ''), 10)
    const val  = padStart(fmtTok(v), 8)
    lines.push(`    ${lbl}  ${padEnd(bar, width)}  ${val}`)
  }
  return lines
}

// Log-scale bar — use when values span multiple orders of magnitude (e.g. token pillars
// where cacheRead >> input). Maps log10(v) to bar width so each 10x = same visual step.
// minLog floor prevents zero/tiny values from going negative.
function logBar(v, maxLog, width = 40, colorCode = c.cyan) {
  if (!v || v <= 0) return { bar: dim('·'.repeat(width)), pct: 0 }
  const log = Math.log10(v)
  const pct = Math.min(log / maxLog, 1)
  const full = Math.floor(pct * width)
  const frac = Math.floor((pct * width - full) * 8)
  const bar = paint(colorCode, '█'.repeat(full) + (frac > 0 ? BLOCKS[frac] : ''))
  return { bar, pct }
}

// ── Sparkline (no dep) ────────────────────────────────────────────────────────
const SPARK = '▁▂▃▄▅▆▇█'
function sparkline(values) {
  const valid = values.filter(Number.isFinite)
  if (valid.length === 0) return dim('no data')
  const min = Math.min(...valid), max = Math.max(...valid)
  return values.map(v => {
    if (!Number.isFinite(v)) return dim('·')
    const idx = max === min ? 7 : Math.round(((v - min) / (max - min)) * 7)
    return SPARK[idx]
  }).join('')
}

// ── Data sources (same as cli.mjs) ──────────────────────────────────────────
function ccusagePillars(platform = 'claude') {
  try {
    const cmd = platform === 'claude' ? 'ccusage claude daily --json' : `ccusage ${platform} daily --json`
    const raw = execSync(cmd, { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const data = JSON.parse(raw)
    const rows = data.daily ?? data
    const now = Date.now()
    const cutoff = { '7d': 7, '30d': 30, '90d': 90 }
    const result = {}
    for (const [win, days] of Object.entries(cutoff)) {
      const since = new Date(now - days * 86400000)
      let i = 0, o = 0, cw = 0, cr = 0
      for (const row of rows) {
        if (new Date(row.date ?? row.day ?? '1970') >= since) {
          i  += row.inputTokens        ?? row.input_tokens        ?? 0
          o  += row.outputTokens       ?? row.output_tokens       ?? 0
          cw += row.cacheCreationTokens ?? row.cache_create_tokens ?? 0
          cr += row.cacheReadTokens    ?? row.cache_read_tokens   ?? 0
        }
      }
      result[win] = { input: i, output: o, cacheCreate: cw, cacheRead: cr }
    }
    let i = 0, o = 0, cw = 0, cr = 0
    for (const row of rows) {
      i  += row.inputTokens        ?? 0
      o  += row.outputTokens       ?? 0
      cw += row.cacheCreationTokens ?? 0
      cr += row.cacheReadTokens    ?? 0
    }
    result['all'] = { input: i, output: o, cacheCreate: cw, cacheRead: cr }
    return result
  } catch { return null }
}

function tokscalePillars(platform = 'claude') {
  const p = path.join(os.homedir(), 'tokscale_report.json')
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    const rows = (data.entries ?? []).filter(e =>
      e.client === platform && e.model !== '<synthetic>' && e.model !== 'unknown' && (e.input > 0 || e.output > 0)
    )
    if (!rows.length) return null
    const acc = rows.reduce((a, e) => ({
      input: a.input + (e.input ?? 0), output: a.output + (e.output ?? 0),
      cacheCreate: a.cacheCreate + (e.cacheWrite ?? 0), cacheRead: a.cacheRead + (e.cacheRead ?? 0),
    }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
    return { all: acc }
  } catch { return null }
}

function tokenDashPillars() {
  const dbPath = path.join(os.homedir(), '.claude', 'token-dashboard.db')
  if (!existsSync(dbPath)) return null
  try {
    const raw = execSync(
      `sqlite3 "${dbPath}" "SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages"`,
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim()
    const [i, o, cw, cr] = raw.split('|').map(Number)
    return { all: { input: i || 0, output: o || 0, cacheCreate: cw || 0, cacheRead: cr || 0 } }
  } catch { return null }
}

async function loadDashboardData() {
  const { tokenpullAny } = await import('./tokenpull.mjs')
  const ALL_PLATFORMS = [
    'claude','codex','amp','gemini','kimi','qwen','goose','kilo',
    'hermes','droid','codebuff','copilot','openclaw','pi',
  ]
  const boardPromise = Promise.race([
    fetch(`${DEFAULT_API_BASE}/api/v1/leaderboard?window=30d&metric=yield_`, { headers: { accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null).catch(() => null),
    new Promise(r => setTimeout(() => r(null), 5000)),
  ])

  // All platforms scan in parallel. tokenpullAny handles each platform's
  // canonical conversion (Codex ioRatio, reasoning→output, etc.) internally.
  const [allResults, tdPillars] = await Promise.all([
    Promise.allSettled(ALL_PLATFORMS.map(p => tokenpullAny(p))),
    Promise.resolve(tokenDashPillars()),
  ])

  const verifierMap = {}
  for (const platform of ALL_PLATFORMS) {
    verifierMap[platform] = { cc: ccusagePillars(platform), ts: tokscalePillars(platform) }
  }

  const active = []
  for (let i = 0; i < ALL_PLATFORMS.length; i++) {
    const r = allResults[i]
    if (r.status !== 'fulfilled') continue
    const d = r.value
    const all = d.windows?.find(w => w.window === 'all')
    if (!all) continue
    if ((all.pillars.input ?? 0) + (all.pillars.output ?? 0) === 0) continue
    active.push(d)
  }

  const boardData = await boardPromise
  return { active, verifierMap, tdPillars, boardData }
}

async function loadCompareData(platform = 'claude') {
  const tpData = await callTool('tokenpull', { platform }).catch(() => null)
  const cc = ccusagePillars(platform)
  const ts = tokscalePillars(platform)
  const td = platform === 'claude' ? tokenDashPillars() : null
  return { tpData, cc, ts, td, platform }
}

async function loadBoardData(window = '30d') {
  const res = await fetch(`${DEFAULT_API_BASE}/api/v1/leaderboard?window=${window}&metric=yield_`, {
    headers: { accept: 'application/json' }
  })
  if (!res.ok) return null
  return res.json()
}

// ── TAB BAR ──────────────────────────────────────────────────────────────────
const TABS = [
  { key: '1', label: 'Dashboard', short: 'D' },
  { key: '2', label: 'Trends',    short: 'T' },  // every metric across windows (sub-views: You/Platform/Field)
  { key: '3', label: 'Compare',   short: 'C' },
  { key: '4', label: 'Board',     short: 'B' },
  { key: '5', label: 'Watch',     short: 'W' },  // in-TUI landing panel; [Enter] launches the watcher
  { key: '6', label: 'Connect',   short: 'N' },  // sign in / switch device — the whole app is the TUI
]

// Three Degrees of Leverage — reference values pulled from signalaf.com/wiki (2026-06-25).
// base = AI avg (modeled 7:2:1 baseline) · field = SigRank avg (wild field median) · top = best operator.
// STATIC for now; goes live (field/top computed from the board) once there's real user volume.
const TD = {
  base:  { yield: 1.57, snr: 0.33, vel: 0.50, lev: 3.2,   d10: 0.50 },
  field: { yield: 1.51, snr: 0.07, vel: 0.08, lev: 22.3,  d10: 1.35 },
  top:   { yield: 745.40, snr: 0.63, vel: 1.70, lev: 438.6, d10: 2.64 },
}

function renderTabBar(activeIdx) {
  const w = W()
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })

  // logo
  const logo = `  ${gold('⊙ SigRank')}`
  // tabs
  const tabStr = TABS.map((t, i) => {
    const lbl = ` ${t.key}:${t.label} `
    return i === activeIdx
      ? `${c.bgCyan}${c.boldCyan}${lbl}${c.reset}`
      : `${c.bgDim}${c.dim}${lbl}${c.reset}`
  }).join('')
  // right side — version (single source of truth) · site · clock
  const right = dim(`${gold('v' + VERSION)}${c.reset}${c.dim}  ·  signalaf.com  ·  ${ts}`)

  const logoVis  = stripAnsi(logo).length
  const tabsVis  = TABS.reduce((a, t) => a + t.label.length + 4, 0)
  const rightVis = stripAnsi(right).length
  const gap = Math.max(1, w - logoVis - tabsVis - rightVis - 2)

  writeln(`${logo}  ${tabStr}${' '.repeat(gap)}${right}`)
  writeln(`  ${hr()}`)
}

// ── GRAPHICS helpers ─────────────────────────────────────────────────────────

// Horizontal stacked bar: input | cacheW | cacheR | output
function tokenBar(p, width = 40) {
  if (!p) return dim('  no data')
  const total = (p.input ?? 0) + (p.output ?? 0) + (p.cacheCreate ?? 0) + (p.cacheRead ?? 0)
  if (total === 0) return dim('  no data')
  const seg = (val, colorCode) => {
    const w = Math.round((val / total) * width)
    return w > 0 ? paint(colorCode, '█'.repeat(w)) : ''
  }
  const bar = seg(p.input, c.cyan) + seg(p.cacheCreate, c.blue) + seg(p.cacheRead, c.boldGold) + seg(p.output, c.green)
  return bar
}

// Generalized cascade-metric sparkline across windows (7d→30d→90d→all).
// pick: (cas) => number · fmt: (v) => string. Used by the Trends tab for every metric.
function metricSpark(d, pick, fmt) {
  const wins = ['7d', '30d', '90d', 'all']
  const vals = wins.map(w => {
    const wd = d.windows?.find(x => x.window === w)
    if (!wd) return null
    const cas = cascadeFrom(wd.pillars)
    return cas ? pick(cas, wd.pillars) : null   // pick gets (cascade, pillars)
  })
  return sparkline(vals) + `  ${wins.map((w, i) => vals[i] != null ? dim(w + ':') + fmt(vals[i]) : '').filter(Boolean).join('  ')}`
}

// Yield sparkline across windows
function yieldSpark(d) {
  const wins = ['7d', '30d', '90d', 'all']
  const vals = wins.map(w => {
    const wd = d.windows?.find(x => x.window === w)
    if (!wd) return null
    const cas = cascadeFrom(wd.pillars)
    return cas?.yield ?? null
  })
  return sparkline(vals) + `  ${wins.map((w, i) => vals[i] != null ? dim(w + ':') + fmtY(vals[i]) : '').filter(Boolean).join('  ')}`
}

// ── TAB 1: DASHBOARD ─────────────────────────────────────────────────────────
function renderDashboard(data, status = '') {
  const { active, verifierMap, tdPillars, boardData } = data
  const w = W()
  const budget = H() - 4  // 2 tab bar + 2 footer
  const WINS = ['7d', '30d', '90d', 'all']
  let used = 0
  const emit = (s = '') => { if (used < budget) { writeln(s); used++ } }

  // Responsive: the full 12-col table is ~124 wide. On terminals narrower than
  // that, drop the two derived columns (Vel, 10x) and tighten the inter-column
  // gap from 2 spaces to 1, so the core pillars + Υ/SNR/Lev/Class still fit.
  const narrow = w < 124
  const gap = narrow ? ' ' : '  '
  const renderRow = (label, colorFn, winKey, p, est = false) => {
    const cas = cascadeFrom(p)
    if (!cas) return
    const clsFn = CLS[cas.class] ?? ((s) => s)
    const cols = [
      padEnd(colorFn(label), 12), padEnd(dim(winKey), 5),
      padStart(est ? dim('~')+fmtTok(p.input) : fmtTok(p.input), 8),
      padStart(fmtTok(p.output), 8),
      padStart((p.cacheCreate??0) > 0 ? (est ? dim('~')+fmtTok(p.cacheCreate) : fmtTok(p.cacheCreate)) : dim('—'), 8),
      padStart((p.cacheRead??0) > 0 ? fmtTok(p.cacheRead) : dim('—'), 9),
      padStart(cas.yield > 10000 ? gold(fmtY(cas.yield)) : fmtY(cas.yield), 9),
      padStart(fmtSNR(cas.snr), 7),
      padStart(fmtLev(cas.leverage)+'×', 7),
      ...(narrow ? [] : [
        padStart(cas.velocity?.toFixed(2) ?? '—', 6),
        padStart(cas.dev10x?.toFixed(2) ?? '—', 6),
      ]),
      padEnd(clsFn(cas.class), 13),
    ]
    emit(`    ${cols.join(gap)}`)
  }

  // ── Cascade table
  emit()
  emit(`  ${bold('Your Cascade')}  ${dim('all platforms · all windows')}`)
  emit()

  // header (matches renderRow's responsive column set + gap)
  const CH = [
    padEnd(hdr('Platform'), 12), padEnd(hdr('Win'), 5),
    padStart(hdr('Input'), 8), padStart(hdr('Output'), 8),
    padStart(hdr('CacheW'), 8), padStart(hdr('CacheR'), 9),
    padStart(hdr('Υ Yield'), 9), padStart(hdr('SNR'), 7),
    padStart(hdr('Lev'), 7),
    ...(narrow ? [] : [padStart(hdr('Vel'), 6), padStart(hdr('10x'), 6)]),
    padEnd(hdr('Class'), 13),
  ]
  emit(`    ${CH.join(gap)}`)
  emit(`  ${dim('·'.repeat(Math.max(0, Math.min(w - 4, narrow ? 96 : 114))))}`)

  if (active.length === 0) {
    emit(`  ${dim('  reading token logs… (takes ~4s on first load · press [R] to refresh)')}`)
  }

  // Calculate how many cascade rows we can fit — reserve space for lower sections.
  // (Υ-trend section moved to the Trends tab; its old `sparkLines` reservation is gone,
  // which is what was starving codex's cascade rows after the Your-Read/Three-Degrees panels landed.)
  const platformCount = active.length
  const barLines = 4 + platformCount + (platformCount > 1 ? 1 : 0)  // Token Composition: hr + header + platforms + combined + note
  // Your Read (hr+header+~3 wins+1 gap = 6) + Three Degrees (blank+hr+header+col-header+5 rows+note = 10) + status
  const boardLines = 17
  const sectionsBelow = barLines + boardLines
  const maxCascadeRows = Math.max(8, budget - used - sectionsBelow)

  let firstWin = {}
  let cascadeRowCount = 0
  for (const d of active) {
    firstWin[d.platform] = WINS.find(wk => {
      const wd = d.windows?.find(w => w.window === wk)
      return wd && (wd.pillars.input + wd.pillars.output) > 0
    })
    for (const wk of WINS) {
      if (cascadeRowCount >= maxCascadeRows || used >= budget - sectionsBelow) break
      const wd = d.windows?.find(x => x.window === wk)
      if (!wd || (wd.pillars.input + wd.pillars.output) === 0) continue
      renderRow(d.platform, (s) => wk === firstWin[d.platform] ? cyan(s) : dim(s), wk, wd.pillars, d.estimated)
      cascadeRowCount++
    }
    emit()
  }

  // combined
  if (active.length > 1 && used < budget - sectionsBelow) {
    const lbl = active.map(d => d.platform).join('+')
    const hasEst = active.some(d => d.estimated)
    let fst = true
    for (const wk of WINS) {
      const cp = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
      let any = false
      for (const d of active) {
        const wd = d.windows?.find(x => x.window === wk)
        if (!wd || (wd.pillars.input + wd.pillars.output) === 0) continue
        cp.input += wd.pillars.input ?? 0; cp.output += wd.pillars.output ?? 0
        cp.cacheCreate += wd.pillars.cacheCreate ?? 0; cp.cacheRead += wd.pillars.cacheRead ?? 0
        any = true
      }
      if (!any) continue
      renderRow(lbl, (s) => fst ? bold(cyan(s)) : dim(s), wk, cp, hasEst)
      fst = false
    }
    emit()
  }

  // (Υ Trend moved to the dedicated Trends tab [2] — every metric, with sub-views.)

  // ── Token bar charts (skip if no room)
  if (used < budget - boardLines) {
    emit(`  ${hr()}`)
    emit(`  ${bold('Token Composition')}  ${dim('█')}${paint(c.cyan,'I')}${dim(' in  █')}${paint(c.blue,'W')}${dim(' cW  █')}${paint(c.boldGold,'R')}${dim(' cR  █')}${paint(c.green,'O')}${dim(' out')}`)
    for (const d of active) {
      if (used >= budget - boardLines) break
      const all = d.windows?.find(w => w.window === 'all')
      if (!all) continue
      emit(`    ${padEnd(cyan(d.platform), 10)}  ${tokenBar(all.pillars, 50)}  ${dim(fmtTok((all.pillars.input??0)+(all.pillars.output??0)+(all.pillars.cacheCreate??0)+(all.pillars.cacheRead??0)))}`)
    }
    if (active.length > 1) {
      const cp = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
      for (const d of active) {
        const all = d.windows?.find(w => w.window === 'all')
        if (!all) continue
        cp.input += all.pillars.input??0; cp.output += all.pillars.output??0
        cp.cacheCreate += all.pillars.cacheCreate??0; cp.cacheRead += all.pillars.cacheRead??0
      }
      emit(`    ${padEnd(bold(active.map(d => d.platform).join('+')), 10)}  ${tokenBar(cp, 50)}  ${dim(fmtTok(cp.input+cp.output+cp.cacheCreate+cp.cacheRead))}`)
    }
  }

  // ── Your insights + the Three Degrees panel (replaces the old top-3 mini board)
  // The user's own cascade (the firstWin/combined row computed above) read against the
  // Three Degrees reference so the Dashboard says "here's you, here's the field, here's the ceiling."
  const you = (() => {
    // Best available cascade for the user: prefer claude's first-window, else any computed row.
    for (const d of active) {
      const wk = firstWin[d.platform]
      const wd = d.windows?.find((x) => x.window === wk)
      const cas = wd && cascadeFrom(wd.pillars)
      if (cas) return cas   // cascadeFrom already returns null for non-compounding rows
    }
    return null
  })()

  if (used < budget - 8) {
    // ── Custom insights — comparison vs the field + a concrete tip for the weakest metric
    emit(`  ${hr()}`)
    emit(`  ${bold('Your Read')}  ${dim('how your cascade sits vs the field')}`)
    if (you) {
      const wins = [], gaps = []
      const chk = (label, val, fieldAvg, top, fmt, tip) => {
        if (val == null) return
        if (val >= top * 0.9) wins.push(`${label} ${fmt(val)} — ${gold('top tier')}`)
        else if (val >= fieldAvg) wins.push(`${label} ${fmt(val)} — above field avg`)
        else gaps.push({ label, txt: `${label} ${fmt(val)} — below field (${fmt(fieldAvg)}): ${tip}`, val, fieldAvg })
      }
      chk('Υ Yield', you.yield, TD.field.yield, TD.top.yield, fmtY, 'compound more — reuse cache, raise output')
      chk('SNR', you.snr, TD.field.snr, TD.top.snr, fmtSNR, 'tighten prompts — less input per unit output')
      chk('Leverage', you.leverage, TD.field.lev, TD.top.lev, (v) => fmtLev(v) + '×', 'lean on cache-read — amplify prior context')
      chk('Velocity', you.velocity, TD.field.vel, TD.top.vel, (v) => v.toFixed(2), 'more output per input token')
      for (const w of wins.slice(0, 3)) emit(`    ${paint(c.green, '▲')} ${w}`)
      // weakest gap gets the prescriptive tip
      const weakest = gaps.sort((a, b) => (a.val / a.fieldAvg) - (b.val / b.fieldAvg))[0]
      if (weakest) emit(`    ${paint(c.magenta, '▽')} ${dim(weakest.txt)}`)
      if (!wins.length && !weakest) emit(`    ${dim('  building your read…')}`)
    } else {
      emit(`    ${dim('  reading your cascade… (press [R] to refresh)')}`)
    }

    // ── Three Degrees — AI avg · SigRank avg · Top (live values from signalaf.com)
    emit()
    emit(`  ${hr()}`)
    emit(`  ${bold('Three Degrees')}  ${dim('AI avg · SigRank avg · top — signalaf.com/wiki')}`)
    const tdHead = [padEnd(hdr('Metric'), 10), padStart(hdr('AI avg'), 9), padStart(hdr('SigRank avg'), 12), padStart(hdr('Top'), 9)]
    emit(`    ${tdHead.join('  ')}`)
    const white = (s) => paint(c.white, s)
    const tdRow = (label, b, f, t, fmt) =>
      emit(`    ${padEnd(label, 10)}  ${padStart(white(fmt(b)), 9)}  ${padStart(fmt(f), 12)}  ${padStart(gold(fmt(t)), 9)}`)
    tdRow('Υ Yield', TD.base.yield, TD.field.yield, TD.top.yield, fmtY)
    tdRow('SNR', TD.base.snr, TD.field.snr, TD.top.snr, fmtSNR)
    tdRow('Velocity', TD.base.vel, TD.field.vel, TD.top.vel, (v) => v.toFixed(2))
    tdRow('Leverage', TD.base.lev, TD.field.lev, TD.top.lev, (v) => fmtLev(v) + '×')
    tdRow('10xDEV', TD.base.d10, TD.field.d10, TD.top.d10, (v) => v.toFixed(2))
    emit(`    ${dim('reference values until live user volume calibrates SigRank avg')}`)
  }

  if (status && used < budget) emit(`  ${dim(status)}`)
}

// ── TAB 2: TRENDS ─────────────────────────────────────────────────────────────
// Every cascade metric (+ rank) as a 7d→30d→90d→all sparkline. Three sub-tabs:
//   You      — your own trajectory (+ rank trend, "calculating" until wired)
//   Platform — per-platform (claude / codex / combined)
//   Field    — board-wide trend (calculating until window-history materializes)
// Switch sub-tabs with [T] (cycles) or [1/2/3]. Data: the same `active` the Dashboard loads.
const TREND_SUBTABS = ['You', 'Platform', 'Field']
// All leaderboard metrics. Most derive from the per-window cascade (pick takes the
// cascade obj + its pillars); §IGNA (proprietary composite) and $/1M (needs cost data)
// aren't computed client-side yet → rendered "calculating", same honest pattern as Rank.
const AA_EFF_BASELINE = 4.0  // efficiency is measured vs the AA 4.0 baseline (per the wiki)
const TREND_METRICS = [
  { label: '∑ Total',  pick: (c, p) => (p.input ?? 0) + (p.output ?? 0) + (p.cacheCreate ?? 0) + (p.cacheRead ?? 0), fmt: fmtTok },
  { label: 'Υ Yield',  pick: (c) => c.yield,     fmt: fmtY },
  { label: 'SNR',      pick: (c) => c.snr,       fmt: fmtSNR },
  { label: 'Velocity', pick: (c) => c.velocity,  fmt: (v) => v.toFixed(2) },
  { label: 'Leverage', pick: (c) => c.leverage,  fmt: (v) => fmtLev(v) + '×' },
  { label: '10xDEV',   pick: (c) => c.dev10x,    fmt: (v) => v.toFixed(2) },
  { label: 'Eff',      pick: (c) => c.yield != null ? c.yield / AA_EFF_BASELINE : null, fmt: (v) => v.toFixed(1) + '×' },
  { label: '§IGNA',    pick: () => null, fmt: () => '—', stub: 'composite calibrating (needs user volume)' },
  { label: 'Op Ratio', pick: (c, p) => (p.input ?? 0) > 0 ? (p.cacheRead ?? 0) / p.input : null, fmt: (v) => `${v.toFixed(0)}:1` },
  { label: '$/1M',     pick: () => null, fmt: () => '—', stub: 'cost data wires post-ingest' },
]
function renderTrends(data, subIdx = 0) {
  const { active } = data
  const budget = H() - 4
  let used = 0
  const emit = (s = '') => { if (used < budget) { writeln(s); used++ } }
  const sub = TREND_SUBTABS[subIdx] ?? 'You'

  // sub-tab switcher row
  const subBar = TREND_SUBTABS.map((t, i) =>
    i === subIdx ? `${c.bgCyan}${c.boldCyan} ${t} ${c.reset}` : `${dim(` ${t} `)}`).join(' ')
  emit()
  emit(`  ${bold('Trends')}  ${dim('every metric across windows (7d → all)')}    ${subBar}`)
  emit(`  ${dim('·'.repeat(Math.min(W() - 4, 70)))}`)
  emit()

  if (sub === 'You' || sub === 'Platform') {
    const rows = sub === 'You'
      ? (active.length ? [{ platform: 'you', windows: active[0]?.windows }] : [])  // primary cascade
      : active
    if (!rows.length) { emit(`  ${dim('  reading your cascade… (press [R] to refresh)')}`); }
    for (const d of rows) {
      if (used >= budget - 2) break
      emit(`  ${bold(sub === 'You' ? 'Your trajectory' : cyan(d.platform))}`)
      for (const m of TREND_METRICS) {
        if (used >= budget - 2) break
        if (m.stub) {
          emit(`    ${padEnd(dim(m.label), 10)}  ${dim('▁▁▁▁  calculating… (' + m.stub + ')')}`)
        } else {
          emit(`    ${padEnd(cyan(m.label), 10)}  ${metricSpark(d, m.pick, m.fmt)}`)
        }
      }
      // rank trend — wired later; honest placeholder for now
      if (used < budget - 1) emit(`    ${padEnd(dim('Rank'), 10)}  ${dim('▁▁▁▁  calculating… (rank history wires post-ingest)')}`)
      emit()
    }
  } else { // Field
    emit(`  ${dim('  Field-wide trends — calculating…')}`)
    emit(`  ${dim('  (needs per-window board history; materializes once live ingest lands)')}`)
  }

  emit()
  emit(`  ${dim('[T]')} switch view (You · Platform · Field)`)
}

// ── TAB 3: COMPARE ───────────────────────────────────────────────────────────
function renderCompare(data) {
  const { tpData, cc, ts, td, platform } = data
  const WINS = ['7d', '30d', '90d', 'all']
  const w = W()
  const budget = H() - 4
  let used = 0
  const emit = (s = '') => { if (used < budget) { writeln(s); used++ } }

  const tpPillars = {}
  for (const win of (tpData?.windows ?? [])) tpPillars[win.window] = win.pillars

  const SOURCES = [
    { name: 'tokenpull',  color: (s) => paint(c.boldCyan, s),   pillars: tpPillars,  note: 'JSONL canon' },
    { name: 'ccusage',    color: (s) => paint(c.green, s),       pillars: cc ?? {},   note: 'ccusage CLI' },
    { name: 'token-dash', color: (s) => paint(c.magenta, s),     pillars: td ?? {},   note: 'SQLite' },
    { name: 'tokscale',   color: (s) => paint(c.blue, s),        pillars: ts ?? {},   note: 'report.json' },
  ].filter(s => Object.keys(s.pillars).length > 0)

  emit()
  emit(`  ${bold('Source Comparison')}  ${dim(`platform: ${platform}`)}  ${dim('·  tokenpull vs ccusage vs token-dash vs tokscale')}`)

  if (!tpData) {
    emit(`  ${dim('tokenpull: no JSONL data found — check ~/.claude/projects/')}`)
  } else {
    const all = tpPillars['all']
    if (all) {
      emit(`  ${dim('tokenpull all-time:')}  In ${cyan(fmtTok(all.input))}  Out ${green(fmtTok(all.output))}  CW ${paint(c.blue, fmtTok(all.cacheCreate))}  CR ${gold(fmtTok(all.cacheRead))}`)
    }
  }
  emit()

  const COL_W = 11
  const hcols = [padEnd(dim('Source'), 12), padEnd(dim('Pillar'), 10), ...WINS.map(wn => padStart(dim(wn), COL_W))]
  emit(`    ${hcols.join('  ')}`)
  emit(`  ${dim('·'.repeat(Math.min(w-4, 12 + 12 + WINS.length*(COL_W+2))))}`)

  const PILLARS = [
    { key: 'input',       label: 'Input' },
    { key: 'output',      label: 'Output' },
    { key: 'cacheWrite',  label: 'CacheW',  dbKey: 'cacheCreate' },
    { key: 'cacheRead',   label: 'CacheR' },
  ]

  // Reserve space for cascade metrics below (~8 lines)
  const metricsLines = 6 + SOURCES.length
  for (const src of SOURCES) {
    let firstRow = true
    for (const pil of PILLARS) {
      if (used >= budget - metricsLines) break
      const dbKey = pil.dbKey ?? pil.key
      const cells = WINS.map(win => {
        const p = src.pillars[win]
        const val = p?.[dbKey] ?? null
        if (val == null) return padStart(dim('—'), COL_W)
        const baseVal = tpPillars[win]?.[dbKey]
        if (src.name !== 'tokenpull' && baseVal != null && baseVal > 0) {
          const delta = (val - baseVal) / baseVal * 100
          const dStr = delta === 0 ? '' : delta > 0 ? green(` +${delta.toFixed(0)}%`) : red(` ${delta.toFixed(0)}%`)
          return padStart(`${fmtTok(val)}${dStr}`, COL_W)
        }
        return padStart(fmtTok(val), COL_W)
      })
      const srcLabel = firstRow ? padEnd(src.color(src.name), 12) : padEnd(dim(''), 12)
      emit(`    ${srcLabel}  ${padEnd(dim(pil.label), 10)}  ${cells.join('  ')}`)
      firstRow = false
    }
    emit()
  }

  if (used < budget - 4) {
    emit(`  ${hr()}`)
    emit(`  ${bold('Cascade Metrics')}  ${dim('all-time · computed from each source')}`)
    const MCH = [padEnd(hdr('Source'),12), padStart(hdr('Υ Yield'),9), padStart(hdr('SNR'),7), padStart(hdr('Lev'),8), padStart(hdr('Vel'),6), padStart(hdr('10x'),6), padEnd(hdr('Class'),13)]
    emit(`    ${MCH.join('  ')}`)
    emit(`  ${dim('·'.repeat(Math.min(w-4, 72)))}`)
    for (const src of SOURCES) {
      if (used >= budget) break
      const p = src.pillars['all']
      if (!p) continue
      const cas = cascadeFrom(p)
      if (!cas) continue
      const clsFn = CLS[cas.class] ?? ((s) => s)
      const cols = [
        padEnd(src.color(src.name), 12),
        padStart(cas.yield > 10000 ? gold(fmtY(cas.yield)) : fmtY(cas.yield), 9),
        padStart(fmtSNR(cas.snr), 7),
        padStart(fmtLev(cas.leverage)+'×', 8),
        padStart(cas.velocity?.toFixed(2) ?? '—', 6),
        padStart(cas.dev10x?.toFixed(2) ?? '—', 6),
        padEnd(clsFn(cas.class), 13),
      ]
      emit(`    ${cols.join('  ')}`)
    }
  }
}

// ── TAB 3: BOARD ─────────────────────────────────────────────────────────────
function renderBoard(boardData, window = '30d') {
  const entries = boardData?.entries ?? boardData?.operators ?? boardData ?? []
  const w = W()
  const budget = H() - 4
  let used = 0
  const emit = (s = '') => { if (used < budget) { writeln(s); used++ } }

  emit()
  emit(`  ${bold('Leaderboard')}  ${dim(`window: ${window}  ·  sorted by Υ Yield  ·  signalaf.com/leaderboard`)}`)
  emit()

  if (!Array.isArray(entries) || entries.length === 0) {
    emit(`  ${dim('  board unavailable')}`)
    return
  }

  const sorted = [...entries].sort((a, b) => (b.yield_ ?? 0) - (a.yield_ ?? 0))

  // Per-column top-3 "shadowbox": medal bg-tint (gold/silver/bronze) on the 1st/2nd/3rd
  // best DISTINCT value in each metric column, mirroring the website's podium boxes.
  const MEDAL_BG = { 1: 220, 2: 250, 3: 130 } // gold · silver · bronze (256-color)
  const top3 = (pick) => {
    const distinct = [...new Set(sorted.map(pick).filter((v) => v != null && isFinite(v)))].sort((a, b) => b - a)
    const m = new Map(); distinct.slice(0, 3).forEach((v, i) => m.set(v, i + 1)); return m
  }
  const pods = {
    yield: top3((e) => e.yield_), snr: top3((e) => e.snr ?? e.compression_ratio),
    lev: top3((e) => e.leverage), vel: top3((e) => e.velocity), d10: top3((e) => e.dev10x),
  }
  // Wrap a padded cell in a medal bg-tint (dark fg on the medal color) when its value places top-3.
  const medal = (map, val, padded) => {
    const place = val == null ? null : map.get(val)
    if (!place) return padded
    return `${ESC}48;5;${MEDAL_BG[place]}m${ESC}38;5;232m${padded}${c.reset}`
  }

  const BH = [
    padStart(hdr('#'), 4), padEnd(hdr('Codename'), 22), padEnd(hdr('Class'), 13),
    padStart(hdr('Υ Yield'), 9), padStart(hdr('SNR'), 7), padStart(hdr('Lev'), 7),
    padStart(hdr('Vel'), 6), padStart(hdr('10x'), 6), padStart(hdr('Pct'), 5), padStart(hdr('7d↕'), 5),
  ]
  emit(`    ${BH.join('  ')}`)
  emit(`  ${dim('·'.repeat(Math.min(w-4, 98)))}`)

  for (let idx = 0; idx < sorted.length; idx++) {
    if (used >= budget) break
    const e   = sorted[idx]
    const rk  = idx === 0 ? gold(`#${idx+1}`) : idx < 3 ? cyan(`#${idx+1}`) : `#${idx+1}`
    const nm  = padEnd(trunc(e.codename ?? '—', 22), 22)
    const cls = padEnd(colorCls(e.class_tier ?? '—'), 13)
    const snrVal = e.snr ?? e.compression_ratio
    // value cells: pad first, then medal-wrap so the tint fills the whole column width
    const yld = medal(pods.yield, e.yield_, padStart(e.yield_ != null ? fmtY(e.yield_) : '—', 9))
    const snr = medal(pods.snr, snrVal, padStart(snrVal != null ? fmtSNR(snrVal) : '—', 7))
    const lev = medal(pods.lev, e.leverage, padStart(e.leverage != null ? fmtLev(e.leverage)+'×' : '—', 7))
    const vel = medal(pods.vel, e.velocity, padStart(e.velocity != null ? e.velocity.toFixed(2) : '—', 6))
    const d10 = medal(pods.d10, e.dev10x, padStart(e.dev10x != null ? e.dev10x.toFixed(2) : '—', 6))
    const pct = padStart(e.percentile != null ? `${e.percentile}%` : '—', 5)
    const mv  = padStart(fmtMov(e.movement_7d), 5)
    emit(`    ${padStart(rk,4)}  ${nm}  ${cls}  ${yld}  ${snr}  ${lev}  ${vel}  ${d10}  ${pct}  ${mv}`)
  }
}

// ── TAB 4: WATCH — landing panel (instructions + why it matters) ─────────────
// Explains what the live watcher does and why it's the point of the agent: it
// re-reads your local logs on an interval and feeds your verified cascade to the
// leaderboard. Launched (in its own window) with [Enter]; interval is tunable.
function renderWatchInfo(platform, win, refresh) {
  writeln()
  writeln(`  ${bold('Live Watch')}  ${dim('the agent that keeps your rank current')}`)
  writeln()
  writeln(`  ${dim('What it does')}`)
  writeln(`    Re-reads your local ${cyan(platform)} token logs every ${gold(refresh + 's')} and recomputes`)
  writeln(`    your cascade (Υ Yield · SNR · Leverage · class) live, on this machine.`)
  writeln()
  writeln(`  ${dim('Why it matters')}`)
  writeln(`    Watch is how the board stays ${bold('current')}: each refresh submits your latest`)
  writeln(`    verified cascade so ${cyan('signalaf.com/leaderboard')} ${bold('auto-updates')} as you work —`)
  writeln(`    no manual re-submit. Tokens never leave your machine; only the metrics post.`)
  writeln()
  writeln(`  ${dim('Settings')}`)
  writeln(`    ${dim('Platform')}  ${cyan(platform)}     ${dim('Window')}  ${cyan(win)}     ${dim('Refresh')}  ${gold(refresh + 's')}`)
  writeln()
  writeln(`    ${dim('[Enter]')} launch watcher (new window)   ${dim('[+]/[-]')} refresh ±5s   ${dim('[P]')} platform   ${dim('[W]')} window`)
  writeln()
}

// ── TAB 6: CONNECT ───────────────────────────────────────────────────────────
// Sign in (paste a connect code) / show signed-in status. The whole app lives in
// the TUI; this replaces every "go run the CLI to enroll" hint. Uses only helpers
// already defined above (bold/dim/cyan/green/red/hr/writeln).
function renderConnect(id, codeBuf = '', msg = '') {
  writeln()
  if (isSignedIn(id)) {
    writeln(`  ${bold('Connect')}  ${dim('your account')}`)
    writeln(`  ${hr()}`)
    writeln(`  ${green('✓')} Signed in as ${cyan(id.codename)}`)
    writeln(`  ${dim(`device ${id.device_id}`)}`)
    writeln()
    writeln(`  ${dim('Press')} ${bold('[S]')} ${dim('from any read tab to submit your runs to the board.')}`)
    writeln()
    writeln(`  ${dim('Switch device? Paste a new connect code, then')} ${bold('[Enter]')}${dim(':')}`)
  } else {
    writeln(`  ${bold('Log in to submit to board')}`)
    writeln(`  ${hr()}`)
    writeln(`  ${dim('status:')} ${red('not signed in')}`)
    writeln()
    writeln(`  ${dim('Paste your connect code, then')} ${bold('[Enter]')}${dim(':')}`)
  }
  writeln(`    ${cyan('>')} ${codeBuf}${dim('▏')}`)
  writeln()
  writeln(`  ${dim('Get a code at signalaf.com → Settings → Connect a device.')}`)
  if (msg) { writeln(); writeln(`  ${msg}`) }
}

// ── TAB 4: WATCH ─────────────────────────────────────────────────────────────
async function renderWatch(platform = 'claude', win = '7d') {
  const { tokenpullAny } = await import('./tokenpull.mjs')
  const d = await tokenpullAny(platform).catch(() => null)
  if (!d) { writeln(`  ${dim(`no data for ${platform}`)}`); return }

  const wdata = d.windows?.find(x => x.window === win)
  if (!wdata) { writeln(`  ${dim(`no data for ${win} window`)}`); return }

  const p   = wdata.pillars
  const cas = cascadeFrom(p)
  const w   = W()

  writeln()
  writeln(`  ${bold('Live Watch')}  ${dim(`${platform} · ${win} window · ${d.files} files · ${wdata.messages?.toLocaleString()} msgs`)}`)
  writeln()

  if (!cas) { writeln(`  ${dim('  insufficient data to compute cascade')}`); return }

  const clsFn = CLS[cas.class] ?? ((s) => s)

  // big numbers
  const metrics = [
    { label: 'Υ Yield',   val: fmtY(cas.yield),           color: cas.yield > 1000 ? c.boldGold : c.boldCyan },
    { label: 'Class',     val: cas.class,                  color: CLS[cas.class] ? c.boldGold : c.reset },
    { label: 'SNR',       val: fmtSNR(cas.snr),           color: c.green },
    { label: 'Leverage',  val: fmtLev(cas.leverage)+'×',  color: c.cyan },
    { label: 'Velocity',  val: cas.velocity?.toFixed(2),   color: c.white },
    { label: '10xDEV',    val: cas.dev10x?.toFixed(2),     color: c.magenta },
  ]

  for (const m of metrics) {
    writeln(`    ${padEnd(dim(m.label), 12)}  ${paint(m.color, m.val ?? '—')}`)
  }
  writeln()

  // token pillars
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Token Pillars')}  ${dim(`${win} window`)}`)
  writeln()

  const pillarsData = [
    { label: 'Input',       val: p.input,       color: c.cyan,    est: d.estimated },
    { label: 'Output',      val: p.output,      color: c.green,   est: false },
    { label: 'Cache Write', val: p.cacheCreate, color: c.blue,    est: d.estimated },
    { label: 'Cache Read',  val: p.cacheRead,   color: c.boldGold,est: false },
  ]
  // Log scale: token pillars span 2–3 orders of magnitude (input ~8M, cacheRead ~1.9B).
  // Linear scale crushes input/output bars to near-invisible. Log10 gives equal visual
  // weight per order-of-magnitude step.
  const maxLog = Math.log10(Math.max(...pillarsData.map(x => x.val ?? 0), 10))
  for (const item of pillarsData) {
    const v   = item.val ?? 0
    const { bar } = logBar(v, maxLog, 40, item.color)
    const est = item.est ? dim('~') : ''
    writeln(`    ${padEnd(dim(item.label), 12)}  ${padEnd(bar, 40)}  ${est}${fmtTok(v)}`)
  }
  writeln(`  ${dim('log₁₀ scale — each step = 10× · absolute values right')}`)
  writeln()

  // trend across windows
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Υ Trend')}  ${dim('7d → 30d → 90d → all')}`)
  writeln()
  writeln(`    ${yieldSpark(d)}`)
  writeln()
}

// ── DEBUG: render a tab once (no TTY/alt-screen) + audit each line's visible
// width vs terminal columns. Usage: `node tui.mjs --render [0|1|2]`. Prints a
// width report (>w = would overflow/wrap) then the raw frame. For diagnosing
// layout overflow without an interactive session.
async function renderOnce(tabIdx = 0) {
  const w = W()
  const data = {
    0: await loadDashboardData().catch((e) => ({ error: e.message })),
    1: await loadCompareData('claude').catch(() => null),
    2: await loadBoardData('30d').catch(() => null),
  }[tabIdx]
  startBuffer()
  if (tabIdx === 0) renderDashboard(data, 'debug')
  else if (tabIdx === 1) renderCompare(data)
  else if (tabIdx === 2) renderBoard(data, '30d')
  else if (tabIdx === 5) renderConnect(loadIdentity(), '', '')
  const lines = _screenBuf || []
  _screenBuf = null; _footerBuf = null
  process.stdout.write(`\n=== WIDTH AUDIT (terminal w=${w}) — lines exceeding w wrap/overflow ===\n`)
  lines.forEach((ln, i) => {
    const vis = stripAnsi(ln).length
    if (vis > w) process.stdout.write(`  OVERFLOW line ${i}: visible=${vis} (>${w} by ${vis - w})  «${stripAnsi(ln).slice(0, 60)}…»\n`)
  })
  const maxVis = Math.max(0, ...lines.map((l) => stripAnsi(l).length))
  process.stdout.write(`  widest visible line = ${maxVis} (terminal w=${w}) → ${maxVis > w ? 'OVERFLOWS' : 'fits'}\n`)
  process.stdout.write(`\n=== RAW FRAME (stripAnsi) ===\n`)
  lines.forEach((ln) => process.stdout.write(stripAnsi(ln) + '\n'))
}

// ── OPENING SPLASH ───────────────────────────────────────────────────────────
// Block-letter SIGRANK wordmark that flashes through colors CONTINUOUSLY until a
// key is pressed (owner 2026-06-25: "keep the animation going"). Randomizes the
// mode each launch (moses gold-shimmer / rainbow / chaos per-letter). Centered to
// terminal width. Any key dismisses → the dashboard loads.
const SPLASH_ART = [
  '███████ ██  ██████  ██████   █████  ███    ██ ██   ██',
  '██      ██ ██       ██   ██ ██   ██ ████   ██ ██  ██ ',
  '███████ ██ ██   ███ ██████  ███████ ██ ██  ██ █████  ',
  '     ██ ██ ██    ██ ██   ██ ██   ██ ██  ██ ██ ██  ██ ',
  '███████ ██  ██████  ██   ██ ██   ██ ██   ████ ██   ██',
]
const SPLASH_RULE = '◈  ───────────────────────────────────────────  ◈'
const MOSES_PAL = [220, 178, 214, 208, 222, 230]
const RAINBOW_PAL = [196, 202, 226, 46, 51, 21, 201, 213]
const col256 = (n, s) => `${ESC}38;5;${n}m${s}${c.reset}`
const stripA = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const ctr = (s) => { const pad = Math.max(0, Math.floor((W() - stripA(s).length) / 2)); return ' '.repeat(pad) + s }

function splashFrame(mode) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)]
  const out = ['', '', ctr(dim(SPLASH_RULE)), '']
  for (const line of SPLASH_ART) {
    if (mode === 'chaos') {
      out.push(ctr([...line].map((ch) => ch === ' ' ? ' ' : col256(Math.floor(Math.random() * 256), ch)).join('')))
    } else {
      const n = mode === 'rainbow' ? pick(RAINBOW_PAL) : pick(MOSES_PAL)
      out.push(ctr(col256(n, line)))
    }
  }
  out.push('', ctr(dim(SPLASH_RULE)), '')
  out.push(ctr(bold('For all builders, burners and 10xers')))
  out.push(ctr(dim('signalaf')), '')
  out.push(ctr(`${dim('powered by')}  ${gold('MO§ES™')}`))
  out.push(ctr(dim('$ npx sigrank-mcp')), '')
  out.push(ctr(`${gold('▸')} ${dim('press any key')} ${gold('◂')}`))
  return out.join('\n')
}

// Animated splash. Controls: [P] pause/resume the color animation · [Enter] (or
// any other key) enter the TUI · Ctrl-C quit. Mode (moses/rainbow/chaos) varies
// per launch. Frozen frame keeps the last colors so a pause reads as intentional.
function showSplash() {
  const modes = ['moses', 'rainbow', 'chaos']
  const mode = modes[Math.floor((Date.now() / 1000) % modes.length)]
  return new Promise((resolve) => {
    let paused = false
    const interactive = !!process.stdin.isTTY   // can we read raw keypresses to dismiss?
    const hint = () => interactive
      ? `${dim('  [P]')} ${paused ? 'resume' : 'pause'}    ${dim('[Enter]')} enter`
      : dim('  loading…')
    const paint = () => { write(CLEAR); write(splashFrame(mode)); write(`\n${ctr(hint())}`) }
    paint()
    let timer = setInterval(paint, 110)

    // Non-interactive stdin (some IDE/integrated terminals): still SHOW the animated
    // wordmark, but auto-advance after a short run instead of waiting for a key (which
    // would never arrive → hang). ~2.2s of animation, then enter the TUI.
    if (!interactive) {
      setTimeout(() => { clearInterval(timer); write(CLEAR); resolve() }, 2200)
      return
    }

    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const onKey = (key) => {
      const k = key.toLowerCase()
      if (k === 'p') {                          // toggle pause — don't enter
        paused = !paused
        if (paused) { clearInterval(timer); timer = null; paint() }      // freeze on current frame
        else { timer = setInterval(paint, 110) }                          // resume animating
        return
      }
      if (timer) clearInterval(timer)
      process.stdin.removeListener('data', onKey)
      if (key === '\x03') { write(SHOW); write(EXIT_ALT); process.exit(0) } // Ctrl-C
      resolve()                                  // Enter / any other key → enter the TUI
    }
    process.stdin.on('data', onKey)
  })
}

// ── MAIN TUI LOOP ─────────────────────────────────────────────────────────────
export async function runTui({ platform = 'claude', window: win = '7d' } = {}) {
  // Debug render mode — non-interactive, dumps a tab + width audit, then exits.
  const ri = process.argv.indexOf('--render')
  if (ri !== -1) {
    const tab = parseInt(process.argv[ri + 1] ?? '0', 10) || 0
    await renderOnce(tab)
    return
  }

  write(ENTER_ALT)  // switch to alternate screen — original terminal state preserved on exit
  write(HIDE)
  write(CLEAR)

  // Opening splash — animated SIGRANK wordmark.
  // Gate on stdOUT.isTTY (can we draw the animation?), matching the launch guard —
  // NOT stdin.isTTY, which was skipping the splash in terminals whose input isn't a
  // raw TTY (some IDE/integrated terminals). showSplash() itself auto-advances when
  // stdin can't be read raw, so it never hangs. (Skippable with --no-splash.)
  if (!process.argv.includes('--no-splash') && process.stdout.isTTY) {
    await showSplash()
    write(CLEAR)
  }

  // ── State
  let activeTab    = 0
  let dashData     = null
  let compareData  = null
  let boardData    = null
  let boardWindow  = '30d'
  let watchPlatform = platform
  let watchWindow  = win
  let watchRefresh = 30        // [5] Watch poll interval (seconds) — [+]/[-] adjust
  let trendSub     = 0         // [2] Trends sub-view index (You/Platform/Field) — [T] cycles
  let loading      = true
  let status       = 'loading…'
  let refreshTimer = null
  let codeBuf      = ''        // [6] Connect tab in-place code field buffer
  let connectMsg   = ''        // [6] Connect last-action message (signed in / invalid code)
  let submitMsg    = ''        // [S] in-place submit result, shown in the read-tab footer

  // ── Redraw (buffered: renders into memory, then paints as a locked frame)
  const redraw = async () => {
    startBuffer()
    renderTabBar(activeTab)

    const hint = `  ${dim('← → or 1-5')} switch tabs   ${dim('[R]')} refresh   ${dim('[Q]')} quit`
    const submitHint = `   ${dim('[S]')} submit · ${dim('signalaf.com/login')} to sign in`
    // Read-tab footer: hr + hint, plus the in-place submit result line when present.
    const readFooter = (hintLine) => submitMsg
      ? [`  ${hr()}`, hintLine, `  ${submitMsg}`]
      : [`  ${hr()}`, hintLine]

    if (activeTab === 0) {                       // Dashboard
      if (!dashData) {
        writeln(`\n  ${dim('loading dashboard…')}`)
      } else {
        renderDashboard(dashData, status)
      }
      setFooter(readFooter(`${hint}${submitHint}`))
    } else if (activeTab === 1) {                // Trends
      if (!dashData) {
        writeln(`\n  ${dim('loading trends…')}`)
      } else {
        renderTrends(dashData, trendSub)
      }
      setFooter(readFooter(`${hint}   ${dim('[T]')} view${submitHint}`))
    } else if (activeTab === 2) {                // Compare
      if (!compareData) {
        writeln(`\n  ${dim(`loading compare (${platform})…`)}`)
      } else {
        renderCompare(compareData)
      }
      setFooter(readFooter(`${hint}   ${dim('[P]')} switch platform${submitHint}`))
    } else if (activeTab === 3) {                // Board
      if (!boardData) {
        writeln(`\n  ${dim(`loading board (${boardWindow})…`)}`)
      } else {
        renderBoard(boardData, boardWindow)
      }
      setFooter(readFooter(`${hint}   ${dim('[W]')} window${submitHint}`))
    } else if (activeTab === 4) {                // Watch
      renderWatchInfo(watchPlatform, watchWindow, watchRefresh)
      setFooter(readFooter(`${hint}${submitHint}`))
    } else if (activeTab === 5) {                // Connect
      renderConnect(loadIdentity(), codeBuf, connectMsg)
      setFooter([`  ${hr()}`, `  ${dim('[Enter]')} sign in   ${dim('[Esc]')} clear/back   ${dim('← →')} tabs   ${dim('[Q]')} quit`])
    }
    flushScreen()
  }

  // ── Initial data load
  const loadAll = async () => {
    status = 'loading…'
    ;[dashData, compareData, boardData] = await Promise.all([
      loadDashboardData().catch(e => { status = `dashboard error: ${e.message}`; return null }),
      loadCompareData(platform).catch(() => null),
      loadBoardData(boardWindow).catch(() => null),
    ])
    status = `last refreshed ${new Date().toLocaleTimeString('en-US', { hour12: false })}`
    await redraw()
  }

  // Always restore terminal on unexpected exit
  const cleanup = () => { write(SHOW); write(EXIT_ALT); process.exit(0) }
  process.once('SIGINT',  cleanup)
  process.once('SIGTERM', cleanup)

  // Soft-landing: if not signed in, open on the Connect tab (a prompt, not a gate —
  // the user can still tab away to read Board/Dashboard while signed out).
  if (!isSignedIn(loadIdentity())) activeTab = 5

  // Draw loading state immediately so user sees tab bar + border
  await redraw()
  await loadAll()

  // auto-refresh board every 30s
  const startAutoRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(async () => {
      if (activeTab === 3) {                     // Board tab (now index 3)
        boardData = await loadBoardData(boardWindow).catch(() => null)
        await redraw()
      }
    }, 30000)
  }
  startAutoRefresh()

  // ── Keyboard
  if (!process.stdin.isTTY) return

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  await new Promise((resolve) => {
    process.stdin.on('data', async (key) => {
      const k = key.toLowerCase()

      if (k === 'q' || k === '\x03') {
        if (refreshTimer) clearInterval(refreshTimer)
        write(SHOW)
        write(EXIT_ALT)
        resolve()
        return
      }

      // ── Connect tab is a FOCUSED code field (the one modal tab). Printable code
      // chars feed the buffer; Enter signs in; Esc clears or leaves; arrows switch.
      // Sits AFTER the quit block (so Q/Ctrl-C always escape) and BEFORE everything
      // else (so single-letter hotkeys don't fire while you're typing a code).
      if (activeTab === 5) {
        if (key === '\r' || key === '\n') {                 // [Enter] → sign in
          const code = codeBuf.trim()
          if (!code) { connectMsg = dim('paste a connect code first'); await redraw(); return }
          connectMsg = dim('signing in…'); await redraw()
          try {
            const out = await callTool('enroll', { code })
            if (out.status === 'enrolled') {
              connectMsg = `${green('✓')} signed in as ${cyan(out.codename || '(operator)')}`
              codeBuf = ''
            } else {
              const reasons = {
                code_invalid: 'that code is invalid, expired, or already used — generate a fresh one.',
                device_already_enrolled: 'this device is already signed in. Revoke it in Settings to re-bind.',
                bad_request: 'the code or device key was malformed.',
                rate_limited: 'too many attempts — wait a few minutes and retry.',
                persistence_unavailable: 'sign-in is temporarily unavailable — try again shortly.',
              }
              connectMsg = `${red('✗')} ${reasons[out.reason] || `sign-in failed (${out.reason || 'unknown'}).`}`
            }
          } catch (e) {
            connectMsg = `${red('✗')} ${e.message}`
          }
          await redraw(); return
        }
        if (key === '\x1b') {                                // [Esc] → clear, or leave when empty
          if (codeBuf) { codeBuf = ''; connectMsg = '' } else { activeTab = 0 }
          await redraw(); return
        }
        if (key === '\x1b[C') { activeTab = Math.min(5, activeTab + 1); await redraw(); return }  // → tab
        if (key === '\x1b[D') { activeTab = Math.max(0, activeTab - 1); await redraw(); return }  // ← tab
        if (key === '\x7f' || key === '\b') { codeBuf = codeBuf.slice(0, -1); await redraw(); return }  // backspace
        // A typed code char (len 1) or a pasted code (one multi-char chunk). Exclude any
        // escape sequence (↑/↓/etc.) so stray control bytes never pollute the buffer.
        if (!key.startsWith('\x1b') && (key.length > 1 || isCodeChar(key))) {
          codeBuf += key.split('').filter(isCodeChar).join('')
          await redraw(); return
        }
        return  // swallow any other key while focused (never falls through to global hotkeys)
      }

      // ESC → go back to Dashboard from any tab
      if (key === '\x1b' && activeTab !== 0) {
        activeTab = 0
        await redraw()
        return
      }

      // tab switching (5 tabs: 0=Dashboard 1=Trends 2=Compare 3=Board 4=Watch)
      let switched = false
      if (key === '\x1b[C') { activeTab = Math.min(5, activeTab + 1); switched = true }
      if (key === '\x1b[D') { activeTab = Math.max(0, activeTab - 1); switched = true }
      if (k === '1') { activeTab = 0; switched = true }
      if (k === '2') { activeTab = 1; switched = true }
      if (k === '3') { activeTab = 2; switched = true }
      if (k === '4') { activeTab = 3; switched = true }
      if (k === '5') { activeTab = 4; switched = true }  // Watch = an in-TUI landing panel
      if (k === '6') { activeTab = 5; switched = true }  // Connect = sign in / switch device
      if (k === 'c' && activeTab !== 5) { activeTab = 5; switched = true }  // [C] → Connect from any read tab

      // Trends tab: [T] cycles the sub-view (You · Platform · Field)
      if (activeTab === 1 && k === 't') { trendSub = (trendSub + 1) % 3; await redraw(); return }

      // Watch tab: [+]/[-] tune the refresh interval (5–600s), [Enter] launches the watcher
      if (activeTab === 4 && (k === '+' || k === '=' )) { watchRefresh = Math.min(600, watchRefresh + 5); await redraw(); return }
      if (activeTab === 4 && (k === '-' || k === '_')) { watchRefresh = Math.max(5, watchRefresh - 5); await redraw(); return }
      if (activeTab === 4 && (key === '\r' || key === '\n')) {
        // Launch the live watcher in its own window, passing the chosen refresh interval.
        try {
          const watchCmd = `sigrank-mcp watch --platform ${watchPlatform} --window ${watchWindow} --refresh ${watchRefresh}`
          execSync(`osascript -e 'tell application "Terminal" to do script "${watchCmd}"'`, { stdio: 'ignore' })
          status = `watcher launched (${watchRefresh}s) in a new window`
        } catch { status = 'could not open Terminal.app — run: sigrank-mcp watch' }
        await redraw()
        return
      }

      if (k === 'r') {
        status = 'refreshing…'
        await redraw()
        await loadAll()
        return
      }

      if (k === 's' && activeTab !== 5) {
        // submit IN-PLACE — sign + POST the verified window via the existing core,
        // show the result in the footer, stay in the alt screen (no exit-to-CLI).
        // (On the Connect tab, 's' is a code char handled by the focused field above.)
        const id = loadIdentity()
        if (!isSignedIn(id)) {                     // not signed in → open Connect, never error
          activeTab = 5
          connectMsg = dim('sign in to submit to board')
          await redraw()
          return
        }
        submitMsg = dim('submitting…')
        await redraw()
        try {
          const out = await callTool('submit_verified', { platform })
          const ws = out.windows || []
          const ok = ws.filter(w => w.status === 'received')
          if (out.status === 'not_enrolled') {
            submitMsg = `${red('✗')} sign in to submit`
          } else if (ok.length) {
            const tier = ok[0].verification_tier || '—'
            submitMsg = `${green('✓')} submitted · ${ok.length} window${ok.length > 1 ? 's' : ''} · tier=${tier}`
          } else {
            const why = ws[0]?.reason || out.status || 'failed'
            submitMsg = `${red('✗')} submit: ${why}`
          }
        } catch (e) {
          submitMsg = `${red('✗')} submit: ${e.message}`
        }
        await redraw()
        return
      }

      if (k === 'w' && activeTab === 3) {        // Board tab (now index 3)
        const windows = ['7d', '30d', '90d', 'all']
        const idx = windows.indexOf(boardWindow)
        boardWindow = windows[(idx + 1) % windows.length]
        boardData = await loadBoardData(boardWindow).catch(() => null)
      }

      if (switched) submitMsg = ''   // submit result is tied to the tab it was sent from
      if (switched || k === 'w') await redraw()
    })
  })

  process.stdin.setRawMode(false)
  process.stdin.pause()
  writeln()
}

// Direct-run entry (e.g. `node tui.mjs --render 0`). Normal launch is via cli.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  runTui().catch((e) => { console.error(e); process.exit(1) })
}
