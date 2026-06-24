# sigrank-mcp

**SigRank terminal client + MCP server.** Check the leaderboard, score your token cascade, and publish your rank — directly from your terminal or any MCP-compatible agent (Claude Code, Cursor, Windsurf).

Zero external dependencies. Pure Node.js. No account required to read.

→ **[signalaf.com](https://signalaf.com)**

---

## Install

```bash
npx sigrank-mcp board
```

No install needed. `npx` runs it directly. Or install globally:

```bash
npm install -g sigrank-mcp
sigrank-mcp board
```

---

## Commands

### `board` — Live leaderboard

```bash
npx sigrank-mcp board            # live, refreshes every 30s
npx sigrank-mcp board --once     # print once and exit
npx sigrank-mcp board --window 7d
```

**Windows:** `7d` · `30d` (default) · `90d` · `all`

```
  ⊙ SigRank Leaderboard                          signalaf.com  02:00:49
  window: 30d  ·  25 operators
  ············································································
     #  Operator              Class            SIGNA     SNR   Depth    Tokens    7d Δ
  ············································································
   #1  TransVaultOrigin      TRANSMITTER       96.4   96.9%    26.1     18.4K      —
   #2  OrcaVanguard          TRANSMITTER       88.0   88.0%    23.0     16.0K      —
   #3  IronLattice           TRANSMITTER       84.0   84.0%    21.6     14.8K      —
   #4  PrismCartographer     ARCH+             79.3   79.2%    19.2     12.4K      —
   #5  MeridianScribe        ARCH+             76.1   76.4%    17.8     11.2K      —
  ············································································
```

---

### `me` — Your cascade

Score your own token usage across all four measurement windows.

```bash
npx sigrank-mcp me                        # auto-detects Claude Code
npx sigrank-mcp me --platform amp         # specify platform
npx sigrank-mcp me --compare              # side-by-side pillar comparison
```

**Supported platforms:** `claude` · `codex` · `amp` · `gemini` · `qwen` · `goose` · `kimi` · `droid` · `hermes` · `kilo` · `copilot` · `codebuff`

```
  ⊙ SigRank  ·  me                                signalaf.com
  platform: claude  ·  source: ~/.claude/projects

  window     Υ Yield    SNR      Leverage   10xDEV   Velocity   Class
  ─────────────────────────────────────────────────────────────────────
  7d          8 231.4   90.1%    1 823.4x    3.26      8.8x     TRANSMITTER
  30d        12 847.2   92.3%    2 041.1x    3.31      9.0x     TRANSMITTER
  90d        11 204.6   89.7%    1 994.8x    3.30      8.9x     TRANSMITTER
  all        18 436.98  90.0%    2 042.2x    3.31      9.0x     TRANSMITTER
```

> Token counts are read locally from your platform's log files. No content is ever read or transmitted — only token counts.

---

### `watch` — Real-time tune meter

Live-updating cascade as you work. Useful for actively optimizing a session.

```bash
npx sigrank-mcp watch            # refreshes every 30s
npx sigrank-mcp watch --window 7d
```

---

### `--version`

```bash
npx sigrank-mcp --version
# 0.7.0
```

---

## MCP server — use inside Claude Code / Cursor / Windsurf

Add to your MCP config (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "sigrank": {
      "command": "npx",
      "args": ["sigrank-mcp"]
    }
  }
}
```

Once wired, your agent can call these tools directly:

| Tool | What it does |
|---|---|
| `rank_paste(text)` | Paste token counts → Υ Yield + class + insight card |
| `get_leaderboard()` | Live public leaderboard |
| `get_operator(codename)` | One operator's live profile |
| `submit_paste(text, codename)` | Score locally + publish to the board |
| `tokenpull(platform?)` | Read local logs → 4-window cascade (no paste needed) |
| `tokenpull_submit(codename, window?)` | Zero-paste publish: read → sign → post |

**Example — score a paste inside Claude:**
```
rank_paste("1251211 11296121 128196310 2555179769")

→ Υ 18436.98 · SNR 90.0% · Leverage 2042.2x · Class: TRANSMITTER
→ "This operator holds both axes at once: 9.0x generation AND 2,042x memory leverage..."
```

---

## How the math works

SigRank ranks operators on **Υ Yield** — a single number that captures how efficiently
you use your AI platform's token budget:

```
Υ = (cache_read × output) / input²
```

Four pillars, one score. Higher is better. The cascade collapses into nine class tiers
from BASE to TRANSMITTER.

| Metric | Formula | What it means |
|---|---|---|
| **Υ Yield** | `(Cr × O) / I²` | Overall cascade efficiency |
| **SNR** | `Cr / (I + Cc)` | Signal-to-noise — how much you're pulling vs pushing |
| **Leverage** | `Cr / I` | Memory amplification — how hard your cache works |
| **10xDEV** | `log₁₀(Leverage)` | Orders of magnitude above baseline |
| **Velocity** | `O / I` | Generation rate — output per unit of input |

---

## Class tiers

```
TRANSMITTER   Υ ≥ 10,000    The closed kinetic loop. Both axes held simultaneously.
ARCH+         Υ ≥ 5,000     High leverage + strong generation.
ARCH          Υ ≥ 2,500     Architectural thinkers. Deep cache, structured output.
POWER+        Υ ≥ 1,000     Power users with efficient patterns.
POWER         Υ ≥  500      Consistent, deliberate operators.
CORE+         Υ ≥  200      Developing efficiency. Cache awareness emerging.
CORE          Υ ≥   50      Active operators. Signal accumulating.
SIGNAL        Υ ≥   10      Early signal. Patterns not yet locked.
BASE          Υ <   10      Baseline. Every operator starts here.
```

---

## Privacy

- **Token counts only.** No message content is read, logged, or transmitted — ever.
- **Local by default.** `me` and `watch` read files on your device only. Numbers stay local unless you explicitly publish.
- **No account required.** Reading the leaderboard is fully anonymous.
- **Background tooling excluded.** Memory plugins and observers are filtered out automatically.

---

## Links

- **Leaderboard:** [signalaf.com](https://signalaf.com)
- **Agent (publish your own data):** [sigrank-agent on PyPI](https://pypi.org/project/sigrank-agent/)
- **npm:** [npmjs.com/package/sigrank-mcp](https://www.npmjs.com/package/sigrank-mcp)
- **Source:** [github.com/SunrisesIllNeverSee/sigrank-mcp](https://github.com/SunrisesIllNeverSee/sigrank-mcp)

---

## License

MIT — © 2026 Deric J. McHenry / Ello Cello LLC
