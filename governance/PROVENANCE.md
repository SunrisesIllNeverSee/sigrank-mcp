---
type: Spec
title: Provenance
description: Provenance requirements for observations and releases, including source, window, transformations, and layered verification. Active.
tags: [sigrank, provenance, verification, ingest, dataset-provenance, spec]
timestamp: 2026-07-21
---

# Provenance

Every observation and release should preserve enough context to answer: where did it come from, when was it observed, what window does it represent, what transformations were applied, and what verification evidence exists?

Submission provenance includes the raw telemetry payload, declared window, device context, snapshot hash, and available signature evidence. The ingest chain records accept/flag/reject reasons and verification tier. Dataset provenance includes source, extraction date, inclusion rules, method version, and anonymization process.

Verification is layered: structural plausibility, duplicate/replay checks, throttling, hash/signature checks, and server-side battery analysis. Passing a layer raises confidence within its scope; it never guarantees truth or intent.

The signature evidence is an ed25519 signature over the **canonical bytes** of the payload (not a hash-then-sign scheme), traveling in the `x-agent-signature` HTTP header on `POST /api/v1/snapshots`. `agent.snapshot_hash` holds `"sha256:" + hex(sha256(canonical_bytes))` — the digest of the canonical bytes, not the signature. Enrollment provenance is established at `POST /api/v1/devices/enroll`, which binds the device's public key to the operator via a connect code.

> **Repo scope.** The ingest gate chain (`lib/ingest/gates.ts`) runs **server-side**, in the `sigrank-app` web app — this `sigrank-mcp` repo is the client and does not contain that file. The MCP's matching client-side concerns live in `submit/index.mjs` (Schema 1.0 payload + the signed POST to `/api/v1/snapshots` with the `x-agent-signature` header) and `identity/sign.mjs` (canonical JSON + ed25519 signature + snapshot hash, byte-compatible port of the server canonicalizer). Enrollment is in `tools/enroll.mjs` (POSTs to `/api/v1/devices/enroll`).

Source (server): `sigrank-app/lib/ingest/gates.ts`, `sigrank-app/lib/ingest/signature.ts`. Client mirror: `submit/index.mjs`, `identity/sign.mjs`, `tools/enroll.mjs`.