# SigRank MCP — Agent Rules

## Publishing

**Do NOT publish to npm for small changes.** Each npm publish requires 3-4
manual steps (owner: bump version, publish, sync MCP registry, sync Smithery).
Publishing one tiny fix burns the owner's time and pollutes the version history.

**Batch changes.** Accumulate fixes/features in git. Publish when there's a
meaningful batch — multiple fixes, a new feature, or a scheduled release.

**Never publish without explicit owner instruction.** The owner says "publish"
or "ship a new version" — that's the only trigger. Do not suggest publishing,
do not auto-bump versions, do not run `npm publish` on your own.

**Version scheme: `0.0.x` only.** Never use 2-digit versions (0.18.x, 0.19.x).
They pollute the npm version history and break the monotonic sequence.
