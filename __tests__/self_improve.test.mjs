/**
 * self_improve.test.mjs — tests for self_improve with scope parameter.
 *
 * Tests daily/weekly/trend scopes, mode detection integration, and
 * backward compatibility (no scope = daily behavior).
 */
import { callTool } from '../tools.mjs'
import assert from 'node:assert'

const MOSES = '1251211 11296121 128196310 2555179769'

// ── Daily scope (default) ───────────────────────────────────────────────────
{
  const r = await callTool('self_improve', { text: MOSES, scope: 'daily' })
  assert.ok(r.mode, 'daily scope returns mode')
  assert.strictEqual(r.mode.mode, 'MAINTAIN', 'MO§ES daily mode = MAINTAIN')
  assert.strictEqual(r.mode.confidence, 0.9, 'MO§ES daily mode confidence')
  assert.ok(typeof r.quality_score === 'number', 'daily scope returns quality_score')
  assert.ok(r.assessment, 'daily scope returns assessment')
  assert.ok(r.advice, 'daily scope returns advice')
  assert.ok(r.current_cascade.mode, 'daily scope includes mode in current_cascade')
  // Existing behavior preserved
  assert.strictEqual(r.current_cascade.yield_, 18436.98, 'daily yield still correct')
  assert.ok(Array.isArray(r.diagnosis), 'daily scope still returns diagnosis')
  assert.ok(Array.isArray(r.suggestions), 'daily scope still returns suggestions')
  assert.ok(r.cycle_summary, 'daily scope still returns cycle_summary')
}

// ── No scope = daily (backward compatible) ──────────────────────────────────
{
  const r = await callTool('self_improve', { text: MOSES })
  assert.ok(r.mode, 'no scope returns mode (default daily)')
  assert.strictEqual(r.mode.mode, 'MAINTAIN', 'no scope mode = MAINTAIN')
  assert.ok(r.quality_score, 'no scope returns quality_score')
  assert.ok(r.assessment, 'no scope returns assessment')
}

// ── Weekly scope ────────────────────────────────────────────────────────────
{
  const r = await callTool('self_improve', { text: MOSES, scope: 'weekly' })
  assert.ok(r.mode, 'weekly scope returns mode')
  assert.ok(r.report, 'weekly scope returns report artifact')
  assert.ok(r.report.current_mode, 'report has current_mode')
  assert.ok(r.report.mode_distribution, 'report has mode_distribution')
  assert.ok(typeof r.report.mode_weighted_yield === 'number', 'report has mode_weighted_yield')
  assert.ok(typeof r.report.peak_yield === 'number', 'report has peak_yield')
  assert.ok(typeof r.report.health_score === 'number', 'report has health_score')
  assert.ok(Array.isArray(r.report.weekly_snapshots), 'report has weekly_snapshots')
  assert.ok(r.report.badges, 'report has badges')
  assert.ok(r.report.badges.earned_this_week, 'report badges has earned_this_week')
  assert.ok(r.report.badges.in_progress, 'report badges has in_progress')
  assert.ok(r.report.badges.collection, 'report badges has collection')
  // Existing behavior preserved
  assert.strictEqual(r.current_cascade.yield_, 18436.98, 'weekly yield still correct')
  assert.ok(Array.isArray(r.suggestions), 'weekly scope still returns suggestions')
}

// ── Trend scope ─────────────────────────────────────────────────────────────
{
  const r = await callTool('self_improve', { text: MOSES, scope: 'trend' })
  assert.ok(r.mode, 'trend scope returns mode')
  assert.ok(r.trend, 'trend scope returns trend object')
  assert.ok(typeof r.trend.yield_7d === 'number', 'trend has yield_7d')
  assert.ok(typeof r.trend.yield_30d === 'number', 'trend has yield_30d')
  assert.ok(typeof r.trend.yield_90d === 'number', 'trend has yield_90d')
  assert.ok(r.trend.trajectory, 'trend has trajectory')
  assert.ok(r.trend.mode_distribution, 'trend has mode_distribution')
  assert.ok(r.trend.phase_pattern, 'trend has phase_pattern')
  // Existing behavior preserved
  assert.strictEqual(r.current_cascade.yield_, 18436.98, 'trend yield still correct')
}

// ── Mode detection for different pillar profiles ────────────────────────────
{
  // DEBUG profile: high input, low output, no cache
  const r = await callTool('self_improve', { text: '10000 100 0 0', scope: 'daily' })
  assert.strictEqual(r.mode.mode, 'DEBUG', 'high input + low output → DEBUG')
  assert.ok(r.quality_score < 1, 'DEBUG quality score < 1 (low yield vs expected)')
}
{
  // IDLE profile: near-zero tokens
  const r = await callTool('self_improve', { text: '100 100 100 100', scope: 'daily' })
  assert.strictEqual(r.mode.mode, 'IDLE', 'near-zero tokens → IDLE')
}

// ── Privacy boundary: daily modes not in weekly report ─────────────────────
{
  const r = await callTool('self_improve', { text: MOSES, scope: 'weekly' })
  // The report should NOT contain daily_modes — only weekly distribution
  const reportJson = JSON.stringify(r.report)
  assert.ok(!reportJson.includes('dailyModes'), 'weekly report does not leak daily modes')
  assert.ok(!reportJson.includes('"daily_modes"'), 'weekly report does not leak daily_modes (snake_case)')
}

console.log('✓ self_improve daily: mode + quality_score + assessment + advice')
console.log('✓ self_improve no scope = daily (backward compatible)')
console.log('✓ self_improve weekly: report artifact with badges + health_score + mode_distribution')
console.log('✓ self_improve trend: yield_7d/30d/90d + trajectory + phase_pattern')
console.log('✓ self_improve mode detection: DEBUG (high input/low output), IDLE (near-zero)')
console.log('✓ self_improve privacy: daily modes not leaked in weekly report')
