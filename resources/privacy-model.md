# SigRank Privacy Model

## What leaves your machine

**Every submission path sends only four numbers:**
- Input tokens
- Output tokens
- Cache create tokens
- Cache read tokens

That's the entire payload — no prompts, no code, no file contents, no conversation text. The MCP parses your input locally and sends only the four token counts to the server, which re-parses and re-scores them authoritatively.

- **Signed path** (`submit_verified`, `watch_tokenpull` with `submit:true`): the four numbers travel with the device's public key, codename, window, and an ed25519 signature. The board verifies the signature without seeing your data.
- **Paste path** (`submit_paste`, `tokenpull_submit`): the MCP parses your pasted token counts locally, then sends only the four canonical numbers to the server's web-paste endpoint. Even if you paste mixed text (prose + numbers), only the extracted token counts are transmitted — the raw text never leaves your machine.

## How it works

1. **Local-first:** All token pulling happens on your machine. SigRank reads session logs from ~/.claude, ~/.codex, ~/.local/share/amp, etc.
2. **Token counts only:** The MCP tools extract integer counts from log metadata. The actual content of your conversations is never read, parsed, or transmitted. On the paste path, the MCP parses the paste locally and sends only the four extracted numbers — the raw paste text stays on your machine.
3. **Signed submission:** Ranked submissions (`submit_verified`, `watch_tokenpull` with `submit:true`) are ed25519-signed with a device-bound key generated locally at enrollment. The board verifies the signature without seeing your data. Paste submissions (`submit_paste`, `tokenpull_submit`) are unsigned and go through the web-paste endpoint with a codename only — but still send only the four token counts, not the raw paste.
4. **Read tools need no auth:** No API keys, no OAuth, no account needed to read the leaderboard or operator profiles. **Enrollment requires a connect code** from signalaf.com → Settings → New key (the code binds your device's public key to your operator server-side); a codename alone is not enough for the signed/ranked path.

## What SigRank can NOT see

- Your prompts or messages
- Your code or file contents
- Your tool calls or their results
- Which AI platform you use (beyond token counts)
- Your identity (only your chosen codename)

## Verification

The submit_verified tool uses ed25519 signing. The board's source_attestations table records the signature for audit. You can verify your own submissions via get_operator.
