# SigRank MCP Versioning Ruleset

> **Status:** Active — updated 2026-08-27 (graduated to 1.0.x)
> **Supersedes:** The 0.0.NNN 3-digit ruleset (2026-07-14 through 2026-08-26)
> **History:** The 0.18.x / 0.19.x whole-number bumps (release-please default semver) were deprecated 2026-07-14. The 0.0.NNN 3-digit scheme was used 2026-07-14 through 2026-08-26. Graduated to 1.0.x on 2026-08-27 to fix MCP Registry semver sorting.

## The Rule

**All MCP releases use the `1.0.NNN` format**, where `NNN` is a monotonically incrementing patch number (third decimal).

```
1.0.0 → 1.0.1 → 1.0.2 → 1.0.3 → ... → 1.0.999
```

The patch (third decimal) increments on every release. No minor bumps, no major jumps.

## Why 1.0.x?

The `0.0.x` scheme was retired early (at 0.0.232, before reaching 0.0.999) because of a **semver sorting conflict with the MCP Registry**:

```
0.17.2 > 0.0.232    (semver: minor 17 > minor 0)
1.0.0 > 0.19.0      (semver: major 1 > major 0)
```

Legacy versions `0.17.x`, `0.18.x`, `0.19.x` were published during a whole-number experiment in July 2026. Under the `0.0.x` scheme, the MCP Registry treated `0.17.2` as "latest" forever, because semver sorts `0.17.2 > 0.0.232`. Graduating to `1.0.x` fixes this — `1.0.0` sorts above all legacy versions.

The patch-in-third-decimal pattern is preserved: every release still bumps one number. The only change is the prefix (`1.0.` instead of `0.0.`).

## What happens at 1.0.999?

When we hit 1.0.999, the next release is **2.0.0**. Same graduation pattern.

## How releases work (auto-publish workflow)

The `.github/workflows/publish.yml` workflow handles versioning automatically:

1. **Push to main** triggers the workflow (if CI passes).
2. **Tests run** (unit, signing, TUI, version format check, pack check).
3. **`npm version patch`** bumps the third decimal: `1.0.NNN → 1.0.NNN+1`.
4. **`npm publish`** publishes the new version to npm.
5. **`mcp-publisher publish`** publishes the updated `server.json` to the MCP Registry.
6. **Version commit** is pushed back to main (package.json + server.json + manifest.json).

Manual publishing is still possible if the workflow is broken (bump version, commit, push, `npm publish`, `mcp-publisher publish`).

> **Batch changes.** Per AGENTS.md: do not publish for small changes. Accumulate fixes/features in git. Publish when there's a meaningful batch.

## What NOT to do

- **No minor bumps** (1.1.0, 1.2.0) — these break the sequence.
- **No major bumps** (2.0.0, 3.0.0) — reserved for graduation at 1.0.999.
- **No skipping numbers** — every release gets the next sequential patch number.
- **No unpublishing** — npm doesn't allow it after 72 hours. Bad versions stay published but get superseded by `latest`.
- **No auto-bumping outside the workflow** — the publish workflow handles bumps. Manual bumps only when the workflow is broken.

## Current state (2026-08-27)

| Version range | Status | Notes |
|---------------|--------|-------|
| 0.0.175–0.0.177 | Published (legacy) | The original 0.0.x sequence |
| 0.17.1–0.17.5 | Published (legacy) | Whole-number experiment — deprecated |
| 0.18.0–0.18.5 | Published (legacy) | Whole-number experiment — deprecated |
| 0.19.0 | Published (legacy) | Last whole-number bump — deprecated |
| 0.0.178–0.0.232 | Published (legacy) | 3-digit sequence, now superseded by 1.0.x |
| **1.0.0** | **Current** | Graduated from 0.0.x to fix MCP Registry semver sorting |

The `latest` tag on npm points to the highest `1.0.x` version. All legacy versions (`0.0.x`, `0.17.x`, `0.18.x`, `0.19.x`) sort below `1.0.0` in semver.

> **Deprecating legacy versions (optional):**
> ```bash
> npm deprecate sigrank@0.19.0 "Use 1.0.x+ (graduated versioning)"
> npm deprecate sigrank@0.18.5 "Use 1.0.x+ (graduated versioning)"
> npm deprecate sigrank@0.17.2 "Use 1.0.x+ (graduated versioning)"
> ```

## Enforcement

The `scripts/check-version.mjs` script fails CI if:
- The version in `package.json` is not `0.0.NNN` (legacy) or `1.0.NNN` (current) format
- The patch number exceeds 999
- The version uses minor bumps or unauthorized major jumps
