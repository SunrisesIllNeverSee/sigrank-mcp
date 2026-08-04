---
type: Reference
title: Cascade
description: Token-flow decomposition from input through output, cache commitment, and cache reuse, yielding the Upsilon metric. Active.
tags: [sigrank, cascade, token-flow, upsilon, metrics, reference]
timestamp: 2026-07-21
---

# Cascade

A cascade is the token-flow decomposition from fresh input through generated output, cache commitment, and cache reuse.

For positive pillars, its stages are:

1. **Transmission:** `output / input`
2. **Commitment:** `cache_create / output`
3. **Reuse:** `cache_read / cache_create`

Their product telescopes to `(cache_read × output) / input²`, the public Upsilon metric. A zero cache-create value is marked non-compounding; stage ratios and the cascade string are then unavailable rather than inferred.

> **Repo scope.** `lib/analytics/cascade.ts` is the **server-side** (sigrank-app) canonical implementation. This `sigrank-mcp` repo ships a byte-compatible client mirror at `analytics/cascade.mjs` (the `cascade()` + `classify()` functions used by the CLI, TUI, and every MCP tool). The two are kept in parity by the canon-parity fixture in `__tests__/fixtures/canon_parity.json` + `__tests__/sign.test.mjs`.

Source (server): `sigrank-app/lib/analytics/cascade.ts`. Client mirror: `analytics/cascade.mjs`.