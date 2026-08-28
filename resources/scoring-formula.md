# Upsilon Measurement Formulas

Upsilon is the measurement engine. SigRank is the public leaderboard and proof surface. The installed package and resource URI retain the `sigrank` name for compatibility.

## Yield (Υ) — the headline metric

```
Υ = Cache Reads × Output / Input²
```

Yield describes the compound relationship between context reuse and output relative to fresh input. It does not, by itself, prove work quality or productivity.

## Derived Metrics

| Metric | Formula | Meaning |
|--------|---------|---------|
| **SNR** | Output / (Input + Output) | Output share of the direct input/output exchange |
| **Leverage** | Cache Reads / Input | Cache-read context relative to fresh input |
| **Velocity** | Output / Input | Output tokens relative to fresh input |
| **10xDEV** | log₁₀(Cache Reads / Input) | Log-scale Leverage under the reference null policy |

## Class Tiers

Class is a SignalAF/SigRank reference qualification layer, not a portable Upsilon metric and not the same thing as archetype or rank. TRANSMITTER is a separate peak badge (K.00), not a ladder tier. See `class-tiers.md` for the current product policy.

The formula is deterministic and computed locally. No network calls needed for scoring.
