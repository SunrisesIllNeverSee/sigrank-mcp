# SigRank MCP server

Exposes SigRank as MCP tools any agent (Claude Code, Cursor, …) can call — turning the
leaderboard into a tool every agent can invoke (distribution moat). Token-only, no auth,
no transcript content.

## Tools
| tool | what |
|---|---|
| `rank_paste(text)` | paste ccusage token counts → **Υ Yield / SNR / Leverage / Velocity / 10xDEV + class + a deterministic prose `card`**. Accepts JSON `{input,output,cacheCreate,cacheRead}` or 4 whitespace numbers in that order. |
| `get_leaderboard()` | the live public board (signalaf.com) |
| `get_operator(codename)` | one operator's live profile |
| `submit_paste(text, codename)` | **rank AND publish** in one call: local cascade + card, then POSTs the raw paste to the board's web-paste endpoint (server re-scores authoritatively). `codename` required to publish; omit for preview-only. |

The cascade math (`cascade.mjs`) mirrors `sigrank-app/lib/ingest/bridge.ts` — Υ = (Cr·O)/I².
Open by design; the proprietary threshold cuts / weights stay server-side.

## Verified
`node test.mjs` → `rank_paste` reproduces canon: **MO§ES `1251211 11296121 128196310 2555179769`
→ Υ 18436.98 · lev 2042.2 · TRANSMITTER.** ✅ (math is dependency-free, runs without install.)

## Run
```bash
npm install            # installs @modelcontextprotocol/sdk
node index.mjs         # stdio MCP server
```
Add to an MCP client (e.g. Claude Code `.mcp.json`):
```json
{ "mcpServers": { "sigrank": { "command": "node", "args": ["/Users/dericmchenry/Desktop/SigRank/sigrank-mcp/index.mjs"] } } }
```
`SIGRANK_API_BASE` overrides the board host (default `https://signalaf.com`).

## Status (MVP)
- ✅ cascade math verified (`rank_paste` → canon Υ). `cascade.mjs` is the testable core.
- ✅ **Runtime smoke PASS** (2026-06-19): `npm install` (0 vuln) + live MCP-client `tools/list`
  + `rank_paste` round-trip + `get_leaderboard`/`get_operator` HTTP 200 against signalaf.com.
- ✅ **3a insight card** (`narrate.mjs`): `rank_paste` returns a deterministic prose `card`
  ported from `moses-sigrank/narrate.py` `_template` (model path skipped on purpose).
- ✅ **3b `submit_paste`** (first write op): ranks locally then POSTs the raw paste to the
  existing anonymous `/api/v1/ingest-paste` (web-paste path — `source='web_paste'`, no auth).
  Verified via injected fetch (no live write). ⚠️ The **first live submit writes production
  Supabase** — fire it once yourself: `SIGRANK_API_BASE=https://signalaf.com` + a real paste.
- Next: convert non-ccusage readers (canon: Claude first), richer class tiering from the
  server-side ruleset, optional `compare(a,b)` tool.
