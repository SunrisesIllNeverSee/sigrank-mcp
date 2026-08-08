---
type: Reference
title: Taxonomy
description: Classification concepts including class tiers and build archetypes. Neither is an identity claim. Active.
tags: [sigrank, taxonomy, class-tier, archetype, classification, reference]
timestamp: 2026-08-09
---

# Taxonomy

SignalAF uses two distinct classification concepts:

- **Class tier:** a server-side classification based on compression and SIGNA RATE. The highest tiers require both conditions; lower tiers use compression only. Thresholds are ordered descending and first match wins.
- **Build archetype:** a deterministic classification of how an operator moves tokens through the cascade. Each of the 10 types is defined by a different primary dimension — input, cache_read, cache_write, output, or multi-axis excellence. CONVERGENT is checked first and pulls out operators who are P80+ on all three derived dimensions (leverage, velocity, construction).

Neither is an identity claim. Tier thresholds and scoring weights are server-controlled; build archetypes are deterministic functions of the three derived ratios.

## The 10 build archetypes

| # | Name | Defined By | Population |
|---|------|-----------|------------|
| 1 | CONVERGENT | P80 on all 3: leverage + velocity + construction | ~6.6% |
| 2 | KINETIC PRODUCER | output (velocity >= 0.8) | ~7.1% |
| 3 | RAW INJECTOR | input (leverage < 5) | ~10.5% |
| 4 | CACHE WARMING | input (leverage 5-10) | ~12.4% |
| 5 | SHALLOW READER | cache_read (leverage 10-15, passive) | ~11.7% |
| 6 | READER | cache_read (leverage 15-23, passive) | ~10.7% |
| 7 | ARCHIVAL | cache_read (leverage 23+, passive) | ~11.7% |
| 8 | BUILDER | cache_write (construction >= 0.02, leverage < 30) | ~10.9% |
| 9 | RECURSIVE MOMENTUM | compound (construction >= 0.02, leverage 30-50) | ~8.3% |
| 10 | COMPOUND AMPLIFIER | compound (construction >= 0.02, leverage 50+) | ~10.2% |

The three derived dimensions:
- **leverage** = cache_read / input (how much you reuse vs fresh input)
- **velocity** = output / input (how much you generate vs take in)
- **construction** = cache_write / cache_read (how much new context you build per read)

Sources: `lib/analytics/scoring-engine.ts`, `lib/analytics/build-archetypes.ts`, `lib/analytics/field-data.ts`.
