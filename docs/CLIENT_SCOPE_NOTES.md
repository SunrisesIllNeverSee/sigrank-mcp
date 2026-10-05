---
type: Reference
title: Client Scope Notes — Client/Server Boundary
description: What this repo implements locally (client) versus what lives server-side in sigrank-app. Salvaged from the retired observatory/ontology/methodology/governance mirror dirs (removed 2026-10-05). Active.
tags: [sigrank, repo-scope, client, server, boundary, signing, endpoints, reference]
timestamp: 2026-10-05
---

# Client Scope Notes — Client/Server Boundary

`sigrank-mcp` is the **client**: local telemetry collection, cascade scoring, signing, and signed submission. `sigrank-app` is the **server**: the public application + API surface, the ingest gate chain, scoring-engine normalization, the Supabase data layer, and board views.

Normative truth lives in `search-authority` (`canon/sigrank/canon.yaml`). This file is implementation documentation, not canon. Metric parity between the two repos is enforced by `__tests__/fixtures/canon_parity.json` + `test.mjs`, not by documentation.

## Client mirror map

| Server-side (sigrank-app) | Client mirror (this repo) |
|---|---|
| `lib/analytics/cascade.ts` (canonical implementation, `safeI = max(i, 1)` clamp) | `analytics/cascade.mjs` (**null-guard**: `i > 0 ? o/i : null`) |
| `lib/analytics/scoring-engine.ts` ([0,100] normalization + bucket table) | not ported — server-only |
| `lib/ingest/gates.ts`, `lib/ingest/signature.ts` (ingest gate chain, canonicalizer) | `submit/index.mjs` (Schema 1.0 payload + signed POST), `identity/sign.mjs` (byte-compatible canonicalizer port), `identity/keystore.mjs` (device-bound keypair) |
| `lib/infra/supabase/auth-server.ts`, `lib/identity/operator-name.ts` (account resolution) | `identity/keystore.mjs` (enrolled identity: codename + operator_id); client never resolves accounts server-side |
| `lib/analytics/benford.ts` (Benford integrity check) | not ported — client surfaces `verification_tier` from the submit ack |
| `lib/analytics/field-types.ts`, `lib/analytics/field-data.ts`, `lib/board/queries.ts`, `lib/analytics/outlier-classify.ts` (field stats) | `presentation/narrate.mjs` (build-archetype narration) |
| telemetry plausibility gate (`lib/ingest/gates.ts`) | `adapters/index.mjs`, `adapters/tokenpull.mjs` collect the four pillars locally; the client does not run the gate |

## Endpoints (client → server)

Both live in `sigrank-app`:

- **Signed snapshot submit:** `POST /api/v1/snapshots` — used by `submit_verified` and `watch_tokenpull` with `submit:true`. The body is the Schema 1.0 payload; the ed25519 signature travels in the `x-agent-signature` header (NOT attached to `agent.snapshot_hash`). The server re-derives the canonical bytes, re-computes the hash, and verifies the signature. (A prior doc revision referenced `/verified/ingest` — that path does not exist.)
- **Device enrollment:** `POST /api/v1/devices/enroll` — used by `enroll`. Sends the device's public key + a connect code; the server binds the key to the operator and returns the codename + operator_id. (A prior doc revision implied enrollment needed only a codename — it requires a connect code from signalaf.com.)

## Signature + hash mechanics

The signature is over the **canonical bytes** of the payload (recursively sorted keys, compact separators, UTF-8), with the derived `agent.signature` and `agent.snapshot_hash` fields stripped before serialization. It is **not** hash-then-sign — ed25519 signs the canonical bytes directly. The signature is the base64 of the 64-byte ed25519 signature, sent in `x-agent-signature`. `agent.snapshot_hash` holds `"sha256:" + hex(sha256(canonical_bytes))` — the digest of the canonical bytes, not the signature.

## Degenerate-input policy divergence

Same math, different degenerate policy — the two agree on every non-degenerate input:

- **Server** (`lib/analytics/cascade.ts`): `safeI = max(i, 1)` — clamps the denominator.
- **Client** (`analytics/cascade.mjs`): null-guard — a degenerate pillar surfaces as a `null` metric + a `warnings[]` entry rather than a silently-clamped value. (Documented inline at `analytics/cascade.mjs`.)

Both sides compute stage values and 10xDEV only when every pillar is positive, and mark the run non-compounding when `cw` is zero.

## Build archetypes (client detail)

10 deterministic types across 4 families (classifier describes operating shape, not rank; derived from leverage / velocity / construction and dynamic over time):

- **Reuse depth:** INPUT-BOUND → PRIMING → CONTEXTUAL → DEEP READER → ARCHIVIST
- **Construction:** BUILDER → RECURSIVE → AMPLIFIER
- **Generation:** KINETIC
- **Convergence:** CONVERGENT (P80+ on all 3 axes)

## Retired mirror (2026-10-05)

The `observatory/`, `ontology/`, `methodology/`, and `governance/` directories were a mirror of `sigrank-app` docs synced by `scripts/sync-spine.mjs`. The mirror was removed because it declared the app as canon source-of-truth (the real canon owner is `search-authority`), was never shipped (absent from `files[]`, excluded in `.npmignore`/`.mcpbignore`), was read by no code, and its check ran in no CI. The repo-scope annotations from the mirrored copies are preserved above.

Resolved 2026-10-05 (owner ruling): the mirrored `ontology/metrics.md` copy had renamed "Yield (Υ)" to "Upsilon" in its description — a canon violation. **Upsilon is the measurement engine/product; Yield (Υ) is the metric.** The violation existed only in the downstream mirror copy; the sigrank-app source was already correct. Do not reintroduce.
