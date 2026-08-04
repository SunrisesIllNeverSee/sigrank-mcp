---
type: Reference
title: Submission and Snapshot
description: Defines submissions as windowed payloads and snapshots as stored, scored representations after ingest checks. Active.
tags: [sigrank, submission, snapshot, ingest, verification, reference]
timestamp: 2026-07-21
---

# Submission and snapshot

A submission is a payload sent for a defined time window. A snapshot is the stored, scored representation produced after parsing, integrity checks, and persistence.

A submission includes raw telemetry, a window, device context, and a claimed snapshot hash. The ingest chain checks plausibility, duplicates/replays, rate limits, hash/signature evidence, and an optional server-side verification battery before it can be scored or stored.

A submission may be accepted, flagged, or rejected. A verification tier describes integrity evidence; it is not proof of intent or correctness.

> **Repo scope.** The ingest gate chain (`lib/ingest/gates.ts`) runs **server-side** in the `sigrank-app` web app — this `sigrank-mcp` repo is the client and does not contain that file. The client-side concerns that produce a submission live in `submit/index.mjs` (Schema 1.0 payload builder + the signed POST), `identity/sign.mjs` (canonical JSON + ed25519 signature + snapshot hash — a byte-compatible port of the server canonicalizer), and `identity/keystore.mjs` (device-bound keypair).

## Endpoints (client → server)

The client talks to two server endpoints. Both live in `sigrank-app` (not in this repo):

- **Signed snapshot submit:** `POST /api/v1/snapshots` — used by `submit_verified` and `watch_tokenpull` with `submit:true`. The body is the Schema 1.0 payload; the ed25519 signature travels in the `x-agent-signature` header (NOT attached to `agent.snapshot_hash`). The server re-derives the canonical bytes, re-computes the hash, and verifies the signature. (A prior revision of this doc referenced a `/verified/ingest` endpoint — that path does not exist; the real path is `/api/v1/snapshots`.)
- **Device enrollment:** `POST /api/v1/devices/enroll` — used by `enroll`. Sends the device's public key + a connect code; the server binds the key to the operator and returns the codename + operator_id. (A prior revision implied enrollment needed only a codename — it actually requires a connect code from signalaf.com.)

## Signature + hash mechanics

The signature is over the **canonical bytes** of the payload (recursively sorted keys, compact separators, UTF-8), with the derived `agent.signature` and `agent.snapshot_hash` fields stripped before serialization. It is **not** a "hash-then-sign" scheme — ed25519 signs the canonical bytes directly. The signature is the base64 of the 64-byte ed25519 signature, sent in the `x-agent-signature` header. `agent.snapshot_hash` holds `"sha256:" + hex(sha256(canonical_bytes))` — it is the digest of the canonical bytes, not the signature, and not "attached" to the signature. The server re-derives all three (canonical bytes, hash, signature verification) from the received payload.

Source (server): `sigrank-app/lib/ingest/gates.ts`, `sigrank-app/lib/ingest/signature.ts`. Client mirror: `submit/index.mjs`, `identity/sign.mjs`.
