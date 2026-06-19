/**
 * tokenpull.mjs — SigRank's in-house local usage reader.
 *
 * Reads token telemetry straight from the platform's local session logs (Claude Code
 * first: ~/.claude/projects/<project>/<session>.jsonl) and slices it into the four
 * windows (7d / 30d / 90d / all) of raw pillars — the WINDOWED_PROFILES payload, pulled
 * with zero paste. No ccusage, no tokscale: our own reader, our own numbers.
 *
 * Token-only: we read usage counts (input/output/cache), message id, and timestamp —
 * never message text. Billing-accurate: messages are deduped by `message.id` so the
 * tally matches what the API actually billed (the one trick token-dashboard gets right
 * and sigrank-agent's line-index keying does not).
 *
 * Adapter-shaped for multi-system: add a Codex / Cursor / Gemini reader by implementing
 * the same { platform, defaultRoot(), messages(root) } contract — Claude is just the first.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DAY_MS = 86_400_000

/** The four windows, in days. `all` = unbounded. */
export const WINDOWS = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'all', days: Infinity },
]

/**
 * Claude Code adapter. Yields one record per billed assistant message:
 * { id, ts, input, output, cacheCreate, cacheRead, file }. Mirrors the field
 * mapping in sigrank-agent/adapters/claude_code.py (the working reference).
 */
export const claudeAdapter = {
  platform: 'claude',
  defaultRoot: () => join(homedir(), '.claude', 'projects'),
  async *messages(root) {
    let projects
    try { projects = await readdir(root, { withFileTypes: true }) } catch { return }
    for (const p of projects.filter((d) => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const dir = join(root, p.name)
      let files
      try { files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort() } catch { continue }
      for (const f of files) {
        let text
        try { text = await readFile(join(dir, f), 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          const s = line.trim()
          if (!s) continue
          let ev
          try { ev = JSON.parse(s) } catch { continue }
          const m = ev && ev.message
          if (!m || typeof m !== 'object') continue
          const u = m.usage
          if (!u || typeof u !== 'object') continue
          yield {
            id: m.id || null,
            ts: ev.timestamp || ev.ts || null,
            input: Number(u.input_tokens) || 0,
            output: Number(u.output_tokens) || 0,
            cacheCreate: Number(u.cache_creation_input_tokens) || 0,
            cacheRead: Number(u.cache_read_input_tokens) || 0,
            file: join(p.name, f),
          }
        }
      }
    }
  },
}

/**
 * Pull local usage and slice it into the four windows of raw pillars.
 * Deterministic given (adapter output, now). Inject `now`/`root`/`adapter` for tests.
 * Returns { platform, root, generatedAt, files, totalMessages, windows:[{window,pillars,messages}] }.
 */
export async function tokenpull({ adapter = claudeAdapter, root, now } = {}) {
  const r = root || adapter.defaultRoot()
  const nowMs = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))

  // Dedup by message.id (first occurrence wins = billing-accurate). No-id messages
  // each get a unique synthetic key so they still count but never collapse together.
  const seen = new Map()
  const files = new Set()
  let noId = 0
  for await (const msg of adapter.messages(r)) {
    const key = msg.id || `__noid_${noId++}`
    if (!seen.has(key)) { seen.set(key, msg); if (msg.file) files.add(msg.file) }
  }
  const msgs = [...seen.values()]

  const windows = WINDOWS.map((w) => {
    const cutoff = w.days === Infinity ? -Infinity : nowMs - w.days * DAY_MS
    const inWin = msgs.filter((m) => {
      if (w.days === Infinity) return true
      const t = m.ts ? Date.parse(m.ts) : NaN
      return Number.isFinite(t) && t >= cutoff && t <= nowMs
    })
    const pillars = inWin.reduce(
      (a, m) => ({ input: a.input + m.input, output: a.output + m.output, cacheCreate: a.cacheCreate + m.cacheCreate, cacheRead: a.cacheRead + m.cacheRead }),
      { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    )
    return { window: w.key, pillars, messages: inWin.length }
  })

  return {
    platform: adapter.platform,
    root: r,
    generatedAt: new Date(nowMs).toISOString(),
    files: files.size,
    totalMessages: msgs.length,
    windows,
  }
}
