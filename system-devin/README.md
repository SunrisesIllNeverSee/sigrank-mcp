---
type: Reference
title: DREP Coordination Root — system-devin
description: Canonical DREP coordination root for sigrank-mcp. rep1=LEAD, rep2=ASSIST, OWNER=human. Single operational coordination state.
tags: [repo-standard, coordination, drep, system-devin]
timestamp: 2026-08-18
---

# DREP Coordination Root

This directory is the canonical DREP coordination root for `sigrank-mcp`.

## Role mapping (canonical, non-negotiable)

| DREP name | Standard name | Human/Agent | Role |
|-----------|--------------|-------------|------|
| OWNER | OWNER | Human (Deric) | Decisions, external actions |
| rep1 | LEAD | Agent | Primary build coordination, documentation, big-picture |
| rep2 | ASSIST | Agent | Bounded support lane, one-off tasks, reports to rep1 |

## Single coordination state

The live coordination bus is `.coord/micro/SCRATCHPAD.md`.
The live session state is `.coord/micro/STATE.md`.

`system-devin/` holds per-role onboarding and handoff state.
There is ONE operational coordination state per repository.
