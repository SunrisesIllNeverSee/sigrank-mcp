# sigrank-mcp Restructure Checklist

Use this checklist to verify every phase of the observatory-spine restructure in `sigrank-mcp`.

## Phase 0 — Pre-flight

- [ ] Branch exists: `restructure/observatory-spine`
- [ ] `git status` is clean before starting each phase
- [ ] `npm test` passes before any changes
- [ ] `node scripts/sync-spine.mjs --check` passes (or `sigrank-app` spine docs are not yet expected)

## Phase 1 observatory spine (from sigrank-app)

- [ ] Wait for `sigrank-app` Phase 1 to complete
- [ ] Run `node scripts/sync-spine.mjs` to copy the canonical docs from `sigrank-app/observatory/` + `ontology/` + `methodology/` + `governance/`
- [ ] Verify copied files land under `observatory/`, `ontology/`, `methodology/`, `governance/` at the repo root
- [ ] `node scripts/sync-spine.mjs --check` passes

## Phase 2 — Consent tracking (from sigrank-app)

- [ ] `sigrank-app` Phase 2 migration merged
- [ ] `sigrank-mcp` reads `data_opt_out` before accepting tool submissions
- [ ] No MCP-only migration needed unless adding MCP-specific tables

## Phase 4 — Restructure `sigrank-mcp`

- [ ] New top-level directories exist:
  - [ ] `lib/mcp/`
  - [ ] `lib/tools/`
  - [ ] `lib/infra/`
  - [ ] `lib/eval/`
  - [ ] `observatory/`
  - [ ] `ontology/`
  - [ ] `methodology/`
  - [ ] `governance/`
- [ ] `tools.mjs` split into `lib/tools/*.mjs`
- [ ] `mcp-server.mjs` updated to register tools from `lib/tools/`
- [ ] Tool handlers imported from `lib/tools/`
- [ ] `lib/supabase.mjs` moved to `lib/infra/supabase.mjs`
- [ ] `lib/posthog.mjs` moved to `lib/infra/posthog.mjs`
- [ ] `lib/audit.mjs` moved to `lib/infra/audit.mjs`
- [ ] `lib/eval.mjs` moved to `lib/eval/eval.mjs`
- [ ] Old files removed after move
- [ ] `package.json` scripts still work (`npm start`, `npm test`)
- [ ] `npm test` passes

## Phase 6 — Wire consent into MCP

- [ ] Tool input schema includes consent-related metadata if applicable
- [ ] Before persisting any submission, MCP checks operator `data_opt_out`
- [ ] Opt-out operators are rejected with a clear error message
- [ ] MCP respects `terms_version` / `privacy_version` freshness
- [ ] `npm test` passes

## Phase 7 — Final verification

- [ ] `npm test`
- [ ] `node scripts/sync-spine.mjs --check`
- [ ] `npm run lint` (if configured)
- [ ] All checklist items above checked
- [ ] Commit with clear message: `refactor: restructure mcp into domain tools and sync observatory spine`
