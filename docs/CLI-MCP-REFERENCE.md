# CLI and MCP reference

[← Start with the quickstart](../README.md)

Tool inputs, adapter limitations, token sources, and the submission privacy contract. Use the client’s tool listing for the current input schemas.

## Commands

```

Default (no args)
  sigrank              unified dashboard: cascade + token pillars + board

Commands
  enroll                   sign in: paste a connect code (get one at signalaf.com → Settings)
  submit                   publish your verified runs to the board (sign in first)
  board                    live leaderboard (refreshes every 30s)
  board --window 7d        board for a specific window (7d, 30d, 90d, all)
  board --once             print once and exit
  compare                  raw pillar audit: tokenpull vs ccusage vs token-dash vs tokscale
  compare --platform codex compare for a specific platform
  tui                      full tabbed TUI: Dashboard / Trends / Compare / Board / Watch / Connect
  tui --platform codex     TUI with a different default platform
  watch                    live tune meter — ALL active platforms × all windows, every 30s
  watch --platform codex   watch only one platform (optional filter)
  watch --window 7d        watch only one window (optional filter)
  proxy                    opt-in local Anthropic/OpenAI usage proxy
  proxy --port 9000        run the proxy on a custom loopback port

Options
  --window    7d · 30d · 90d · all  (default: 30d for board; all windows for watch)
  --platform  claude · codex · amp · gemini · opencode · goose · …
  --refresh   poll interval in seconds (default: 30)
  --once      print once and exit (board only)
  --port      proxy port (default: 8787)

For AI clients (not typeable)
  In a piped/non-TTY context, sigrank is an MCP stdio server.
  AI clients (Claude, Cursor, …) call its tools automatically — these are
  NOT shell commands. Humans use the commands above.

Examples
  sigrank                        # unified dashboard
  sigrank board                  # live leaderboard
  sigrank compare                # pillar audit (claude)
  sigrank compare --platform codex
  sigrank watch --window 7d --refresh 60
  sigrank board --window all --once
```

### Optional API usage proxy

Some desktop coding agents receive provider usage in API responses but do not
persist it in their local session files. SigRank SignalAF can capture those
provider-reported counts through a manually started loopback proxy:

```bash
sigrank proxy              # http://localhost:8787
sigrank proxy --port 9000  # custom port
```

Then point a compatible tool's API base URL at the displayed local URL. The
first release supports Anthropic Messages (`/v1/messages`), OpenAI Chat
Completions (`/v1/chat/completions`), and OpenAI Responses (`/v1/responses`).
The tool must support a custom API base URL; this is not guaranteed for every
desktop client.

The proxy is **off by default**: it opens no port and observes no traffic unless
you explicitly run `sigrank proxy`. It binds only to loopback and stops when the
command exits. Request and response content, API keys, and tool calls are
forwarded transiently but never written to disk. Only usage metadata is appended
to `~/.sigrank-mcp/proxy-sessions.jsonl` (directory `0700`, file `0600`).

Anthropic and OpenAI calls are currently grouped under one `proxy` platform row.
For streamed Chat Completions, SigRank SignalAF sets OpenAI's
`stream_options.include_usage=true` so the provider includes the final usage
chunk; response chunks are still forwarded immediately.

### The TUI is the whole app

Launch it and sign in inside it:

```
npx sigrank
```

Six tabs. Keys: `1`-`6` or `←` `→` to switch · `R` refresh · `Q` quit.

| Tab           | Key | Content                                                                                                                              |
| ------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Dashboard** | `1` | Cascade table (all platforms × windows + combined) · Υ sparklines · token composition bars · mini board                              |
| **Trends**    | `2` | Every metric across windows — sub-views: You / Platform / Field                                                                      |
| **Compare**   | `3` | 4-source pillar audit (tokenpull vs ccusage vs token-dash vs tokscale) · delta % · cascade metrics per source · cache read bar chart |
| **Board**     | `4` | Full leaderboard with all fields · `[W]` cycles window (7d/30d/90d/all)                                                              |
| **Watch**     | `5` | In-TUI landing panel · `[Enter]` launches the live watcher (big numbers + pillar bars + Υ trend, auto-refreshes 30s)                 |
| **Connect**   | `6` | Sign in / switch device — paste a connect code from signalaf.com → Settings. Then `[S]` submits.                                     |

### Sign in + submit

```bash
sigrank enroll          # sign in: paste a connect code (get one at signalaf.com → Settings)
sigrank submit          # publish your verified runs to the board (sign in first)
sigrank submit --dry-run  # inspect the exact signed payload without sending anything
```

Or do it inside the TUI on the **Connect** tab (`6`), then press `[S]` to submit.

---

## Tools

| Tool                                  | Args                                                                             | What                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rank_paste(text)`                    | `{input, output, cacheCreate, cacheRead}` JSON or 4 whitespace-delimited numbers | Scores token pillars → Υ Yield / SNR / Leverage / Velocity / 10xDEV / Class + prose narration card                                                                         |
| `get_leaderboard()`                   | `{window?}`                                                                      | Live board from signalaf.com — sorted by Υ Yield                                                                                                                           |
| `get_operator(codename)`              | `{codename}`                                                                     | One operator's live profile                                                                                                                                                |
| `submit_paste(text, codename)`        | `{text, codename?}`                                                              | Rank locally then POST to board. Omit codename for preview-only                                                                                                            |
| `tokenpull(platform?)`                | `{platform?}`                                                                    | On-device local reader: scans local logs → 4-window cascade. Zero paste, token-only                                                                                        |
| `tokenpull_submit(codename, window?)` | `{codename?, window?}`                                                           | `tokenpull` → publish to board. Omit codename for preview                                                                                                                  |
| `tokenpull_compare(platform?)`        | `{platform?}`                                                                    | All four sources side-by-side: tokenpull + ccusage + token-dash + tokscale. Returns pillars, cascade metrics, and delta % vs tokenpull per window                          |
| `rank_windows`                        | `{platform?, window?}`                                                           | Multi-window cascade from local logs                                                                                                                                       |
| `get_sigrank_standard_record`         | `{input, output, cache_write?, cache_read?}`                                     | Builds the portable `sigrank/0.1-draft` compatibility record (legacy alias under TTEOP authority) — canonical cascade, computed locally                                   |
| `discover_peers`                      | `{codename?}`                                                                    | Find mentors, peers, and complementary operators on the leaderboard                                                                                                        |
| `watch_tokenpull`                     | `{platform?, interval_s?}`                                                       | One cascade snapshot per call (interval_s advisory)                                                                                                                        |
| `submit_verified`                     | `{window?, platform?, dry_run?}`                                                 | THE ranked path: builds + ed25519-signs Schema 1.0 snapshots and POSTs them. `platform:'multi'` sums all active platforms. `dry_run:true` returns the exact payload unsent |
| `enroll`                              | `{code, device_label?}`                                                          | Bind this device with a connect code from signalaf.com → Settings                                                                                                          |
| `diagnose_cascade`                    | `{text?}`                                                                        | Diagnoses where your token cascade is leaking efficiency — ranked findings with severity + estimated Υ impact                                                              |
| `simulate_change`                     | `{text?, changes}`                                                               | Prescriptive "what if" — test proposed pillar changes and see the exact Υ delta + class change before committing                                                           |
| `suggest_improvements`                | `{text?}`                                                                        | Generates ranked, simulated improvement suggestions — tests strategies and returns them sorted by Υ yield impact                                                           |
| `self_improve`                        | `{text?}`                                                                        | One-click optimize: diagnoses, suggests, and simulates the best change in a single call                                                                                    |
| `tokscale_breakdown(threshold?)`       | `{threshold?}`                                                                   | Per-model token breakdown across platforms (models under threshold → "other")                                                                                              |
| `tokscale_market_share()`              | `{}`                                                                             | AI tool market share: each tool's % of tokens/cost/messages, ranked. From local tokscale data                                                                              |
| `tokscale_developer_profile()`         | `{}`                                                                             | Per-developer usage profile across all detected tools: model mix, pillars, sessions, workspace count (no names). Paths redacted                             |
| `tokscale_model_trends()`              | `{}`                                                                             | Model adoption over time: per-model first/last seen, active days, month-by-month adoption curve                                                                            |
| `tokscale_cost_analysis()`             | `{}`                                                                             | Cost per developer per model: cost_per_million_tokens, cost_per_message, share_cost, client rollup                                                                        |
| `tokscale_device_profile()`            | `{}`                                                                             | Device fingerprinting: installed tools, session counts, active days, day-of-week distribution, concurrency. Paths redacted                  |
| `tokscale_mcp_usage()`                 | `{}`                                                                             | MCP server usage: detected servers, detection window, active days                                                                                                         |
| `tokscale_competitive_intel(target)`   | `{target}`                                                                       | Competitive intelligence for any AI tool: rank, model mix, cost efficiency, share vs all competitors                                                                      |

Intent tools (`get_best_operator`, `compare_self`, `compare_operators`, `describe_power_user`, `optimize_efficiency`) moved to [bestuser-router-mcp](https://github.com/SunrisesIllNeverSee/bestuser-router-mcp) — `npx bestuser-router-mcp`.

---

## Cascade math

```
Υ Yield    = (cache_read × output) / input²       (TTEOP canonical)
SNR        = output / (input + output)            (display alias for output_fraction)
Leverage   = cache_read / input                   (TTEOP canonical)
Velocity   = output / input                       (TTEOP canonical)
10xDEV     = log₁₀(leverage)                      (display alias for log_leverage)
```

Canonical metric computation is delegated to [`tteop-spec`](https://www.npmjs.com/package/tteop-spec)
via [`token-cascade`](https://www.npmjs.com/package/token-cascade). SNR
and 10xDEV are SigRank display aliases for the TTEOP metrics `output_fraction`
and `log_leverage` respectively. See [`TTEOP-IMPLEMENTATION-PROFILE.md`](../TTEOP-IMPLEMENTATION-PROFILE.md) for the
full authority chain.
Canon check: `MO§ES (1251211, 11296121, 128196310, 2555179769) → Υ 18436.98`.

---

## Token Pillars — sources

The dashboard pulls from multiple sources and shows them side-by-side for verification:

| Source            | What                                                                           | Platform              |
| ----------------- | ------------------------------------------------------------------------------ | --------------------- |
| `tokenpull`       | On-device JSONL scanner (canon source)                                         | claude, codex, amp, … |
| `ccusage`         | `ccusage <platform> daily --json` CLI (bundled)                                | claude, codex         |
| `token-dashboard` | `~/.claude/token-dashboard.db` SQLite ([Nate's](https://github.com/nateherkai/token-dashboard)) | claude only           |
| `tokscale`        | `tokscale models --json` CLI (bundled, falls back to `~/tokscale_report.json`) | claude, codex         |

**Some adapters estimate fresh input.** Where an adapter cannot read fresh input and cache-write separately, the scanner derives a split. This does not apply to every non-Claude platform: the adapter table identifies native and estimated sources. For adapters using the ratio-based split:

```
input       = output × ioRatio         (ioRatio derived from Claude ratio, else 2.0)
cacheCreate = uncached − input         (uncached = input_tokens − cached_input_tokens)
cacheRead   = exact (from logs)
```

- **Beta** = operator's Claude input/output ratio (if Claude data available)
- **Alpha** = 2.0 default (when no Claude data)

Verifier numbers (ccusage/tokscale for codex) show **raw uncached input** (`input_tokens − cached`) — a different field than the estimated input above. The discrepancy is expected and explained inline in the dashboard.

---

## Platform adapters

All adapters are token-only (no message content, no cost fields, no credentials). The table records adapter paths and pillar limitations. When changing an adapter, update this reference to match `adapters/index.mjs` and `adapters/tokenpull.mjs`.

| Platform           | Path                                           | Pillar shape & notes                                                                                              |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Claude Code        | ✅ `~/.claude/projects` (recursive, incl. `subagents/`) | Native 4-pillar; dedup by `(session_id, message_id)` — final snapshot wins                                  |
| Codex              | ✅ `~/.codex/sessions` (+ `archived_sessions`) | `input_tokens` incl. cached → `input` + `cacheCreate` split window-level via `io_ratio`; `cacheRead` native (`cached_input_tokens`); `reasoning_output`→output; verified vs ccusage (~1%) |
| Devin CLI          | ✅ `~/.local/share/devin/cli/sessions.db`      | SQLite; native 4-pillar from `metadata.metrics` (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`); `input_tokens` is fresh (excludes cache)                                   |
| Amp                | ✅ `~/.local/share/amp/threads`                | Native 4-pillar; per-message                                                                                      |
| Kimi               | ✅ `~/.kimi/sessions`                          | Native 4-pillar; `StatusUpdate` lines only                                                                        |
| pi-agent           | ✅ `~/.pi/agent/sessions`                      | Native 4-pillar; per-message JSONL                                                                                |
| oh-my-pi (`omp`)   | ✅ `~/.omp/agent/sessions` (recursive, incl. nested subagent transcripts) | Native 4-pillar from `.message.usage` on `type:"message"` entries (`cacheWrite`→`cacheCreate`); **`reasoningTokens` is already inside `output`** — never added, or it double-counts; `usage.cost` reuses the same four key names for USD floats and is dropped; dedup by (session header `id`, entry `id`). Separate harness from pi-agent |
| OpenClaw           | ✅ `~/.openclaw`                               | Native 4-pillar; per-message JSONL                                                                                |
| Droid              | ✅ `~/.factory/sessions/*.settings.json`       | Native 4-pillar; `thinking_tokens`→output                                                                         |
| Codebuff           | ✅ `~/.config/manicode`                        | Native 4-pillar; `chat-messages.json`                                                                             |
| Hermes             | ✅ `~/.hermes/state.db`                        | Native 4-pillar; SQLite; `reasoning_tokens`→output                                                                |
| Kilo               | ✅ `~/.local/share/kilo/kilo.db`               | Native 4-pillar; SQLite                                                                                            |
| Qwen               | ✅ `~/.qwen/projects`                          | Estimated (`cacheCreate=0` — no field in logs); `cacheRead` from `cachedContentTokenCount`; `thoughtsTokenCount`→output |
| Goose              | ✅ `~/.local/share/goose/sessions/sessions.db` (or `$GOOSE_PATH_ROOT/data/sessions/sessions.db`) | Estimated (`cacheCreate=cacheRead=0` — no cache fields); reasoning = `total−input−output`→output; cumulative-column dedup by session id |
| Gemini CLI         | ✅ `~/.gemini/tmp`                             | Estimated (`cacheCreate=0`); `cacheRead` from `cached` field; `thought`→output; `input` = `input−cached` (fresh)  |
| GitHub Copilot CLI | ✅ `~/.copilot/otel`                           | Native 4-pillar (OTel spans: `llm.token_count.{prompt,completion,cache_creation,cache_read}`); requires `COPILOT_OTEL_ENABLED=true` + `COPILOT_OTEL_EXPORTER_TYPE=file` set **before** session start |
| OpenCode           | ⚠️ `~/.local/share/opencode`                   | Data gap — logs store `cost:0` and derive tokens via LiteLLM at runtime; raw token counts not persisted. No pillars readable with current format |
| SigRank SignalAF proxy      | ✅ `~/.sigrank-mcp/proxy-sessions.jsonl`       | Opt-in native 4-pillar usage reported by Anthropic/OpenAI; same-timestamp records keep the last call; OpenAI cached input is separated from fresh input |
| Other (user JSON)  | ✅ `$SIGRANK_OTHER_PATH`                       | User-supplied JSON `{ "windows": { "all": {input,output,cacheCreate,cacheRead} } }`; all-time only (no timestamps) |
| Cursor             | 🔜                                             | Chat log path TBD                                                                                                 |
| Windsurf           | 🔜                                             | Session logs at `~/.codeium/windsurf/`                                                                            |

`estimated=true` means one or more pillars are derived, not native. The server re-scores all submitted pillars authoritatively; local preview Υ is indicative only.

---

## Privacy

- **Exactly what leaves your machine (signed submit):** the four token pillars (input, output, cache create, cache read) per window, your codename, device id, device public key, ed25519 signature, agent version, platform, message/session counts, and the weekly report block. `enroll` additionally sends a device label, which defaults to `sigrank <version> · <platform>` (your hostname is never sent unless you set `SIGRANK_DEVICE_LABEL` or pass `device_label`). Never sent: prompts, responses, file paths, repo/project names, or environment variables.
- **MCP safety rails.** The `enroll` tool refuses to re-bind a device that is already enrolled (re-enroll from the CLI), and `submit_verified` requires `confirm: true` to publish (not needed with `dry_run`). `tokscale_developer_profile` returns workspace counts only, never workspace or project names.
- **Token-only persistence and submission.** Local-log adapters read usage metadata only. The optional proxy necessarily handles provider-bound request and response bytes in memory, but never persists their content; it writes only token counts, model/backend metadata, and timestamps. Only token telemetry is submitted to SigRank SignalAF.
- **Local by default.** `tokenpull` reads only the selected or detected adapter paths on your device (e.g. `~/.claude/projects` for Claude, `~/.codex` for Codex, plus additional paths for Amp, Devin, Gemini, Goose, and other supported platforms). Numbers stay on your machine unless you explicitly submit with a codename.
- **Background tooling excluded.** Memory plugins, observers, summarizers (e.g. `claude-mem`, `mem0`, `observer-sessions`) are filtered from both Claude and Codex reads. `subagents/` are kept — they represent real operator work.
- **Board reads are anonymous.** No account needed to browse, compare, or watch.
- **Ranked submissions are signed, not trusted.** `sigrank submit` requires a one-time `enroll` (device-bound ed25519 key — the private key never leaves your machine). Verify what's sent with `sigrank submit --dry-run`: the payload is four token counts, ratios, and a signature.

---

## Env vars

| Var                     | Default                | Description                  |
| ----------------------- | ---------------------- | ---------------------------- |
| `SIGRANK_API_BASE`      | `https://signalaf.com` | Override the board host (https required; http only for loopback) |
| `SIGRANK_DEVICE_LABEL`  | `sigrank <version> · <platform>` | Optional device label sent at enroll |
| `SIGRANK_FETCH_TIMEOUT` | `10000`                | Board API fetch timeout (ms) |

---

