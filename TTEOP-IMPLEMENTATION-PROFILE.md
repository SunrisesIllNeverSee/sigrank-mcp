# TTEOP Implementation Profile — sigrank-mcp (sigrank CLI/MCP)

> **Purpose:** Explain how this product implements, consumes, and produces TTEOP.
> This is a product implementation profile, NOT a protocol definition.
> TTEOP semantics are owned solely by the [`otep-spec`](https://github.com/SunrisesIllNeverSee/otep-spec) repository.

## Protocol identity

| Field | Value |
|-------|-------|
| Protocol name | TTEOP (Token Telemetry Evaluation Operator Protocol) |
| Protocol version | `tteop/0.1-draft` |
| TTEOP version pin | `tteop-spec@0.1.5-draft` (target — see Known limitations) |
| GitHub repository | [SunrisesIllNeverSee/otep-spec](https://github.com/SunrisesIllNeverSee/otep-spec) |
| npm package | [tteop-spec](https://www.npmjs.com/package/tteop-spec) |
| Version DOI | [10.5281/zenodo.22180349](https://doi.org/10.5281/zenodo.22180349) |
| Concept DOI | [10.5281/zenodo.22180348](https://doi.org/10.5281/zenodo.22180348) |
| MCP transport | [tteop-mcp](https://github.com/SunrisesIllNeverSee/tteop-mcp) (transport class, does not define protocol semantics) |
| Legacy predecessor | [sigrank-standard](https://github.com/SunrisesIllNeverSee/sigrank-standard) (`sigrank/0.1-draft`, superseded) |

## Product role

**sigrank-mcp** is the on-device scanner and MCP tool. It reads local token
telemetry from AI operator sessions, computes TTEOP-derived metrics via
`@sigrank/cascade`, and submits signed snapshots to the SignalAF leaderboard.

- **Producer role:** sigrank-mcp reads local token usage (I/O/W/R), builds
  `sigrank/0.1-draft` compatibility records (a TTEOP legacy alias), and
  submits ed25519-signed telemetry snapshots to signalaf.com.
- **Consumer role:** sigrank-mcp computes and displays TTEOP-derived metrics
  (Yield, Leverage, Velocity, SNR, 10xDEV) in its TUI and MCP tool responses.

## TTEOP fields used

| TTEOP field | Symbol | Used in sigrank-mcp |
|-------------|--------|---------------------|
| input | `I` | Yes — fresh input-token count from local telemetry |
| output | `O` | Yes — output-token count from local telemetry |
| cache_write | `W` | Yes — cache creation tokens (accepted as `cacheCreate` in code) |
| cache_read | `R` | Yes — cache read tokens (accepted as `cacheRead` in code) |

## TTEOP derived metrics used

| TTEOP metric | Formula | sigrank-mcp display name |
|--------------|---------|--------------------------|
| Yield (Υ) | `(R × O) / I²` | Yield (Υ) |
| Leverage | `R / I` | Leverage |
| Velocity | `O / I` | Velocity |
| output_fraction | `O / (I + O)` | SNR (legacy display alias) |
| log_leverage | `log10(R / I)` | 10xDEV (legacy display alias) |

**Note:** `SNR` and `10xDEV` are product display names for the TTEOP metrics
`output_fraction` and `log_leverage` respectively. They are NOT separate TTEOP
metrics. TTEOP owns the canonical names and formulas; sigrank-mcp owns the
display names.

## Conformance

- **Primary conformance target:** `tteop-spec@0.1.5-draft` (TTEOP)
- **Legacy wire identifier:** `sigrank/0.1-draft` (TTEOP legacy alias, retained
  for backward compatibility — resolves to `tteop/0.1-draft` semantics)
- **Cascade tests:** `__tests__/cascade.test.mjs` verifies cascade math
- **Standard record test:** `__tests__/standard-record.test.mjs` verifies the
  `sigrank/0.1-draft` compatibility record structure and MO§ES canonical vector

## Product-specific extensions

sigrank-mcp adds the following product-specific extensions that are NOT part of
TTEOP and must not be described as TTEOP semantics:

- **Mode detection** (`detectMode`, `qualityScore`) — classifies operator
  behavior into modes (IDLE, CONVERGE, KINETIC, AMPLIFY, CONTEXT) based on
  pillar ratios. Product extension, not TTEOP.
- **Class tiers** (8-tier experience ladder: ARCH+ to IGNITER) — sigrank-mcp
  product taxonomy, not TTEOP.
- **ed25519 signing** — submission integrity mechanism. Product extension,
  not TTEOP.
- **TUI dashboard** — interactive terminal UI for local use. Product extension.
- **Simulation tools** (`simulate_change`) — what-if analysis on token mix.
  Product extension.

These extensions are owned by sigrank-mcp / Upsilon and governed by Search
Authority's product implementation authority class. They may not redefine
TTEOP I/O/W/R meaning, formulas, null semantics, privacy, or conformance.

## Display transformations

| TTEOP canonical | sigrank-mcp display | Reason |
|-----------------|---------------------|--------|
| `output_fraction` | SNR | Historical display name retained for user familiarity |
| `log_leverage` | 10xDEV | Historical display name retained for user familiarity |

These are display aliases only. The underlying computation uses TTEOP
canonical formulas via `@sigrank/cascade`. The display names are product
extensions, not protocol redefinitions.

## Legacy aliases accepted

| Legacy alias | Resolves to | Status |
|--------------|-------------|--------|
| `sigrank/0.1-draft` | `tteop/0.1-draft` | Used as wire identifier for backward compatibility |
| `otep/0.1-draft` | `tteop/0.1-draft` | Accepted for backward compatibility (pre-rename) |

The `sigrank/0.1-draft` wire identifier is deliberately retained in
`tools/standard-record.mjs` (`SIGRANK_STANDARD_VERSION`) for compatibility
with existing clients. It resolves to current TTEOP semantics and does NOT
constitute a second active standard.

## Known limitations

- sigrank-mcp uses `@sigrank/cascade@^0.1.1` for metric computation, which
  implements TTEOP canonical formulas but is not yet version-pinned to
  `tteop-spec`. A future release will align the cascade package version with
  the TTEOP version pin.
- The wire identifier remains `sigrank/0.1-draft` for compatibility. Migration
  to `tteop/0.1-draft` as the wire identifier is a future product decision.
- The `sigrank` npm package name and `npx sigrank` CLI command are preserved
  as technical identifiers per owner directive (2026-08-28). They are NOT
  protocol names.

## Authority boundary

```
TTEOP (otep-spec)
  specifies canonical protocol semantics
        │
        ▼
THIS PROFILE (TTEOP-IMPLEMENTATION-PROFILE.md)
  explains how sigrank-mcp uses TTEOP
        │
        ▼
SIGRANK-MCP / sigrank CLI
  implements product behavior
  (local scanning, TUI, signing, submission, mode detection, class tiers)
```

sigrank-mcp may add product-specific extensions but may not redefine TTEOP
semantics. This profile is the implementation contract between TTEOP and
sigrank-mcp.
