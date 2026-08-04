---
type: Reference
title: Ontology
description: Defines the terms SignalAF uses, from operator submissions through telemetry pillars to cascade metrics and signals. Active.
tags: [sigrank, ontology, definitions, glossary, terms, reference]
timestamp: 2026-07-21
---

# Ontology

This directory defines the terms SignalAF uses. Definitions describe the current product model; they are not claims about an operator beyond the data and method supporting them.

The model moves from an **operator** submitting a windowed **submission**, through four raw **telemetry** pillars, to cascade **metrics**, cautious **signals**, and comparisons against the **field**. Classification and future profiles live in the taxonomy and Atlas.

> **Repo scope.** The `lib/...` sources cited throughout this directory (`lib/analytics/cascade.ts`, `lib/analytics/scoring-engine.ts`, `lib/analytics/field-types.ts`, `lib/ingest/gates.ts`) are **server-side** in the `sigrank-app` web app. This `sigrank-mcp` repo is the client; its mirrors are `analytics/cascade.mjs` (cascade metrics), `identity/keystore.mjs` + `identity/sign.mjs` (operator identity + signing), and `adapters/tokenpull.mjs` (telemetry collection). Each doc below carries its own repo-scope banner.

Source basis (server): `sigrank-app/lib/analytics/cascade.ts`, `sigrank-app/lib/analytics/scoring-engine.ts`, `sigrank-app/lib/analytics/field-types.ts`, `sigrank-app/lib/ingest/gates.ts`. Client mirrors: `analytics/cascade.mjs`, `identity/keystore.mjs`, `identity/sign.mjs`, `adapters/tokenpull.mjs`.