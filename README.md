# SigRank CLI & MCP

Read your local AI usage, inspect the token cascade, and optionally publish a signed snapshot to the [SigRank leaderboard on SignalAF](https://signalaf.com).

```bash
npx sigrank
```

[![npm](https://img.shields.io/npm/v/sigrank.svg?style=flat-square)](https://www.npmjs.com/package/sigrank)
[![CI](https://github.com/SunrisesIllNeverSee/sigrank-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SunrisesIllNeverSee/sigrank-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](./LICENSE)

**[Website](https://signalaf.com) · [Quickstart](#get-started) · [MCP setup](#connect-an-mcp-client) · [Tool and adapter reference](./docs/CLI-MCP-REFERENCE.md) · [Privacy](#privacy)**

## What it does

- Reads usage metadata from supported local AI session logs.
- Shows input, output, cache-write, and cache-read counts across available time windows.
- Calculates Yield, Leverage, Velocity, SNR, and 10xDEV locally.
- Provides a terminal dashboard and MCP tools for AI clients.
- Submits signed telemetry only when you choose to publish.

This evaluates observable token-processing patterns, not model quality, work quality, productivity, or business outcomes. An adapter may estimate a pillar when its source does not expose it separately; those limitations are documented in the [adapter reference](./docs/CLI-MCP-REFERENCE.md#platform-adapters).

## Get started

Requires **Node.js 20 or later**. No global install is required.

### Explore locally

```bash
npx sigrank                       # interactive dashboard in a terminal
npx sigrank board --once          # public leaderboard, one-shot
npx sigrank board --window 7d --once
```

The dashboard includes Dashboard, Trends, Compare, Board, Watch, and Connect tabs. Use `1`–`6` or the arrow keys to switch, `R` to refresh, and `Q` to quit.

### Publish your own snapshot

1. Sign in at [signalaf.com](https://signalaf.com) and create a connect code in Settings.
2. Enroll this device, then inspect the dry-run payload.
3. Submit when you are ready to publish.

```bash
npx sigrank enroll
npx sigrank submit --dry-run
npx sigrank submit
```

Enrollment binds a device signing key to your operator account. The private key stays on your device. The server verifies and re-scores submitted telemetry; a local preview is not a guaranteed public rank.

For repeated use, an optional global installation provides the same commands:

```bash
npm install -g sigrank
sigrank
```

## Connect an MCP client

Add this server to your client's MCP configuration:

```json
{
  "mcpServers": {
    "sigrank": {
      "command": "npx",
      "args": ["-y", "sigrank"]
    }
  }
}
```

The entry point automatically runs an MCP stdio server when launched without a terminal. MCP tool names are called by the client; they are not shell commands.

| Task | Tools |
| --- | --- |
| Inspect local usage | `tokenpull`, `rank_windows`, `tokenpull_compare` |
| Calculate from supplied counts | `rank_paste`, `get_sigrank_standard_record` |
| Read public results | `get_leaderboard`, `get_operator`, `discover_peers` |
| Explore possible changes | `diagnose_cascade`, `simulate_change`, `suggest_improvements` |
| Enroll and submit | `enroll`, `submit_verified` |

For the full list, arguments, and adapter paths, see the [CLI and MCP reference](./docs/CLI-MCP-REFERENCE.md). Publishing through `submit_verified` requires `confirm: true`; `dry_run: true` inspects the payload without publishing.

## Command guide

| Command | Purpose |
| --- | --- |
| `sigrank` | Open the terminal dashboard |
| `sigrank board --once` | Print the public leaderboard |
| `sigrank compare --platform codex` | Audit token counts across available local sources |
| `sigrank watch --window 7d` | Watch local usage updates |
| `sigrank enroll` | Bind a device using a connect code |
| `sigrank submit --dry-run` | Inspect a signed submission without sending it |
| `sigrank submit` | Publish a verified submission |
| `sigrank proxy` | Start the optional loopback usage proxy |
| `sigrank --help` | Show the current command reference |

### Optional usage proxy

Some clients do not persist all provider-reported usage in their session files. `sigrank proxy` can capture usage from compatible Anthropic or OpenAI API traffic when a client supports a custom API base URL.

The proxy is **off by default** and binds only to loopback. It forwards provider-bound request/response content and credentials in memory, but does not persist their content. Its local usage log contains token counts and metadata. See the [privacy contract](./docs/CLI-MCP-REFERENCE.md#privacy) before using it.

## How measurement works

Four token pillars feed the calculation:

```text
Yield (Υ) = (cache_read × output) / input²
Leverage  = cache_read / input
Velocity  = output / input
SNR       = output / (input + output)
10xDEV    = log₁₀(Leverage)
```

This package distributes the **Upsilon** measurement engine through the `sigrank` CLI/MCP compatibility command. **SigRank** is the public leaderboard and proof surface on **SignalAF**. **TTEOP** defines the protocol semantics; **MO§ES™** is the governance framework.

The implementation delegates canonical calculations through `token-cascade` to `tteop-spec`. See the [TTEOP implementation profile](./TTEOP-IMPLEMENTATION-PROFILE.md) and [protocol compatibility notes](./docs/PROTOCOL-COMPATIBILITY.md).

## Privacy

Local inspection does not publish your usage. Signed submissions include the four pillars plus account/device identifiers, signature, platform/version information, counts, and report metadata. Enrollment also sends a device label.

Prompt text, response text, source code, repository contents, and local file paths are not part of the ranked submission payload. The optional proxy's transient handling of content is separate from what is persisted or submitted.

Read the [full payload and privacy details](./docs/CLI-MCP-REFERENCE.md#privacy), and use `submit --dry-run` to inspect what would be sent.

## Development

```bash
git clone https://github.com/SunrisesIllNeverSee/sigrank-mcp.git
cd sigrank-mcp
npm install
npm test
npm run test:packaged
```

Run `node index.mjs` in a terminal for the dashboard, or configure the checked-out entry point in an MCP client. Release versions are managed by the repository's explicit publishing workflow; a documentation commit does not publish an npm release.

## Related projects

- [sigrank-app](https://github.com/SunrisesIllNeverSee/sigrank-app) — SignalAF website, profiles, public API, and leaderboard.
- [token-cascade](https://www.npmjs.com/package/token-cascade) — measurement implementation consumed by this package.
- [TTEOP](https://github.com/SunrisesIllNeverSee/otep-spec) — protocol specification and semantics.

## Contributing and security

See the [contributing guide](./.github/CONTRIBUTING.md). Open bugs in [GitHub Issues](https://github.com/SunrisesIllNeverSee/sigrank-mcp/issues); report vulnerabilities privately through the [security policy](https://github.com/SunrisesIllNeverSee/sigrank-mcp/security/policy).

## License

[MIT](./LICENSE).
