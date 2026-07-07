/**
 * badges.mjs — pure badge computation for the Cascade Report System.
 *
 * 8 launch badges. Pure functions — take history + current pillars, return
 * badge collection + progress. No deps, no transport, no network.
 *
 * Badge types:
 *   Permanent — once earned, always earned (First Spark, Cascade Engine, etc.)
 *   Current   — must be maintained (Cascade Streak, Top 10)
 *
 * Badge states:
 *   earned     — condition met, badge is in the collection
 *   in_progress — condition not yet met, but progress is trackable
 *   locked     — condition not met, no progress to show (not returned)
 */

/**
 * Compute all 8 launch badges.
 *
 * @param {object} params
 * @param {object} params.pillars — current { input, output, cacheCreate, cacheRead }
 * @param {object} params.cascade — current cascade result (from cascade())
 * @param {array}  params.history — array of daily snapshots { date, mode, yield, pillars }
 * @param {boolean} params.isVerified — whether the operator submitted via signed agent
 * @param {number|null} params.rank — current leaderboard rank (null if not ranked)
 * @returns {object} { earned_this_week, in_progress, collection }
 */
export function computeBadges({ pillars, cascade: cas, history = [], isVerified = false, rank = null }) {
  const cr = Number(pillars?.cacheRead || 0)
  const i = Number(pillars?.input || 0)
  const leverage = cas?.leverage ?? (i > 0 ? cr / i : 0)

  const earned = []
  const inProgress = []
  const collection = []

  // 1. First Spark — cacheRead > input (1× leverage)
  if (leverage > 1) {
    earned.push({ id: 'first_spark', label: 'First Spark', icon: '◈', condition: '1× cache leverage', date_earned: _latestDate(history) })
    collection.push('first_spark')
  } else if (cr > 0) {
    inProgress.push({ id: 'first_spark', label: 'First Spark', icon: '◈', progress: Math.min(leverage, 1), target: 1, display: `${leverage.toFixed(1)}× / 1×` })
  }

  // 2. Cascade Engine — cacheRead > 10× input
  if (leverage > 10) {
    earned.push({ id: 'cascade_engine', label: 'Cascade Engine', icon: '⚡', condition: '10× cache leverage', date_earned: _latestDate(history) })
    collection.push('cascade_engine')
  } else if (leverage > 1) {
    inProgress.push({ id: 'cascade_engine', label: 'Cascade Engine', icon: '⚡', progress: Math.min(leverage, 10), target: 10, display: `${leverage.toFixed(1)}× / 10×` })
  }

  // 3. Chain Reaction — cacheRead > 100× input
  if (leverage > 100) {
    earned.push({ id: 'chain_reaction', label: 'Chain Reaction', icon: '⚡', condition: '100× cache leverage', date_earned: _latestDate(history) })
    collection.push('chain_reaction')
  } else if (leverage > 10) {
    inProgress.push({ id: 'chain_reaction', label: 'Chain Reaction', icon: '⚡', progress: Math.min(leverage, 100), target: 100, display: `${leverage.toFixed(1)}× / 100×` })
  }

  // 4. Foundation — 3 completed BUILD→MAINTAIN arcs
  const arcs = _countBuildMaintainArcs(history)
  if (arcs >= 3) {
    earned.push({ id: 'foundation', label: 'Foundation', icon: '🏗️', condition: '3 BUILD→MAINTAIN arcs', date_earned: _latestDate(history) })
    collection.push('foundation')
  } else {
    inProgress.push({ id: 'foundation', label: 'Foundation', icon: '🏗️', progress: arcs, target: 3, display: `${arcs}/3 arcs` })
  }

  // 5. Phoenix — returned to MAINTAIN within 1 day of disruption, 5×
  const phoenixCount = _countPhoenixReturns(history)
  if (phoenixCount >= 5) {
    earned.push({ id: 'phoenix', label: 'Phoenix', icon: '🔥', condition: '5× MAINTAIN recovery within 1 day', date_earned: _latestDate(history) })
    collection.push('phoenix')
  } else {
    inProgress.push({ id: 'phoenix', label: 'Phoenix', icon: '🔥', progress: phoenixCount, target: 5, display: `${phoenixCount}/5 recoveries` })
  }

  // 6. Verified — submitted via signed agent
  if (isVerified) {
    earned.push({ id: 'verified', label: 'Verified', icon: '✓', condition: 'Submitted via signed agent', date_earned: _latestDate(history) })
    collection.push('verified')
  }
  // No in-progress for verified — it's binary

  // 7. Cascade Streak 🔥 — 7 consecutive days MAINTAIN (current badge)
  const streak = _countMaintainStreak(history)
  if (streak >= 7) {
    earned.push({ id: 'cascade_streak', label: 'Cascade Streak', icon: '🔥', condition: '7 consecutive days MAINTAIN', date_earned: _latestDate(history), current: true })
    collection.push('cascade_streak')
  } else {
    inProgress.push({ id: 'cascade_streak', label: 'Cascade Streak', icon: '🔥', progress: streak, target: 7, display: `${streak}/7 days` })
  }

  // 8. Top 10 🏆 — currently in top 10 (server-side, but we include it if rank is provided)
  if (rank !== null && rank <= 10) {
    earned.push({ id: 'top_10', label: 'Top 10', icon: '🏆', condition: `Currently #${rank}`, date_earned: _latestDate(history), current: true })
    collection.push('top_10')
  }
  // No in-progress for top 10 — it's a live position, not a progress badge

  return {
    earned_this_week: earned.map(b => b.id),
    in_progress: inProgress,
    collection,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _latestDate(history) {
  if (!history || history.length === 0) return null
  return history[history.length - 1]?.date || null
}

/**
 * Count completed BUILD→MAINTAIN arcs in history.
 * An arc = a BUILD phase followed by a MAINTAIN phase.
 */
function _countBuildMaintainArcs(history) {
  if (!history || history.length < 2) return 0
  let arcs = 0
  let wasBuild = false
  for (const h of history) {
    if (h.mode === 'BUILD') {
      wasBuild = true
    } else if (h.mode === 'MAINTAIN' && wasBuild) {
      arcs++
      wasBuild = false
    }
  }
  return arcs
}

/**
 * Count Phoenix returns — MAINTAIN within 1 day of a non-MAINTAIN day.
 */
function _countPhoenixReturns(history) {
  if (!history || history.length < 2) return 0
  let count = 0
  for (let idx = 1; idx < history.length; idx++) {
    if (history[idx].mode === 'MAINTAIN' && history[idx - 1].mode !== 'MAINTAIN') {
      count++
    }
  }
  return count
}

/**
 * Count current consecutive MAINTAIN days (ending at the last entry).
 */
function _countMaintainStreak(history) {
  if (!history || history.length === 0) return 0
  let streak = 0
  for (let idx = history.length - 1; idx >= 0; idx--) {
    if (history[idx].mode === 'MAINTAIN') {
      streak++
    } else {
      break
    }
  }
  return streak
}
