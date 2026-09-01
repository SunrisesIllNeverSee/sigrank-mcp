# SigRank × Vercel

SigRank has two remote-MCP deployment modes for Vercel users.

## 1. Canonical hosted endpoint

Use the maintained Streamable HTTP server directly:

```text
https://signalaf.com/api/mcp
```

This is the preferred zero-install path.

## 2. Project-owned Vercel endpoint

Deploy the relay starter:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSunrisesIllNeverSee%2Fsigrank-mcp%2Ftree%2Fmain%2Fexamples%2Fvercel-remote-mcp&project-name=sigrank-mcp&repository-name=sigrank-mcp-vercel)

The deployment exposes:

```text
https://YOUR-PROJECT.vercel.app/api/mcp
```

and relays requests to the canonical server. This deliberately preserves one implementation of SigRank's remote tools and cascade behavior.

## Vercel acquisition surface

The companion page at `https://signalaf.com/vercel` contains:

- one-click deploy;
- canonical MCP endpoint configuration;
- Vercel Agent Tools / Marketplace positioning;
- a free public deployment diagnostic for rendered metadata, robots, sitemap, `llms.txt`, MCP discovery, and real 404 behavior.

## Marketplace / Agent Tools boundary

The MCP endpoint is implementation-ready. Public Marketplace publication still requires a Vercel integration/provider record and Vercel's external review/approval flow. Do not fork the MCP implementation to satisfy that process; configure the integration to use the canonical remote MCP surface.
