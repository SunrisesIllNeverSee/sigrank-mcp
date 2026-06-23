/**
 * cli.mjs — SigRank terminal UI.
 *
 * Commands (no external deps — pure Node.js ANSI escape codes):
 *
 *   npx sigrank-mcp board                live leaderboard, refreshes every 30s
 *   npx sigrank-mcp board --window 7d    board for a specific window
 *   npx sigrank-mcp board --once         print once and exit (no live refresh)
 *   npx sigrank-mcp me                   your cascade across all 4 windows
 *   npx sigrank-mcp me --platform amp    use a different platform adapter
 *   npx sigrank-mcp me --compare         raw pillar comparison: ccusage vs tokenpull vs token-dashboard
 *   npx sigrank-mcp watch                RT tune meter — local cascade, refreshes
 *   npx sigrank-mcp watch --window 7d    watch a specific window
 *
 * Color palette mirrors the SigRank web dark theme:
 *   gold = class TRANSMITTER headline + rank #1
 *   cyan = active metrics / your row highlight
 *   dim  = secondary data, separators
 *   red  = negative movement / delta
 *   green = positive movement
 */

import { callTool, DEFAULT_API_BASE } from './tools.mjs'
import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

// ── ANSI helpers (no chalk dep) ────────────────────────────────────────────
const ESC = '\x1b['
const c = {
  reset:    `${ESC}0m`,
  bold:     `${ESC}1m`,
  dim:      `${ESC}2m`,
  gold:     `${ESC}33m`,
  boldGold: `${ESC}1;33m`,
  cyan:     `${ESC}36m`,
  boldCyan: `${ESC}1;36m`,
  green:    `${ESC}32m`,
  red:      `${ESC}31m`,
  white:    `${ESC}97m`,
  boldWhite:`${ESC}1;97m`,
  magenta:  `${ESC}35m`,
  blue:     `${ESC}34m`,
}
const paint = (color, str) => `${color}${str}${c.reset}`
const bold  = (str) => paint(c.bold, str)
const dim   = (str) => paint(c.dim, str)
const gold  = (str) => paint(c.boldGold, str)
const cyan  = (str) => paint(c.boldCyan, str)
const green = (str) => paint(c.green, str)
const red   = (str) => paint(c.red, str)

// ── Class tier → color ─────────────────────────────────────────────────────
const CLASS_COLOR = {
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
const colorClass = (cls) => (CLASS_COLOR[cls] ?? ((s) => s))(cls)

// ── Terminal utils ──────────────────────────────────────────────────────────
const CLEAR_SCREEN   = `${ESC}2J${ESC}H`
const CURSOR_UP      = (n) => `${ESC}${n}A`
const ERASE_LINE     = `${ESC}2K`
const HIDE_CURSOR    = `${ESC}?25l`
const SHOW_CURSOR    = `${ESC}?25h`
const termWidth      = () => process.stdout.columns || 80
const write          = (s) => process.stdout.write(s)
const writeln        = (s = '') => process.stdout.write(s + '\n')

// Right-pad or truncate to exact width (ANSI-escape-aware via strip helper)
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, '') }
function padEnd(s, w) {
  const vis = stripAnsi(s).length
  return vis >= w ? s : s + ' '.repeat(w - vis)
}
function padStart(s, w) {
  const vis = stripAnsi(s).length
  return vis >= w ? s : ' '.repeat(w - vis) + s
}
function trunc(s, w) {
  const stripped = stripAnsi(s)
  if (stripped.length <= w) return s
  // truncate the raw string, not the escape-aware one — safe for plain strings
  return s.slice(0, w - 1) + '…'
}

// ── Number formatters ───────────────────────────────────────────────────────
const fmtYield = (y) => {
  if (y == null) return '—'
  if (y >= 10000) return `${(y / 1000).toFixed(1)}K`
  if (y >= 1000)  return `${(y / 1000).toFixed(2)}K`
  return y.toFixed(1)
}
const fmtLev = (l) => {
  if (l == null) return '—'
  if (l >= 1000) return `${(l / 1000).toFixed(1)}K`
  return l.toFixed(0)
}
const fmtPct  = (n) => n != null ? `${(n * 100).toFixed(0)}%` : '—'
const fmtSNR  = (n) => n != null ? `${(n * 100).toFixed(1)}%` : '—'
const fmtMove = (n) => {
  if (n == null || n === 0) return dim('  —')
  return n > 0 ? green(`+${n}`) : red(`${n}`)
}
const fmtTokens = (n) => {
  if (n == null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

// ── Header / footer ─────────────────────────────────────────────────────────
function renderHeader(title, subtitle = '') {
  const w = termWidth()
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  const right = dim(`signalaf.com  ${ts}`)
  const rightVis = stripAnsi(right).length
  const leftVis  = stripAnsi(title).length
  const gap = Math.max(1, w - leftVis - rightVis)
  writeln()
  writeln(`  ${title}${' '.repeat(gap)}${right}`)
  if (subtitle) writeln(`  ${dim(subtitle)}`)
  writeln(`  ${dim('─'.repeat(w - 4))}`)
}

function renderFooter(hint = '') {
  const w = termWidth()
  writeln(`  ${dim('─'.repeat(w - 4))}`)
  if (hint) writeln(`  ${dim(hint)}`)
  writeln()
}

// ── BOARD command ────────────────────────────────────────────────────────────

const BOARD_COLS = [
  { key: 'rank',              label: '#',       w: 4,  align: 'r' },
  { key: 'codename',          label: 'Operator',w: 20, align: 'l' },
  { key: 'class_tier',        label: 'Class',   w: 13, align: 'l' },
  { key: 'signa_rate',        label: 'SIGNA',   w: 7,  align: 'r' },
  { key: 'compression_ratio', label: 'SNR',     w: 6,  align: 'r' },
  { key: 'session_depth',     label: 'Depth',   w: 6,  align: 'r' },
  { key: 'token_throughput',  label: 'Tokens',  w: 8,  align: 'r' },
  { key: 'movement_7d',       label: '7d Δ',    w: 6,  align: 'r' },
]

function renderBoardRow(entry, highlight = false) {
  const rank = entry.rank === 1 ? gold(`#${entry.rank}`) : `#${entry.rank}`
  const name = highlight
    ? cyan(trunc(entry.codename, 19))
    : trunc(entry.codename, 19)
  const cls  = colorClass(entry.class_tier ?? '—')
  const sna  = (entry.signa_rate ?? 0).toFixed(1)
  const snr  = fmtSNR(entry.compression_ratio)
  const dep  = entry.session_depth != null ? entry.session_depth.toFixed(1) : '—'
  const tok  = fmtTokens(entry.token_throughput)
  const mv   = fmtMove(entry.movement_7d)

  const cols = [
    padStart(rank, 4),
    padEnd(name, 20),
    padEnd(cls, 13),
    padStart(sna, 7),
    padStart(snr, 6),
    padStart(dep, 6),
    padStart(tok, 8),
    padStart(mv, 6),
  ]
  const prefix = highlight ? `${c.boldCyan}▶${c.reset} ` : '  '
  writeln(prefix + cols.join('  '))
}

function renderBoardHeader(window = '30d') {
  renderHeader(
    `${gold('⊙ SigRank')} ${bold('Leaderboard')}`,
    `window: ${window}  ·  sorted by SIGNA rate  ·  top 25 operators`
  )
  // column headers
  const headers = BOARD_COLS.map(col =>
    col.align === 'r'
      ? padStart(dim(col.label), col.w)
      : padEnd(dim(col.label), col.w)
  )
  writeln(`    ${headers.join('  ')}`)
  writeln(`  ${dim('·'.repeat(termWidth() - 4))}`)
}

async function fetchBoard(window = '30d') {
  const res = await fetch(`${DEFAULT_API_BASE}/api/v1/leaderboard?window=${window}`, {
    headers: { accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Board API → HTTP ${res.status}`)
  return res.json()
}

async function runBoard({ window = '30d', once = false, refresh = 30 } = {}) {
  let lines = 0

  const draw = async () => {
    let data
    try { data = await fetchBoard(window) }
    catch (e) {
      writeln(red(`  ✗ Could not reach signalaf.com: ${e.message}`))
      return
    }

    if (!once && lines > 0) {
      // move cursor up and redraw in-place
      write(CURSOR_UP(lines))
    }

    const out = []
    const push = (s = '') => out.push(s)

    push()
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
    const right = `signalaf.com  ${ts}`
    const title = `⊙ SigRank Leaderboard`
    const w = termWidth()
    const gap = Math.max(1, w - 2 - title.length - right.length)
    push(`  ${gold('⊙ SigRank')} ${bold('Leaderboard')}${' '.repeat(gap)}${dim(right)}`)
    push(`  ${dim(`window: ${data.window ?? window}  ·  ${data.total_operators ?? (data.entries?.length ?? 0)} operators`)}`)
    push(`  ${dim('─'.repeat(w - 4))}`)

    // column header row
    const headers = BOARD_COLS.map(col =>
      col.align === 'r'
        ? padStart(dim(col.label), col.w)
        : padEnd(dim(col.label), col.w)
    ).join('  ')
    push(`    ${headers}`)
    push(`  ${dim('·'.repeat(w - 4))}`)

    const entries = data.entries ?? []
    for (const entry of entries) {
      const rank = entry.rank === 1 ? gold(`#${entry.rank}`) : `#${entry.rank}`
      const name = trunc(entry.codename ?? '—', 19)
      const cls  = colorClass(entry.class_tier ?? '—')
      const sna  = (entry.signa_rate ?? 0).toFixed(1)
      const snr  = fmtSNR(entry.compression_ratio)
      const dep  = entry.session_depth != null ? entry.session_depth.toFixed(1) : '—'
      const tok  = fmtTokens(entry.token_throughput)
      const mv   = fmtMove(entry.movement_7d)
      const cols = [
        padStart(rank, 4),
        padEnd(name, 20),
        padEnd(cls, 13),
        padStart(sna, 7),
        padStart(snr, 6),
        padStart(dep, 6),
        padStart(tok, 8),
        padStart(mv, 6),
      ]
      push(`  ${cols.join('  ')}`)
    }

    push(`  ${dim('─'.repeat(w - 4))}`)
    if (!once) push(`  ${dim(`auto-refresh every ${refresh}s  ·  ctrl+c to exit`)}`)
    push()

    // write all at once to minimize flicker
    const rendered = out.join('\n')
    write(rendered)
    lines = out.length
  }

  if (!once) write(HIDE_CURSOR)
  try {
    await draw()
    if (!once) {
      const iv = setInterval(draw, refresh * 1000)
      await new Promise((resolve) => {
        process.on('SIGINT', () => { clearInterval(iv); resolve() })
      })
    }
  } finally {
    if (!once) write(SHOW_CURSOR + '\n')
  }
}

// ── ME command ───────────────────────────────────────────────────────────────

async function runMe({ platform = 'claude', compare = false } = {}) {
  if (compare) return runCompare({ platform })

  write(HIDE_CURSOR)
  writeln(`  ${dim('reading local token logs…')}`)

  let pulled
  try {
    pulled = await callTool('tokenpull', { platform })
  } catch (e) {
    write(SHOW_CURSOR)
    write(CURSOR_UP(1) + ERASE_LINE)
    writeln(red(`  ✗ ${e.message}`))
    process.exit(1)
  }

  // clear the "reading…" line
  write(CURSOR_UP(1) + ERASE_LINE)

  const w = termWidth()
  writeln()
  writeln(`  ${gold('⊙ SigRank')} ${bold('Your Cascade')}  ${dim(`platform: ${pulled.platform ?? platform}`)}`)
  if (pulled.estimated) writeln(`  ${dim('⚠  estimated values (cache data unavailable for this platform)')}`)
  writeln(`  ${dim('─'.repeat(w - 4))}`)

  // column headers
  const cols_h = [
    padEnd(dim('Window'), 8),
    padStart(dim('Υ Yield'), 10),
    padStart(dim('SNR'), 7),
    padStart(dim('Leverage'), 9),
    padStart(dim('Velocity'), 9),
    padStart(dim('10xDEV'), 8),
    padStart(dim('Class'), 13),
    padStart(dim('Tokens'), 8),
  ]
  writeln(`    ${cols_h.join('  ')}`)
  writeln(`  ${dim('·'.repeat(w - 4))}`)

  const windows = pulled.windows ?? []
  for (const win of windows) {
    const cas = win.cascade
    const isAll = win.window === 'all'
    const wLabel = isAll ? bold('all-time') : win.window
    const yVal   = cas?.yield  != null ? fmtYield(cas.yield)  : '—'
    const snrVal = cas?.snr    != null ? fmtSNR(cas.snr)       : '—'
    const levVal = cas?.leverage != null ? `${fmtLev(cas.leverage)}×` : '—'
    const velVal = cas?.velocity != null ? cas.velocity.toFixed(2)    : '—'
    const devVal = cas?.dev10x  != null ? cas.dev10x.toFixed(2)       : '—'
    const cls    = colorClass(cas?.class ?? '—')
    const tok    = fmtTokens(win.pillars?.total ?? (
      (win.pillars?.input ?? 0) + (win.pillars?.output ?? 0) +
      (win.pillars?.cacheCreate ?? 0) + (win.pillars?.cacheRead ?? 0)
    ))

    const row = [
      padEnd(wLabel, 8),
      padStart(isAll ? gold(yVal) : yVal, 10),
      padStart(snrVal, 7),
      padStart(levVal, 9),
      padStart(velVal, 9),
      padStart(devVal, 8),
      padEnd(cls, 13),
      padStart(tok, 8),
    ]
    writeln(`  ${row.join('  ')}`)
  }

  writeln(`  ${dim('─'.repeat(w - 4))}`)

  // card for the best window (all-time if present, else first)
  const best = windows.find(w => w.window === 'all') ?? windows[0]
  if (best?.card) {
    writeln()
    writeln(`  ${dim('cascade read:')}`)
    // wrap card text at terminal width
    const cardText = best.card
    const maxW = w - 6
    const words = cardText.split(' ')
    let line = ''
    for (const word of words) {
      if (line.length + word.length + 1 > maxW) {
        writeln(`  ${line}`)
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    if (line) writeln(`  ${line}`)
  }

  writeln()

  // submit hint
  writeln(`  ${dim('to publish:')}  ${cyan('npx sigrank-mcp board')}  ${dim('after')}  ${cyan('tokenpull_submit')}  ${dim('via your MCP client')}`)
  writeln()
  write(SHOW_CURSOR)
}

// ── COMPARE command ───────────────────────────────────────────────────────────
// Side-by-side: ccusage (JSON) vs tokenpull vs token-dashboard (SQLite)

function ccusagePillars(platform = 'claude') {
  // ccusage <platform> daily --json → sum by window
  try {
    const cmd = platform === 'claude' ? 'ccusage claude daily --json' : `ccusage ${platform} daily --json`
    const raw = execSync(cmd, { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const data = JSON.parse(raw)
    const rows = data.daily ?? data // ccusage may return {daily:[...]} or [...]

    const now = Date.now()
    const cutoff = { '7d': 7, '30d': 30, '90d': 90 }
    const result = {}

    for (const [win, days] of Object.entries(cutoff)) {
      const since = new Date(now - days * 86400000)
      let input = 0, output = 0, cacheCreate = 0, cacheRead = 0
      for (const row of rows) {
        const d = new Date(row.date ?? row.day ?? row.week ?? '1970-01-01')
        if (d >= since) {
          input       += row.inputTokens        ?? row.input_tokens        ?? 0
          output      += row.outputTokens       ?? row.output_tokens       ?? 0
          cacheCreate += row.cacheCreationTokens ?? row.cache_create_tokens ?? 0
          cacheRead   += row.cacheReadTokens    ?? row.cache_read_tokens   ?? 0
        }
      }
      result[win] = { input, output, cacheCreate, cacheRead }
    }
    // all-time = sum everything
    let input = 0, output = 0, cacheCreate = 0, cacheRead = 0
    for (const row of rows) {
      input       += row.inputTokens        ?? row.input_tokens        ?? 0
      output      += row.outputTokens       ?? row.output_tokens       ?? 0
      cacheCreate += row.cacheCreationTokens ?? row.cache_create_tokens ?? 0
      cacheRead   += row.cacheReadTokens    ?? row.cache_read_tokens   ?? 0
    }
    result['all'] = { input, output, cacheCreate, cacheRead }
    return result
  } catch {
    return null
  }
}

function tokscalePillars() {
  // Read tokscale_report.json — claude client only, all-time only (no timestamps in export)
  const reportPath = path.join(os.homedir(), 'tokscale_report.json')
  if (!existsSync(reportPath)) return null
  try {
    const data = JSON.parse(readFileSync(reportPath, 'utf8'))
    const entries = data.entries ?? []
    const claude = entries.filter(e =>
      e.client === 'claude' &&
      e.model !== '<synthetic>' && e.model !== 'unknown' &&
      e.provider !== 'unknown'
    )
    const p = claude.reduce((acc, e) => ({
      input:       acc.input       + (e.input      ?? 0),
      output:      acc.output      + (e.output     ?? 0),
      cacheCreate: acc.cacheCreate + (e.cacheWrite ?? 0),
      cacheRead:   acc.cacheRead   + (e.cacheRead  ?? 0),
    }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
    // tokscale export has no timestamps → only all-time available
    return { all: p }
  } catch { return null }
}

function appPillars() {
  // App numbers from screenshots — all-time, per model (no cache fields)
  // Hard-coded from 2026-06-23 screenshot capture (update when re-screenshotted)
  return {
    all: {
      input:       6_378_000,   // sum of all models: 5.6M + 102.1K + 92.9K + 130.3K + 418.9K + 33.5K
      output:     38_682_400,   // sum: 19.6M + 6.5M + 5.4M + 6.6M + 292.4K + 290.4K
      cacheCreate: null,        // not shown in App UI
      cacheRead:   null,        // not shown in App UI
    },
    _note: 'App UI — all-time, per-model sum from screenshots 2026-06-23. No cache fields. Update when re-screenshotted.',
    _perModel: [
      { model: 'claude-opus-4-8',  input: 5_600_000, output: 19_600_000 },
      { model: 'claude-sonnet-4-5',input:   102_100,  output:  6_500_000 },
      { model: 'claude-sonnet-4-6',input:    92_900,  output:  5_400_000 },
      { model: 'claude-opus-4-7',  input:   130_300,  output:  6_600_000 },
      { model: 'claude-fable-5',   input:   418_900,  output:    292_400 },
      { model: 'claude-haiku-4-5', input:    33_500,  output:    290_400 },
    ],
  }
}

function tokenDashPillars() {
  const dbPath = path.join(os.homedir(), '.claude', 'token-dashboard.db')
  if (!existsSync(dbPath)) return null
  try {
    const tmpScript = path.join(os.tmpdir(), 'sigrank_td_query.py')
    writeFileSync(tmpScript, `
import sqlite3, json, sys
from datetime import datetime, timezone, timedelta
db = sqlite3.connect(sys.argv[1])
cf = "(model LIKE '%claude%' OR model LIKE '%fable%' OR model LIKE '%sonnet%' OR model LIKE '%opus%' OR model LIKE '%haiku%')"
out = {}
for win, days in [('7d',7),('30d',30),('90d',90)]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    r = db.execute(f"SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens+cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages WHERE timestamp>=? AND {cf}",(since,)).fetchone()
    out[win] = {'input':r[0] or 0,'output':r[1] or 0,'cacheCreate':r[2] or 0,'cacheRead':r[3] or 0}
r = db.execute(f"SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens+cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages WHERE {cf}").fetchone()
out['all'] = {'input':r[0] or 0,'output':r[1] or 0,'cacheCreate':r[2] or 0,'cacheRead':r[3] or 0}
print(json.dumps(out))
`)
    const raw = execSync(`python3 "${tmpScript}" "${dbPath}"`,
      { timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function fmtDelta(a, b) {
  if (a == null || b == null) return dim('  —')
  const d = b - a
  if (d === 0) return dim('  =')
  const pct = a !== 0 ? `${d > 0 ? '+' : ''}${((d / a) * 100).toFixed(1)}%` : ''
  const abs = `${d > 0 ? '+' : ''}${fmtTokens(Math.abs(d))}`
  const label = `${abs} ${pct}`
  return d > 0 ? green(label) : red(label)
}

// Compute cascade metrics from raw pillars (mirrors bridge.ts computeCascadeMetrics)
function cascadeFromPillars(p) {
  if (!p) return null
  const i  = p.input       ?? 0
  const o  = p.output      ?? 0
  const cw = p.cacheCreate ?? 0
  const cr = p.cacheRead   ?? 0
  if (i === 0 && o === 0) return null
  const safeI = Math.max(i, 1)
  const total = i + o + cw + cr
  const velocity = o / safeI
  const leverage = cr / safeI
  const yield_   = leverage * velocity
  const snr      = (i + o) > 0 ? o / (i + o) : 0
  // dev10x = log10(T × C × R) — only when all four pillars present
  let dev10x = null
  if (cw > 0 && o > 0 && i > 0 && cr > 0) {
    const T = o / i, C = cw / o, R = cr / cw
    dev10x = Math.log10(T * C * R)
  }
  // efficiency = ((cr+cw+o)/i) / 4.0
  const efficiency = ((cr + cw + o) / safeI) / 4.0
  const cls = yield_ > 500 ? 'TRANSMITTER' : yield_ > 400 ? 'ARCH+' : yield_ > 300 ? 'ARCH' : yield_ > 150 ? 'POWER' : 'BASE'
  return { yield: yield_, velocity, leverage, snr, dev10x, efficiency, class: cls, total }
}

async function runCompare({ platform = 'claude' } = {}) {
  write(HIDE_CURSOR)

  // Pull all five sources in parallel
  writeln(`  ${dim('reading all 5 sources…')}`)
  const [ccPillars, tpData, tdPillars, tsPillars, apPillars] = await Promise.all([
    Promise.resolve(ccusagePillars(platform)),
    callTool('tokenpull', { platform }).catch(() => null),
    Promise.resolve(tokenDashPillars()),
    Promise.resolve(tokscalePillars()),
    Promise.resolve(appPillars()),
  ])
  write(CURSOR_UP(1) + ERASE_LINE)

  const w = termWidth()
  const WINS = ['7d', '30d', '90d', 'all']
  const WIN_LABEL = { '7d': '7d', '30d': '30d', '90d': '90d', 'all': 'all-time' }

  // build tokenpull pillar lookup
  const tpPillars = {}
  for (const win of (tpData?.windows ?? [])) {
    tpPillars[win.window] = win.pillars
  }

  // sources: name, color, pillars-by-window, note
  const SOURCES = [
    { name: 'tokenpull',   color: cyan,                      pillars: tpPillars,                      note: 'JSONL deduped by msg id · canon source' },
    { name: 'ccusage',     color: (s) => paint(c.green, s),  pillars: ccPillars ?? {},                note: 'ccusage claude subcommand · monthly only' },
    { name: 'token-dash',  color: (s) => paint(c.magenta,s), pillars: tdPillars ?? {},                note: 'SQLite — double-counts sessions · use with caution' },
    { name: 'tokscale',    color: (s) => paint(c.blue, s),   pillars: tsPillars ?? {},                note: 'all-time only · partial export (~5% of opus-4-8)' },
    { name: 'App',         color: gold,                      pillars: apPillars ?? {},                note: 'screenshots 2026-06-23 · no cache fields · update manually' },
  ]

  writeln()
  writeln(`  ${gold('⊙ SigRank')} ${bold('5-Source Comparison')}  ${dim(`platform: ${platform}  ·  claude only`)}`)
  writeln(`  ${dim('─'.repeat(w - 4))}`)

  // ── PILLARS TABLE ──────────────────────────────────────────────────────────
  const PILLARS = [
    { key: 'input',       label: 'Input' },
    { key: 'output',      label: 'Output' },
    { key: 'cacheCreate', label: 'Cache Write' },
    { key: 'cacheRead',   label: 'Cache Read' },
  ]

  for (const { key, label } of PILLARS) {
    writeln()
    writeln(`  ${bold(label)}`)
    const hcols = [padEnd(dim('Source'), 14), ...WINS.map(win => padStart(dim(WIN_LABEL[win]), 13))]
    writeln(`    ${hcols.join('  ')}`)
    writeln(`  ${dim('·'.repeat(Math.min(w - 4, 14 + WINS.length * 15)))}`)

    for (const src of SOURCES) {
      const vals = WINS.map(win => {
        const p = src.pillars[win]
        const v = p?.[key]
        if (v == null) return padStart(dim('—'), 13)
        return padStart(fmtTokens(v), 13)
      })
      writeln(`    ${padEnd(src.color(src.name), 14)}  ${vals.join('  ')}`)
    }
  }

  // ── SIGNATURE TABLE ────────────────────────────────────────────────────────
  writeln()
  writeln(`  ${dim('─'.repeat(w - 4))}`)
  writeln(`  ${bold('Cascade Signature')}  ${dim('per source · all windows where data available')}`)
  writeln()

  const SIG_METRICS = [
    { key: 'yield',      label: 'Υ Yield',    fmt: v => fmtYield(v),       w: 9 },
    { key: 'velocity',   label: 'Vel',         fmt: v => v.toFixed(2),      w: 6 },
    { key: 'leverage',   label: 'Lev',         fmt: v => `${fmtLev(v)}×`,  w: 7 },
    { key: 'snr',        label: 'SNR',         fmt: v => fmtSNR(v),         w: 6 },
    { key: 'dev10x',     label: '10x',         fmt: v => v.toFixed(2),      w: 5 },
    { key: 'efficiency', label: 'Eff',         fmt: v => v.toFixed(1),      w: 6 },
    { key: 'class',      label: 'Class',       fmt: v => colorClass(v),     w: 12 },
  ]

  // header
  const sigHdr = [
    padEnd(dim('Source'), 14),
    padEnd(dim('Window'), 8),
    ...SIG_METRICS.map(m => padStart(dim(m.label), m.w)),
  ]
  writeln(`    ${sigHdr.join('  ')}`)
  writeln(`  ${dim('·'.repeat(Math.min(w - 4, 80)))}`)

  for (const src of SOURCES) {
    const availWins = WINS.filter(win => src.pillars[win] != null)
    if (availWins.length === 0) {
      writeln(`    ${padEnd(src.color(src.name), 14)}  ${dim('no data')}`)
      continue
    }
    let first = true
    for (const win of availWins) {
      const p = src.pillars[win]
      // For tokenpull, use the pre-computed cascade from the tool if available
      let cas
      if (src.name === 'tokenpull') {
        const tpWin = tpData?.windows?.find(ww => ww.window === win)
        cas = tpWin?.cascade ? {
          yield: tpWin.cascade.yield,
          velocity: tpWin.cascade.velocity,
          leverage: tpWin.cascade.leverage,
          snr: tpWin.cascade.snr,
          dev10x: tpWin.cascade.dev10x,
          efficiency: null,
          class: tpWin.cascade.class,
        } : cascadeFromPillars(p)
      } else {
        cas = cascadeFromPillars(p)
      }

      const srcLabel = first ? src.color(src.name) : ' '.repeat(stripAnsi(src.name).length)
      const winLabel = win === 'all' ? bold('all-time') : win
      const sigCols = SIG_METRICS.map(m => {
        const v = cas?.[m.key]
        return padStart(v != null ? m.fmt(v) : dim('—'), m.w)
      })
      writeln(`    ${padEnd(srcLabel, 14)}  ${padEnd(winLabel, 8)}  ${sigCols.join('  ')}`)
      first = false
    }
  }

  // ── NOTES ─────────────────────────────────────────────────────────────────
  writeln()
  writeln(`  ${dim('─'.repeat(w - 4))}`)
  for (const src of SOURCES) {
    writeln(`  ${src.color(src.name.padEnd(12))}  ${dim(src.note)}`)
  }
  writeln(`  ${dim('Eff = ((cacheRead+cacheWrite+output)/input)/4.0 vs AA baseline')}`)
  writeln(`  ${dim('App has no cache fields → Υ/Lev/Eff/10x unavailable from App source')}`)
  writeln()
  write(SHOW_CURSOR)
}

// ── WATCH command ─────────────────────────────────────────────────────────────

async function runWatch({ platform = 'claude', window: win = '7d', refresh = 30 } = {}) {
  let prev = null
  let lines = 0

  write(HIDE_CURSOR)

  const draw = async () => {
    let result
    try {
      result = await callTool('watch_tokenpull', { platform, window: win })
    } catch (e) {
      writeln(red(`  ✗ ${e.message}`))
      return
    }

    const cas = result.cascade
    const changed = prev !== null && prev !== cas?.yield

    if (lines > 0) write(CURSOR_UP(lines))

    const out = []
    const push = (s = '') => out.push(s)
    const w = termWidth()
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false })

    push()
    push(`  ${gold('⊙ SigRank')} ${bold('Watch')}  ${dim(`${platform}  ·  window: ${win}  ·  ${ts}`)}`)
    push(`  ${dim('─'.repeat(w - 4))}`)
    push()

    const yDisplay = cas?.yield != null ? fmtYield(cas.yield) : '—'
    const indicator = changed ? green(' ▲ updated') : dim(' · no change')

    push(`  ${bold('Υ Yield')}      ${cas?.yield != null ? gold(yDisplay) : '—'}${indicator}`)
    push(`  ${bold('SNR')}          ${fmtSNR(cas?.snr)}`)
    push(`  ${bold('Leverage')}     ${cas?.leverage != null ? `${fmtLev(cas.leverage)}×` : '—'}`)
    push(`  ${bold('Velocity')}     ${cas?.velocity != null ? cas.velocity.toFixed(2) : '—'}`)
    push(`  ${bold('10xDEV')}       ${cas?.dev10x != null ? cas.dev10x.toFixed(2) : '—'}`)
    push(`  ${bold('Class')}        ${colorClass(cas?.class ?? '—')}`)
    push()
    push(`  ${dim('─'.repeat(w - 4))}`)
    push(`  ${dim(`polling every ${refresh}s  ·  tokens stay on your machine  ·  ctrl+c to exit`)}`)
    push()

    write(out.join('\n'))
    lines = out.length
    prev = cas?.yield ?? null
  }

  try {
    await draw()
    const iv = setInterval(draw, refresh * 1000)
    await new Promise((resolve) => {
      process.on('SIGINT', () => { clearInterval(iv); resolve() })
    })
  } finally {
    write(SHOW_CURSOR + '\n')
  }
}

// ── HELP ─────────────────────────────────────────────────────────────────────

function showHelp() {
  writeln()
  writeln(`  ${gold('⊙ SigRank')} ${bold('CLI')}  ${dim('v0.6.5')}`)
  writeln()
  writeln(`  ${bold('Commands')}`)
  writeln(`    ${cyan('board')}                live leaderboard (refreshes every 30s)`)
  writeln(`    ${cyan('board --window 7d')}    board for a specific window (7d, 30d, 90d, all_time)`)
  writeln(`    ${cyan('board --once')}         print once and exit`)
  writeln(`    ${cyan('me')}                   your cascade across all 4 time windows`)
  writeln(`    ${cyan('me --platform amp')}    use a different platform adapter`)
  writeln(`    ${cyan('me --compare')}         raw pillar comparison: ccusage vs tokenpull vs token-dashboard`)
  writeln(`    ${cyan('watch')}                live tune meter — re-reads local logs every 30s`)
  writeln(`    ${cyan('watch --window 7d')}    watch a specific window`)
  writeln()
  writeln(`  ${bold('Options')}`)
  writeln(`    ${dim('--window')}    7d · 30d · 90d · all_time  (default: 30d for board, 7d for watch)`)
  writeln(`    ${dim('--platform')}  claude · codex · amp · gemini · opencode · goose · …`)
  writeln(`    ${dim('--refresh')}   poll interval in seconds (default: 30)`)
  writeln(`    ${dim('--once')}      print once and exit (board only)`)
  writeln()
  writeln(`  ${bold('MCP server mode')}  (default when no command given)`)
  writeln(`    ${dim('npx sigrank-mcp')}   starts the MCP server on stdio`)
  writeln()
  writeln(`  ${bold('Examples')}`)
  writeln(`    ${dim('npx sigrank-mcp board')}`)
  writeln(`    ${dim('npx sigrank-mcp me')}`)
  writeln(`    ${dim('npx sigrank-mcp watch --window 7d --refresh 60')}`)
  writeln(`    ${dim('npx sigrank-mcp board --window all_time --once')}`)
  writeln()
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────────

export async function runCli(argv) {
  const args = argv.slice(2) // strip 'node' + script path
  const cmd  = args[0]

  // parse --key value flags
  const flags = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
      flags[key] = val
    }
  }

  try {
    if (cmd === 'board') {
      await runBoard({
        window:  flags.window  ?? '30d',
        once:    flags.once    === true || flags.once === 'true',
        refresh: Number(flags.refresh) || 30,
      })
    } else if (cmd === 'me') {
      await runMe({ platform: flags.platform ?? 'claude', compare: flags.compare === true || flags.compare === 'true' })
    } else if (cmd === 'watch') {
      await runWatch({
        platform: flags.platform ?? 'claude',
        window:   flags.window   ?? '7d',
        refresh:  Number(flags.refresh) || 30,
      })
    } else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      showHelp()
    } else if (cmd === '--version' || cmd === '-v') {
      writeln('0.6.5')
    } else {
      // unknown command: show help
      showHelp()
    }
  } catch (e) {
    write(SHOW_CURSOR)
    writeln(red(`\n  ✗ ${e.message}`))
    process.exit(1)
  }
}
