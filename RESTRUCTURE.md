---
type: Reference
title: sigrank-mcp Restructure Notes
description: Post-restructure reference for the sigrank-mcp repo. Documents the new directory layout, back-compat shims, the observatory spine, and cross-repo sync commands.
tags: [sigrank, sigrank-mcp, restructure, observatory-spine, mcp-tools]
timestamp: 2026-07-20
---

# sigrank-mcp Restructure Notes

**Status:** Completed (or in progress — check git log).

This repo was restructured around the same **observatory spine** used by `sigrank-app`. The goal was to move from a flat root with many `.mjs` files into a domain-organized structure while preserving backward compatibility.

## New directory structure

| Directory | Purpose |
|---|---|
| `index.mjs` | MCP entry point — stays at root because npm expects it. |
| `tools/` | Individual MCP tools + dispatcher in `tools/index.mjs`. |
| `analytics/` | Pure cascade math (shared concepts with sigrank-app). |
| `identity/` | Keystore, signing, connect codes. |
| `submit/` | Submission pipeline (submit, preflight). |
| `adapters/` | Multi-platform token readers. |
| `presentation/` | CLI (`cli.mjs`), TUI (`tui.mjs`), narration (`narrate.mjs`). |
| `resources/` | MCP resources surfaced from the spine docs. |
| `prompts/` | Prompt templates extracted from inline code. |

## Backward-compatibility shims

The following root files remain as one-line re-exports so existing imports do not break:

```
cascade.mjs  -> export * from './analytics/cascade.mjs'
tools.mjs    -> export * from './tools/index.mjs'
keystore.mjs -> export * from './identity/keystore.mjs'
sign.mjs     -> export * from './identity/sign.mjs'
connect.mjs  -> export * from './identity/connect.mjs'
submit.mjs   -> export * from './submit/index.mjs'
preflight.mjs -> export * from './submit/preflight.mjs'
adapters.mjs -> export * from './adapters/index.mjs'
tokenpull.mjs -> export * from './adapters/tokenpull.mjs'
cli.mjs      -> export * from './presentation/cli.mjs'
tui.mjs      -> export * from './presentation/tui.mjs'
narrate.mjs  -> export * from './presentation/narrate.mjs'
```

## The observatory spine

`sigrank-mcp` mirrors the canonical knowledge layer from `sigrank-app`:

```
observatory/
ontology/
methodology/
governance/
```

Do **not** edit these docs in `sigrank-mcp`. Edit them in `sigrank-app`, then run:

```bash
node scripts/sync-spine.mjs
```

Useful flags:

```bash
node scripts/sync-spine.mjs --check    # exit 1 if spine is out of sync
node scripts/sync-spine.mjs --dry-run    # preview changes without copying
SIGRANK_APP_PATH=/path/to/sigrank-app node scripts/sync-spine.mjs
```

## Quick setup

See `environment.yaml` for the canonical setup:

```bash
npm install
npm test
npm start
```

**Node version:** `>=18` (specified in `package.json` engines).

## Publishing rules

From `AGENTS.md`:

- Do **not** publish for small changes.
- Only publish when the owner explicitly says "publish" or "ship a new version".
- Version scheme is `0.0.x` only.

## Important files

| File | Role |
|---|---|
| `index.mjs` | MCP server entry point |
| `manifest.json` / `server.json` | MCP server metadata |
| `tools/index.mjs` | Tool dispatcher + `TOOLS` array |
| `analytics/cascade.mjs` | Cascade math |
| `identity/sign.mjs` | Signing parity with sigrank-app |
| `submit/index.mjs` | Submission pipeline |

## Verification

Before every commit:

```bash
npm test
```

If signing logic changed, also run the canonical parity tests in `sigrank-app`:
`npm run test:canonical`.
