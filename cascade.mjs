/**
 * cascade.mjs — pure SigRank yield cascade (no deps, no transport).
 * Mirrors sigrank-app/lib/ingest/bridge.ts computeCascadeMetrics() so rank_paste
 * reproduces the canonical MO§ES Υ 18436.98 from its 4 raw token pillars.
 * Paper-and-pencil math, open by design; proprietary threshold cuts stay server-side.
 */

export const round = (n, d) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null)

/** The four raw token pillars → the cascade. */
export function cascade({ input, output, cacheCreate, cacheRead }) {
  const i = Number(input), o = Number(output), cw = Number(cacheCreate), cr = Number(cacheRead)
  const total = i + o + cw + cr
  const snr = o / (i + o)                 // signal-to-noise (= app M.01 "compression")
  const velocity = o / i                  // output per fresh input
  const leverage = cr / i                 // cache-read leverage
  const yield_ = leverage * velocity      // Υ = (Cr·O)/I² — THE rank metric
  const dev10x = Math.log10((o / i) * (cw / o) * (cr / cw)) // = log10(Cr/I)
  return {
    pillars: { input: i, output: o, cacheCreate: cw, cacheRead: cr, total },
    yield: round(yield_, 2),
    snr: round(snr, 4),
    leverage: round(leverage, 1),
    velocity: round(velocity, 3),
    dev10x: round(dev10x, 2),
    class: classify(yield_, dev10x),
  }
}

/** MVP class tiering from Υ + 10xDEV (canon assigns from cascade SNR + 10xDEV; this
 *  is the open-MVP approximation — proprietary threshold cuts stay server-side). */
export function classify(yieldVal, dev10x) {
  if (yieldVal >= 1000 || dev10x >= 3) return 'TRANSMITTER'
  if (dev10x >= 1.45) return 'ARCH+'
  if (dev10x >= 1.35) return 'ARCH'
  if (dev10x >= 1.2) return 'POWER'
  if (dev10x >= 1.0) return 'BASE'
  if (dev10x >= 0) return 'SEEKER'
  if (dev10x >= -0.3) return 'REFINER'
  return 'IGNITER'
}

/** Extract the 4 pillars from pasted text: JSON object OR 4 whitespace numbers. */
export function parsePillars(text) {
  const t = String(text || '').trim()
  try {
    const j = JSON.parse(t)
    const g = (...keys) => { for (const k of keys) if (j[k] != null) return j[k]; return null }
    const input = g('input', 'tokens_input_fresh', 'inputTokens', 'input_tokens')
    const output = g('output', 'tokens_output', 'outputTokens', 'output_tokens')
    const cacheCreate = g('cacheCreate', 'tokens_cache_creation', 'cache_creation_tokens')
    const cacheRead = g('cacheRead', 'tokens_cache_read', 'cache_read_tokens')
    if ([input, output, cacheCreate, cacheRead].every((v) => v != null))
      return { input, output, cacheCreate, cacheRead }
  } catch { /* not JSON — fall through */ }
  const nums = (t.match(/\d[\d,]*\.?\d*/g) || []).map((s) => Number(s.replace(/,/g, '')))
  if (nums.length >= 4) {
    const [input, output, cacheCreate, cacheRead] = nums
    return { input, output, cacheCreate, cacheRead }
  }
  throw new Error('Could not parse 4 token pillars (input, output, cacheCreate, cacheRead) from the input.')
}
