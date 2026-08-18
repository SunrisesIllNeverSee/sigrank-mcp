# Migration Map — sigrank-mcp

**Installed:** 2026-08-18
**Mode:** migrate
**Profile:** library

## Existing structure preserved

All existing root directories declared in `allowed_root_dirs_extra`:
- `__tests__/`, `adapters/`, `analytics/`, `eval/`, `governance/`, `identity/`,
  `lib/`, `methodology/`, `observatory/`, `ontology/`, `presentation/`,
  `prompts/`, `resources/`, `submit/`, `tools/`

## Existing root files preserved

18 `.mjs` files at root (adapters, badges, cascade, cli, connect, index, keystore,
narrate, omp-cache, preflight, proxy, review, sign, submit, test, tokenpull,
tokscale_analytics, tools, tui) — these are the MCP server entry points and
should be preserved as-is for npm package compatibility.

`sigrank.mcpb` — 3.6MB binary at root (MCP bundle). Preserved as-is.

## Pre-existing coordination

No prior `system-devin/`, `.coord/`, or `Devins_Plans/` existed.
Canonical DREP installed fresh at `system-devin/`.

## Canon context

- Authority role: `implementation`
- Canon contexts: `sigrank`
- Authority owner: `search_authority`

## Migration steps (before enforce)

1. [ ] Consider relocating loose `.mjs` files to `src/` (requires package.json updates)
2. [ ] Consider relocating `sigrank.mcpb` to `artifacts/` or `dist/`
3. [ ] Run `repo_check.py --ci` until clean
4. [ ] Switch REPO.yaml mode from `migrate` → `enforce`

## Enforce readiness

NOT READY — requires migration steps above.
