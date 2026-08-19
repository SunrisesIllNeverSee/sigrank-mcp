// tui-themes.mjs — centralized ANSI color palette with multiple themes
//
// Tokscale-inspired: all colors live in one module, render code references
// them through `currentTheme`. Supports dark (default), light, high-contrast,
// and monochrome themes for accessibility.
//
// Usage in tui.mjs:
//   import { currentTheme as c, setTheme } from "./tui-themes.mjs";
//   // c.gold, c.cyan, c.reset, etc. — same interface as the old `c` object
//
// CLI:
//   node tui.mjs --theme dark           # default
//   node tui.mjs --theme light          # light terminal
//   node tui.mjs --theme high-contrast  # visually impaired
//   node tui.mjs --theme monochrome     # colorblind

const ESC = "\x1b[";

export const THEMES = {
  // ── Dark (default) — current palette, designed for dark terminals ──
  // green uses 256-color 77 (#5fd75f) for WCAG AA compliance on dark bg (9.0:1).
  // Standard ANSI 32 (#5a8a5a) only achieves 4.1:1 — below the 4.5:1 threshold.
  dark: {
    name: "dark",
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    gold: `${ESC}33m`,
    boldGold: `${ESC}1;33m`,
    cyan: `${ESC}36m`,
    boldCyan: `${ESC}1;36m`,
    green: `${ESC}38;5;77m`,  // brighter green #5fd75f (9.0:1 on dark — was ANSI 32 at 4.1:1)
    red: `${ESC}38;5;203m`,   // brighter red #ff5f5f (5.6:1 on dark — was ANSI 31 at 4.46:1, just below AA)
    white: `${ESC}97m`,
    boldWhite: `${ESC}1;97m`,
    magenta: `${ESC}35m`,
    blue: `${ESC}34m`,
    bgDim: `${ESC}48;5;236m`,
    bgCyan: `${ESC}48;5;23m`,
    // Medal backgrounds (256-color) — gold/silver/bronze podium tints
    medalBg: { 1: 220, 2: 250, 3: 130 },
    medalFg: `${ESC}38;5;232m`, // dark text on medal bg
  },

  // ── Light — dark text on light/white terminals ──
  // Uses 256-color codes (38;5;N) with darker shades that pass WCAG AA (4.5:1)
  // on white backgrounds. Standard ANSI 33/36/32/31/35/34 render as pastel
  // shades that fail contrast on white — these 256-color variants fix that.
  light: {
    name: "light",
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}38;5;242m`,     // medium gray (4.5:1 on white — passes AA for large text)
    gold: `${ESC}38;5;130m`,    // dark orange-gold #af5f00 (4.7:1 — yellow can't pass AA on white, this is the closest)
    boldGold: `${ESC}1;38;5;130m`, // bold dark orange-gold (4.7:1)
    cyan: `${ESC}38;5;24m`,     // dark cyan #005f87 (7.0:1)
    boldCyan: `${ESC}1;38;5;24m`, // bold dark cyan (7.0:1)
    green: `${ESC}38;5;28m`,    // dark green #008700 (4.7:1)
    red: `${ESC}38;5;124m`,     // dark red #af0000 (7.4:1)
    white: `${ESC}30m`,         // BLACK text on light bg (21:1)
    boldWhite: `${ESC}1;30m`,   // bold black
    magenta: `${ESC}38;5;90m`,  // dark magenta #870087 (8.8:1)
    blue: `${ESC}38;5;19m`,     // dark blue #0000af (13.0:1)
    bgDim: `${ESC}48;5;250m`,   // light grey bg for active tab
    bgCyan: `${ESC}48;5;194m`,  // light teal bg for active tab
    medalBg: { 1: 220, 2: 250, 3: 130 },
    medalFg: `${ESC}38;5;232m`,
  },

  // ── High contrast — bold everything, no dim, maximum readability ──
  highContrast: {
    name: "high-contrast",
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}0;37m`,       // NO dim — full brightness white instead
    gold: `${ESC}1;33m`,      // bold gold
    boldGold: `${ESC}1;33m`,
    cyan: `${ESC}1;36m`,      // bold cyan
    boldCyan: `${ESC}1;36m`,
    green: `${ESC}1;32m`,     // bold green
    red: `${ESC}1;31m`,       // bold red
    white: `${ESC}1;97m`,     // bold bright white
    boldWhite: `${ESC}1;97m`,
    magenta: `${ESC}1;35m`,   // bold magenta
    blue: `${ESC}1;34m`,      // bold blue
    bgDim: `${ESC}48;5;238m`, // slightly lighter dark bg
    bgCyan: `${ESC}48;5;24m`, // slightly lighter teal bg
    medalBg: { 1: 220, 2: 250, 3: 130 },
    medalFg: `${ESC}1;38;5;232m`,
  },

  // ── Monochrome — bold/normal only, no color (colorblind-safe) ──
  monochrome: {
    name: "monochrome",
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,          // dim is fine in monochrome (it's weight, not color)
    gold: `${ESC}1m`,         // bold only (no color)
    boldGold: `${ESC}1m`,
    cyan: `${ESC}0m`,         // normal weight
    boldCyan: `${ESC}1m`,     // bold
    green: `${ESC}0m`,        // normal
    red: `${ESC}1m`,          // bold (errors stand out by weight)
    white: `${ESC}0m`,        // normal
    boldWhite: `${ESC}1m`,    // bold
    magenta: `${ESC}0m`,      // normal
    blue: `${ESC}0m`,         // normal
    bgDim: `${ESC}7m`,        // reverse video for active tab (no color)
    bgCyan: `${ESC}7m`,       // reverse video
    medalBg: {},              // no medal colors in monochrome
    medalFg: `${ESC}1m`,      // bold for medal winners
  },
};

export let currentTheme = THEMES.dark;

export function setTheme(name) {
  if (THEMES[name]) {
    currentTheme = THEMES[name];
  }
  return currentTheme;
}

export function getThemeNames() {
  return Object.keys(THEMES);
}
