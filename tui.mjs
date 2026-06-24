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
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import os from 'os'
import path from 'path'

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
const green  = (s) => paint(c.green, s)
const red    = (s) => paint(c.red, s)

const CLEAR      = `${ESC}H${ESC}2J`   // home + erase visible area
const ENTER_ALT  = `${ESC}?1049h`       // enter alternate screen buffer
const EXIT_ALT   = `${ESC}?1049l`       // exit alternate screen buffer (restores original)
const HIDE       = `${ESC}?25l`
const SHOW       = `${ESC}?25h`
const UP         = (n) => `${ESC}${n}A`
const ERLINE     = `${ESC}2K`

const write  = (s) => process.stdout.write(s)
const writeln = (s = '') => process.stdout.write(s + '\n')
const W      = () => process.stdout.columns || 100
const H      = () => process.stdout.rows    || 40

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, '') }
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
    fetch(`${DEFAULT_API_BASE}/api/v1/leaderboard?window=30d`, { headers: { accept: 'application/json' } })
      .then(r => r.ok ? r.json() : null).catch(() => null),
    new Promise(r => setTimeout(() => r(null), 5000)),
  ])

  const [platformResults, tdPillars] = await Promise.all([
    Promise.allSettled(ALL_PLATFORMS.map(p => tokenpullAny(p))),
    Promise.resolve(tokenDashPillars()),
  ])

  const verifierMap = {}
  for (const platform of ALL_PLATFORMS) {
    verifierMap[platform] = { cc: ccusagePillars(platform), ts: tokscalePillars(platform) }
  }

  const active = []
  for (let i = 0; i < ALL_PLATFORMS.length; i++) {
    const r = platformResults[i]
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
  const res = await fetch(`${DEFAULT_API_BASE}/api/v1/leaderboard?window=${window}`, {
    headers: { accept: 'application/json' }
  })
  if (!res.ok) return null
  return res.json()
}

// ── TAB BAR ──────────────────────────────────────────────────────────────────
const TABS = [
  { key: '1', label: 'Dashboard', short: 'D' },
  { key: '2', label: 'Compare',   short: 'C' },
  { key: '3', label: 'Board',     short: 'B' },
  { key: '4', label: 'Watch',     short: 'W' },
]

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
  // right side
  const right = dim(`signalaf.com  ${ts}`)

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
  const WINS = ['7d', '30d', '90d', 'all']

  // ── Cascade table
  writeln()
  writeln(`  ${bold('Your Cascade')}  ${dim('all platforms · all windows')}`)
  writeln()

  // header
  const CH = [
    padEnd(dim('Platform'), 12), padEnd(dim('Win'), 5),
    padStart(dim('Input'), 8), padStart(dim('Output'), 8),
    padStart(dim('CacheW'), 8), padStart(dim('CacheR'), 9),
    padStart(dim('Υ Yield'), 9), padStart(dim('SNR'), 7),
    padStart(dim('Lev'), 7), padStart(dim('Vel'), 6),
    padStart(dim('10x'), 6), padEnd(dim('Class'), 13),
  ]
  writeln(`    ${CH.join('  ')}`)
  writeln(`  ${dim('·'.repeat(Math.min(w - 4, 114)))}`)

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
      padStart(cas.velocity?.toFixed(2) ?? '—', 6),
      padStart(cas.dev10x?.toFixed(2) ?? '—', 6),
      padEnd(clsFn(cas.class), 13),
    ]
    writeln(`    ${cols.join('  ')}`)
  }

  let firstWin = {}
  for (const d of active) {
    firstWin[d.platform] = WINS.find(wk => {
      const wd = d.windows?.find(w => w.window === wk)
      return wd && (wd.pillars.input + wd.pillars.output) > 0
    })
    for (const wk of WINS) {
      const wd = d.windows?.find(x => x.window === wk)
      if (!wd || (wd.pillars.input + wd.pillars.output) === 0) continue
      renderRow(d.platform, (s) => wk === firstWin[d.platform] ? cyan(s) : dim(s), wk, wd.pillars, d.estimated)
    }
    writeln()
  }

  // combined
  if (active.length > 1) {
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
    writeln()
  }

  // ── Yield sparklines
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Υ Trend')}  ${dim('across windows (7d→all)')}`)
  writeln()
  for (const d of active) {
    writeln(`    ${padEnd(cyan(d.platform), 10)}  ${yieldSpark(d)}`)
  }
  writeln()

  // ── Token bar charts
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Token Composition')}  ${dim('all-time · proportional · █')}${paint(c.cyan,'I')}${dim(' input  █')}${paint(c.blue,'W')}${dim(' cacheWrite  █')}${paint(c.boldGold,'R')}${dim(' cacheRead  █')}${paint(c.green,'O')}${dim(' output')}`)
  writeln()
  for (const d of active) {
    const all = d.windows?.find(w => w.window === 'all')
    if (!all) continue
    writeln(`    ${padEnd(cyan(d.platform), 10)}  ${tokenBar(all.pillars, 50)}  ${dim(fmtTok((all.pillars.input??0)+(all.pillars.output??0)+(all.pillars.cacheCreate??0)+(all.pillars.cacheRead??0)))}`)
  }
  // combined bar
  if (active.length > 1) {
    const cp = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
    for (const d of active) {
      const all = d.windows?.find(w => w.window === 'all')
      if (!all) continue
      cp.input += all.pillars.input??0; cp.output += all.pillars.output??0
      cp.cacheCreate += all.pillars.cacheCreate??0; cp.cacheRead += all.pillars.cacheRead??0
    }
    const lbl = active.map(d => d.platform).join('+')
    writeln(`    ${padEnd(bold(lbl), 10)}  ${tokenBar(cp, 50)}  ${dim(fmtTok(cp.input+cp.output+cp.cacheCreate+cp.cacheRead))}`)
  }
  writeln(`  ${dim('proportional — cacheRead typically dominates (~90%) for high-leverage operators')}`)
  writeln()

  // ── Mini board (top 3)
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Board')}  ${dim('30d · top 5 · signalaf.com')}  ${dim('SIGNA = server-side credential score (calibrating)')}`)
  writeln()
  const entries = boardData?.operators ?? boardData?.entries ?? boardData ?? []
  if (Array.isArray(entries) && entries.length > 0) {
    const BH = [padStart(dim('#'),4), padEnd(dim('Codename'),20), padEnd(dim('Class'),13), padStart(dim('SIGNA~'),7), padStart(dim('SNR'),7), padStart(dim('7d↕'),5)]
    writeln(`    ${BH.join('  ')}`)
    writeln(`  ${dim('·'.repeat(Math.min(w-4, 68)))}`)
    for (const e of entries.slice(0, 5)) {
      const rk  = e.rank === 1 ? gold(`#${e.rank}`) : `#${e.rank}`
      const nm  = padEnd(trunc(e.codename ?? '—', 20), 20)
      const cls = padEnd(colorCls(e.class_tier ?? '—'), 13)
      const sna = padStart(e.signa_rate != null ? dim(e.signa_rate.toFixed(1)) : dim('—'), 7)
      const snr = padStart(e.compression_ratio != null ? fmtSNR(e.compression_ratio) : '—', 7)
      const mv  = padStart(fmtMov(e.movement_7d), 5)
      writeln(`    ${padStart(rk,4)}  ${nm}  ${cls}  ${sna}  ${snr}  ${mv}`)
    }
    if (entries.length > 5) writeln(`  ${dim(`  … ${entries.length - 5} more on signalaf.com`)}`)
  } else {
    writeln(`  ${dim('  board unavailable')}`)
  }
  writeln()

  // status line
  if (status) writeln(`  ${dim(status)}`)
}

// ── TAB 2: COMPARE ───────────────────────────────────────────────────────────
function renderCompare(data) {
  const { tpData, cc, ts, td, platform } = data
  const WINS = ['7d', '30d', '90d', 'all']
  const WIN_LABEL = { '7d': '7d', '30d': '30d', '90d': '90d', 'all': 'all' }
  const w = W()

  const tpPillars = {}
  for (const win of (tpData?.windows ?? [])) tpPillars[win.window] = win.pillars

  const SOURCES = [
    { name: 'tokenpull',  color: (s) => paint(c.boldCyan, s),   pillars: tpPillars,  note: 'JSONL canon' },
    { name: 'ccusage',    color: (s) => paint(c.green, s),       pillars: cc ?? {},   note: 'ccusage CLI' },
    { name: 'token-dash', color: (s) => paint(c.magenta, s),     pillars: td ?? {},   note: 'SQLite' },
    { name: 'tokscale',   color: (s) => paint(c.blue, s),        pillars: ts ?? {},   note: 'report.json' },
  ].filter(s => Object.keys(s.pillars).length > 0)

  const PILLARS = [
    { key: 'input',       label: 'Input' },
    { key: 'output',      label: 'Output' },
    { key: 'cacheCreate', label: 'Cache Write' },
    { key: 'cacheRead',   label: 'Cache Read' },
  ]

  writeln()
  writeln(`  ${bold('Source Comparison')}  ${dim(`platform: ${platform}  ·  tokenpull vs ccusage vs token-dash vs tokscale`)}`)
  writeln()

  for (const { key, label } of PILLARS) {
    writeln(`  ${bold(label)}`)
    const hcols = [padEnd(dim('Source'), 12), ...WINS.map(w => padStart(dim(WIN_LABEL[w]), 12))]
    writeln(`    ${hcols.join('  ')}`)
    writeln(`  ${dim('·'.repeat(Math.min(w-4, 72)))}`)

    // get tokenpull as baseline for delta
    const base = tpPillars

    for (const src of SOURCES) {
      const cells = WINS.map(win => {
        const p = src.pillars[win]
        const val = p?.[key] ?? null
        if (val == null) return padStart(dim('—'), 12)
        const baseVal = base[win]?.[key]
        if (src.name !== 'tokenpull' && baseVal != null && baseVal > 0) {
          const delta = ((val - baseVal) / baseVal * 100)
          const deltaStr = delta === 0 ? '' : delta > 0 ? green(` +${delta.toFixed(0)}%`) : red(` ${delta.toFixed(0)}%`)
          return padStart(`${fmtTok(val)}${deltaStr}`, 12)
        }
        return padStart(fmtTok(val), 12)
      })
      writeln(`    ${padEnd(src.color(src.name), 12)}  ${cells.join('  ')}  ${dim(src.note)}`)
    }
    writeln()
  }

  // cascade metrics comparison (all-time)
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Cascade Metrics')}  ${dim('all-time · computed from each source')}`)
  writeln()
  const MCH = [padEnd(dim('Source'),12), padStart(dim('Υ Yield'),9), padStart(dim('SNR'),7), padStart(dim('Leverage'),10), padStart(dim('Vel'),6), padStart(dim('10x'),6), padEnd(dim('Class'),13)]
  writeln(`    ${MCH.join('  ')}`)
  writeln(`  ${dim('·'.repeat(Math.min(w-4, 74)))}`)
  for (const src of SOURCES) {
    const p = src.pillars['all']
    if (!p) continue
    const cas = cascadeFrom(p)
    if (!cas) continue
    const clsFn = CLS[cas.class] ?? ((s) => s)
    const cols = [
      padEnd(src.color(src.name), 12),
      padStart(cas.yield > 10000 ? gold(fmtY(cas.yield)) : fmtY(cas.yield), 9),
      padStart(fmtSNR(cas.snr), 7),
      padStart(fmtLev(cas.leverage)+'×', 10),
      padStart(cas.velocity?.toFixed(2) ?? '—', 6),
      padStart(cas.dev10x?.toFixed(2) ?? '—', 6),
      padEnd(clsFn(cas.class), 13),
    ]
    writeln(`    ${cols.join('  ')}`)
  }
  writeln()

  // bar chart comparison — cacheRead all-time
  writeln(`  ${hr()}`)
  writeln()
  writeln(`  ${bold('Cache Read  (all-time)')}`)
  writeln()
  const crVals   = SOURCES.map(s => s.pillars['all']?.cacheRead ?? 0)
  const crLabels = SOURCES.map(s => s.name)
  const crColors = [
    (s) => paint(c.boldCyan, s),
    (s) => paint(c.green, s),
    (s) => paint(c.magenta, s),
    (s) => paint(c.blue, s),
  ]
  const maxCr = Math.max(...crVals, 1)
  for (let i = 0; i < SOURCES.length; i++) {
    const v    = crVals[i]
    const pct  = v / maxCr
    const full = Math.round(pct * 40)
    const bar  = crColors[i % crColors.length]('█'.repeat(full))
    writeln(`    ${padEnd(dim(crLabels[i]), 12)}  ${padEnd(bar, 40)}  ${fmtTok(v)}`)
  }
  writeln()
}

// ── TAB 3: BOARD ─────────────────────────────────────────────────────────────
function renderBoard(boardData, window = '30d') {
  const entries = boardData?.operators ?? boardData?.entries ?? boardData ?? []
  const w = W()

  writeln()
  writeln(`  ${bold('Leaderboard')}  ${dim(`window: ${window}  ·  sorted by SIGNA rate  ·  signalaf.com`)}`)
  writeln()

  if (!Array.isArray(entries) || entries.length === 0) {
    writeln(`  ${dim('  board unavailable')}`)
    return
  }

  const BH = [
    padStart(dim('#'), 4), padEnd(dim('Codename'), 22), padEnd(dim('Class'), 13),
    padStart(dim('SIGNA'), 7), padStart(dim('SNR'), 7), padStart(dim('Depth'), 7),
    padStart(dim('Tokens'), 8), padStart(dim('Force'), 7), padStart(dim('Pct'), 5), padStart(dim('7d↕'), 5),
  ]
  writeln(`    ${BH.join('  ')}`)
  writeln(`  ${dim('·'.repeat(Math.min(w-4, 95)))}`)

  for (const e of entries) {
    const rk  = e.rank === 1 ? gold(`#${e.rank}`) : e.rank <= 3 ? cyan(`#${e.rank}`) : `#${e.rank}`
    const nm  = padEnd(trunc(e.codename ?? '—', 22), 22)
    const cls = padEnd(colorCls(e.class_tier ?? '—'), 13)
    const sna = padStart(e.signa_rate        != null ? e.signa_rate.toFixed(1) : '—', 7)
    const snr = padStart(e.compression_ratio != null ? fmtSNR(e.compression_ratio) : '—', 7)
    const dep = padStart(e.session_depth     != null ? e.session_depth.toFixed(1) : '—', 7)
    const tok = padStart(e.token_throughput  != null ? fmtTok(e.token_throughput)  : '—', 8)
    const frc = padStart(e.signal_force      != null ? e.signal_force.toFixed(1) : '—', 7)
    const pct = padStart(e.percentile        != null ? `${e.percentile}%` : '—', 5)
    const mv  = padStart(fmtMov(e.movement_7d), 5)
    writeln(`    ${padStart(rk,4)}  ${nm}  ${cls}  ${sna}  ${snr}  ${dep}  ${tok}  ${frc}  ${pct}  ${mv}`)
  }
  writeln()
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

// ── MAIN TUI LOOP ─────────────────────────────────────────────────────────────
export async function runTui({ platform = 'claude', window: win = '7d' } = {}) {
  write(ENTER_ALT)  // switch to alternate screen — original terminal state preserved on exit
  write(HIDE)
  write(CLEAR)

  // ── State
  let activeTab    = 0
  let dashData     = null
  let compareData  = null
  let boardData    = null
  let boardWindow  = '30d'
  let watchPlatform = platform
  let watchWindow  = win
  let loading      = true
  let status       = 'loading…'
  let refreshTimer = null

  // ── Redraw
  const redraw = async () => {
    write(CLEAR)
    renderTabBar(activeTab)

    const hint = `  ${dim('← → or 1-4')} switch tabs   ${dim('[R]')} refresh   ${dim('[Q]')} quit`

    if (activeTab === 0) {
      if (!dashData) {
        writeln(`\n  ${dim('loading dashboard…')}`)
      } else {
        renderDashboard(dashData, status)
      }
      writeln(`  ${hr()}`)
      writeln(`${hint}   ${dim('[S]')} submit to board`)
    } else if (activeTab === 1) {
      if (!compareData) {
        writeln(`\n  ${dim(`loading compare (${platform})…`)}`)
      } else {
        renderCompare(compareData)
      }
      writeln(`  ${hr()}`)
      writeln(`${hint}   ${dim('[P]')} switch platform`)
    } else if (activeTab === 2) {
      if (!boardData) {
        writeln(`\n  ${dim(`loading board (${boardWindow})…`)}`)
      } else {
        renderBoard(boardData, boardWindow)
      }
      writeln(`  ${hr()}`)
      writeln(`${hint}   ${dim('[W]')} window`)
    } else if (activeTab === 3) {
      await renderWatch(watchPlatform, watchWindow)
      writeln(`  ${hr()}`)
      writeln(`${hint}   auto-refresh 30s`)
    }
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

  await loadAll()

  // auto-refresh board + watch every 30s
  const startAutoRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = setInterval(async () => {
      if (activeTab === 2) {
        boardData = await loadBoardData(boardWindow).catch(() => null)
        await redraw()
      } else if (activeTab === 3) {
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

      // tab switching
      let switched = false
      if (k === '\x1b[c' || k === '\x1b[d') { // right/left arrows (some terminals)
        // handled below via raw escape
      }
      if (key === '\x1b[C') { activeTab = Math.min(3, activeTab + 1); switched = true }
      if (key === '\x1b[D') { activeTab = Math.max(0, activeTab - 1); switched = true }
      if (k === '1') { activeTab = 0; switched = true }
      if (k === '2') { activeTab = 1; switched = true }
      if (k === '3') { activeTab = 2; switched = true }
      if (k === '4') { activeTab = 3; switched = true }

      if (k === 'r') {
        status = 'refreshing…'
        await redraw()
        await loadAll()
        return
      }

      if (k === 's' && activeTab === 0) {
        // submit flow — exit alt screen, hand off to CLI submit path
        const { runCli } = await import('./cli.mjs')
        if (refreshTimer) clearInterval(refreshTimer)
        write(SHOW)
        write(EXIT_ALT)
        await runCli(['node', 'cli.mjs', '--submit'])
        resolve()
        return
      }

      if (k === 'w' && activeTab === 2) {
        const windows = ['7d', '30d', '90d', 'all']
        const idx = windows.indexOf(boardWindow)
        boardWindow = windows[(idx + 1) % windows.length]
        boardData = await loadBoardData(boardWindow).catch(() => null)
      }

      if (switched || k === 'w') await redraw()
    })
  })

  process.stdin.setRawMode(false)
  process.stdin.pause()
  writeln()
}
