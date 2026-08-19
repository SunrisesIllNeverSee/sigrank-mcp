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
  dark: {
    name: "dark",
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    gold: `${ESC}33m`,
    boldGold: `${ESC}1;33m`,
    cyan: `${ESC}36m`,
    boldCyan: `${ESC}1;36m`,
    green: `${ESC}32m`,
    red: `${ESC}31m`,
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
  // Colors adjusted for contrast against white/light backgrounds.
  light: {
    name: "light",
    reset: `${ESC}0m`,
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    gold: `${ESC}33m`,        // yellow is readable on white
    boldGold: `${ESC}1;33m`,
    cyan: `${ESC}36m`,        // cyan is readable on white
    boldCyan: `${ESC}1;36m`,
    green: `${ESC}32m`,       // standard green (darker shade would be better but ANSI 32 is the option)
    red: `${ESC}31m`,         // standard red
    white: `${ESC}30m`,       // BLACK text on light bg (was bright white)
    boldWhite: `${ESC}1;30m`, // bold black
    magenta: `${ESC}35m`,
    blue: `${ESC}34m`,        // blue is readable on white
    bgDim: `${ESC}48;5;250m`, // light grey bg for active tab
    bgCyan: `${ESC}48;5;194m`,// light teal bg for active tab
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
