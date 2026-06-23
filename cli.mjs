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
import { existsSync } from 'fs'
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

function tokenDashPillars() {
  // query token-dashboard SQLite directly
  const dbPath = path.join(os.homedir(), '.claude', 'token-dashboard.db')
  if (!existsSync(dbPath)) return null
  try {
    const claudeFilter = `(model LIKE '%claude%' OR model LIKE '%fable%' OR model LIKE '%sonnet%' OR model LIKE '%opus%' OR model LIKE '%haiku%')`
    const now = new Date()
    const result = {}
    for (const [win, days] of [['7d', 7], ['30d', 30], ['90d', 90]]) {
      const since = new Date(now - days * 86400000).toISOString()
      const cmd = `python3 -c "
import sqlite3, json
db = sqlite3.connect('${dbPath}')
r = db.execute('''SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens+cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages WHERE timestamp>=? AND ${claudeFilter}''',(('${since}',))).fetchone()
print(json.dumps({'input':r[0] or 0,'output':r[1] or 0,'cacheCreate':r[2] or 0,'cacheRead':r[3] or 0}))
"`
      const raw = execSync(cmd, { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      result[win] = JSON.parse(raw)
    }
    // all-time
    const cmd = `python3 -c "
import sqlite3, json
db = sqlite3.connect('${dbPath}')
r = db.execute('SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens+cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages WHERE ${claudeFilter}').fetchone()
print(json.dumps({'input':r[0] or 0,'output':r[1] or 0,'cacheCreate':r[2] or 0,'cacheRead':r[3] or 0}))
"`
    const raw = execSync(cmd, { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    result['all'] = JSON.parse(raw)
    return result
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

async function runCompare({ platform = 'claude' } = {}) {
  write(HIDE_CURSOR)
  writeln(`  ${dim('reading ccusage…')}`)
  const ccPillars = ccusagePillars(platform)
  write(CURSOR_UP(1) + ERASE_LINE)

  writeln(`  ${dim('reading tokenpull…')}`)
  let tpData
  try { tpData = await callTool('tokenpull', { platform }) } catch { tpData = null }
  write(CURSOR_UP(1) + ERASE_LINE)

  writeln(`  ${dim('reading token-dashboard…')}`)
  const tdPillars = tokenDashPillars()
  write(CURSOR_UP(1) + ERASE_LINE)

  const w = termWidth()
  const WINS = ['7d', '30d', '90d', 'all']
  const WIN_LABEL = { '7d': '7d', '30d': '30d', '90d': '90d', 'all': 'all-time' }

  // build tokenpull pillar lookup
  const tpPillars = {}
  for (const win of (tpData?.windows ?? [])) {
    tpPillars[win.window] = win.pillars
  }

  writeln()
  writeln(`  ${gold('⊙ SigRank')} ${bold('Source Comparison')}  ${dim(`platform: ${platform}  ·  claude tokens only`)}`)
  writeln(`  ${dim('─'.repeat(w - 4))}`)

  const PILLARS = [
    { key: 'input',       label: 'Input' },
    { key: 'output',      label: 'Output' },
    { key: 'cacheCreate', label: 'Cache Create' },
    { key: 'cacheRead',   label: 'Cache Read' },
  ]

  for (const { key, label } of PILLARS) {
    writeln()
    writeln(`  ${bold(label)}`)

    // header row
    const hcols = [
      padEnd(dim('Source'), 16),
      ...WINS.map(win => padStart(dim(WIN_LABEL[win]), 14))
    ]
    writeln(`    ${hcols.join('  ')}`)
    writeln(`  ${dim('·'.repeat(Math.min(w - 4, 16 + WINS.length * 16)))}`)

    // ccusage row
    if (ccPillars) {
      const cols = [padEnd(cyan('ccusage'), 16), ...WINS.map(win => padStart(fmtTokens(ccPillars[win]?.[key] ?? 0), 14))]
      writeln(`    ${cols.join('  ')}`)
    } else {
      writeln(`    ${padEnd(dim('ccusage'), 16)}  ${dim('not found')}`)
    }

    // tokenpull row
    if (tpData) {
      const cols = [padEnd(cyan('tokenpull'), 16), ...WINS.map(win => padStart(fmtTokens(tpPillars[win]?.[key] ?? 0), 14))]
      writeln(`    ${cols.join('  ')}`)
    } else {
      writeln(`    ${padEnd(dim('tokenpull'), 16)}  ${dim('not found')}`)
    }

    // token-dashboard row
    if (tdPillars) {
      const cols = [padEnd(cyan('token-dash'), 16), ...WINS.map(win => padStart(fmtTokens(tdPillars[win]?.[key] ?? 0), 14))]
      writeln(`    ${cols.join('  ')}`)
    } else {
      writeln(`    ${padEnd(dim('token-dash'), 16)}  ${dim('not found — run: python3 ~/token-dashboard/cli.py scan')}`)
    }

    // delta row: tokenpull vs token-dash (the two most comparable)
    if (tpData && tdPillars) {
      const cols = [
        padEnd(dim('Δ tp→td'), 16),
        ...WINS.map(win => {
          const a = tpPillars[win]?.[key] ?? 0
          const b = tdPillars[win]?.[key] ?? 0
          return padStart(fmtDelta(a, b), 14)
        })
      ]
      writeln(`    ${cols.join('  ')}`)
    }
  }

  // SigRank cascade section
  writeln()
  writeln(`  ${dim('─'.repeat(w - 4))}`)
  writeln(`  ${bold('SigRank Cascade')}  ${dim('(tokenpull → cascade math)')}`)
  writeln()

  const CASCADE_ROWS = [
    { key: 'yield',    label: 'Υ Yield',   fmt: v => fmtYield(v) },
    { key: 'snr',      label: 'SNR',        fmt: v => fmtSNR(v) },
    { key: 'leverage', label: 'Leverage',   fmt: v => `${fmtLev(v)}×` },
    { key: 'velocity', label: 'Velocity',   fmt: v => v.toFixed(2) },
    { key: 'dev10x',   label: '10xDEV',     fmt: v => v.toFixed(2) },
    { key: 'class',    label: 'Class',      fmt: v => colorClass(v) },
  ]

  const hcols = [padEnd(dim('Metric'), 12), ...WINS.map(win => padStart(dim(WIN_LABEL[win]), 12))]
  writeln(`    ${hcols.join('  ')}`)
  writeln(`  ${dim('·'.repeat(Math.min(w - 4, 12 + WINS.length * 14)))}`)

  for (const { key, label, fmt } of CASCADE_ROWS) {
    const cols = [
      padEnd(dim(label), 12),
      ...WINS.map(win => {
        const cas = tpPillars[win] ? (tpData?.windows?.find(w => w.window === win)?.cascade) : null
        const v = cas?.[key]
        return padStart(v != null ? fmt(v) : dim('—'), 12)
      })
    ]
    writeln(`    ${cols.join('  ')}`)
  }

  // estimated rank hint
  writeln()
  writeln(`  ${dim('─'.repeat(w - 4))}`)
  writeln(`  ${dim('note: token-dash has longer history (SQLite); tokenpull reads live JSONL only')}`)
  writeln(`  ${dim('note: ccusage = primary pillar source (all agents); tokenpull = claude-only cascade input')}`)
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
