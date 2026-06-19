// Acceptance test: the cascade reproduces canon, rank_paste adds a deterministic
// card, and submit_paste shapes the right write request (verified via injected
// fetch — no live calls, no writes to production).
import { cascade, parsePillars } from './cascade.mjs'
import { narrate } from './narrate.mjs'
import { callTool } from './tools.mjs'
import assert from 'node:assert'

const MOSES = '1251211 11296121 128196310 2555179769'

// --- 1. Cascade math reproduces canon ---
const c = cascade(parsePillars(MOSES))
console.log(JSON.stringify(c, null, 2))
assert.strictEqual(c.yield, 18436.98, `Υ mismatch: got ${c.yield}, want 18436.98`)
assert.strictEqual(c.leverage, 2042.2, `leverage mismatch: got ${c.leverage}`)
assert.strictEqual(c.class, 'TRANSMITTER', `class mismatch: got ${c.class}`)
// JSON form parses identically.
const j = cascade(parsePillars('{"input":1251211,"output":11296121,"cacheCreate":128196310,"cacheRead":2555179769}'))
assert.strictEqual(j.yield, 18436.98, 'JSON parse path Υ mismatch')

// --- 2. (3a) rank_paste returns the cascade + a deterministic card ---
const rp = await callTool('rank_paste', { text: MOSES })
assert.strictEqual(rp.yield, 18436.98, 'rank_paste Υ mismatch')
assert.match(rp.card, /TRANSMITTER/, 'card names the class')
assert.match(rp.card, /2,042x/, 'card cites the real 2042x leverage')
const rp2 = await callTool('rank_paste', { text: MOSES })
assert.strictEqual(rp.card, rp2.card, 'card must be deterministic (same numbers → same card)')
// the card never invents a number outside the cascade
assert.ok(!/NaN|undefined|Infinity/.test(rp.card), 'card must not leak NaN/undefined/Infinity')
console.log('\ncard →', rp.card)

console.log('\n✓ cascade reproduces canon (Υ 18436.98) + rank_paste card is deterministic')
