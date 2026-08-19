# TUI Visual Audit — Neutral Build-Out Prompt

> **Purpose:** Audit YOUR TUI MCP. This prompt is product-neutral.
> It does NOT preload any specific product's TUI, data, or branding.
> Point it at YOUR TUI module and it audits YOUR tabs.

---

## What this does

A headless TUI review system that renders every tab at multiple terminal sizes and checks:

1. **Overflow** — lines wider than the terminal (would wrap/garble)
2. **Truncation** — labels cut short with "…" or missing columns
3. **Dead space** — empty rows inside a tab that could hold content
4. **Alignment** — column headers misaligned with their data rows
5. **Color health** — lines with no color at all (might be missing styling)
6. **Graph integrity** — sparkline/bar functions tested with known inputs
7. **Budget analysis** — rows used vs available, where content could expand

Also supports:
- `--golden-save` — write rendered frames to `.tui-golden/` for CI baseline
- `--golden-check` — compare current render against saved golden frames
- `--svg` — export each tab as an SVG screenshot
- `--png` — export each tab as a PNG (2x retina)
- `--ci` — exit non-zero on HIGH severity issues (for CI gates)

Runs every theme (dark/light/high-contrast/monochrome) so rendering regressions
in any palette are caught.

---

## How to use it

### Option A: Import and call with your config

```javascript
import { runAudit, formatAuditReport } from "./dev/tui-audit.mjs";

const audit = await runAudit({
  config: {
    productName: "YourApp",           // shows in report headers
    tuiPath: "./presentation/tui.mjs", // YOUR TUI module
    themePath: "./presentation/tui-themes.mjs", // YOUR theme module
    tabs: [
      {
        label: "Dashboard",
        render: async (ctx) => {
          // ctx.tui = your TUI module's exports
          // ctx.data = whatever you loaded (see loadData below)
          // Call YOUR render function here
          ctx.tui.renderDashboard(ctx.data);
        },
      },
      {
        label: "Settings",
        render: async (ctx) => {
          ctx.tui.renderSettings(ctx.data);
        },
      },
      // ... add one entry per tab in YOUR TUI
    ],
  },
  ci: true,  // exit 1 on HIGH issues
});

console.log(formatAuditReport(audit));
process.exit(audit.ciExitCode);
```

### Option B: Copy the audit tool into your repo

1. Copy `dev/tui-audit.mjs` into your project
2. Create a config like the example above
3. Run it: `node your-audit-runner.mjs`

### Your TUI module must export

The audit tool expects your TUI module to export:

```javascript
export {
  startBuffer,    // () => void — starts capturing output to an internal buffer
  stripAnsi,      // (str) => str — strips ANSI escape codes for width analysis
  _getScreenBuf,  // () => string[] — returns the captured buffer lines
  _resetBuf,      // () => void — clears the buffer
  // ... your render functions (renderDashboard, renderBoard, etc.)
};
```

### Your theme module must export

```javascript
export {
  setTheme,       // (name) => void — switches the active theme
  getThemeNames,  // () => string[] — returns ['dark', 'light', ...]
};
```

If you don't have a theme system, you can use a stub:

```javascript
// tui-themes.mjs (minimal stub)
const _themes = { dark: {} };
export let currentTheme = _themes.dark;
export function setTheme(name) { currentTheme = _themes[name] || _themes.dark; }
export function getThemeNames() { return Object.keys(_themes); }
```

---

## Config reference

```typescript
interface AuditConfig {
  productName: string;          // shown in report headers
  tuiPath: string;              // import path to your TUI module
  themePath: string;            // import path to your theme module
  tabs: TabConfig[] | null;     // null = use SigRank defaults (backward compat)
}

interface TabConfig {
  label: string;                // tab name shown in the report
  render: (ctx: RenderContext) => void | Promise<void>;
}

interface RenderContext {
  tui: any;                     // your TUI module's exports
  dashData: any;                // data loaded by the audit (or null)
  compareData: any;
  boardData: any;
  watchData: any;
  identity: any;                // from keystore.mjs loadIdentity() (or null)
}
```

---

## What the audit checks

For each tab × each terminal size × each theme:

- **Overflow**: any line wider than the terminal width
- **Truncation**: labels ending with "…" or suspiciously short
- **Dead space**: consecutive empty rows that could hold content
- **Alignment**: column headers vs data row column positions
- **Color health**: lines with zero ANSI color codes (might be unstyled)
- **Graph integrity**: sparkline/bar functions tested with known inputs
- **Budget**: rows used vs terminal height (how much space is wasted)
- **Responsive**: does the tab use extra width at 140 cols vs 80 cols?
- **Visual weight**: % of lines with graphs/bars vs plain text

Terminal sizes tested:
- 80×24 (minimal — small IDE panel / SSH default)
- 100×30 (standard — typical terminal)
- 120×40 (wide — large terminal / tmux split)
- 140×50 (ultrawide — full-screen on large monitor)

---

## CI integration

```yaml
# .github/workflows/tui-audit.yml
name: TUI Audit
on: [push, pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: node dev/tui-audit-runner.mjs --ci
```

The `--ci` flag exits with code 1 if any HIGH severity issues are found.

---

## Golden frames

Save a baseline: `node your-runner.mjs --golden-save`
Check against baseline: `node your-runner.mjs --golden-check`

Golden frames are saved to `.tui-golden/` and should be committed to the repo.
When you intentionally change the layout, re-save golden frames and commit them.

---

## Important notes

- **This is YOUR audit.** It renders YOUR TUI tabs with YOUR data.
  The audit tool itself is product-neutral — it doesn't preload any
  specific product's TUI, data loaders, or branding.
- **No external dependencies.** Pure ANSI buffer analysis.
  SVG/PNG export uses `@resvg/resvg-js` (optional, dev-only).
- **Privacy-safe.** The audit runs locally. No data leaves your machine.
