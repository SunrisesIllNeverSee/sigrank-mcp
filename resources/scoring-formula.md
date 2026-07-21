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

## Class Tier Thresholds

| Tier | Yield Range | Profile |
|------|-------------|---------|
| **Burner** | Υ < 1.0 | Raw volume — high input, low cache reuse, brute-force output |
| **Builder** | 1.0 ≤ Υ < 10.0 | Balanced — moderate cache, decent output efficiency |
| **10xer** | Υ ≥ 10.0 | Cascade-optimized — high cache reads, minimal input, efficient output |

The formula is deterministic and computed locally. No network calls needed for scoring.
