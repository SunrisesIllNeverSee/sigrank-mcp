---
type: Reference
title: Operator
description: Account-level subject associated with AI-work telemetry. Not necessarily a unique human or legal person. Active.
tags: [sigrank, operator, identity, accounts, display-name, reference]
timestamp: 2026-07-21
---

# Operator

An operator is the account-level subject associated with AI-work telemetry in SignalAF. It is not necessarily a legal person, employer, or unique human: one operator can have devices, submissions, and an optional authenticated account link.

An authenticated user resolves to an operator through `operator_accounts`. The board display rule prefers an available display name, otherwise a codename; direct identity is not appropriate for research releases. A profile can exist before it is claimed.

> **Repo scope.** `lib/infra/supabase/auth-server.ts` and `lib/identity/operator-name.ts` are **server-side** in `sigrank-app`. The MCP client's notion of an operator is the enrolled identity in `identity/keystore.mjs` (codename + operator_id + device-bound ed25519 key); the client never resolves accounts server-side.

Sources (server): `sigrank-app/lib/infra/supabase/auth-server.ts`, `sigrank-app/lib/identity/operator-name.ts`. Client mirror: `identity/keystore.mjs`.