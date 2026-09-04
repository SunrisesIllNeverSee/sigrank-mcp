# TTEOP Implementation Profile — sigrank-mcp (sigrank CLI/MCP)

> **Purpose:** Explain how this product implements, consumes, and produces TTEOP.
> This is a product implementation profile, NOT a protocol definition.
> TTEOP semantics are owned solely by the [`otep-spec`](https://github.com/SunrisesIllNeverSee/otep-spec) repository.

## Protocol identity

| Field | Value |
|-------|-------|
| Protocol name | TTEOP (Token Telemetry Evaluation Operator Protocol) |
| Protocol version | `tteop/0.1-draft` |
| TTEOP version pin | `tteop-spec@0.1.5-draft` (via `@sigrank/cascade@0.2.1`, exact pin) |
| GitHub repository | [SunrisesIllNeverSee/otep-spec](https://github.com/SunrisesIllNeverSee/otep-spec) |
| npm package | [tteop-spec](https://www.npmjs.com/package/tteop-spec) |
| Version DOI | [10.5281/zenodo.22180349](https://doi.org/10.5281/zenodo.22180349) |
| Concept DOI | [10.5281/zenodo.22180348](https://doi.org/10.5281/zenodo.22180348) |
| MCP transport | [tteop-mcp](https://github.com/SunrisesIllNeverSee/tteop-mcp) (transport class, does not define protocol semantics) |
| Legacy predecessor | [sigrank-standard](https://github.com/SunrisesIllNeverSee/sigrank-standard) (`sigrank/0.1-draft`, superseded) |

## Product role

**sigrank-mcp** is the on-device scanner and MCP tool. It reads local token
telemetry from AI operator sessions, computes TTEOP-derived metrics via
`@sigrank/cascade` (which delegates canonical computation to `tteop-spec`),
and submits signed snapshots to the SignalAF leaderboard.

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

Conformance is structured in three tiers:

### PRIMARY — TTEOP conformance (MUST PASS)
- **Suite:** `tteop-spec/conformance/tteop-runner.mjs` (20 SRP areas, including
  SRP-METRIC-001 through SRP-METRIC-006 for canonical metric semantics)
- **Invoked via:** `tteop-mcp` `tteop_run_conformance` MCP tool (7 runtime tests
  covering canonical vector, zero input/output, missing cache, build-validate
  round-trip, forbidden field detection)
- **Authority:** `tteop-spec@0.1.5-draft` is the canonical executable/reference
  implementation. This suite is the primary gate for TTEOP protocol conformance.

### PRODUCT — SigRank cascade/sigrank-mcp tests (MUST PASS)
- **Drift detection:** `__tests__/tteop-delegation.test.mjs` proves
  `@sigrank/cascade` delegates correctly to `tteop-spec` (canonical vector
  equivalence, banker's rounding, null semantics, product extension separation)
- **Cascade tests:** `__tests__/cascade.test.mjs` verifies cascade math and modes
- **Standard record test:** `__tests__/standard-record.test.mjs` verifies the
  `sigrank/0.1-draft` compatibility record structure and MO§ES canonical vector
- **Architecture test:** `__tests__/product-architecture.test.mjs` verifies
  product/protocol separation

### LEGACY — sigrank-standard compatibility fixtures (compatibility only)
- **Suite:** `__tests__/contract/standalone-conformance.test.mjs`
- **Fixtures:** 13 fixtures from `sigrank-standard` (pinned ref `c73f152`)
- **Classification:** LEGACY COMPATIBILITY ONLY. This is NOT the primary
  conformance gate. It verifies backward compatibility with the legacy
  `sigrank/0.1-draft` wire format. The primary TTEOP conformance suite lives
  in `tteop-spec` and is invoked via `tteop-mcp`.

### Runtime dependency note

`sigrank-mcp` has a direct `tteop-spec` dependency, but this is TEST-ONLY.
The only import of `tteop-spec` in non-test code is zero (the comment in
`analytics/cascade.mjs` references it documentationally). The runtime
computation path is single:

```
sigrank-mcp → analytics/cascade.mjs → @sigrank/cascade → tteop-spec
```

The direct `tteop-spec` dependency exists solely so
`__tests__/tteop-delegation.test.mjs` can call `computeMetrics` and
`roundHalfToEven` directly to verify cascade hasn't drifted. There is no
competing computation path.

## Product-specific extensions

sigrank-mcp adds the following product-specific extensions that are NOT part of
TTEOP and must not be described as TTEOP semantics:

- **Mode detection** (`detectMode`, `qualityScore`) — classifies operator
  behavior into modes (IDLE, MAINTAIN, DEBUG, EDIT, BUILD) based on
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

The `get_sigrank_standard_record` tool output now includes explicit
authority transition metadata:

```json
{
  "spec": "sigrank/0.1-draft",
  "spec_status": "legacy_alias",
  "protocol": {
    "name": "TTEOP",
    "version": "tteop/0.1-draft",
    "authority": "tteop-spec@0.1.5-draft"
  },
  ...
}
```

An agent consuming this response must not conclude that `sigrank/0.1-draft`
is the active interoperability standard. The `spec_status` field and
`protocol` block make the authority transition unambiguous.

## Known limitations

- The wire identifier remains `sigrank/0.1-draft` for compatibility. Migration
  to `tteop/0.1-draft` as the wire identifier is a future product decision.
- The `sigrank` npm package name and `npx sigrank` CLI command are preserved
  as technical identifiers per owner directive (2026-08-28). They are NOT
  protocol names.

## Authority boundary

```
TTEOP (protocol specification)
  specifies canonical protocol semantics
        │
        ▼
tteop-spec@0.1.5-draft (canonical executable/reference semantics)
  computes Yield, Leverage, Velocity, output_fraction, log_leverage
  with banker's rounding (SRP-METRIC-002) and canonical null semantics
        │
        ▼
@sigrank/cascade@0.2.1 (SigRank product facade)
  delegates computeMetrics() to tteop-spec
  passes null cache through to tteop-spec for canonical null semantics
  maps output_fraction → snr, log_leverage → dev10x (display aliases)
  adds RS05 class taxonomy, operator signatures, field ranking
  translates canonical warning strings to product-facing names
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
