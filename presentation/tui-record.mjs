// tui-record.mjs — record a TUI session as an animated GIF
//
// Renders each tab headlessly (same in-process render as the audit), converts
// the ANSI buffer to RGB pixels, and encodes as a GIF that cycles through the
// tabs. Useful for README demos, documentation, and bug reproduction.
//
// Usage:
//   node tui.mjs --record demo.gif                    # record at 100×30, 10fps
//   node tui.mjs --record demo.gif --record-speed 5   # 5fps (slower)
//   node tui.mjs --record demo.gif --record-size 80   # 80 cols wide
//
// No TTY needed — works headless for CI. The "session" is a scripted cycle
// through all 6 tabs (Dashboard → Trends → Compare → Board → Watch → Connect),
// with each tab held for ~1 second of playback.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── ANSI color → RGB mapping ───────────────────────────────────────────────
// Maps ANSI SGR codes to approximate RGB colors (matching the audit's palette).
// Background is dark (#1d1f21). Default text is light gray (#c5c8c6).

const BG = [0x1d, 0x1f, 0x21];
const DEFAULT_FG = [0xc5, 0xc8, 0xc6];

const ANSI_RGB = {
  0: DEFAULT_FG,    // reset
  1: DEFAULT_FG,    // bold (same color, just brighter weight — we approximate)
  2: [0x6e, 0x8a, 0x6e], // dim
  30: [0x00, 0x00, 0x00], // black
  31: [0xcc, 0x66, 0x66], // red
  32: [0x5a, 0x8a, 0x5a], // green
  33: [0xf0, 0xc8, 0x62], // gold/yellow
  34: [0x81, 0xa2, 0xbe], // blue
  35: [0xb2, 0x94, 0xbb], // magenta
  36: [0x56, 0xb4, 0xb4], // cyan
  37: [0xc5, 0xc8, 0xc6], // white (standard)
  90: [0x6e, 0x8a, 0x6e], // bright black (dim)
  97: [0xe0, 0xe0, 0xe0], // bright white
};

function parseAnsiColor(line) {
  // Returns array of { char, fg } for each visible character in the line.
  // Parses ANSI escape sequences to track the current foreground color.
  const result = [];
  let fg = DEFAULT_FG;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      // ANSI escape sequence — parse the SGR code(s)
      let j = i + 2;
      let code = "";
      while (j < line.length && line[j] !== "m" && line[j] !== "H" && line[j] !== "J" && line[j] !== "K") {
        code += line[j];
        j++;
      }
      if (line[j] === "m") {
        // SGR — update foreground color
        const codes = code.split(";").map((n) => parseInt(n, 10));
        if (codes[0] === 0 || codes[0] === undefined) {
          fg = DEFAULT_FG;
        } else if (codes[0] === 1 && codes[1]) {
          // bold + color (e.g. 1;33 = bold gold)
          fg = ANSI_RGB[codes[1]] ?? DEFAULT_FG;
        } else if (codes[0] === 2) {
          fg = ANSI_RGB[2] ?? [0x6e, 0x8a, 0x6e];
        } else if (ANSI_RGB[codes[0]]) {
          fg = ANSI_RGB[codes[0]];
        } else if (codes[0] >= 40 && codes[0] < 50) {
          // background color — skip (we use uniform dark bg)
        } else if (codes[0] >= 48) {
          // extended background (256-color) — skip
        }
      }
      i = j + 1;
    } else if (line[i] === "\x1b") {
      // Other escape sequence — skip
      i += 2;
    } else {
      result.push({ char: line[i], fg });
      i++;
    }
  }
  return result;
}

function frameToPixels(lines, cols, rows) {
  // Convert ANSI text lines to an RGBA pixel buffer.
  // Each character cell is 10×20 pixels (monospace approximation).
  const charW = 10;
  const charH = 20;
  const width = cols * charW;
  const height = rows * charH;
  const data = new Uint8Array(width * height * 4);

  // Fill with background color
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BG[0];
    data[i + 1] = BG[1];
    data[i + 2] = BG[2];
    data[i + 3] = 255;
  }

  // Render each character as a filled block (approximation — no font rendering)
  for (let row = 0; row < Math.min(lines.length, rows); row++) {
    const chars = parseAnsiColor(lines[row] || "");
    for (let col = 0; col < Math.min(chars.length, cols); col++) {
      const { char, fg } = chars[col];
      if (char === " " || char === "") continue;

      // Draw a small filled rectangle for each character
      const px = col * charW;
      const py = row * charH;
      // Simple glyph: draw a 7×14 block (leaving 1px margin top/bottom, 1.5px sides)
      const gw = 7;
      const gh = 14;
      const ox = 1;
      const oy = 3;
      for (let dy = 0; dy < gh; dy++) {
        for (let dx = 0; dx < gw; dx++) {
          const idx = ((py + oy + dy) * width + (px + ox + dx)) * 4;
          if (idx >= 0 && idx < data.length - 3) {
            data[idx] = fg[0];
            data[idx + 1] = fg[1];
            data[idx + 2] = fg[2];
            data[idx + 3] = 255;
          }
        }
      }
    }
  }

  return { data, width, height };
}

// ── GIF encoding ───────────────────────────────────────────────────────────

export async function encodeGif(frames, fps = 10) {
  const mod = await import("gifenc");
  const { GIFEncoder, quantize, applyPalette } = mod.default || mod;
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);

  for (const frame of frames) {
    const palette = quantize(frame.data, 256);
    const indexed = applyPalette(frame.data, palette);
    gif.writeFrame(indexed, frame.width, frame.height, { palette, delay });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// ── Record session ─────────────────────────────────────────────────────────

export async function recordSession(outputPath, opts = {}) {
  const { fps = 10, cols = 100, rows = 30, holdPerTab = 1 } = opts;

  const tui = await import("./tui.mjs");
  const { startBuffer, _getScreenBuf, _resetBuf } = tui;
  const { loadIdentity } = await import("../keystore.mjs");

  // Set terminal dimensions for the render
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });

  // Load data once — reused across all tabs (same pattern as tui-audit.mjs).
  // Each load is try/catch so a failed source doesn't kill the recording.
  const dashData = await tui.loadDashboardData?.().catch(() => null) ?? null;
  const compareData = await tui.loadCompareData?.("claude").catch(() => null) ?? null;
  const boardData = await tui.loadBoardData?.("30d").catch(() => null) ?? null;

  const frames = [];

  // Render each tab and capture frames
  for (let tabIdx = 0; tabIdx < 6; tabIdx++) {
    startBuffer();
    try {
      if (tabIdx === 0) tui.renderDashboard(dashData || { active: [] }, "record");
      else if (tabIdx === 1) tui.renderTrends(dashData || { active: [] }, 0);
      else if (tabIdx === 2) tui.renderCompare(compareData);
      else if (tabIdx === 3) tui.renderBoard(boardData, "30d");
      else if (tabIdx === 4) await tui.renderWatch("all", "all-windows");
      else if (tabIdx === 5) tui.renderConnect(loadIdentity(), "", "");
    } catch {
      // skip broken tab
    }
    const rawLines = [...(_getScreenBuf() || [])];
    _resetBuf();

    // Pad to rows
    const padded = [...rawLines];
    while (padded.length < rows) padded.push("");

    const pixels = frameToPixels(padded, cols, rows);
    // Hold each tab for `holdPerTab` frames
    for (let h = 0; h < holdPerTab * fps; h++) {
      frames.push(pixels);
    }
  }

  // Encode GIF
  const gifBuffer = await encodeGif(frames, fps);

  // Write to file
  const dir = dirname(outputPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, gifBuffer);

  return { path: outputPath, size: gifBuffer.length, frames: frames.length, fps };
}

// ── CLI entry point (called from tui.mjs --record) ─────────────────────────

export async function recordCli(args) {
  const recordIdx = args.indexOf("--record");
  const outputPath = args[recordIdx + 1] || "sigrank-demo.gif";
  const speedIdx = args.indexOf("--record-speed");
  const fps = speedIdx !== -1 ? parseInt(args[speedIdx + 1], 10) : 10;
  const sizeIdx = args.indexOf("--record-size");
  const cols = sizeIdx !== -1 ? parseInt(args[sizeIdx + 1], 10) : 100;
  const rows = Math.round(cols * 0.3);

  console.log(`Recording TUI session → ${outputPath} (${cols}×${rows}, ${fps}fps)...`);
  const result = await recordSession(outputPath, { fps, cols, rows });
  console.log(`✓ Recorded ${result.frames} frames → ${result.path} (${(result.size / 1024 / 1024).toFixed(1)}MB)`);
}
