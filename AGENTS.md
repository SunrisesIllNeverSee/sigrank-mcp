# SigRank MCP — Agent Rules

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
