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

const comma = (n, dec) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const plain = (n, dec) => Number(n).toFixed(dec)

/**
 * Given a cascade result ({ velocity, leverage, dev10x, pillars, class }) and an
 * optional subject name, return "**CLASS.** <one or two sentences>". Deterministic.
 */
export function narrate(cascade, name = 'This operator') {
  const klass = cascade.class || cascade.klass || 'UNCLASSED'
  const v = Number(cascade.velocity)
  const l = Number(cascade.leverage)

  // "non-compounding" = a stateless pipe: no cache commits, so the cascade can't
  // form. cascade.mjs leaves dev10x null when cacheCreate is 0 (the cw/o term
  // collapses), which is exactly metrics.py's non_compounding flag.
  const cw = cascade.pillars ? Number(cascade.pillars.cacheCreate) : NaN
  const nonCompounding = cascade.dev10x == null || !(cw > 0)

  let body
  if (nonCompounding) {
    body =
      `${name} runs a stateless pipe — no cache commits, so the cascade can't form. ` +
      `High read volume, but nothing is being built forward. Leverage ${comma(l, 1)}x comes from reuse alone.`
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
