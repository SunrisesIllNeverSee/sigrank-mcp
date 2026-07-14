# SigRank MCP Versioning Ruleset

> **Status:** Active — enforced as of 2026-07-14  
> **Supersedes:** The 0.18.x / 0.19.x whole-number bumps (release-please default semver)

## The Rule

**All MCP releases use the `0.0.NNN` format**, where `NNN` is a monotonically incrementing 3-digit patch number.

```
0.0.175 → 0.0.176 → 0.0.177 → 0.0.178 → 0.0.179 → ... → 0.0.999
```

## Why 3-digit?

1. **Continuity.** The MCP shipped as 0.0.175–0.0.177 for months. Whole-number bumps (0.18.0, 0.19.0) broke the sequence and made it look like a different project.
2. **Signal.** A high patch number (0.0.178) communicates "mature, many iterations" — which is true. A low minor number (0.19.0) communicates "early, few releases" — which is false.
3. **Simplicity.** One number going up. No minor/major debate. Every merge → next number.
4. **npm compatibility.** npm sorts versions correctly — `0.0.178 > 0.0.177`. The `latest` tag always points to the highest published version.

## What happens at 0.0.999?

When we hit 0.0.999, the next release is **1.0.0**. This is the only time the format changes — it signals a real 1.0 milestone (stable API, full docs, academic publication).

## How releases work

1. **Conventional commits** on main trigger release-please (GitHub Action).
2. Release-please opens a PR bumping `0.0.NNN → 0.0.NNN+1` + updating CHANGELOG.md.
3. Merge the PR → GitHub release created with tag `v0.0.NNN`.
4. Owner runs `npm publish` from the repo dir (manual — the npm token is not in CI).

## release-please configuration

The release workflow is configured with `bump-patch-only: true` to prevent minor/major bumps. Every conventional commit (feat, fix, chore, docs) produces a patch bump only.

## What NOT to do

- **No minor bumps** (0.1.0, 0.18.0, 0.19.0) — these break the sequence.
- **No major bumps** (1.0.0, 2.0.0) — reserved for the real 1.0 milestone.
- **No skipping numbers** — every merge gets the next sequential number.
- **No unpublishing** — npm doesn't allow it after 72 hours. Bad versions stay published but get superseded by `latest`.

## Current state (2026-07-14)

| Version | Status | Notes |
|---------|--------|-------|
| 0.0.175–0.0.177 | Published (legacy) | The original sequence |
| 0.17.1–0.17.5 | Published (legacy) | Whole-number experiment — deprecated |
| 0.18.0–0.18.5 | Published (legacy) | Whole-number experiment — deprecated |
| 0.19.0 | Published (legacy) | Last whole-number bump — deprecated |
| **0.0.178** | **Next** | Resumes the 3-digit sequence from 0.0.177 |

The `latest` tag on npm points to the highest version number. Once 0.0.178 is published, it becomes `latest` (0.0.178 > 0.19.0 in semver? **No** — semver sorts 0.19.0 > 0.0.178 because 19 > 0 in the minor position).

**Correction:** npm semver considers `0.19.0 > 0.0.178` because minor (19) > minor (0). So publishing 0.0.178 will NOT make it `latest`. We need to use `npm dist-tag` to force it:

```bash
npm publish                    # publishes 0.0.178
npm dist-tag add sigrank@0.0.178 latest  # force latest to 0.0.178
```

Or, simpler: publish 0.0.178 and then `npm deprecate` the 0.18.x/0.19.0 versions:

```bash
npm deprecate sigrank@0.19.0 "Use 0.0.178+ (3-digit versioning)"
npm deprecate sigrank@0.18.5 "Use 0.0.178+ (3-digit versioning)"
# etc.
```

## Enforcement

The `scripts/check-version.mjs` script (to be added) will fail CI if:
- The version in `package.json` is not `0.0.NNN` format
- The version skips a number
- The version uses minor/major bumps
