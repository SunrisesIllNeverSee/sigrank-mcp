---
type: Coordination
title: Micro Coordination Bus
description: Append-only working coordination bus for agents operating inside this repository.
tags: [repo-standard, coordination, scratchpad]
timestamp: 2026-08-18
---


# Micro Coordination Bus

## Protocol

- Read the tail before beginning material work.
- Append assignments, blockers, decisions, and completion reports.
- Do not use this as durable product documentation; promote durable knowledge into the appropriate repo document.

## Log

### 2026-08-26 — Devin (GLM-5.2 High)

- Assignment: rewire sigrank-mcp to import cascade math from @sigrank/cascade npm package.
- Scope: replace 379 lines of vendored cascade math in analytics/cascade.mjs with a facade that imports from @sigrank/cascade@0.1.1. Preserve backward compatibility for all 28 importing files via object-form wrapper + local-only helpers (CLASS_TIERS, tierOf, detectMode, parsePillars, etc.).
- Decision: used facade pattern instead of direct import swap — the npm package's cascade() takes positional args while all 20+ call sites use object form. Wrapper re-attaches local-only `mode` field.
- Commit: 9072839
- Tests: 313 assertions pass, MO§ES Υ 18436.98 verified.
- Status: complete.

