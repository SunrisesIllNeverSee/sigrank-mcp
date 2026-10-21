# Upsilon Privacy Model

## What leaves your machine

**The usage content of every submission is four numbers:**
- Input tokens
- Output tokens
- Cache create tokens
- Cache read tokens

The signed path additionally carries: codename, device id, device public key, ed25519 signature, agent version, platform, message/session counts, and the weekly report block. `enroll` sends a device label (default `sigrank <version> · <platform>`; your hostname is not sent unless you set `SIGRANK_DEVICE_LABEL` or pass `device_label` yourself).

Never sent: prompts, responses, code, file contents, file paths, repo or project names, or environment variables. The server re-parses and re-scores the pillars authoritatively.

The optional `sigrank proxy` is a local Upsilon transport path to Anthropic/OpenAI, not a
submission path to the SigRank leaderboard. When explicitly enabled, it necessarily receives and
forwards provider-bound API keys, prompts, tool calls, and responses in memory.
It does not persist that content or send it to the SigRank service; it appends
only provider-reported token counts, model/backend metadata, and timestamps to
`~/.sigrank-mcp/proxy-sessions.jsonl`.

- **Signed path** (`submit_verified`, `watch_tokenpull` with `submit:true`; both require `confirm:true`, so nothing publishes without your approval): the four numbers travel with the device's public key, codename, window, and an ed25519 signature. The board verifies the signature without seeing your data.
- **Preview tools** (`submit_paste`, `tokenpull_submit`): compute your cascade locally and send nothing. They do not publish to the board; publishing goes through the signed path or the signalaf.com web UI.

## How it works

1. **Local-first:** All token pulling happens on your machine. Upsilon reads usage metadata from session logs in ~/.claude, ~/.codex, ~/.local/share/amp, etc. The optional proxy also runs only on loopback and only when manually started.
2. **Token-only persistence:** Local-log adapters extract integer counts from log metadata without reading conversation content. The optional proxy forwards request/response bytes transiently but persists only usage metadata. Paste parsing (`submit_paste`, `rank_paste`) happens locally and nothing is transmitted.
3. **Signed submission:** Ranked submissions (`submit_verified`, `watch_tokenpull` with `submit:true`) are ed25519-signed with a device-bound key generated locally at enrollment. The board verifies the signature without seeing your data. `submit_paste` and `tokenpull_submit` are preview-only and never submit.
4. **Read tools need no auth:** No API keys, no OAuth, no account needed to read the leaderboard or operator profiles. **Enrollment requires a connect code** from signalaf.com → Settings → New key (the code binds your device's public key to your operator server-side); a codename alone is not enough for the signed/ranked path.

## What the Upsilon service can NOT see

- Your prompts or messages
- Your code or file contents
- Your tool calls or their results
- Your hostname (unless you opt in via a device label)
- File paths, repo/project names, or environment variables
- Your identity (only your chosen codename; the platform name, agent version, and message/session counts are sent)

The local proxy process is different from the Upsilon service: if you opt in, it
handles your provider traffic in memory solely to forward it to Anthropic or
OpenAI. That content is never stored in the proxy JSONL file.

## Verification

The submit_verified tool uses ed25519 signing. The board's source_attestations table records the signature for audit. You can verify your own submissions via get_operator.
