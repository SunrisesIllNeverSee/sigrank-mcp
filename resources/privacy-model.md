# SigRank Privacy Model

## What leaves your machine

**Only four numbers per submission:**
- Input tokens
- Output tokens
- Cache create tokens
- Cache read tokens

**That's it.** No prompts, no code, no file contents, no conversation text.

## How it works

1. **Local-first:** All token pulling happens on your machine. SigRank reads session logs from ~/.claude, ~/.codex, ~/.local/share/amp, etc.
2. **Token counts only:** The MCP tools extract integer counts from log metadata. The actual content of your conversations is never read, parsed, or transmitted.
3. **Signed submission:** Submissions are ed25519-signed. The board verifies authenticity without seeing your data.
4. **No auth required:** No API keys, no OAuth, no account needed to read the leaderboard. Enrollment only requires a codename.

## What SigRank can NOT see

- Your prompts or messages
- Your code or file contents
- Your tool calls or their results
- Which AI platform you use (beyond token counts)
- Your identity (only your chosen codename)

## Verification

The submit_verified tool uses ed25519 signing. The board's source_attestations table records the signature for audit. You can verify your own submissions via get_operator.
