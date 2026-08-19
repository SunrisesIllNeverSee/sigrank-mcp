# SigRank TUI Test Suite — Run Report

**Date:** 2026-08-18
**Repo:** `~/Developer/active/SigRank-repos/_02_sigrank-mcp`
**Commit at time of run:** `e2396e2 feat(tui): PNG export, GIF recording, theme system, audit CI`

---

## Surface 1: Keybinding Tests

**Command:** `node dev/tui-keybind-test.mjs` (previously `presentation/tui-keybind-test.mjs`)
**Exit code:** 0
**Result: 44/44 passed, 0 failed**

All 44 tests passed covering:
- Tab switching (1-6, arrows, [C])
- Esc→Dashboard from any non-Dashboard tab
- q/Ctrl+C quit from any tab
- [R] refresh from any tab
- [S] submit (signed-in gate — opens preview when signed in, redirects to Connect when not)
- [P] platform cycle (Compare + Watch, includes 'all')
- [W] window cycle (Watch + Board)
- [Y] just-me toggle (Board, signed-in gate)
- [T] Trends sub-view cycle
- [+]/[-] Watch refresh interval
- [Enter] Watch launch
- [X] sign-out (Connect, no code buffer)
- [O] OMP toggle (Dashboard, availability gate)
- Submit-preview mode (Enter confirms, Esc cancels, other keys swallowed)
- Connect code-entry field (type/submit/cancel/backspace)
- Dashboard scroll (↑↓jk/PgUp/PgDn, scrollable gate)
- Unknown keys → noop

No failures.

---

## Surface 2: Full TUI Audit

### `--audit` (full report)

**Command:** `node presentation/tui.mjs --audit`
**Exit code:** 0
**Themes tested:** 4 (dark, light, highContrast, monochrome)
**Sizes tested:** 4 (80×24, 100×30, 120×40, 140×50)
**Tabs tested:** 6 (Dashboard, Trends, Compare, Board, Watch, Connect)
**Total frames rendered:** 96 (6 tabs × 4 sizes × 4 themes)

#### Per-tab grades

| Tab | Grade | Score |
|-----|-------|-------|
| Dashboard | A | 96/100 |
| Trends | A | 98/100 |
| Compare | B | 88/100 |
| Board | A | 99/100 |
| Watch | A | 95/100 |
| Connect | A | 98/100 |

#### Per-tab issue summary (across 4 sizes × 4 themes)

| Tab | HIGH | MED | LOW | Summary |
|-----|------|-----|-----|---------|
| Dashboard | 0 | 8 | 0 | 0 HIGH / 8 MED / 0 LOW across 4 sizes |
| Trends | 0 | 5 | 3 | 0 HIGH / 5 MED / 3 LOW across 4 sizes |
| Compare | 5 | 7 | 0 | 5 HIGH / 7 MED / 0 LOW across 4 sizes |
| Board | 0 | 4 | 0 | 0 HIGH / 4 MED / 0 LOW across 4 sizes |
| Watch | 5 | 3 | 0 | 5 HIGH / 3 MED / 0 LOW across 4 sizes |
| Connect | 0 | 8 | 0 | 0 HIGH / 8 MED / 0 LOW across 4 sizes |
| **Total** | **10** | **35** | **3** | |

Note: HIGH issues are per-theme, so 5 unique HIGH issues × 4 themes = 20 HIGH entries in the report.

#### HIGH severity issues (5 unique, deduplicated)

All 5 HIGH issues are **overflow** on Compare and Watch tabs — long "no data" /
"no source" fallback messages that exceed terminal width. These appear in the
no-data paths (data loads were try-caught; audit ran on empty data).

1. **[overflow] Compare @ minimal (80×24)** — line 3 is 124 cols (>80 by 44)
   `"    no data from: ccusage (npm i -g ccusage) · token-dashboard (~/.cla"`

2. **[overflow] Compare @ minimal (80×24)** — line 5 is 96 cols (>80 by 16)
   `"    no source data available for this platform — install a verifier or"`

3. **[overflow] Watch @ minimal (80×24)** — line 4 is 86 cols (>80 by 6)
   `"    no active platforms detected — run some sessions, this picks them "`

4. **[overflow] Compare @ standard (100×30)** — line 3 is 124 cols (>100 by 24)
   `"    no data from: ccusage (npm i -g ccusage) · token-dashboard (~/.cla"`

5. **[overflow] Compare @ wide (120×40)** — line 3 is 124 cols (>120 by 4)
   `"    no data from: ccusage (npm i -g ccusage) · token-dashboard (~/.cla"`

#### Color contrast (WCAG AA)

11 ANSI colors fail WCAG AA threshold (4.5:1 for normal text, 3:1 for dim/large):
- gold, boldGold, cyan, boldCyan, green, red, white, magenta, blue fail on light background
- green, red fail on dark background
- dim passes on both

#### Recommendations from audit

1. Fix 20 overflow lines (20 groups) — they wrap/garble in real terminals
2. Fix 16 column alignment issues — table columns don't line up
3. 7 tabs don't adapt to wider terminals — bars/columns could use the extra space
4. 88 tabs are text-heavy — could add sparklines, bars, or mini-graphs

### `--audit --ci` (CI mode)

**Command:** `node presentation/tui.mjs --audit --ci`
**Exit code:** 0

Exit 0 = no HIGH issues blocking CI.

### `--audit --svg` (SVG export)

**Command:** `node presentation/tui.mjs --audit --svg`
**Exit code:** 0
**SVG files written:** 24 files to `.tui-screenshots/`
**Format:** `{tab}_{width}x{height}.svg` (6 tabs × 4 sizes = 24 SVGs)

---

## Notes

- All three audit modes completed without hanging.
- Data loads were try-caught (no network/auth in this environment); audit ran
  on empty/no-data fallback paths. The HIGH overflow issues are all in those
  fallback message strings.
- The keybind tester is the source of truth for keybinding behavior — 44/44
  passed, no disagreements with the audit.
- No test files were modified. These were read-only runs.
- After this report was compiled, the test/dev files were moved from
  `presentation/` to `dev/` (pure rename, 0 content changes) with import paths
  in `presentation/tui.mjs` updated to `../dev/tui-audit.mjs` and
  `../dev/tui-record.mjs` (with graceful try/catch for npm package users who
  don't have the dev tools). Both test surfaces re-verified from the new
  locations — 44/44 keybind tests still pass, audit still runs clean.
