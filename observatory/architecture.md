---
type: Design
title: Architecture
description: System architecture for the SignalAF app, ingest gate chain, and data layer. Active.
tags: [sigrank, architecture, ingest, supabase, nextjs, design]
timestamp: 2026-07-21
---

# Architecture

```text
Operator tools / MCP client
          |
          v  POST /api/v1/devices/enroll  (enroll: public key + connect code)
             POST /api/v1/snapshots       (signed snapshot, x-agent-signature header)
          |
          v
  App API: enrollment and snapshots
          |
          v
Ingest: parse -> validate -> sign/verify -> integrity gates -> persistence
          |                                      |
          v                                      v
Supabase data layer                     verification tier / reasons
          |
          +--> App board, profiles, comparisons, field pages
          +--> Versioned datasets and research releases
```

The Next.js app is the public application and API surface. MCP tooling collects locally available telemetry and submits a snapshot through the API. The data layer stores operator identity links, devices, snapshots, and derived board views. Server-side authentication verifies the Supabase JWT with `getUser()` and resolves the linked operator; it does not trust an unverified cookie session.

The ingest gate chain runs before scoring or persistence and can accept, flag, or reject a submission. It separates public diagnostics from server-only integrity controls. The signature is verified by re-deriving the canonical bytes from the received payload and checking the ed25519 signature from the `x-agent-signature` header (the signature is over the canonical bytes directly, not a hash-then-sign scheme; `agent.snapshot_hash` holds the sha256 digest of those same canonical bytes).

> **Repo scope.** This diagram describes the **server-side** `sigrank-app` architecture. The `sigrank-mcp` client is the "Operator tools / MCP client" box at the top: it collects telemetry (`adapters/`), scores it (`analytics/cascade.mjs`), signs it (`identity/sign.mjs`), and POSTs snapshots (`submit/index.mjs` → `POST /api/v1/snapshots` with the `x-agent-signature` header) and enrollments (`tools/enroll.mjs` → `POST /api/v1/devices/enroll`) to the App API. The ingest gate chain, Supabase data layer, and auth-server are all in `sigrank-app` and not present in this repo.

Sources (server): `sigrank-app/lib/ingest/gates.ts`, `sigrank-app/lib/ingest/signature.ts`, `sigrank-app/lib/infra/supabase/auth-server.ts`. Client side: `adapters/`, `analytics/cascade.mjs`, `identity/sign.mjs`, `submit/index.mjs`, `tools/enroll.mjs`.