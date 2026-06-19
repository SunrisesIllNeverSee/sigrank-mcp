// Acceptance test: rank_paste must reproduce the canonical MO§ES Υ from the 4 pillars.
import { cascade, parsePillars } from './cascade.mjs'
import assert from 'node:assert'

const MOSES = '1251211 11296121 128196310 2555179769'
const c = cascade(parsePillars(MOSES))
console.log(JSON.stringify(c, null, 2))
assert.strictEqual(c.yield, 18436.98, `Υ mismatch: got ${c.yield}, want 18436.98`)
assert.strictEqual(c.leverage, 2042.2, `leverage mismatch: got ${c.leverage}`)
assert.strictEqual(c.class, 'TRANSMITTER', `class mismatch: got ${c.class}`)
// JSON form parses identically.
const j = cascade(parsePillars('{"input":1251211,"output":11296121,"cacheCreate":128196310,"cacheRead":2555179769}'))
assert.strictEqual(j.yield, 18436.98, 'JSON parse path Υ mismatch')
console.log('\n✓ rank_paste reproduces canon: MO§ES Υ 18436.98 · lev 2042.2 · TRANSMITTER')
