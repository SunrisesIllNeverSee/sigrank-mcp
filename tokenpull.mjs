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

/** Recursively yield every *.jsonl path under dir (any depth), sorted. Must be
 *  recursive: Claude Code stores sub-agent transcripts in `<project>/subagents/`
 *  (and other nested logs) — a 2-level readdir silently drops them, which badly
 *  under-counts input (sub-agent runs are input-heavy). token-dashboard's rglob. */
async function* _walkJsonl(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* _walkJsonl(full)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full
  }
}

/**
 * Claude Code adapter. Yields one record per billed assistant message:
 * { id, sid, ts, input, output, cacheCreate, cacheRead, file }. Walks
 * ~/.claude/projects RECURSIVELY (incl. subagents/) and carries sessionId so the
 * caller can dedup by (session_id, message_id) like token-dashboard.
 */
export const claudeAdapter = {
  platform: 'claude',
  defaultRoot: () => join(homedir(), '.claude', 'projects'),
  async *messages(root) {
    for await (const path of _walkJsonl(root)) {
      let text
      try { text = await readFile(path, 'utf8') } catch { continue }
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : path
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
          sid: ev.sessionId || null,
          ts: ev.timestamp || ev.ts || null,
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cacheCreate: Number(u.cache_creation_input_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0,
          file: rel,
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

  // Dedup by (session_id, message_id), keeping the FINAL snapshot — matches
  // token-dashboard: Claude Code writes 2-3 partial→final lines per response with
  // the same message.id; only the final tally matches billing. No-id records each
  // get a unique synthetic key so they always count.
  const seen = new Map()
  const files = new Set()
  let noId = 0
  for await (const msg of adapter.messages(r)) {
    const key = msg.sid && msg.id ? `${msg.sid}|${msg.id}` : (msg.id || `__noid_${noId++}`)
    seen.set(key, msg) // keep-last (final snapshot wins)
    if (msg.file) files.add(msg.file)
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
