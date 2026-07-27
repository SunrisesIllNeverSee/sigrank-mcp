# SigRank MCP Versioning Ruleset

> **Status:** Active — enforced as of 2026-07-14, updated 2026-07-27 (manual versioning)
> **Supersedes:** The 0.18.x / 0.19.x whole-number bumps (release-please default semver)

## The Rule

**All MCP releases use the `0.0.NNN` format**, where `NNN` is a monotonically incrementing 3-digit patch number.

```
0.0.175 → 0.0.176 → 0.0.177 → 0.0.178 → 0.0.179 → ... → 0.0.999
```

## Why 3-digit?

1. **Continuity.** The MCP shipped as 0.0.175–0.0.177 for months. Whole-number bumps (0.18.0, 0.19.0) broke the sequence and made it look like a different project.
2. **Signal.** A high patch number (0.0.178) communicates "mature, many iterations" — which is true. A low minor number (0.19.0) communicates "early, few releases" — which is false.
3. **Simplicity.** One number going up. No minor/major debate. Every release → next number.
4. **npm compatibility.** npm sorts versions correctly — `0.0.178 > 0.0.177`. The `latest` tag always points to the highest published version.

## What happens at 0.0.999?

When we hit 0.0.999, the next release is **1.0.0**. This is the only time the format changes — it signals a real 1.0 milestone (stable API, full docs, academic publication).

## How releases work (manual — release-please removed 2026-07-23)

Release-please was removed on 2026-07-23 (`adeeb65`). It was causing version jumps (0.0.178 → 0.11.4 → 0.19.0) despite `bump-patch-only: true` being set, and the branches it created triggered failed Vercel builds on the sigrank-app repo. Versioning is now fully manual:

1. **Owner says "publish" or "ship a new version"** — that's the only trigger (per AGENTS.md). Do not auto-bump, do not suggest publishing.
2. **Bump `package.json`** version `0.0.NNN → 0.0.NNN+1`.
3. **Update `CHANGELOG.md`** with the changes since the last tag (`git log v0.0.NNN..HEAD`).
4. **Commit** the bump + CHANGELOG (+ any ruleset updates) as one commit.
5. **Tag** `git tag v0.0.NNN+1` and push the commit + tag.
6. **Create GitHub release** from the tag (optional but recommended for the release notes).
7. **Owner runs `npm publish`** from the repo dir (manual — the npm token is not in CI).
8. **Owner syncs MCP registries** (Glama, Smithery, etc.) — manual, 3-4 steps.

> **Batch changes.** Per AGENTS.md: do not publish for small changes. Accumulate fixes/features in git. Publish when there's a meaningful batch — multiple fixes, a new feature, or a scheduled release.

## What NOT to do

- **No minor bumps** (0.1.0, 0.18.0, 0.19.0) — these break the sequence.
- **No major bumps** (1.0.0, 2.0.0) — reserved for the real 1.0 milestone.
- **No skipping numbers** — every release gets the next sequential number.
- **No unpublishing** — npm doesn't allow it after 72 hours. Bad versions stay published but get superseded by `latest`.
- **No auto-bumping** — version bumps happen only on explicit owner instruction.

## Current state (2026-07-27)

| Version | Status | Notes |
|---------|--------|-------|
| 0.0.175–0.0.177 | Published (legacy) | The original sequence |
| 0.17.1–0.17.5 | Published (legacy) | Whole-number experiment — deprecated |
| 0.18.0–0.18.5 | Published (legacy) | Whole-number experiment — deprecated |
| 0.19.0 | Published (legacy) | Last whole-number bump — deprecated |
| 0.0.178 | Published (`latest`) | Resumed the 3-digit sequence; restructure + consent wiring shipped in git but not yet published |
| **0.0.179** | **Tagged, not yet published** | Observatory-spine restructure + consent flows + CI fixes. `npm publish` pending owner action. |

The `latest` tag on npm points to 0.0.178. Once 0.0.179 is published, it becomes `latest` (0.0.179 > 0.0.178 in semver — both are `0.0.x`, so the patch number sorts correctly).

> **Note on the 0.18.x/0.19.0 legacy versions:** npm semver considers `0.19.0 > 0.0.178` because minor (19) > minor (0). If `latest` ever drifts back to a 0.19.x version (e.g. via a stray publish), force it back with:
> ```bash
> npm dist-tag add sigrank@0.0.179 latest
> ```
> Consider deprecating the legacy whole-number versions:
> ```bash
> npm deprecate sigrank@0.19.0 "Use 0.0.178+ (3-digit versioning)"
> npm deprecate sigrank@0.18.5 "Use 0.0.178+ (3-digit versioning)"
> # etc.
> ```

## Enforcement

The `scripts/check-version.mjs` script (to be added) will fail CI if:
- The version in `package.json` is not `0.0.NNN` format
- The version skips a number
- The version uses minor/major bumps
