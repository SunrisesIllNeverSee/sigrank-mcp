---
type: Spec
title: Normalization
description: How raw pillars are made comparable through ratios, denominator clamping, and scoring-engine normalization to [0,100]. Active.
tags: [sigrank, normalization, ratios, scoring, comparability, spec]
timestamp: 2026-07-21
---

# Normalization

Raw pillars are made comparable through ratios rather than direct token totals: velocity divides output by fresh input, leverage divides cache reads by fresh input, and SNR uses the input-plus-output total. The cascade implementation clamps the input denominator to at least one to avoid division by zero.

Volume is separately represented as `log10(total pillars)` rather than folded into every ratio. The scoring engine also normalizes selected Core 5 inputs to `[0,100]`: compression is multiplied by 100, prompt complexity and cross-thread are clamped, throughput uses `min(100, 20 × log10(x + 1))`, and session depth uses a server-side bucket table.

Normalization improves comparability but cannot remove different tools, models, workloads, windows, or reporting practices.

> **Repo scope.** `lib/analytics/cascade.ts` (cascade ratios + `safeI = max(i, 1)` denominator clamp) and `lib/analytics/scoring-engine.ts` (the `[0,100]` normalization + bucket table) are **server-side** in `sigrank-app`. The MCP client mirror for the cascade ratios is `analytics/cascade.mjs`, which uses a **null-guard** policy (`i > 0 ? o/i : null`) instead of the clamp; the scoring-engine normalization is server-only and not ported to the client.

Sources (server): `sigrank-app/lib/analytics/cascade.ts`, `sigrank-app/lib/analytics/scoring-engine.ts`. Client mirror: `analytics/cascade.mjs`.