---
type: Handoff
title: rep1 (LEAD) Task Brief — Spine Mirror Removal
description: Spine mirror (observatory/ontology/methodology/governance synced from sigrank-app) removed on branch chore/spine-mirror-removal. rep1 owns review/merge + sigrank-app follow-ups after search-recovery lands.
tags: [repo-standard, coordination, drep, rep1, lead, handoff, spine, canon]
timestamp: 2026-10-05
---

# rep1 Task Brief — Spine Mirror Removal (2026-10-05)

**From:** Devin (ello lead, ello-repo-control)
**To:** Drep1 / rep1 (LEAD) — sigrank-mcp
**Full report:** `~/Developer/active/SigRank-repos/reports/sigrank-mcp/2026-10-05_spine-mirror-removal.md`

## State

Branch `chore/spine-mirror-removal`, commit `0b10525` — local, unpushed, unmerged.

- The four mirrored doc dirs and `scripts/sync-spine.mjs` are deleted; `sync:spine`/`spine:check`/`spine:diff` scripts and stale ignore entries removed; `REPO.yaml` `allowed_root_dirs_extra` no longer admits them (standard will flag reintroduction).
- All mcp-only repo-scope annotations salvaged into `docs/CLIENT_SCOPE_NOTES.md` — read it before touching docs; it holds real corrections the app copies lack.
- `npm test` green (test.mjs + 34/34 node --test), all five `sigrank://` resources still serve from `resources/`.

## Your queue

1. Review + merge the branch. Merge to main fires publish.yml — safe; the removed dirs were never in `files[]`.
2. **sigrank-app (after PR #202 `fix/search-recovery-01-index-surface` merges — worktree is on that branch now, do not touch mid-flight):**
   - remove the `spine:check` script (its `cd ../sigrank-mcp` is broken in the `_01_/_02_` layout anyway)
   - port salvaged corrections UP into the app docs (endpoint paths, signature mechanics, corrected `lib/` source paths — full list in the report)
   - stamp canon provenance on normative docs, or fold them into a search-authority projection — owner call
3. **Owner flag:** removed `ontology/metrics.md` copy had Yield(Υ)→Upsilon in its description — conflicts with canon (Upsilon=engine, Yield=metric). Flagged, not propagated. Owner rules before any app-side edit.
4. On next release, verify `sigrank.mcpb` regenerates without spine paths.

## Why (one line)

The mirror declared the app "source of truth" and pushed docs sideways between two canon consumers — never shipped, never read by code, never checked by CI, drifted 19 files in both directions. Canon flow is `search-authority → consumer`; the lateral contract is now gone.
