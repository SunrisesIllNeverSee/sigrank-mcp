---
type: Reference
title: Protocol Compatibility — MCP Era Negotiation
description: Which MCP protocol revisions this server serves on stdio, how era selection works, and what hosts/clients can rely on. Phase 2B contract. Active.
tags: [sigrank, mcp, protocol, 2026-07-28, compatibility, era, reference]
timestamp: 2026-10-05
---

# Protocol Compatibility — MCP Era Negotiation

The server is entered through `serveStdio` (`@modelcontextprotocol/server/stdio`,
SDK `2.3.0`), which owns era selection per connection. One factory builds one
server instance per connection; the same tool/prompt/resource handlers back
both eras.

## Served eras

| Era | Wire revision | Opening | Status |
|---|---|---|---|
| Legacy | `2024-10-07` … `2025-11-25` | `initialize` handshake | **Retained — default for unprobed openings** |
| Modern | `2026-07-28` | `server/discover` with envelope | **Served — opt-in per connection** |

`legacy: 'serve'` is the posture: this server never refuses a 2025-era
client. There is no plan to flip to `legacy: 'reject'`; if that ever changes
it is a breaking release, not a patch.

## How era selection works

The first request classifies the connection:

- `initialize` **without** a modern `_meta` envelope → legacy, pinned for the
  connection's lifetime. This is byte-for-byte the pre-2B behavior.
- `server/discover` carrying a valid modern envelope
  (`_meta["io.modelcontextprotocol/protocolVersion"]: "2026-07-28"` +
  `io.modelcontextprotocol/clientCapabilities`) → modern probe, pinned once
  the next request arrives.
- A claim-less `server/discover` is legacy traffic (the legacy instance has
  no such method → `-32601`). The envelope is the claim — required.
- `server/discover` followed by a bare `initialize` **on the same
  connection** discards the probe instance and serves the legacy handshake —
  auto-negotiating clients (`versionNegotiation: 'auto'`) work unmodified.
- `initialize` on an already modern-pinned connection → `-32022`
  (`Unsupported protocol version`, `data.supported: ["2026-07-28"]`), the
  spec's corrective-continuation signal.

## What changes on a modern connection

- Server identity moves into result `_meta`
  (`io.modelcontextprotocol/serverInfo`) — the discover result carries it;
  there is no `initialize` response.
- `getClientCapabilities()` / `getClientVersion()` would return `undefined`
  on modern pins — this server **reads neither**, so handlers are era-clean.
- Unknown-tool/prompt/resource errors stay `-32602` in both eras;
  `isError` tool results are unchanged. Era selection never changes tool
  semantics — same TOOLS table, same canonical record, same I/O/W/R.
- stdout remains protocol-only on both eras (locked by tests).

## Host/client matrix

| Client shape | Negotiates | Works? |
|---|---|---|
| SDK v1.x / 2025-era clients (`initialize` only) | legacy | ✅ |
| SDK v2 client, default (`versionNegotiation` absent) | legacy | ✅ |
| SDK v2 client `mode: 'auto'` (probes via sibling stdio process or in place) | modern | ✅ |
| SDK v2 client `{ pin: '2026-07-28' }` | modern | ✅ |
| Hand-rolled modern client (envelope'd `server/discover` first) | modern | ✅ |
| Old proxies that never probe (Glama, mcp-proxy, container stdio) | legacy | ✅ |

Contract lock: `__tests__/mcp-stdio.test.mjs` — 15 legacy-era tests +
9 modern-era tests, all asserting identical surface.
