# SigRank Quick Start

## Install

```bash
npx sigrank
```

No global install needed. The MCP server starts automatically when an AI client (Claude, Cursor, Cline) connects.

## First Submission

1. **Enroll** — register your operator codename:
   ```bash
   npx sigrank enroll
   ```

2. **Pull + Submit** — scan your local AI session logs and publish:
   ```bash
   npx sigrank submit
   ```

3. **Dry Run** — see exactly what would be sent before publishing:
   ```bash
   npx sigrank submit --dry-run
   ```

## Token Pull Sources

SigRank bundles two token readers as npm dependencies:
- **ccusage** — Claude Code session logs
- **tokscale** — multi-platform token telemetry

A third source, **token-dashboard**, is read from `~/.claude/token-dashboard.db` (SQLite).
That DB is created by [Nate's token-dashboard](https://github.com/nateherkai/token-dashboard) (Python):
```bash
git clone https://github.com/nateherkai/token-dashboard.git
cd token-dashboard
python3 cli.py dashboard
```
Run the scan once to create the DB; SigRank reads it directly via sqlite3 after that.

## MCP Client Setup

Add to your MCP client config:
```json
{
  "mcpServers": {
    "sigrank": {
      "command": "npx",
      "args": ["sigrank"]
    }
  }
}
```

## Live Board

Visit https://signalaf.com to see the global leaderboard.
