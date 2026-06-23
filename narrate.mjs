/**
 * narrate.mjs — deterministic prose "card" for a cascade result.
 *
 * Port of _template() from ~/Desktop/moses-sigrank/narrate.py. The model path
 * (MiniCPM4-0.5B) is intentionally SKIPPED: the template is the trustworthy,
 * instant, auditable fallback — same numbers in → same card out, and it can never
 * emit a metric the cascade didn't produce. A model hook can layer behind this same
 * narrate() interface later without a rewrite.
 *
 * Token-only. No network, no randomness.
 */

// Safe formatters: never emit NaN/Infinity/undefined into the card.
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : null)
const comma = (n, dec) => {
  const v = safeNum(n)
  return v !== null ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '—'
}
const plain = (n, dec) => {
  const v = safeNum(n)
  return v !== null ? v.toFixed(dec) : '—'
}

/**
 * Given a cascade result ({ velocity, leverage, dev10x, pillars, class }) and an
 * optional subject name, return "**CLASS.** <one or two sentences>". Deterministic.
 */
export function narrate(cascade, name = 'This operator') {
  const klass = cascade.class || cascade.klass || 'UNCLASSED'
  const v = safeNum(cascade.velocity)
  const l = safeNum(cascade.leverage)

  // "non-compounding" = a stateless pipe: no cache commits, so the cascade can't
  // form. cascade.mjs leaves dev10x null when cacheCreate is 0 (the cw/o term
  // collapses), which is exactly metrics.py's non_compounding flag.
  // Also catches zero-input sessions where velocity/leverage are null.
  const cw = cascade.pillars ? Number(cascade.pillars.cacheCreate) : NaN
  const nonCompounding = cascade.dev10x == null || !(cw > 0) || v === null || l === null

  let body
  if (nonCompounding) {
    const leverageStr = l !== null ? `Leverage ${comma(l, 1)}x comes from reuse alone.` : 'Leverage is undefined (no fresh input recorded).'
    const dev10xNote = cascade.dev10x == null ? ' 10xDEV is undefined — the compounding loop has not formed yet.' : ''
    body =
      `${name} runs a stateless pipe — no cache commits, so the cascade can't form. ` +
      `High read volume, but nothing is being built forward. ${leverageStr}${dev10xNote}`
  } else if (v >= 1 && l >= 100) {
    body =
      `${name} holds both axes at once: ${plain(v, 1)}x generation AND ${comma(l, 0)}x memory leverage. ` +
      `A closed kinetic loop — the rare operator the leverage/generation tradeoff says shouldn't exist.`
  } else if (l >= 10 && v < 1) {
    body =
      `${name} is an archival sponge — ${comma(l, 0)}x reuse but only ${plain(v, 2)}x generation. ` +
      `Holds context beautifully, executes little with it. The reuse number is inflated by a weak commitment stage.`
  } else if (v >= 0.8 && l < 2) {
    body =
      `${name} is a volatile ingestor — ${plain(v, 2)}x generation but ${plain(l, 1)}x leverage. ` +
      `Fast on single shots, resets between turns. Memory doesn't persist into a compounding loop.`
  } else {
    body =
      `${name} sits low on both axes: ${plain(v, 2)}x generation, ${plain(l, 1)}x leverage. ` +
      `A transient profile — neither building state nor converting input to output efficiently.`
  }
  return `**${klass}.** ${body}`
}
