# SigRank Remote MCP on Vercel

Deploy a project-owned Vercel endpoint for the canonical SigRank remote MCP server.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSunrisesIllNeverSee%2Fsigrank-mcp%2Ftree%2Fmain%2Fexamples%2Fvercel-remote-mcp&project-name=sigrank-mcp&repository-name=sigrank-mcp-vercel)

## What gets deployed

Your deployment exposes:

```text
https://YOUR-PROJECT.vercel.app/api/mcp
https://YOUR-PROJECT.vercel.app/.well-known/mcp.json
https://YOUR-PROJECT.vercel.app/llms.txt
```

The MCP endpoint forwards Streamable HTTP requests to the canonical server:

```text
https://signalaf.com/api/mcp
```

The server card and `llms.txt` advertise the project-owned endpoint to agents while pointing back to the canonical SigRank documentation and upstream implementation.

This architecture is deliberate: the Vercel deployment gives you a project-owned endpoint while keeping SigRank scoring, tools, and benchmark behavior on one canonical implementation instead of duplicating metric logic.

## MCP client configuration

```json
{
  "mcpServers": {
    "sigrank": {
      "url": "https://YOUR-PROJECT.vercel.app/api/mcp"
    }
  }
}
```

No environment variables are required.

## Direct hosted option

If you do not need a project-owned relay, use the canonical endpoint directly:

```text
https://signalaf.com/api/mcp
```

Full tool documentation: https://signalaf.com/mcp
