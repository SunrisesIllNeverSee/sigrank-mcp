---
type: Reference
title: SigRank MCP server
description: The SigRank MCP — exposes the leaderboard as tools any agent can call (rank_paste, get_leaderboard, get_operator, submit_paste, tokenpull, tokenpull_submit). tokenpull is the zero-paste on-device reader (4-window cascade, verified vs token-dashboard). Token-only, read-only, no transcript content. Cascade math mirrors lib/ingest/bridge.ts; proprietary threshold cuts stay server-side.
tags: [sigrank, mcp, tokenpull, agent, ingest, reference]
timestamp: 2026-06-23
---

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
| `tokenpull(platform?)` | **in-house local reader** (no ccusage/tokscale): scans local logs → the 4 windows (7d/30d/90d/all) each cascaded. **Claude** (native, recursive incl. `subagents/`, dedup `(session,message)` keep-final, verified vs token-dashboard) + **Codex** (reads `~/.codex/sessions`, estimated via `io_ratio` — Beta from the operator's Claude ratio, else Alpha 2.0; verified vs `ccusage codex`). Zero paste, on-device, token-only. |
| `tokenpull_submit(codename, window?)` | **the zero-paste flow**: `tokenpull` → publish each window's canonical pillars to the board (server re-scores), tagged with `platform`. `codename` required to publish; omit for preview. |

The cascade math (`cascade.mjs`) mirrors `sigrank-app/lib/ingest/bridge.ts` — Υ = (Cr·O)/I².
Open by design; the proprietary threshold cuts / weights stay server-side.

## Privacy
- **Token-only, always.** No message content is ever read, logged, or transmitted — only token counts (`input`, `output`, `cache_creation`, `cache_read`), message IDs, and timestamps.
- **Local by default.** `tokenpull` and `tokenpull_submit` read only `~/.claude/projects` (Claude) or `~/.codex` (Codex) on your device. The numbers stay on your machine unless you explicitly call `_submit` with a codename.
- **Background tooling excluded.** Memory plugins, observers, and summarizers (e.g. `claude-mem`, `mem0`, `observer-sessions`) are filtered out of both Claude and Codex reads. `subagents/` are kept — they represent real operator work. The filter list is in `EXCLUDE_TOOLING` in `tokenpull.mjs` and is extensible.
- **No auth required.** All board reads and the web-paste submit path are anonymous. No credentials are stored or transmitted.
- **Content hash per upload.** Every `_submit` call attaches a SHA-256 hash of the pillar payload + a `ddmmyy` datestamp. No personal identifiers beyond the operator-chosen codename.

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
- ✅ **tokenpull** (`tokenpull.mjs`): in-house local usage reader (Claude + Codex). Recursive scan
  (incl. `subagents/`), dedup by `(session_id, message_id)` keep-final, 4-window cascade.
  **Verified against token-dashboard (nateherkai): 7d input 3.44M EXACT match** (~1208 files).
  Bug fixed: a 2-level readdir was dropping sub-agent transcripts → 4× input under-count.
- ✅ **Hardened** (2026-06-23): div-by-zero guards in cascade, `_parseWarnings` on suspicious input,
  AbortController fetch timeout (10s, env-overridable), symlink-safe `_walkJsonl` with MAX_JSONL_FILES
  cap, `EXCLUDE_TOOLING` applied to Codex, uncaughtException/unhandledRejection handlers.

## Multi-model adapter support
All adapters are token-only (no message content, no cost fields, no credentials). Numbers are
refined as data accumulates — SigRank is continuously improving methods as more operator data arrives.

| Platform | Path | Notes |
|---|---|---|
| Claude Code | ✅ `~/.claude/projects` | native, verified; dedup by `(session_id, message_id)` |
| Codex | ✅ `~/.codex/sessions` | estimated via `io_ratio`; verified vs `ccusage codex` |
| Amp | ✅ `~/.local/share/amp/threads` | full 4-pillar; per-message |
| Kimi | ✅ `~/.kimi/sessions` | full 4-pillar; `StatusUpdate` lines only |
| pi-agent | ✅ `~/.pi/agent/sessions` | full 4-pillar; per-message JSONL |
| OpenClaw | ✅ `~/.openclaw` (+ `.clawdbot`, `.moltbot`, `.moldbot`) | full 4-pillar; per-message JSONL |
| Droid | ✅ `~/.factory/sessions/*.settings.json` | full 4-pillar; per-session JSON; thinking→output |
| Codebuff | ✅ `~/.config/manicode` | full 4-pillar; `chat-messages.json` |
| Hermes | ✅ `~/.hermes/state.db` | full 4-pillar; SQLite; reasoning→output |
| Kilo | ✅ `~/.local/share/kilo/kilo.db` | full 4-pillar; SQLite |
| Qwen | ✅ `~/.qwen/projects` | cacheCreate=0 (`estimated`); no create field in logs; thought→output |
| Goose | ✅ `~/.local/share/goose/sessions/sessions.db` | cacheCreate=cacheRead=0 (`estimated`); SQLite |
| Gemini CLI | ✅ `~/.gemini/tmp` | cacheCreate=0 (`estimated`); cache extracted from input field |
| GitHub Copilot CLI | ✅ `~/.copilot/otel` | OTel JSONL; requires `COPILOT_OTEL_ENABLED=true` before session |
| OpenCode | ⚠️ `~/.local/share/opencode` | `dataGap`: raw token counts not persisted in log format |
| Cursor | 🔜 | chat log path TBD; token usage varies by plan |
| Windsurf | 🔜 | session logs at `~/.codeium/windsurf/` |

`estimated=true` means `cacheCreate` is unavailable — the other 3 pillars are native. The server
re-scores all submitted pillars authoritatively; local preview Υ is indicative only.
