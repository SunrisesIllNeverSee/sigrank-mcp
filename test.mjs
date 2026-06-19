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

// --- 3. (3b) submit_paste: no codename → local preview, NO submission ---
const noCode = await callTool('submit_paste', { text: MOSES })
assert.strictEqual(noCode.yield, 18436.98, 'submit_paste preview Υ mismatch')
assert.match(noCode.card, /TRANSMITTER/, 'preview card present')
assert.strictEqual(noCode.submission.status, 'not_submitted', 'no codename must not submit')
assert.strictEqual(noCode.submission.reason, 'codename_required')

// --- 4. (3b) submit_paste with codename → POSTs {codename, raw_paste} to ingest-paste.
//     Verified with an INJECTED fetch — no live call, no write to production. ---
let captured = null
const fakeFetch = async (url, init) => {
  captured = { url, init }
  return { ok: true, status: 202, json: async () => ({ status: 'received', submission_id: 'paste_test', signa_rate: 96.4, class_tier: 'TRANSMITTER' }) }
}
const sub = await callTool('submit_paste', { text: MOSES, codename: 'TransVaultOrigin' }, { apiBase: 'http://test.local', fetchImpl: fakeFetch })
assert.ok(captured.url.endsWith('/api/v1/ingest-paste'), 'submits to /api/v1/ingest-paste')
assert.strictEqual(captured.init.method, 'POST')
const body = JSON.parse(captured.init.body)
assert.strictEqual(body.codename, 'TransVaultOrigin', 'codename forwarded')
assert.strictEqual(body.raw_paste, MOSES, 'RAW paste forwarded (server re-scores authoritatively)')
assert.strictEqual(sub.yield, 18436.98, 'local preview Υ still returned alongside submission')
assert.strictEqual(sub.submission.httpStatus, 202, 'server ack status surfaced')
assert.strictEqual(sub.submission.status, 'received', 'server ack body merged')

console.log('\n✓ cascade canon (Υ 18436.98) · rank_paste card deterministic · submit_paste round-trip (injected fetch, no live write)')
