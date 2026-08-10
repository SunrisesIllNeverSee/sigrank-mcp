---
type: Reference
title: Taxonomy
description: Classification concepts including class tiers and archetypes. Neither is an identity claim. Active.
tags: [sigrank, taxonomy, class-tier, archetype, classification, reference]
timestamp: 2026-07-21
---

# Taxonomy

SignalAF uses two distinct classification concepts:

- **Class tier:** a server-side classification based on total tokens accumulated. 8 tiers × 3 sub-stages = 24 stages (IGNITER III → ARCH+ I). Thresholds are ordered descending and first match wins.
- **Build archetype:** a composition classifier describing the operator's operating shape — not their rank. 10 deterministic types across 4 families:
  - **Reuse depth:** INPUT-BOUND → PRIMING → CONTEXTUAL → DEEP READER → ARCHIVIST
  - **Construction:** BUILDER → RECURSIVE → AMPLIFIER
  - **Generation:** KINETIC
  - **Convergence:** CONVERGENT (P80+ on all 3 axes)

Neither is an identity claim. Tier thresholds are server-controlled; archetypes are derived from the operator's cascade dimensions (leverage, velocity, construction) and are dynamic — the same operator can move between states as their composition changes.

Sources: `lib/analytics/scoring-engine.ts`, `lib/analytics/build-archetypes.ts`, `presentation/narrate.mjs`.