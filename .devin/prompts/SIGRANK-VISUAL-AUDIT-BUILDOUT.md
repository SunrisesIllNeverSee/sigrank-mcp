# SigRank Visual Audit Build-Out — Full Gold-Plate Spec

> **Status:** Draft for owner approval
> **Author:** Drep2
> **Date:** 2026-08-18
> **Scope:** Both repos — `_02_sigrank-mcp` (TUI) and `_01_sigrank-app` (web)
> **Canon:** Search Authority master canon governs all product/metric/terminology changes

---

## What we have

| Layer | Tool | Status |
|-------|------|--------|
| TUI audit | `presentation/tui-audit.mjs` (1123 lines) | Built, 9 check categories, A-F grades, CI mode, golden frames, SVG export |
| Web perf/a11y | Lighthouse CI (`lighthouserc.json`) | 4 URLs, warn-level thresholds |
| Web e2e | Playwright (`e2e/*.spec.ts`) | 4 specs: leaderboard, score-paste, profile, theme-cycle |
| Web a11y | Axe in Playwright | Informational only (logs violations, doesn't fail) |
| Web visual layout | — | **Nothing. No automated visual layout review.** |
| TUI CI integration | — | **Nothing. Audit exists but isn't wired into CI.** |
| TUI keybinding tests | — | **Nothing. 15+ keybindings, none tested.** |
| TUI render perf | — | **Nothing. No timing measurement.** |

## What's wrong right now

The audit found real issues that we haven't fixed:

1. **Board tab overflows at 100 cols** — 21 consecutive lines are 106 cols wide, overflow by 6. Every user on a standard terminal sees garbled/wrapped rows.
2. **Connect tab overflows at 100 cols** — help text is 109 cols, overflows by 9.
3. **Dashboard overflows at 80 cols** — cascade table is 99 cols, overflows by 19.
4. **Compare has dead-space** — 3-4 consecutive empty rows between the source table and cascade metrics.
5. **6 tabs don't adapt to wider terminals** — Trends, Board, Watch, Connect render identical content at 80 cols and 140 cols. Extra width is wasted.
6. **22 frames are text-heavy** — Connect is 80% text / 0.2% graph. Watch is 63% text / 0% graph. Board is 51% text / 0% graph. Owner explicitly wants more mini-graphs.

---

## Build-out plan (9 workstreams)

### WS-1: Wire TUI audit into CI

**Repo:** `_02_sigrank-mcp`
**File:** `.github/workflows/tui-audit.yml` (new)

Add a CI job that runs on every PR and push to main:

```yaml
name: TUI Audit

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  tui-audit:
    name: TUI layout audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: TUI audit (CI mode)
        run: node presentation/tui.mjs --audit --ci
      - name: Golden frame check
        run: node presentation/tui.mjs --audit --golden-check
      - name: Upload SVG screenshots on failure
        if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: tui-screenshots
          path: .tui-screenshots/
          retention-days: 14
```

**Acceptance:**
- PRs that introduce overflow or HIGH severity issues are blocked.
- Golden frame drift is detected and reported.
- SVG screenshots are uploaded as artifacts on failure for visual review.

**Dependencies:** Commit golden frames first (`--golden-save`), then commit `.tui-golden/` to the repo (remove from `.gitignore`).

---

### WS-2: Fix the issues the audit already found

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui.mjs`

#### Board overflow (106 cols at 100-col terminal)

The Board table has columns: `#`, `Codename` (20 chars), `Platform`, `Win`, `Υ Yield`, `Op Ratio`, `Tokens`. At 100 cols this is 106.

**Fix options (pick one):**
- A) Drop the `Tokens` column (saves ~12 cols). Tokens are already visible in the cascade table on Dashboard.
- B) Shorten `Codename` from 20→14 chars (saves 6 cols). Codenames are `signal-XXXXXXXXXX` (18 chars) — truncating to `signal-XXXX..` loses 6 chars but stays identifiable.
- C) Responsive: show `Tokens` only when `W() >= 120`.

**Recommended:** Option C — responsive column hiding. Show all columns at 120+, hide `Tokens` below 120.

#### Connect overflow (109 cols at 100-col terminal)

The help text line is too long:
```
Signed in on the wrong device, or want a fresh start? [X] signs out — next paste provisions a fresh device.
```

**Fix:** Wrap across 2 lines at `W() < 110`:
```
Signed in on the wrong device, or want a fresh start?
[X] signs out — next paste provisions a fresh device.
```

#### Dashboard overflow (99 cols at 80-col terminal)

The cascade table has 8 columns. At 80 cols it's 99.

**Fix:** Responsive column hiding below `W() < 90`:
- Hide `Class` column (saves ~10 cols)
- Shorten `CacheW`/`CacheR` headers to `CW`/`CR` (saves 6 cols)

#### Compare dead-space (3-4 empty rows between sections)

**Fix:** Fill the gap with a mini visual — either:
- A horizontal bar comparing each source's Υ Yield (uses the `logBar()` function we restored)
- Or a one-line summary: `tokenpull leads Υ 575.1 vs ccusage 682.7 — gap: 107.6 (18.7%)`

**Recommended:** Option A — a `logBar()` comparison row. Owner wants more mini-graphs.

**Acceptance:**
- `node tui.mjs --audit --ci` exits 0 (no HIGH severity issues).
- Board grade goes from B → A.
- All tabs fit at 100×30 with zero overflow.

---

### WS-3: Web app visual audit with Playwright

**Repo:** `_01_sigrank-app`
**File:** `e2e/visual-audit.spec.ts` (new)

The web app has Lighthouse for perf/a11y and Playwright for functional e2e, but **nothing reviews the actual visual layout**. We need screenshot comparison + layout checks.

#### Key pages to audit (non-SEO, core product)

| Page | URL | What to check |
|------|-----|---------------|
| Home | `/` | Hero, CTA, cascade visualization |
| Leaderboard | `/board/all` | Table alignment, sort indicators, row spacing |
| Score paste | `/score/paste` | Textarea, preview button, projection card |
| Methodology | `/methodology` | Formula rendering, diagram alignment |
| Profile | `/u/[username]` | Metric cards, sparklines, cascade chart |
| Token cascade | `/token-cascade` | Pillar bars, waterfall chart |
| Metrics index | `/metrics` | Card grid, link alignment |
| FAQ | `/faq` | Accordion, spacing |
| Settings | `/settings` | Form alignment, key management |

#### What the visual audit checks

1. **Screenshot baseline comparison** — capture full-page screenshots at desktop (1280×720) and mobile (375×667) widths. Compare against committed baselines. Flag any pixel diff > 5%.

2. **Layout shift detection** — use Playwright's `page.locator().boundingBox()` to check:
   - No element overlaps (cards, text, buttons)
   - No element extends beyond viewport width
   - No element has zero height (collapsed/hidden)
   - Headers/footers are pinned correctly

3. **Visual hierarchy check** — verify:
   - H1 is the largest text on the page
   - CTAs are visible without scrolling (above the fold)
   - Tables don't have columns wider than viewport
   - Sparklines/charts have non-zero dimensions

4. **Color contrast sampling** — sample 5 text/background pairs per page, check WCAG AA (4.5:1 for normal text, 3:1 for large text). Use `page.evaluate()` to compute contrast ratios.

5. **Responsive breakpoint check** — render at 375px, 768px, 1280px, 1920px. Verify no horizontal scroll at any width.

**Implementation pattern:**

```typescript
import { test, expect } from "@playwright/test";

const PAGES = [
  { name: "home", path: "/" },
  { name: "leaderboard", path: "/board/all" },
  { name: "score-paste", path: "/score/paste" },
  { name: "methodology", path: "/methodology" },
  { name: "token-cascade", path: "/token-cascade" },
  { name: "metrics", path: "/metrics" },
  { name: "faq", path: "/faq" },
];

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 720 },
];

for (const page of PAGES) {
  for (const vp of VIEWPORTS) {
    test(`visual: ${page.name} @ ${vp.name}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: vp });
      const p = await ctx.newPage();
      await p.goto(page.path);
      await p.waitForLoadState("networkidle");

      // 1. No horizontal scroll
      const scrollWidth = await p.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${page.name} has horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(vp.width);

      // 2. No overlapping elements (check top-level containers)
      const overlaps = await p.evaluate(() => {
        const els = [...document.querySelectorAll("main, header, footer, section, article")];
        const rects = els.map((e) => e.getBoundingClientRect());
        const issues = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
              if (a.width > 50 && b.width > 50) issues.push({ a: i, b: j });
            }
          }
        }
        return issues;
      });
      expect(overlaps, `${page.name} has overlapping elements at ${vp.name}`).toEqual([]);

      // 3. Screenshot baseline
      await expect(p).toHaveScreenshot(`${page.name}-${vp.name}.png`, {
        maxDiffPixelRatio: 0.05,
        animations: "disabled",
      });

      await ctx.close();
    });
  }
}
```

**Acceptance:**
- 21 visual tests (7 pages × 3 viewports) pass on current site.
- Baseline screenshots committed to `e2e/visual-snapshots/`.
- Horizontal scroll detected and fixed on any page.
- CI runs visual audit on every PR.

**Note:** First run generates baselines. Commit them. Subsequent runs compare against baselines.

---

### WS-4: TUI render performance audit

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui-audit.mjs` (extend)

Add timing to the audit. Measure how long each tab takes to render. If a tab takes >500ms it'll feel sluggish to the user.

**Implementation:**

```javascript
// In runAudit(), wrap each render call:
const t0 = performance.now();
startBuffer();
try {
  if (tabIdx === 0) renderDashboard(dashData, "audit");
  // ...
} catch (e) { /* ... */ }
const renderTime = performance.now() - t0;

// Add to frame analysis:
analysis.renderTime = renderTime;
if (renderTime > 500) {
  analysis.issues.push({
    severity: "low",
    category: "perf",
    tab: tabLabel,
    msg: `render took ${renderTime.toFixed(0)}ms (>500ms threshold) — may feel sluggish`,
  });
}
```

**Add to summary table:** `Render` column showing ms per tab.

**Add to report:** A perf section listing slowest tabs.

**Acceptance:**
- Every tab's render time is measured and reported.
- Tabs >500ms are flagged.
- No tab should take >1s (would block the event loop).

---

### WS-5: TUI keyboard shortcut audit

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui-keybind-test.mjs` (new)

We have 15+ keybindings but no automated test that they work. Documented keybindings from `tui.mjs`:

| Key | Context | Action |
|-----|---------|--------|
| `1`-`6` | Global | Switch to tab N |
| `D`/`T`/`C`/`B`/`W`/`N` | Global | Tab shortcuts |
| `←`/`→` | Global | Previous/next tab |
| `Esc` | Global | Back to Dashboard |
| `q`/`Ctrl+C` | Global | Quit |
| `R` | Dashboard/Trends | Refresh data |
| `S` | Any read tab | Submit cascade |
| `O` | Dashboard | Open OMP cache |
| `P` | Compare/Watch | Cycle platform |
| `W` | Watch/Board | Cycle window |
| `C` | Global (not Connect) | Compare tab |
| `T` | Trends | Cycle sub-view (You/Platform/Field) |
| `+`/`-` | Watch | Add/remove platform |
| `Enter` | Watch | Launch watcher |
| `X` | Connect | Sign out |
| `Y` | Board (signed in) | Toggle your-rank mode |
| `j`/`k` | Board | Scroll down/up |
| `↑`/`↓` | Board | Scroll down/up |
| `PgUp`/`PgDn` | Board | Page scroll |

**Test approach:**

We can't easily test interactive stdin in a unit test, but we CAN test that the keybinding handler function correctly routes keys to actions. Extract the key handler into a testable function, then assert:

```javascript
// Extract from tui.mjs:
export function handleKey(key, state) {
  // Returns { action, tab, ... } based on key + current state
  // Pure function — no side effects, no stdin
}

// Test:
test("S key on Dashboard triggers submit", () => {
  const result = handleKey("s", { activeTab: 0 });
  expect(result.action).toBe("submit");
});

test("S key on Connect does NOT trigger submit", () => {
  const result = handleKey("s", { activeTab: 5 });
  expect(result.action).not.toBe("submit");
});

test("1-6 keys switch tabs", () => {
  for (let i = 0; i < 6; i++) {
    const result = handleKey(String(i + 1), { activeTab: 0 });
    expect(result.action).toBe("switch-tab");
    expect(result.tab).toBe(i);
  }
});

test("P key cycles platform on Compare", () => {
  const result = handleKey("p", { activeTab: 2 });
  expect(result.action).toBe("cycle-platform");
});

test("P key does nothing on Dashboard", () => {
  const result = handleKey("p", { activeTab: 0 });
  expect(result.action).not.toBe("cycle-platform");
});
```

**Acceptance:**
- Every documented keybinding has a test.
- Context-conditional bindings (S on read tabs only, P on Compare/Watch only) are tested for both correct and incorrect contexts.
- Quit keys (q, Ctrl+C) are tested.
- Test runs in <1s.

---

### WS-6: TUI-to-PNG export

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui-audit.mjs` (extend)

SVG is great for docs but PNG is needed for:
- README badges
- Social media cards
- Slack/Discord previews
- GitHub issue attachments

**Implementation:** Use the existing SVG export + a headless renderer. Two options:

- **A) `sharp`** — `npm install sharp`, then `sharp(svgBuffer).png().toFile(path)`. Fast, native, no browser.
- **B) `@resvg/resvg-js`** — pure Rust SVG-to-PNG, no system dependencies. `npm install @resvg/resvg-js`.

**Recommended:** Option B (`@resvg/resvg-js`) — no system dependencies, works in CI without installing system libraries.

```javascript
import { Resvg } from "@resvg/resvg-js";

function frameToPng(svgString, outPath) {
  const resvg = new Resvg(svgString, {
    fitTo: { mode: "width", value: 1200 }, // 2x for retina
  });
  const pngBuffer = resvg.render().asPng();
  writeFileSync(outPath, pngBuffer);
}
```

**New flag:** `--audit --png` exports PNG screenshots alongside SVG.

**Acceptance:**
- `--audit --png` generates PNG screenshots for every tab × size.
- PNGs are 2x resolution for retina displays.
- No new system dependencies (pure JS/Rust via npm).

---

### WS-7: TUI session recording as animated GIF

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui-record.mjs` (new)

Record a TUI session as an animated GIF for:
- README demos
- Documentation showing tab navigation
- Bug reproduction (record the exact sequence that triggers a bug)

**Implementation:**

1. Wrap the TUI render loop to capture each frame to an internal buffer.
2. On exit, encode frames as a GIF using `gifenc` (pure JS, no deps):
   ```javascript
   import { GIFEncoder, quantize, applyPalette } from "gifenc";
   ```
3. Each frame: render TUI → convert ANSI to RGB pixels → quantize → add to GIF.

**New flags:**
- `--record <output.gif>` — record session to GIF
- `--record-speed <fps>` — playback speed (default 10 fps)

**Usage:**
```bash
# Record a demo: open TUI, navigate through tabs, quit
node tui.mjs --record demo.gif
# Result: demo.gif showing the tab navigation
```

**Acceptance:**
- `--record` produces a valid GIF file.
- GIF plays at reasonable speed (10 fps default).
- File size < 2MB for a 10-second recording.
- Works in headless mode for CI (scripted key sequence).

---

### WS-8: Color contrast checking (TUI)

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui-audit.mjs` (extend)

TUI terminals handle color differently than web, but we can still check that our ANSI color choices have sufficient contrast against the terminal background.

**Our color palette (from `tui.mjs`):**

| ANSI Code | Color | Hex (assumed dark bg #1d1f21) |
|-----------|-------|------|
| `33` | gold | `#f0c862` |
| `36` | cyan | `#56b4b4` |
| `32` | green | `#5a8a5a` |
| `31` | red | `#cc6666` |
| `97` | white | `#e0e0e0` |
| `35` | magenta | `#b294bb` |
| `34` | blue | `#81a2be` |
| `2` | dim | `#6e8a6e` (muted) |

**Check:** For each color, compute contrast ratio against both dark (`#1d1f21`) and light (`#ffffff`) terminal backgrounds. Flag any color that fails WCAG AA (4.5:1 for normal text, 3:1 for large text).

```javascript
function contrastRatio(foreground, background) {
  const fl = relativeLuminance(foreground);
  const bl = relativeLuminance(background);
  return (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  const toLinear = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
```

**Add to audit report:** A color contrast section listing each color's ratio against dark/light backgrounds.

**Acceptance:**
- Every ANSI color in the palette is checked.
- Colors failing WCAG AA are flagged.
- `dim` (muted) text is checked at the 3:1 large-text threshold (it's used for secondary info).

---

### WS-9: Theme system (tokscale-inspired)

**Repo:** `_02_sigrank-mcp`
**File:** `presentation/tui-themes.mjs` (new)

Tokscale has centralized colors. We have inline ANSI codes scattered across `tui.mjs`. A theme system would:
1. Centralize all colors in one file
2. Support multiple themes (dark, light, high-contrast, monochrome)
3. Let users pick a theme via `--theme <name>` flag
4. Make the TUI accessible to colorblind users

**Theme structure:**

```javascript
export const THEMES = {
  dark: {
    name: "dark",
    background: "#1d1f21",
    foreground: "#c5c8c6",
    gold: "\x1b[33m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    white: "\x1b[97m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  },
  light: {
    name: "light",
    background: "#ffffff",
    foreground: "#333333",
    gold: "\x1b[33m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    white: "\x1b[30m",   // dark text on light bg
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  },
  highContrast: {
    name: "high-contrast",
    background: "#000000",
    foreground: "#ffffff",
    gold: "\x1b[1;33m",  // bold gold
    cyan: "\x1b[1;36m",  // bold cyan
    green: "\x1b[1;32m",
    red: "\x1b[1;31m",
    white: "\x1b[1;97m",
    magenta: "\x1b[1;35m",
    blue: "\x1b[1;34m",
    dim: "\x1b[0;37m",   // no dim — full brightness
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  },
  monochrome: {
    name: "monochrome",
    background: "#000000",
    foreground: "#ffffff",
    gold: "\x1b[1m",     // bold only
    cyan: "\x1b[0m",
    green: "\x1b[0m",
    red: "\x1b[1m",
    white: "\x1b[0m",
    magenta: "\x1b[1m",
    blue: "\x1b[0m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  },
};
```

**Migration:** Replace all inline ANSI codes in `tui.mjs` with theme references:
```javascript
// Before:
emit(`  ${"\x1b[33m"}MO§ES™${"\x1b[0m"}`);

// After:
import { currentTheme as T } from "./tui-themes.mjs";
emit(`  ${T.gold}MO§ES™${T.reset}`);
```

**New flag:** `--theme <name>` selects theme at startup. Default: `dark`.

**Acceptance:**
- All 4 themes render correctly.
- No inline ANSI codes remain in `tui.mjs` (all go through theme).
- `--theme light` works on light-background terminals.
- `--theme high-contrast` works for visually impaired users.
- `--theme monochrome` works for colorblind users.
- Audit checks all themes (not just dark).

---

## Implementation order

Priority-ordered. Each workstream is independently shippable.

| # | Workstream | Impact | Effort | Blocks |
|---|-----------|--------|--------|--------|
| 1 | WS-2: Fix audit-found issues | High — fixes real user-facing bugs | Medium | Nothing |
| 2 | WS-1: Wire TUI audit into CI | High — prevents regressions | Low | WS-2 (should pass first) |
| 3 | WS-3: Web visual audit (Playwright) | High — covers the other half of the product | Medium | Nothing |
| 4 | WS-5: TUI keybinding tests | Medium — prevents input regressions | Medium | Nothing |
| 5 | WS-4: TUI render perf audit | Medium — catches sluggishness | Low | Nothing |
| 6 | WS-8: Color contrast checking | Medium — accessibility | Low | Nothing |
| 7 | WS-6: TUI-to-PNG export | Low — nice for docs | Low | Nothing |
| 8 | WS-9: Theme system | Low — feature, not audit | High | Nothing |
| 9 | WS-7: Animated GIF recording | Low — nice for demos | High | Nothing |

**Recommended first batch:** WS-1 + WS-2 + WS-3 (close the loop: fix issues → prevent regressions → expand to web).

**Recommended second batch:** WS-4 + WS-5 + WS-8 (depth: perf + input + accessibility).

**Gold-plate batch:** WS-6 + WS-7 + WS-9 (polish: PNG + GIF + themes).

---

## Canon compliance

- No metric/formula changes (WS-1 through WS-9 are all presentation/audit layer).
- MO§ES™ display unchanged.
- Canonical Υ 18436.98 unchanged.
- No taxonomy/archetype/class/rank changes.
- Theme system (WS-9) changes colors only, not content or terminology.
- Web visual audit (WS-3) checks layout, not SEO/AEO/GEO content (those pages are intentionally strategic — see AGENTS.md).

---

## Verification protocol

After each workstream:

1. `node --check` on all modified files
2. `node test.mjs` — all pass, Υ 18436.98 intact
3. `node presentation/tui.mjs --audit --ci` — exits 0
4. `node presentation/tui.mjs --render 0` through `--render 5` — all render
5. `node presentation/tui.mjs --audit --golden-check` — no regressions
6. For web changes: `npx tsc --noEmit` + `npm run test:canonical` (11/11)
7. Append scratchpad report

---

## Drep coordination

- **Drep2** owns WS-1, WS-2, WS-4, WS-5, WS-6, WS-7, WS-8, WS-9 (TUI repo).
- **Drep2** owns WS-3 (web repo — new test file, no production code changes).
- **Drep1** should be consulted for any canon-adjacent decisions (theme naming, color choices that affect brand perception).
- All reports go through `D-REP-SCRATCH.md` using the arrow format.
- No commits without owner direction (auto-publish is ON).
