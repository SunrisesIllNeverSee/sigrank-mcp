# Contributing to SigRank MCP

Thanks for your interest! SigRank MCP is the CLI + MCP server for the SigRank leaderboard.

## Quick start

```bash
git clone https://github.com/SunrisesIllNeverSee/sigrank-mcp.git
cd sigrank-mcp
npm install
node test.mjs          # 29 unit tests
node index.mjs         # TUI (if TTY) or MCP server (if piped)
```

## Before you commit

```bash
node test.mjs          # 29 assertions, no network, no fs writes
node sign.test.mjs     # signing tests
```

CI also runs (in addition to the above + cross-repo contract + pack-check):

- **Secret scan** (gitleaks) — never commit real keys/tokens; test fixtures
  and test files are allowlisted in `.gitleaks.toml`.
- **CodeQL** — static analysis on JS; fix or dismiss alerts it raises on your PR.
  Especially relevant for `sign.mjs` + `keystore.mjs` (crypto + key handling).
- **Dependency audit** — `npm audit` fails on high/critical advisories (moderate
  is reported only). If your PR bumps a dep with a high/critical advisory, CI blocks.

## Invariants — do not break

- **Token-only.** No message content is ever read, logged, or transmitted.
- **No auth required.** All board reads and submit are anonymous.
- **No credentials stored.** The keystore uses paste-keys, not API keys.
- **Canon check:** `MO§ES (1251211, 11296121, 128196310, 2555179769) → Υ 18436.98`

## Adding a platform adapter

1. Add the adapter to `adapters.mjs` following the existing pattern.
2. Add a test case to `test.mjs` (adapter registry + shape contract).
3. Update the platform table in `README.md`.

## Pull requests

Use the PR template. Verify tests pass before requesting review.
