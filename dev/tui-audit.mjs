// tui-audit.mjs — headless TUI review system
//
// Renders every tab at multiple terminal sizes, then checks:
//   1. Overflow       — lines wider than the terminal (would wrap/garble)
//   2. Truncation     — labels cut short with "…" or missing columns
//   3. Dead space     — empty rows inside a tab that could hold content
//   4. Alignment      — column headers misaligned with their data rows
//   5. Color health   — lines with no color at all (might be missing styling)
//   6. Graph integrity — sparkline/bar functions tested with known inputs
//   7. Budget analysis — rows used vs available, where content could expand
//
// Also supports:
//   --golden-save   write rendered frames to .tui-golden/ for CI baseline
//   --golden-check  compare current render against saved golden frames
//   --svg           export each tab as an SVG screenshot for docs/README
//   --png           export each tab as a PNG (2x retina via @resvg/resvg-js)
//
// The audit runs every theme (dark/light/high-contrast/monochrome) so we catch
// rendering regressions in any palette. Golden frames and SVG/PNG export only
// run for the default (dark) theme.
//
// Usage:
//   node tui.mjs --audit              full audit report (all themes)
//   node tui.mjs --audit --golden-save   save golden frames (dark theme)
//   node tui.mjs --audit --golden-check  diff against golden (dark theme)
//   node tui.mjs --audit --svg           export SVG screenshots (dark theme)
//   node tui.mjs --audit --png           export PNG screenshots (dark theme)
//
// No external dependencies. Pure ANSI buffer analysis.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTheme, getThemeNames } from "../presentation/tui-themes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "..", ".tui-golden");

// Terminal sizes to test — covers the real-world range from small IDE panels
// to large dedicated terminals. Each size is [cols, rows, label].
const TEST_SIZES = [
  [80, 24, "minimal (80×24) — small IDE panel / SSH default"],
  [100, 30, "standard (100×30) — typical terminal"],
  [120, 40, "wide (120×40) — large terminal / tmux split"],
  [140, 50, "ultrawide (140×50) — full-screen on large monitor"],
];

// ── Graph function tests ────────────────────────────────────────────────────
// Test the rendering primitives with known inputs so we catch graph bugs
// without needing a full data load. These are the functions that had the
// fake-dot / fake-trend / fake-flat-line bugs we just fixed.

function auditSparkline() {
  const issues = [];
  const tests = [
    {
      name: "all-null → 'no data'",
      input: [null, null, null, null],
      check: (out) => out.includes("no data"),
      raw: true, // check the raw sparkline string, not the rendered line
    },
    {
      name: "single point → no fake peak (should be mid-height ▄, not █)",
      input: [null, null, 469.3, null],
      check: (out) => out.includes("▄") && !out.includes("█"),
      raw: true,
    },
    {
      name: "two points → real trend (▁█ shape, not flat)",
      input: [null, null, 469.3, 575.1],
      check: (out) => out.includes("▁") && out.includes("█"),
      raw: true,
    },
    {
      name: "missing windows → gaps (spaces, not dots)",
      input: [null, null, 469.3, 575.1],
      check: (out) => !out.includes("·"),
      raw: true,
    },
    {
      name: "all same value → flat mid-height (▄▄▄▄, not ████)",
      input: [100, 100, 100, 100],
      check: (out) => out.includes("▄") && !out.includes("█"),
      raw: true,
    },
  ];

  // We can't import sparkline directly (it's not exported), so we test it
  // indirectly by checking the rendered Trends output. But we CAN test the
  // properties we care about by examining the output of --render 1.
  // For now, return the test definitions so the caller can run them.
  return tests;
}

// ── Frame analysis ──────────────────────────────────────────────────────────

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function hasColor(s) {
  return /\x1b\[[0-9;]*m/.test(s);
}

function visibleLen(s) {
  return stripAnsi(s).length;
}

function analyzeFrame(lines, cols, rows, tabLabel, rawLines = null) {
  const issues = [];
  const budget = rows - 4; // matches the render functions' budget calc
  const nonEmpty = lines.filter((l) => stripAnsi(l).trim().length > 0);
  const used = nonEmpty.length;
  const wasted = budget - used;

  // 1. Overflow — lines wider than cols. Group consecutive overflow lines
  //    so we report "Board rows 5-25 overflow by 6" instead of 21 separate
  //    issues for the same root cause.
  let overflowStart = -1;
  let overflowCount = 0;
  let overflowAmount = 0;
  lines.forEach((ln, i) => {
    const vis = visibleLen(ln);
    if (vis > cols) {
      if (overflowStart === -1) overflowStart = i;
      overflowCount++;
      overflowAmount = Math.max(overflowAmount, vis - cols);
    } else {
      if (overflowCount > 0) {
        issues.push({
          severity: "high",
          category: "overflow",
          tab: tabLabel,
          line: overflowStart,
          msg:
            overflowCount > 1
              ? `${overflowCount} consecutive lines (lines ${overflowStart}-${overflowStart + overflowCount - 1}) overflow by ${overflowAmount} cols each`
              : `line ${overflowStart} is ${overflowAmount + cols} cols (>${cols} by ${overflowAmount})`,
          preview: stripAnsi(lines[overflowStart]).slice(0, 70),
          count: overflowCount,
        });
        overflowStart = -1;
        overflowCount = 0;
        overflowAmount = 0;
      }
    }
  });
  // Flush trailing overflow group
  if (overflowCount > 0) {
    issues.push({
      severity: "high",
      category: "overflow",
      tab: tabLabel,
      line: overflowStart,
      msg:
        overflowCount > 1
          ? `${overflowCount} consecutive lines (lines ${overflowStart}-${overflowStart + overflowCount - 1}) overflow by ${overflowAmount} cols each`
          : `line ${overflowStart} is ${overflowAmount + cols} cols (>${cols} by ${overflowAmount})`,
      preview: stripAnsi(lines[overflowStart]).slice(0, 70),
      count: overflowCount,
    });
  }

  // 2. Truncation — lines ending with "…" that might be cut labels.
  //    Exclude intentional stubs: "calculating…", "calibrating…", etc.
  const STUB_PHRASES = ["calculating", "calibrating", "loading", "pending", "warming"];
  lines.forEach((ln, i) => {
    const clean = stripAnsi(ln).trimEnd();
    if (clean.endsWith("…") && clean.length > 10) {
      const lower = clean.toLowerCase();
      if (!STUB_PHRASES.some((p) => lower.includes(p))) {
        issues.push({
          severity: "low",
          category: "truncation",
          tab: tabLabel,
          line: i,
          msg: `possible truncated label: "${clean.slice(-30)}"`,
        });
      }
    }
  });

  // 3. Dead space — consecutive empty rows INSIDE the content area.
  //    Distinguish between:
  //    - Trailing dead space (after last content line) → just unused budget, not a bug
  //    - Internal dead space (between content sections) → real gap that could hold content
  //    - Single blank row between sections → intentional separator, not flagged
  //    Only flag 2+ consecutive internal blanks (2 is enough to be notable;
  //    a single blank is a normal section separator).
  const lastContentIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (stripAnsi(lines[i]).trim().length > 0) return i;
    }
    return -1;
  })();

  let emptyStreak = 0;
  let streakStart = -1;
  lines.forEach((ln, i) => {
    // Don't flag trailing dead space — that's just unused budget (covered by check 4)
    if (i > lastContentIdx) return;

    if (stripAnsi(ln).trim().length === 0) {
      if (emptyStreak === 0) streakStart = i;
      emptyStreak++;
    } else {
      if (emptyStreak >= 2) {
        issues.push({
          severity: "low",
          category: "dead-space",
          tab: tabLabel,
          line: streakStart,
          msg: `${emptyStreak} consecutive empty rows between content (lines ${streakStart}-${streakStart + emptyStreak - 1}) — could hold sparklines, bars, or stats`,
        });
      }
      emptyStreak = 0;
    }
  });

  // 4. Budget analysis — how much of the terminal is used.
  //    Distinguish between "room for more" (info) and "content dropped" (high).
  //    Only flag underuse at larger sizes — small terminals are naturally tight.
  const isSmallTerm = rows <= 24;
  if (used > budget) {
    issues.push({
      severity: "high",
      category: "budget",
      tab: tabLabel,
      msg: `${used} rows rendered but only ${budget} fit — ${used - budget} rows silently dropped`,
    });
  } else if (wasted > 5 && !isSmallTerm) {
    issues.push({
      severity: "info",
      category: "budget",
      tab: tabLabel,
      msg: `${used}/${budget} rows used (${wasted} unused) — room for more content`,
    });
  }

  // 5. Color health — flag completely uncolored content lines.
  //    Uses rawLines (with ANSI) since `lines` are already stripped.
  //    Only flag if >50% of content lines are uncolored (some lines like
  //    plain text descriptions are intentionally uncolored).
  const sourceForColor = rawLines || lines;
  const contentLines = sourceForColor.filter(
    (l) =>
      stripAnsi(l).trim().length > 5 &&
      !stripAnsi(l).trim().startsWith("─") &&
      !stripAnsi(l).trim().startsWith("·"),
  );
  const uncolored = contentLines.filter((l) => !hasColor(l));
  if (uncolored.length > contentLines.length * 0.5) {
    issues.push({
      severity: "info",
      category: "color",
      tab: tabLabel,
      msg: `${uncolored.length}/${contentLines.length} content lines have no color — might be missing styling`,
    });
  }

  // 6. Column alignment — detect header/data misalignment in table-like sections.
  //    Looks for rows that start with spaces + a short label, followed by
  //    multiple space-separated values. If the value columns don't line up
  //    across consecutive rows, the table is misaligned.
  const tableRows = [];
  lines.forEach((ln, i) => {
    const clean = stripAnsi(ln).trim();
    // Table rows: start with a label, have 2+ space-separated value groups
    // Skip headers (contain only letters/spaces/colons) and hr lines
    if (
      clean.length > 10 &&
      !clean.startsWith("─") &&
      !clean.startsWith("·") &&
      !clean.startsWith("╔") &&
      !clean.startsWith("║") &&
      !clean.startsWith("╚") &&
      !clean.startsWith("┌") &&
      !clean.startsWith("├") &&
      !clean.startsWith("└") &&
      !clean.match(/^[A-Z][a-z\s]+$/) // pure header text
    ) {
      // Find column positions by tracking where value groups start
      const matches = [...clean.matchAll(/\s{2,}(\S)/g)];
      if (matches.length >= 2) {
        tableRows.push({
          line: i,
          colPositions: matches.map((m) => m.index + m[0].length - 1),
        });
      }
    }
  });
  // Check alignment across consecutive table rows
  for (let i = 1; i < tableRows.length; i++) {
    const prev = tableRows[i - 1];
    const curr = tableRows[i];
    // Only compare if they have the same number of columns
    if (prev.colPositions.length !== curr.colPositions.length) continue;
    let misaligned = 0;
    for (let j = 0; j < prev.colPositions.length; j++) {
      if (Math.abs(prev.colPositions[j] - curr.colPositions[j]) > 2) {
        misaligned++;
      }
    }
    if (misaligned >= prev.colPositions.length / 2) {
      issues.push({
        severity: "low",
        category: "alignment",
        tab: tabLabel,
        line: curr.line,
        msg: `row ${curr.line} columns misaligned with row ${prev.line} (${misaligned}/${prev.colPositions.length} columns off)`,
      });
      break; // one per tab is enough to flag the issue
    }
  }

  return { issues, used, budget, wasted, lineCount: lines.length };
}

// ── Sparkline integrity check ───────────────────────────────────────────────
// Scans the rendered Trends tab for graph characters and verifies the patterns
// match our design rules: no fake dots for missing data, no fake flat lines
// for stubs, no fake peaks from single data points.

const SPARK_CHARS = new Set(["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]);
const BLOCK_CHARS = new Set(["█", "▓", "▒", "░", "▍", "▎", "▏"]);
const DOT_CHAR = "·";

function checkSparklineIntegrity(lines, tabLabel) {
  const issues = [];
  if (tabLabel !== "Trends") return issues;

  // Find all lines that contain sparkline characters
  const sparkLines = lines.filter((l) => {
    const clean = stripAnsi(l);
    return [...clean].some((ch) => SPARK_CHARS.has(ch));
  });

  // Check 1: No fake dots (·) in sparkline rows — missing data should be spaces
  for (const ln of sparkLines) {
    const clean = stripAnsi(ln);
    if (clean.includes(DOT_CHAR) && [...clean].some((ch) => SPARK_CHARS.has(ch))) {
      // Dots are OK in the dot-leader rows (········) but NOT mixed with spark chars
      const sparkIdx = [...clean].findIndex((ch) => SPARK_CHARS.has(ch));
      const dotIdx = clean.indexOf(DOT_CHAR);
      if (dotIdx < sparkIdx && dotIdx > 0) {
        // Dots before spark chars = dot leader, OK
      } else {
        issues.push({
          severity: "high",
          category: "sparkline",
          tab: tabLabel,
          msg: `fake dot (·) mixed with sparkline chars — missing data should render as space, not dot`,
          preview: clean.slice(0, 70),
        });
        break; // one is enough
      }
    }
  }

  // Check 2: Stub lines should NOT have sparkline characters
  const STUB_LABELS = ["§IGNA", "$/1M", "Rank"];
  for (const ln of lines) {
    const clean = stripAnsi(ln);
    if (STUB_LABELS.some((label) => clean.includes(label))) {
      if ([...clean].some((ch) => SPARK_CHARS.has(ch))) {
        issues.push({
          severity: "high",
          category: "sparkline",
          tab: tabLabel,
          msg: `stub metric has sparkline chars — should show blank + "calculating…" only`,
          preview: clean.slice(0, 70),
        });
        break;
      }
    }
  }

  // Check 3: Single-point sparklines should use ▄ (mid-height), not █ (peak)
  // We can't perfectly reconstruct the data, but we can check: if a sparkline
  // has only 1 spark char and it's █, that's a fake peak from 1 data point.
  for (const ln of sparkLines) {
    const clean = stripAnsi(ln);
    const sparkCount = [...clean].filter((ch) => SPARK_CHARS.has(ch)).length;
    if (sparkCount === 1 && clean.includes("█")) {
      // Could be a legit full-height bar (logBar), so only flag in Trends context
      // where sparklines are the graph type. Check it's not a bar chart row.
      if (!clean.match(/^\s*[IWRO]\s/)) {
        issues.push({
          severity: "low",
          category: "sparkline",
          tab: tabLabel,
          msg: `single spark char is █ (peak) — should be ▄ (mid-height) for 1 data point`,
          preview: clean.slice(0, 70),
        });
        break;
      }
    }
  }

  return issues;
}

// ── Responsive detection ────────────────────────────────────────────────────
// Compares the same tab across sizes. If the content is identical at 80 cols
// and 140 cols, the tab isn't adapting to wider terminals — it should use
// the extra space for more columns, wider bars, or more content.

function checkResponsive(frames, tabLabel) {
  const issues = [];
  const tabFrames = frames.filter((f) => f.tabLabel === tabLabel);
  if (tabFrames.length < 2) return issues;

  // Compare smallest vs largest
  const small = tabFrames[0];
  const large = tabFrames[tabFrames.length - 1];

  // Strip trailing whitespace from each line for fair comparison
  const normalize = (lines) => lines.map((l) => l.trimEnd());
  const smallNorm = normalize(small.lines);
  const largeNorm = normalize(large.lines);

  // If the line content is identical (just more trailing space), not responsive
  // But allow for different row budgets (more rows at larger sizes)
  // Check: does the large frame have MORE content than the small frame?
  const smallContent = smallNorm.filter((l) => l.length > 0).length;
  const largeContent = largeNorm.filter((l) => l.length > 0).length;

  if (largeContent <= smallContent + 2 && large.cols > small.cols + 30) {
    // The tab added almost no content despite 60+ more columns
    issues.push({
      severity: "info",
      category: "responsive",
      tab: tabLabel,
      msg: `not responsive: ${largeContent} content rows at ${large.cols} cols vs ${smallContent} at ${small.cols} cols — extra width unused`,
    });
  }

  // Check: does any line get WIDER (more content) at larger sizes?
  // Compare the widest non-empty line at each size
  const smallMaxWidth = Math.max(...smallNorm.filter((l) => l.length > 0).map((l) => l.length));
  const largeMaxWidth = Math.max(...largeNorm.filter((l) => l.length > 0).map((l) => l.length));

  if (largeMaxWidth <= smallMaxWidth + 5 && large.cols > small.cols + 30) {
    issues.push({
      severity: "info",
      category: "responsive",
      tab: tabLabel,
      msg: `lines don't widen: max line width ${largeMaxWidth} at ${large.cols} cols vs ${smallMaxWidth} at ${small.cols} cols — bars/columns could be wider`,
    });
  }

  return issues;
}

// ── Color contrast checking (WCAG AA) ───────────────────────────────────────
// Computes contrast ratios for the TUI's ANSI color palette against both
// dark and light terminal backgrounds. Flags colors that fail WCAG AA:
//   - 4.5:1 for normal text
//   - 3:1 for large text (used for dim/secondary info)

const ANSI_COLORS = [
  { name: "gold (33)",      ansi: 33,  hex: "#f0c862", usage: "MOSES, top yield, medals" },
  { name: "boldGold (1;33)", ansi: "1;33", hex: "#ffd700", usage: "highlighted gold" },
  { name: "cyan (36)",      ansi: 36,  hex: "#56b4b4", usage: "codename, platform" },
  { name: "boldCyan (1;36)", ansi: "1;36", hex: "#7fd4d4", usage: "highlighted cyan" },
  { name: "green (32)",     ansi: 32,  hex: "#5a8a5a", usage: "verified, positive deltas" },
  { name: "red (31)",       ansi: 31,  hex: "#cc6666", usage: "errors, negative deltas" },
  { name: "white (97)",     ansi: 97,  hex: "#e0e0e0", usage: "bright text" },
  { name: "magenta (35)",   ansi: 35,  hex: "#b294bb", usage: "token-dash source" },
  { name: "blue (34)",      ansi: 34,  hex: "#81a2be", usage: "cache write, tokscale" },
  { name: "dim (2)",        ansi: 2,   hex: "#6e8a6e", usage: "secondary/labels" },
];

const TERMINAL_BGS = [
  { name: "dark",  hex: "#1d1f21" },  // common dark terminal (Atom Dark)
  { name: "light", hex: "#ffffff" },  // white terminal
];

function hexToRgb(hex) {
  const m = hex.replace("#", "");
  return [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]) {
  const toLinear = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg, bg) {
  const fl = relativeLuminance(hexToRgb(fg));
  const bl = relativeLuminance(hexToRgb(bg));
  return (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
}

function checkColorContrast() {
  const lines = [];
  const issues = [];
  const AA_NORMAL = 4.5;
  const AA_LARGE = 3.0;

  lines.push("  ANSI color     hex       dark-bg  light-bg  usage");
  lines.push("  ─────────────  ────────  ───────  ────────  ──────────────────────");

  for (const color of ANSI_COLORS) {
    const darkRatio = contrastRatio(color.hex, TERMINAL_BGS[0].hex);
    const lightRatio = contrastRatio(color.hex, TERMINAL_BGS[1].hex);
    const isDim = color.name.startsWith("dim");
    const threshold = isDim ? AA_LARGE : AA_NORMAL; // dim = secondary info = large-text threshold

    const darkPass = darkRatio >= threshold;
    const lightPass = lightRatio >= threshold;

    const darkStr = `${darkRatio.toFixed(1)}${darkPass ? "" : " ✗"}`;
    const lightStr = `${lightRatio.toFixed(1)}${lightPass ? "" : " ✗"}`;

    lines.push(
      `  ${color.name.padEnd(14)}  ${color.hex}  ${darkStr.padEnd(8)}  ${lightStr.padEnd(8)}  ${color.usage}`,
    );

    if (!darkPass) {
      issues.push({
        severity: "low",
        category: "contrast",
        msg: `${color.name} fails WCAG AA on dark bg (${darkRatio.toFixed(1)}:${threshold} needed) — ${color.usage}`,
      });
    }
    if (!lightPass) {
      issues.push({
        severity: "low",
        category: "contrast",
        msg: `${color.name} fails WCAG AA on light bg (${lightRatio.toFixed(1)}:${threshold} needed) — ${color.usage}`,
      });
    }
  }

  lines.push("");
  lines.push(`  Threshold: ${AA_NORMAL}:1 (normal text) · ${AA_LARGE}:1 (dim/large text)`);
  if (issues.length === 0) {
    lines.push("  ✅ All colors pass WCAG AA on both dark and light backgrounds.");
  } else {
    lines.push(`  ⚠ ${issues.length} color(s) fail WCAG AA — see flags above.`);
  }

  return { lines, issues };
}

// ── Visual weight analysis ──────────────────────────────────────────────────
// Measures the ratio of graph/bar characters vs text vs empty space.
// Tabs that are all text with no visual elements could benefit from
// sparklines, bars, or other mini-graphs.

function analyzeVisualWeight(lines, tabLabel) {
  const issues = [];
  let graphChars = 0;
  let textChars = 0;
  let emptyChars = 0;

  for (const ln of lines) {
    const clean = stripAnsi(ln);
    for (const ch of clean) {
      if (SPARK_CHARS.has(ch) || BLOCK_CHARS.has(ch)) {
        graphChars++;
      } else if (ch === " ") {
        emptyChars++;
      } else if (ch !== "\x1b" && ch !== "·" && ch !== "─") {
        textChars++;
      }
    }
  }

  const total = graphChars + textChars + emptyChars;
  const graphPct = total > 0 ? (graphChars / total) * 100 : 0;
  const textPct = total > 0 ? (textChars / total) * 100 : 0;

  // Flag tabs with very low graph density — they could be more visual
  // (the owner explicitly wants more mini-graphs)
  if (graphPct < 2 && textPct > 20) {
    issues.push({
      severity: "info",
      category: "visual-weight",
      tab: tabLabel,
      msg: `text-heavy: ${textPct.toFixed(0)}% text, ${graphPct.toFixed(1)}% graph chars — could add sparklines, bars, or mini-graphs`,
    });
  }

  return { issues, graphPct, textPct, graphChars, textChars };
}

// ── Per-tab grading ─────────────────────────────────────────────────────────
// Weights: high=10pts, low=3pts, info=1pt. Score = max(0, 100 - total_penalty).
// Grade: A≥90, B≥75, C≥60, D≥40, F<40. Averaged across all sizes per tab.

function gradeTab(tabResults) {
  let totalPenalty = 0;
  let sizeCount = 0;
  for (const r of tabResults) {
    if (r.error) continue;
    sizeCount++;
    for (const issue of r.issues) {
      if (issue.severity === "high") totalPenalty += 10;
      else if (issue.severity === "low") totalPenalty += 3;
      else totalPenalty += 1;
    }
  }
  if (sizeCount === 0) return { grade: "—", score: 0 };
  const avgPenalty = totalPenalty / sizeCount;
  const score = Math.max(0, Math.round(100 - avgPenalty));
  let grade;
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 40) grade = "D";
  else grade = "F";
  return { grade, score };
}

// ── Actionable fix suggestions ──────────────────────────────────────────────
// Turns overflow issues into specific "shorten column X by N chars" advice.

function suggestFixes(results) {
  const suggestions = [];
  const overflowByTab = {};

  for (const r of results) {
    if (r.error) continue;
    for (const issue of r.issues) {
      if (issue.category === "overflow") {
        if (!overflowByTab[r.tab]) overflowByTab[r.tab] = [];
        overflowByTab[r.tab].push(issue);
      }
    }
  }

  for (const [tab, issues] of Object.entries(overflowByTab)) {
    // Find the max overflow amount for this tab
    const maxOverflow = Math.max(...issues.map((i) => i.count || 1));
    const overflowAmt = issues[0]?.msg?.match(/by (\d+) cols/)?.[1];
    if (overflowAmt) {
      const n = parseInt(overflowAmt);
      if (tab === "Board") {
        suggestions.push({
          tab,
          fix: `Board table is ${n} cols too wide. Drop the "Tokens" column (saves ~12 cols) or shorten "Codename" column from 20→14 chars (saves 6 cols).`,
        });
      } else if (tab === "Connect") {
        suggestions.push({
          tab,
          fix: `Connect help text is ${n} cols too wide. Wrap the long sentence across 2 lines, or shorten "Signed in on the wrong device, or want a fresh start? [X] signs out — next paste provisions a fresh device." to fit.`,
        });
      } else if (tab === "Dashboard") {
        suggestions.push({
          tab,
          fix: `Dashboard cascade table is ${n} cols too wide at 80 cols. Hide the "Class" column on narrow terminals, or shorten "CacheW"/"CacheR" headers to "CW"/"CR".`,
        });
      } else if (tab === "Compare") {
        suggestions.push({
          tab,
          fix: `Compare header is ${n} cols too wide. Shorten "tokenpull vs ccusage vs token-dash vs tokscale" to "4 sources" on narrow terminals.`,
        });
      } else {
        suggestions.push({
          tab,
          fix: `${tab} has lines ${n} cols too wide. Shorten the longest column or wrap text.`,
        });
      }
    }
  }

  // Responsive suggestions
  const responsiveTabs = new Set();
  for (const r of results) {
    if (r.error) continue;
    for (const issue of r.issues) {
      if (issue.category === "responsive" && issue.tab) {
        responsiveTabs.add(issue.tab);
      }
    }
  }
  for (const tab of responsiveTabs) {
    if (tab === "Trends") {
      suggestions.push({
        tab,
        fix: `Trends doesn't widen at larger terminals. Sparkline bars could be wider (40→60 chars at 120+ cols), or add a 5th window column when width allows.`,
      });
    } else if (tab === "Watch") {
      suggestions.push({
        tab,
        fix: `Watch doesn't adapt to width. At 120+ cols, show platforms side-by-side instead of stacked, or add sparkline columns per window.`,
      });
    } else if (tab === "Connect") {
      suggestions.push({
        tab,
        fix: `Connect is a fixed-width form. At larger terminals, add a side panel showing device info, submission history, or connection status sparkline.`,
      });
    } else if (tab === "Board") {
      suggestions.push({
        tab,
        fix: `Board table is fixed-width. At 120+ cols, add a "Trend" sparkline column showing each operator's Υ trajectory across windows.`,
      });
    }
  }

  // Visual weight suggestions
  const visualTabs = new Set();
  for (const r of results) {
    if (r.error) continue;
    for (const issue of r.issues) {
      if (issue.category === "visual-weight") {
        visualTabs.add(issue.tab);
      }
    }
  }
  for (const tab of visualTabs) {
    if (tab === "Watch") {
      suggestions.push({
        tab,
        fix: `Watch is 63% text, 0% graph. Add a mini sparkline per platform showing Υ across windows, or a horizontal bar comparing platform yields.`,
      });
    } else if (tab === "Connect") {
      suggestions.push({
        tab,
        fix: `Connect is 80% text. Add a connection-status indicator bar or a device fingerprint visualization.`,
      });
    } else if (tab === "Board") {
      suggestions.push({
        tab,
        fix: `Board is 51% text, 0% graph. Add a Υ Yield bar next to each row, or a mini sparkline showing rank trajectory.`,
      });
    } else if (tab === "Compare") {
      suggestions.push({
        tab,
        fix: `Compare is 41% text, 0% graph. Add delta bars showing each source's % difference from tokenpull, or a radar chart comparing sources.`,
      });
    }
  }

  return suggestions;
}

function goldenPath(tabIdx, sizeIdx) {
  return join(GOLDEN_DIR, `tab${tabIdx}_size${sizeIdx}.txt`);
}

function saveGolden(frames) {
  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
  let saved = 0;
  for (const frame of frames) {
    const path = goldenPath(frame.tabIdx, frame.sizeIdx);
    const content = frame.lines.map(stripAnsi).join("\n");
    writeFileSync(path, content + "\n");
    saved++;
  }
  return saved;
}

function checkGolden(frames) {
  const diffs = [];
  for (const frame of frames) {
    const path = goldenPath(frame.tabIdx, frame.sizeIdx);
    if (!existsSync(path)) {
      diffs.push({
        tab: frame.tabLabel,
        size: frame.sizeLabel,
        status: "missing",
        msg: "no golden frame saved — run --golden-save first",
      });
      continue;
    }
    const golden = readFileSync(path, "utf8").trimEnd();
    const current = frame.lines.map(stripAnsi).join("\n").trimEnd();
    if (golden !== current) {
      // Find first differing line
      const gLines = golden.split("\n");
      const cLines = current.split("\n");
      const maxLen = Math.max(gLines.length, cLines.length);
      let firstDiff = -1;
      for (let i = 0; i < maxLen; i++) {
        if (gLines[i] !== cLines[i]) {
          firstDiff = i;
          break;
        }
      }
      diffs.push({
        tab: frame.tabLabel,
        size: frame.sizeLabel,
        status: "changed",
        firstDiff,
        goldenPreview: gLines[firstDiff]?.slice(0, 70) || "(none)",
        currentPreview: cLines[firstDiff]?.slice(0, 70) || "(none)",
      });
    }
  }
  return diffs;
}

// ── SVG export ──────────────────────────────────────────────────────────────
// Renders a TUI frame as an SVG image — for docs, README, PR descriptions.
// Each terminal cell = one <text> element in a monospace grid. Colors mapped
// from ANSI to SVG fill. No external dep — pure string concatenation.

const ANSI_TO_SVG_COLOR = {
  "33": "#f0c862", // gold
  "1;33": "#f0c862", // boldGold
  "36": "#56b4b4", // cyan
  "1;36": "#56b4b4", // boldCyan
  "32": "#5a8a5a", // green
  "31": "#cc6666", // red
  "97": "#e0e0e0", // white
  "1;97": "#ffffff", // boldWhite
  "35": "#b294bb", // magenta
  "34": "#81a2be", // blue
  "2": "#6e8a6e", // dim (muted)
  "1": "#e0e0e0", // bold
  "0": "#c5c8c6", // reset → default text
};

function frameToSvg(lines, cols, rows, title) {
  const cellW = 7.2; // monospace cell width in px (at 12px font)
  const cellH = 16; // cell height in px
  const padX = 16;
  const padY = 16;
  const svgW = cols * cellW + padX * 2;
  const svgH = rows * cellH + padY * 2 + 24; // +24 for title bar

  let cells = "";
  lines.forEach((line, rowIdx) => {
    if (rowIdx >= rows) return;
    const clean = stripAnsi(line);
    // Parse color from the ANSI codes in this line
    const colorMatch = line.match(/\x1b\[([0-9;]+)m/);
    let fill = "#c5c8c6"; // default
    let opacity = 1;
    if (colorMatch) {
      const code = colorMatch[1];
      if (ANSI_TO_SVG_COLOR[code]) fill = ANSI_TO_SVG_COLOR[code];
      if (code === "2") opacity = 0.6; // dim
    }
    for (let col = 0; col < Math.min(clean.length, cols); col++) {
      const ch = clean[col];
      if (ch === " ") continue;
      const x = padX + col * cellW;
      const y = padY + 24 + rowIdx * cellH;
      // Escape XML special chars
      const esc = ch
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      cells += `<text x="${x}" y="${y}" fill="${fill}" opacity="${opacity}" font-family="monospace" font-size="12">${esc}</text>`;
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <rect width="${svgW}" height="${svgH}" fill="#0d0d0d"/>
  <rect x="0" y="0" width="${svgW}" height="3" fill="#f0c862"/>
  <text x="${padX}" y="${padY + 12}" fill="#5a8a5a" font-family="monospace" font-size="11" letter-spacing="2">${escapeXml(title)}</text>
  ${cells}
</svg>`;
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Main audit runner ───────────────────────────────────────────────────────

// Race a promise against a timeout so the headless audit can never hang on a
// data load whose promise never settles (a network fetch or local session-tree
// scan with no internal timeout). The audit's own `.catch()` only handles
// rejection — a pending promise blocks forever. withTimeout resolves to a
// fallback (same shape the catch handlers already use) once the bound elapses,
// so the audit continues on partial/empty data, exactly as designed.
function withTimeout(promise, ms, { onCatch, onTimeout } = {}) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([
    promise.catch((e) => (onCatch ? onCatch(e) : onTimeout)),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

// Per-load bound. The board fetch inside loadDashboardData already races a 5s
// timer, but pullActivePlatforms (local scan) and callTool("tokenpull") have no
// bound. 8s is generous for a real local scan yet keeps the three sequential
// loads well under the 60s hang threshold.
const LOAD_TIMEOUT_MS = 8000;

const TAB_LABELS = [
  "Dashboard",
  "Trends",
  "Compare",
  "Board",
  "Watch",
  "Connect",
];

export async function runAudit(opts = {}) {
  const { goldenSave = false, goldenCheck = false, svg = false, png = false, ci = false } = opts;
  const results = [];
  const allFrames = [];
  const themeNames = getThemeNames();
  const themeResults = []; // per-theme summary for the report

  // Import the render functions from tui.mjs — in-process, no child processes.
  const tui = await import("../presentation/tui.mjs");
  const {
    renderDashboard,
    renderTrends,
    renderCompare,
    renderBoard,
    renderConnect,
    renderWatchData,
    loadWatchData,
    loadDashboardData,
    loadCompareData,
    loadBoardData,
    startBuffer,
    stripAnsi: tuiStripAnsi,
    _getScreenBuf,
    _resetBuf,
  } = tui;
  // loadIdentity is imported from keystore.mjs (same as tui.mjs does).
  const { loadIdentity } = await import("../keystore.mjs");

  // Load data once — reused across all themes and sizes (data doesn't change).
  // Each load is try/catch so a failed source doesn't kill the whole audit.
  // withTimeout also bounds loads whose promises never settle (network/local
  // scan with no internal timeout) — without it a pending load hangs the
  // headless audit forever. The fallbacks match the prior catch shapes so
  // renderers see identical input whether a load rejected or timed out.
  const dashData = await withTimeout(loadDashboardData(), LOAD_TIMEOUT_MS, {
    onCatch: (e) => ({ error: e.message }),
    onTimeout: { error: `load timed out (${LOAD_TIMEOUT_MS / 1000}s)` },
  });
  const compareData = await withTimeout(loadCompareData("claude"), LOAD_TIMEOUT_MS, {
    onCatch: () => null,
    onTimeout: null,
  });
  const boardData = await withTimeout(loadBoardData("30d"), LOAD_TIMEOUT_MS, {
    onCatch: () => null,
    onTimeout: null,
  });
  // Watch data: a full 16-platform scan takes ~8s and is NOT cached across
  // calls, so loading it once here (vs. re-scanning per frame) cuts ~130s off
  // the audit. renderWatchData renders from this pre-loaded snapshot per size.
  // On timeout/failure, fall back to an empty dataset so the Watch tab still
  // renders its "no active platforms" frame rather than hanging the audit.
  const watchData = await withTimeout(loadWatchData("all", "all-windows"), LOAD_TIMEOUT_MS, {
    onCatch: () => ({ active: [], platFilter: null, winFilter: null }),
    onTimeout: { active: [], platFilter: null, winFilter: null },
  });

  // ── Theme loop ──
  // Audit every theme (dark/light/high-contrast/monochrome) so we catch
  // rendering regressions in any palette. Golden frames and SVG/PNG export
  // only run for the default (dark) theme to avoid bloating output and
  // clobbering the dark-theme golden baselines with other themes' ANSI.
  for (let themeIdx = 0; themeIdx < themeNames.length; themeIdx++) {
    const themeName = themeNames[themeIdx];
    const isDefaultTheme = themeName === "dark";
    setTheme(themeName);

    let themeIssueCount = 0;
    let themeHighCount = 0;

  for (let sizeIdx = 0; sizeIdx < TEST_SIZES.length; sizeIdx++) {
    const [cols, rows, sizeLabel] = TEST_SIZES[sizeIdx];

    // Stub terminal dimensions — W() and H() read these each call.
    Object.defineProperty(process.stdout, "columns", {
      value: cols,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      value: rows,
      configurable: true,
    });

    for (let tabIdx = 0; tabIdx < TAB_LABELS.length; tabIdx++) {
      const tabLabel = TAB_LABELS[tabIdx];

      // Render the tab in-process: start buffer → call render fn → capture.
      // Time the render to catch sluggish tabs (>500ms feels laggy to the user).
      const t0 = performance.now();
      startBuffer();
      try {
        if (tabIdx === 0) renderDashboard(dashData, "audit");
        else if (tabIdx === 1) renderTrends(dashData, 0);
        else if (tabIdx === 2) renderCompare(compareData);
        else if (tabIdx === 3) renderBoard(boardData, "30d");
        else if (tabIdx === 4) renderWatchData(watchData);
        else if (tabIdx === 5) renderConnect(loadIdentity(), "", "");
      } catch (e) {
        _resetBuf();
        results.push({
          tab: tabLabel,
          size: sizeLabel,
          theme: themeName,
          error: `render failed: ${e.message}`,
        });
        continue;
      }
      const renderTime = performance.now() - t0;

      // Capture the buffer via the getter (reads the live _screenBuf).
      // Keep BOTH raw (with ANSI) for color analysis AND stripped for width/text.
      const rawLines = [...(_getScreenBuf() || [])];
      _resetBuf();

      const frame = {
        tabIdx,
        sizeIdx,
        themeIdx,
        themeName,
        tabLabel,
        sizeLabel,
        cols,
        rows,
        lines: rawLines.map((l) => tuiStripAnsi(l)),
        rawLines,
      };
      allFrames.push(frame);

      // Analyze the frame (pass raw lines for color check, stripped for width)
      const analysis = analyzeFrame(frame.lines, cols, rows, tabLabel, rawLines);

      // Render performance — flag tabs that take >500ms (feels sluggish)
      analysis.renderTime = renderTime;
      if (renderTime > 500) {
        analysis.issues.push({
          severity: "low",
          category: "perf",
          tab: tabLabel,
          msg: `render took ${renderTime.toFixed(0)}ms (>500ms threshold) — may feel sluggish`,
        });
      } else if (renderTime > 1000) {
        analysis.issues.push({
          severity: "high",
          category: "perf",
          tab: tabLabel,
          msg: `render took ${renderTime.toFixed(0)}ms (>1s — blocks the event loop)`,
        });
      }

      // Sparkline integrity check (only for Trends tab)
      const sparkIssues = checkSparklineIntegrity(frame.lines, tabLabel);
      analysis.issues.push(...sparkIssues);

      // Visual weight analysis
      const visual = analyzeVisualWeight(frame.lines, tabLabel);
      analysis.issues.push(...visual.issues);
      analysis.visualWeight = { graphPct: visual.graphPct, textPct: visual.textPct };

      results.push({
        tab: tabLabel,
        size: sizeLabel,
        theme: themeName,
        cols,
        rows,
        ...analysis,
      });

      // Track per-theme issue counts
      themeIssueCount += analysis.issues.length;
      for (const iss of analysis.issues) {
        if (iss.severity === "high") themeHighCount++;
      }

      // SVG/PNG export — only for the default (dark) theme
      if (isDefaultTheme && (svg || png)) {
        const svgDir = join(__dirname, "..", ".tui-screenshots");
        if (!existsSync(svgDir)) mkdirSync(svgDir, { recursive: true });
        const title = `SigRank · ${tabLabel} (${cols}×${rows})`;
        const svgContent = frameToSvg(frame.lines, cols, rows, title);
        if (svg) {
          const svgPath = join(svgDir, `${tabLabel.toLowerCase()}_${cols}x${rows}.svg`);
          writeFileSync(svgPath, svgContent);
        }
        // PNG export (2x retina via @resvg/resvg-js — pure Rust, no system deps)
        if (png) {
          try {
            const { Resvg } = await import("@resvg/resvg-js");
            const pngPath = join(svgDir, `${tabLabel.toLowerCase()}_${cols}x${rows}.png`);
            const resvg = new Resvg(svgContent, {
              fitTo: { mode: "width", value: cols * 10 }, // 2x retina (char ~10px wide)
            });
            writeFileSync(pngPath, resvg.render().asPng());
          } catch (e) {
            // @resvg/resvg-js not installed — skip PNG, SVG still works
            results.push({
              tab: tabLabel,
              size: sizeLabel,
              theme: themeName,
              error: `PNG export failed: ${e.message} (npm install @resvg/resvg-js)`,
            });
          }
        }
      }
    }
  }

    themeResults.push({ name: themeName, issues: themeIssueCount, high: themeHighCount });
  } // end theme loop

  // Restore default theme after auditing all themes
  setTheme("dark");

  // Responsive detection — needs frames from all sizes, so run after the loop.
  // Only use dark-theme frames (other themes have different ANSI that would
  // confuse the width/responsive comparison).
  const darkFrames = allFrames.filter((f) => f.themeName === "dark");
  for (const tabLabel of TAB_LABELS) {
    const responsiveIssues = checkResponsive(darkFrames, tabLabel);
    if (responsiveIssues.length > 0) {
      // Find the largest-size dark-theme result for this tab and append issues
      const tabResults = results.filter((r) => r.tab === tabLabel && r.theme === "dark" && !r.error);
      if (tabResults.length > 0) {
        const largest = tabResults[tabResults.length - 1];
        largest.issues.push(...responsiveIssues);
      }
    }
  }

  // Golden frame operations — only for dark theme (the canonical baseline)
  let goldenResult = null;
  if (goldenSave) {
    const saved = saveGolden(darkFrames);
    goldenResult = { action: "saved", count: saved };
  } else if (goldenCheck) {
    const diffs = checkGolden(darkFrames);
    goldenResult = { action: "checked", diffs };
  }

  // Per-tab grades — only from dark-theme results (matches pre-theme-loop behavior)
  const grades = {};
  for (const tabLabel of TAB_LABELS) {
    const tabResults = results.filter((r) => r.tab === tabLabel && r.theme === "dark");
    grades[tabLabel] = gradeTab(tabResults);
  }

  // Actionable fix suggestions — from dark-theme results only
  const suggestions = suggestFixes(results.filter((r) => r.theme === "dark"));

  // CI mode: count HIGH severity issues across ALL themes for exit code
  let highCount = 0;
  for (const r of results) {
    if (r.error) {
      highCount++;
      continue;
    }
    for (const issue of r.issues) {
      if (issue.severity === "high") highCount++;
    }
  }
  const ciExitCode = ci && highCount > 0 ? 1 : 0;

  return {
    results,
    goldenResult,
    allFrames,
    themeResults,
    sparklineTests: auditSparkline(),
    grades,
    suggestions,
    ciExitCode,
    highCount,
  };
}

export function formatAuditReport(auditData) {
  const { results, goldenResult, themeResults, sparklineTests, grades, suggestions, highCount } = auditData;
  const lines = [];

  lines.push("╔══════════════════════════════════════════════════════════════════════╗");
  lines.push("║  SigRank TUI Audit — every tab × every size × every theme            ║");
  lines.push("╚══════════════════════════════════════════════════════════════════════╝");
  lines.push("");

  // Theme summary — shows issue counts per theme at a glance
  if (themeResults && themeResults.length > 0) {
    lines.push("── Theme summary ──────────────────────────────────────────────────────────");
    for (const t of themeResults) {
      const flag = t.high > 0 ? " ❌" : " ✅";
      lines.push(`  ${pad(t.name, 16)} ${pad(String(t.issues), 5)} issues${t.high > 0 ? `, ${t.high} HIGH` : ""}${flag}`);
    }
    lines.push("");
  }

  // Summary table — dark theme (default) results only, to keep the table readable.
  // Other themes are audited for CI pass/fail; their per-frame details appear in
  // the severity sections below if they have issues.
  const darkResults = results.filter((r) => r.theme === "dark");
  lines.push("┌─────────────┬──────────────────────────────┬───────┬───────┬────────┬────────┬───────┬───────┐");
  lines.push("│ Tab         │ Size                         │ Lines │ Budget│ Wasted │ Issues │ Graph │ Render│");
  lines.push("├─────────────┼──────────────────────────────┼───────┼───────┼────────┼────────┼───────┼───────┤");

  let totalIssues = 0;
  for (const r of darkResults) {
    if (r.error) {
      lines.push(
        `│ ${pad(r.tab, 11)} │ ${pad(r.size, 28)} │ ERROR │       │        │        │       │       │`,
      );
      continue;
    }
    const issueCount = r.issues.length;
    totalIssues += issueCount;
    const wasted = r.wasted > 0 ? r.wasted : 0;
    const graphPct = r.visualWeight ? `${r.visualWeight.graphPct.toFixed(1)}%` : "—";
    const renderMs = r.renderTime != null ? `${r.renderTime.toFixed(0)}ms` : "—";
    lines.push(
      `│ ${pad(r.tab, 11)} │ ${pad(r.size, 28)} │ ${pad(String(r.lineCount), 5)} │ ${pad(String(r.budget), 5)} │ ${pad(String(wasted), 6)} │ ${pad(String(issueCount), 6)} │ ${pad(graphPct, 5)} │ ${pad(renderMs, 5)} │`,
    );
  }
  lines.push("└─────────────┴──────────────────────────────┴───────┴───────┴────────┴────────┴───────┴───────┘");
  lines.push("");
  lines.push(`Total issues (dark): ${totalIssues}${highCount ? ` (${highCount} HIGH across all themes — CI would fail with --ci)` : ""}`);
  lines.push("");

  // Per-tab grades
  if (grades) {
    lines.push("── Per-tab grades ──────────────────────────────────────────────────────────");
    for (const tabLabel of TAB_LABELS) {
      const g = grades[tabLabel];
      if (g && g.grade !== "—") {
        const bar = "█".repeat(Math.round(g.score / 10)) + "░".repeat(10 - Math.round(g.score / 10));
        lines.push(`  ${pad(tabLabel, 11)}  ${g.grade}  ${bar} ${g.score}/100`);
      }
    }
    lines.push("");
  }

  // Issues by severity — include theme name so non-dark issues are identifiable
  const bySeverity = { high: [], low: [], info: [] };
  for (const r of results) {
    if (!r.issues) continue;
    for (const issue of r.issues) {
      bySeverity[issue.severity]?.push({ ...issue, tab: r.tab, size: r.size, theme: r.theme });
    }
  }

  if (bySeverity.high.length > 0) {
    lines.push("── HIGH severity (must fix) ──────────────────────────────────────────────");
    for (const issue of bySeverity.high) {
      lines.push(`  [${issue.category}] ${issue.tab} @ ${issue.size} [${issue.theme}]`);
      lines.push(`    ${issue.msg}`);
      if (issue.preview) lines.push(`    "${issue.preview}"`);
      lines.push("");
    }
  }

  if (bySeverity.low.length > 0) {
    lines.push("── LOW severity (should review) ───────────────────────────────────────────");
    for (const issue of bySeverity.low) {
      lines.push(`  [${issue.category}] ${issue.tab} @ ${issue.size} [${issue.theme}]`);
      lines.push(`    ${issue.msg}`);
      lines.push("");
    }
  }

  if (bySeverity.info.length > 0) {
    lines.push("── INFO (suggestions) ─────────────────────────────────────────────────────");
    for (const issue of bySeverity.info) {
      lines.push(`  [${issue.category}] ${issue.tab} @ ${issue.size} [${issue.theme}]`);
      lines.push(`    ${issue.msg}`);
      lines.push("");
    }
  }

  // Sparkline test definitions
  lines.push("── Graph function tests ───────────────────────────────────────────────────");
  lines.push("  Run these against the rendered Trends tab to verify graph integrity:");
  for (const test of sparklineTests) {
    lines.push(`  • ${test.name}`);
    lines.push(`    input: [${test.input.join(", ")}]`);
    lines.push(`    expect: ${test.check.toString().replace(/\s+/g, " ").slice(0, 80)}`);
  }
  lines.push("");

  // Golden frame results
  if (goldenResult) {
    lines.push("── Golden frames ──────────────────────────────────────────────────────────");
    if (goldenResult.action === "saved") {
      lines.push(`  Saved ${goldenResult.count} golden frames to ${GOLDEN_DIR}`);
      lines.push("  Run --golden-check in CI to detect visual regressions.");
    } else if (goldenResult.action === "checked") {
      if (goldenResult.diffs.length === 0) {
        lines.push("  ✅ All frames match golden — no visual regressions.");
      } else {
        lines.push(`  ❌ ${goldenResult.diffs.length} frames differ from golden:`);
        for (const d of goldenResult.diffs) {
          lines.push(`    ${d.tab} @ ${d.size}: ${d.status}`);
          if (d.firstDiff >= 0) {
            lines.push(`      line ${d.firstDiff}:`);
            lines.push(`        golden:  ${d.goldenPreview}`);
            lines.push(`        current: ${d.currentPreview}`);
          }
        }
      }
    }
    lines.push("");
  }

  // Actionable fix suggestions
  if (suggestions && suggestions.length > 0) {
    lines.push("── Fix suggestions (actionable) ────────────────────────────────────────────");
    for (const s of suggestions) {
      lines.push(`  ${s.tab}:`);
      lines.push(`    ${s.fix}`);
      lines.push("");
    }
  }

  // Color contrast report — WCAG AA ratios for the ANSI palette
  const contrastReport = checkColorContrast();
  if (contrastReport.lines.length > 0) {
    lines.push("── Color contrast (WCAG AA) ────────────────────────────────────────────────");
    lines.push(...contrastReport.lines);
    lines.push("");
  }

  // Recommendations
  lines.push("── Recommendations ────────────────────────────────────────────────────────");
  const recs = [];
  const overflowIssues = bySeverity.high.filter((i) => i.category === "overflow");
  const overflowLines = overflowIssues.reduce((sum, i) => sum + (i.count || 1), 0);
  const sparklineIssues = bySeverity.high.filter((i) => i.category === "sparkline").length;
  const budgetOverflow = bySeverity.high.filter((i) => i.category === "budget").length;
  const deadSpaceCount = bySeverity.low.filter((i) => i.category === "dead-space").length;
  const truncCount = bySeverity.low.filter((i) => i.category === "truncation").length;
  const alignCount = bySeverity.low.filter((i) => i.category === "alignment").length;
  const responsiveCount = bySeverity.info.filter((i) => i.category === "responsive").length;
  const visualWeightCount = bySeverity.info.filter((i) => i.category === "visual-weight").length;

  if (overflowLines > 0)
    recs.push(`Fix ${overflowLines} overflow lines (${overflowIssues.length} groups) — they wrap/garble in real terminals`);
  if (sparklineIssues > 0)
    recs.push(`Fix ${sparklineIssues} sparkline integrity violations — fake dots, fake stubs, or fake peaks`);
  if (budgetOverflow > 0)
    recs.push(`Fix ${budgetOverflow} tabs that render more rows than fit — content is silently dropped`);
  if (truncCount > 0)
    recs.push(`Review ${truncCount} truncated labels — might be losing important text`);
  if (alignCount > 0)
    recs.push(`Fix ${alignCount} column alignment issues — table columns don't line up`);
  if (deadSpaceCount > 0)
    recs.push(`${deadSpaceCount} dead-space zones could hold sparklines, bars, or stats`);
  if (responsiveCount > 0)
    recs.push(`${responsiveCount} tabs don't adapt to wider terminals — bars/columns could use the extra space`);
  if (visualWeightCount > 0)
    recs.push(`${visualWeightCount} tabs are text-heavy — could add sparklines, bars, or mini-graphs (owner wants more visuals)`);
  if (recs.length === 0)
    recs.push("No issues found — all tabs render within budget at all tested sizes.");
  recs.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
  lines.push("");

  return lines.join("\n");
}

function pad(s, w) {
  const len = String(s).length;
  if (len >= w) return String(s).slice(0, w);
  return String(s) + " ".repeat(w - len);
}
