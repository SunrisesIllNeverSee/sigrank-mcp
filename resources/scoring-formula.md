# SigRank Scoring Formula

## Yield (Υ) — the headline metric

```
Υ = Cache Reads × Output / Input²
```

Yield rewards operators who maximize output while minimizing input — and who build cache to amortize that input across sessions. A high yield means you're getting more done with less, efficiently.

## Derived Metrics

| Metric | Formula | Meaning |
|--------|---------|---------|
| **SNR** | Output / (Input + CacheCreate) | Signal-to-noise: how much of your token spend is productive output vs. overhead |
| **Leverage** | Cache Reads / Input | How well you reuse cached context — higher = better cache utilization |
| **Velocity** | Output / Input | Raw output efficiency — how much output you generate per token of input |
| **10xDEV** | Composite score | Weighted blend of yield, leverage, and velocity for cross-platform comparison |

## Class Tiers

Class tiers are based on **total tokens accumulated**, not yield ranges. The 8-tier experience ladder (descending: ARCH+, ARCH, POWER, BASE, SEEKER, REFINER, BEARER, IGNITER) measures operator progression. TRANSMITTER is a separate peak badge (K.00), not a ladder tier. See `class-tiers.md` for the full ladder and thresholds.

The formula is deterministic and computed locally. No network calls needed for scoring.
