/**
 * badges.test.mjs — tests for all 8 launch badge computations.
 *
 * Tests earn conditions, progress tracking, and the collection structure.
 */
import { computeBadges } from '../badges.mjs'
import { cascade } from '../cascade.mjs'
import assert from 'node:assert'

// Helper: build a history array of daily snapshots
function makeHistory(modes) {
  return modes.map((mode, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    mode,
    yield: mode === 'MAINTAIN' ? 5000 : mode === 'BUILD' ? 15 : mode === 'EDIT' ? 45 : 10,
    pillars: { input: 1000, output: 1000, cacheCreate: 1000, cacheRead: mode === 'MAINTAIN' ? 100000 : 0 },
  }))
}

// ── 1. First Spark — 1× leverage ────────────────────────────────────────────
{
  const pillars = { input: 1000, output: 500, cacheCreate: 100, cacheRead: 1500 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false })
  // leverage = 1500/1000 = 1.5 > 1
  assert.ok(r.collection.includes('first_spark'), 'First Spark earned at 1× leverage')
}
{
  const pillars = { input: 1000, output: 500, cacheCreate: 100, cacheRead: 500 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false })
  // leverage = 500/1000 = 0.5 < 1
  assert.ok(!r.collection.includes('first_spark'), 'First Spark not earned below 1×')
  const progress = r.in_progress.find(b => b.id === 'first_spark')
  assert.ok(progress, 'First Spark in progress')
}

// ── 2. Cascade Engine — 10× leverage ────────────────────────────────────────
{
  const pillars = { input: 1000, output: 2000, cacheCreate: 500, cacheRead: 15000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false })
  // leverage = 15000/1000 = 15 > 10
  assert.ok(r.collection.includes('cascade_engine'), 'Cascade Engine earned at 10× leverage')
  assert.ok(r.collection.includes('first_spark'), 'First Spark also earned')
}

// ── 3. Chain Reaction — 100× leverage ───────────────────────────────────────
{
  const pillars = { input: 1000, output: 2000, cacheCreate: 500, cacheRead: 150000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false })
  // leverage = 150000/1000 = 150 > 100
  assert.ok(r.collection.includes('chain_reaction'), 'Chain Reaction earned at 100× leverage')
  assert.ok(r.collection.includes('cascade_engine'), 'Cascade Engine also earned')
}

// ── 4. Foundation — 3 BUILD→MAINTAIN arcs ───────────────────────────────────
{
  // BUILD, MAINTAIN, BUILD, MAINTAIN, BUILD, MAINTAIN = 3 arcs
  const history = makeHistory(['BUILD', 'MAINTAIN', 'BUILD', 'MAINTAIN', 'BUILD', 'MAINTAIN'])
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history, isVerified: false })
  assert.ok(r.collection.includes('foundation'), 'Foundation earned with 3 BUILD→MAINTAIN arcs')
}
{
  // Only 2 arcs
  const history = makeHistory(['BUILD', 'MAINTAIN', 'BUILD', 'MAINTAIN'])
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history, isVerified: false })
  assert.ok(!r.collection.includes('foundation'), 'Foundation not earned with 2 arcs')
  const progress = r.in_progress.find(b => b.id === 'foundation')
  assert.strictEqual(progress.progress, 2, 'Foundation progress = 2/3')
}

// ── 5. Phoenix — 5× MAINTAIN recovery within 1 day ──────────────────────────
{
  // 5 disruptions followed by MAINTAIN
  const history = makeHistory(['DEBUG', 'MAINTAIN', 'BUILD', 'MAINTAIN', 'DEBUG', 'MAINTAIN', 'BUILD', 'MAINTAIN', 'DEBUG', 'MAINTAIN'])
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history, isVerified: false })
  assert.ok(r.collection.includes('phoenix'), 'Phoenix earned with 5 recoveries')
}
{
  // Only 3 recoveries
  const history = makeHistory(['DEBUG', 'MAINTAIN', 'BUILD', 'MAINTAIN', 'DEBUG', 'MAINTAIN'])
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history, isVerified: false })
  assert.ok(!r.collection.includes('phoenix'), 'Phoenix not earned with 3 recoveries')
  const progress = r.in_progress.find(b => b.id === 'phoenix')
  assert.strictEqual(progress.progress, 3, 'Phoenix progress = 3/5')
}

// ── 6. Verified — submitted via signed agent ─────────────────────────────────
{
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: true })
  assert.ok(r.collection.includes('verified'), 'Verified badge earned when isVerified=true')
}
{
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false })
  assert.ok(!r.collection.includes('verified'), 'Verified badge not earned when isVerified=false')
}

// ── 7. Cascade Streak — 7 consecutive MAINTAIN days ─────────────────────────
{
  const history = makeHistory(['MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN'])
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history, isVerified: false })
  assert.ok(r.collection.includes('cascade_streak'), 'Cascade Streak earned with 7 consecutive MAINTAIN')
}
{
  // 6 consecutive + 1 DEBUG at the end
  const history = makeHistory(['MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'MAINTAIN', 'DEBUG'])
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history, isVerified: false })
  assert.ok(!r.collection.includes('cascade_streak'), 'Cascade Streak broken by DEBUG at end')
  const progress = r.in_progress.find(b => b.id === 'cascade_streak')
  assert.strictEqual(progress.progress, 0, 'Streak resets to 0 when last day is not MAINTAIN')
}

// ── 8. Top 10 — currently in top 10 ─────────────────────────────────────────
{
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false, rank: 5 })
  assert.ok(r.collection.includes('top_10'), 'Top 10 badge earned at rank 5')
}
{
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false, rank: 15 })
  assert.ok(!r.collection.includes('top_10'), 'Top 10 badge not earned at rank 15')
}
{
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false, rank: null })
  assert.ok(!r.collection.includes('top_10'), 'Top 10 badge not earned when rank is null')
}

// ── MO§ES: should earn First Spark, Cascade Engine, Chain Reaction ──────────
{
  const MOSES = { input: 1251211, output: 11296121, cacheCreate: 128196310, cacheRead: 2555179769 }
  const cas = cascade(MOSES)
  const r = computeBadges({ pillars: MOSES, cascade: cas, history: [], isVerified: true })
  assert.ok(r.collection.includes('first_spark'), 'MO§ES: First Spark (2042× leverage)')
  assert.ok(r.collection.includes('cascade_engine'), 'MO§ES: Cascade Engine')
  assert.ok(r.collection.includes('chain_reaction'), 'MO§ES: Chain Reaction')
  assert.ok(r.collection.includes('verified'), 'MO§ES: Verified')
}

// ── Return structure ─────────────────────────────────────────────────────────
{
  const pillars = { input: 1000, output: 1000, cacheCreate: 500, cacheRead: 10000 }
  const cas = cascade(pillars)
  const r = computeBadges({ pillars, cascade: cas, history: [], isVerified: false })
  assert.ok(Array.isArray(r.earned_this_week), 'earned_this_week is array')
  assert.ok(Array.isArray(r.in_progress), 'in_progress is array')
  assert.ok(Array.isArray(r.collection), 'collection is array')
  assert.ok(r.earned_this_week.every(id => typeof id === 'string'), 'earned_this_week contains IDs')
}

console.log('✓ badges: First Spark (1× leverage) — earn + progress')
console.log('✓ badges: Cascade Engine (10× leverage)')
console.log('✓ badges: Chain Reaction (100× leverage)')
console.log('✓ badges: Foundation (3 BUILD→MAINTAIN arcs) — earn + progress')
console.log('✓ badges: Phoenix (5× recovery) — earn + progress')
console.log('✓ badges: Verified (signed agent) — binary')
console.log('✓ badges: Cascade Streak (7 consecutive MAINTAIN) — earn + progress + reset')
console.log('✓ badges: Top 10 (rank ≤ 10) — binary, null-safe')
console.log('✓ badges: MO§ES earns First Spark + Cascade Engine + Chain Reaction + Verified')
console.log('✓ badges: return structure (earned_this_week, in_progress, collection)')
