---
type: Reference
title: Metrics
description: Public cascade metrics including Upsilon, SNR, Velocity, Leverage, and 10xDEV as deterministic diagnostics over raw pillars. Active.
tags: [sigrank, metrics, upsilon, snr, velocity, leverage, 10xdev, reference]
timestamp: 2026-07-21
---

# Metrics

Public cascade metrics are deterministic diagnostics over raw pillars:

- **Upsilon (Υ, yield):** `(cache_read × output) / input²`.
- **SNR:** `output / (input + output)` when the denominator is positive, otherwise `0`.
- **Velocity:** `output / max(input, 1)`.
- **Leverage:** `cache_read / max(input, 1)`.
- **10xDEV:** `log10(transmission × commitment × reuse)` only when all four pillars are positive. By cancellation, this equals `log10(Υ)` in that domain; the app's direct `log10(Leverage)` is not what `computeCascadeMetrics` implements.

The implementation also exposes scale, blended price display, efficiency, and an operation ratio. Metrics quantify token-flow relationships; they are not direct productivity or quality measures.

> **Repo scope.** `lib/analytics/cascade.ts` is the **server-side** (sigrank-app) canonical implementation. The MCP client mirror is `analytics/cascade.mjs` (`cascade()` computes Υ, SNR, Velocity, Leverage, 10xDEV, and the class tier). The two are kept in parity by the canon-parity fixture.

Source (server): `sigrank-app/lib/analytics/cascade.ts`. Client mirror: `analytics/cascade.mjs`.