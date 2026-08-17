# SigRank MCP — Agent Rules

## Quick reference

| What | Command |
|------|---------|
| Unit tests | `node test.mjs` (313 assertions) |
| Signing tests | `node sign.test.mjs` |
| Run CLI locally | `node index.mjs` (TUI if TTY, MCP server if piped) |
| Install deps | `npm install` |

**Bun (faster alternative):** All commands work with Bun (~10-30x faster):

| What | Bun command |
|------|-------------|
| Install deps | `bun install` |
| Unit tests | `bun test.mjs` |
| Signing tests | `bun sign.test.mjs` |
| Run CLI locally | `bun index.mjs` |
| Run published CLI | `bunx sigrank` (same as `npx sigrank` but faster) |

Bun is installed at `~/.bun/bin/bun` (v1.3.13). It reads the same `package.json`
and `package-lock.json` — no migration needed. Use `bunx` instead of `npx` for
one-off package execution.

## Publishing

**Auto-publish is ON (2026-07-31).** Push to main triggers `.github/workflows/publish.yml`,
which runs tests, bumps the patch version, publishes to npm, pushes the version
commit back to main, and dispatches a `sync-mcp-version` event to sigrank-app
(so the app's `MCP_VERSION` constant auto-updates → Vercel auto-deploys).

**Do NOT manually run `npm publish` or `npm version`.** The workflow handles it.
If you need to publish manually (e.g. the workflow is broken), bump the patch
version in `package.json`, commit, push, and the workflow will handle the rest.

**Do NOT add `npm publish` or `npm version` to commit messages or scripts.**
The workflow does this automatically. Manual publishes create duplicate versions.

**Version scheme: `0.0.x` only.** Never use 2-digit versions (0.18.x, 0.19.x).
They pollute the npm version history and break the monotonic sequence.

**Required secret (GitHub repo settings → Secrets → Actions):**
- `NPM_TOKEN` — npm automation token (npmjs.com → Access Tokens → Automation)

The app repo auto-syncs by checking npm daily — no cross-repo PAT needed.

---

## Master Canon Context (Search Authority)

This repository is the **SigRank MCP server** — the on-device scanner and MCP
tool. It is governed by the Search Authority master canon.

### When to load canon context

Before modifying any of the following, load the relevant canon context:

- canonical product definitions (what SigRank measures)
- metrics or formulas (Yield, Leverage, Velocity, SNR, 10xDEV, Construction)
- taxonomy (archetypes, classes, ranks)
- ingest architecture or telemetry primitives (input, output, cache read, cache write)
- ecosystem relationships (SigRank ↔ Conservation Law, MO§ES, etc.)
- terminology (MO§ES™ rendering, deprecated terms)
- product boundaries (operator-vs-model, enterprise vs public canon)

### How to load canon context

```bash
export SEARCH_AUTHORITY_PATH="${SEARCH_AUTHORITY_PATH:-$HOME/Developer/active/search-authority}"
python3 "$SEARCH_AUTHORITY_PATH/canon_cli.py" context sigrank
```

Or use the canon MCP server (compatible agents):

```bash
python3 "$SEARCH_AUTHORITY_PATH/canon_mcp.py"
```

If the canon repository is unavailable, **do not invent canonical context** —
ask the owner. The canon outranks ad-hoc public copy or generated model output
for normative product/research truth.

### What is NOT authority-sensitive

Dependency bumps, build config, test infrastructure, and publishing workflow
changes do **not** require loading the canon.

### Key governance rules

- SigRank evaluates AI **operators**, not AI models.
- Archetype = shape. Class = scale/qualification. Rank = field position.
- Do NOT redefine Class as total-token volume.
- Exactly ONE MO§ES entity. Canonical display: MO§ES™. Never render: MO§E§.
- The harness may measure authority, but it cannot manufacture authority.
- Automated systems may not promote claims into owner-approved truth.
