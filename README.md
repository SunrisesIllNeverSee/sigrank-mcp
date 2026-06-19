# SigRank MCP server

Exposes SigRank as MCP tools any agent (Claude Code, Cursor, …) can call — turning the
leaderboard into a tool every agent can invoke (distribution moat). Token-only, no auth,
no transcript content.

## Tools
| tool | what |
|---|---|
| `rank_paste(text)` | paste ccusage token counts → **Υ Yield / SNR / Leverage / Velocity / 10xDEV + class**. Accepts JSON `{input,output,cacheCreate,cacheRead}` or 4 whitespace numbers in that order. |
| `get_leaderboard()` | the live public board (signalaf.com) |
| `get_operator(codename)` | one operator's live profile |

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
{ "mcpServers": { "sigrank": { "command": "node", "args": ["/abs/path/sigrank-mcp/index.mjs"] } } }
```
`SIGRANK_API_BASE` overrides the board host (default `https://signalaf.com`).

## Status (MVP)
- ✅ cascade math verified (`rank_paste` → canon Υ). `cascade.mjs` is the testable core.
- ⏳ **Runtime smoke pending** (built under context limit): `npm install` + a live MCP-client
  `tools/list` + `rank_paste` round-trip. The SDK wiring is the standard stdio pattern.
- Next: convert non-ccusage readers (canon: Claude first), richer class tiering from the
  server-side ruleset, optional `compare(a,b)` tool.
