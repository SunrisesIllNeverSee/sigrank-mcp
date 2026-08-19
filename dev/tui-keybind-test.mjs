// ── TUI Keybinding Tests ───────────────────────────────────────────────────
// Tests the keybinding resolution logic extracted from the main TUI loop.
// The main loop in tui.mjs is deeply intertwined with mutable state and async
// redraws. This module exports a PURE `resolveKeyAction(key, state)` function
// that returns the action a key should trigger, without performing side effects.
//
// Run: node presentation/tui-keybind-test.mjs

// ── Pure key resolver ──────────────────────────────────────────────────────
// Mirrors the key handling logic in tui.mjs (lines ~2674–2945).
// Returns { action, tab?, platform?, window?, ... } or { action: "noop" }.
//
// state = {
//   activeTab: number (0-5),
//   signedIn: boolean,
//   ompAvailable: boolean,
//   ompLoading: boolean,
//   submitPreview: boolean,
//   codeBuf: string (non-empty = user is typing a connect code),
//   platform: string (current compare platform),
//   watchPlatform: string,
//   watchWindow: string,
//   boardWindow: string,
//   trendSub: number (0=You, 1=Platform, 2=Field),
//   cascadeScrollable: boolean,
// }
//
// TABS: 0=Dashboard 1=Trends 2=Compare 3=Board 4=Watch 5=Connect

const TAB_NAMES = ["Dashboard", "Trends", "Compare", "Board", "Watch", "Connect"];

const CYCLE_PLATFORMS = [
  "claude", "codex", "amp", "gemini", "kimi", "qwen",
  "goose", "kilo", "hermes", "droid", "codebuff", "copilot",
  "openclaw", "pi", "omp",
];

export function resolveKeyAction(rawKey, state) {
  const k = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
  const {
    activeTab = 0,
    signedIn = false,
    ompAvailable = false,
    ompLoading = false,
    submitPreview = false,
    codeBuf = "",
  } = state;

  // ── Submit preview mode (Enter/Esc only) ──
  if (submitPreview) {
    if (rawKey === "\r" || rawKey === "\n") return { action: "submit-confirm" };
    if (rawKey === "\x1b") return { action: "submit-cancel" };
    return { action: "noop" };
  }

  // ── Connect tab: code entry field captures most keys ──
  if (activeTab === 5 && codeBuf !== "") {
    if (rawKey === "\r" || rawKey === "\n") return { action: "connect-submit" };
    if (rawKey === "\x1b") return { action: "connect-cancel" };
    if (rawKey === "\x7f" || rawKey === "\b") return { action: "connect-backspace" };
    if (k === "x" && !codeBuf) return { action: "sign-out" };
    // Other printable chars go into the code buffer
    if (rawKey.length === 1 && rawKey >= " " && rawKey <= "~")
      return { action: "connect-type", char: rawKey };
    return { action: "noop" };
  }

  // ── Quit (q / Ctrl+C) ──
  if (k === "q" || rawKey === "\x03") return { action: "quit" };

  // ── Sign out [X] (Connect tab, no code buffer) ──
  if (k === "x" && activeTab === 5 && !codeBuf) return { action: "sign-out" };

  // ── OMP toggle [O] (Dashboard only, when available) ──
  if (activeTab === 0 && k === "o" && ompAvailable) {
    if (ompLoading) return { action: "omp-toggle-loading" };
    return { action: "omp-toggle" };
  }

  // ── Esc → back to Dashboard (from any non-Dashboard tab) ──
  if (rawKey === "\x1b" && activeTab !== 0) return { action: "back-to-dashboard" };

  // ── Dashboard scroll (↑/↓/j/k/PgUp/PgDn) ──
  if (activeTab === 0 && state.cascadeScrollable) {
    if (rawKey === "\x1b[A" || k === "k") return { action: "scroll-up" };
    if (rawKey === "\x1b[B" || k === "j") return { action: "scroll-down" };
    if (rawKey === "\x1b[5~") return { action: "scroll-page-up" };
    if (rawKey === "\x1b[6~") return { action: "scroll-page-down" };
  }

  // ── Tab switching: ←/→ arrows ──
  if (rawKey === "\x1b[C") return { action: "switch-tab", tab: Math.min(5, activeTab + 1) };
  if (rawKey === "\x1b[D") return { action: "switch-tab", tab: Math.max(0, activeTab - 1) };

  // ── Tab switching: number keys 1-6 ──
  for (let i = 0; i < 6; i++) {
    if (k === String(i + 1)) return { action: "switch-tab", tab: i };
  }

  // ── [C] → Connect from any non-Connect tab ──
  if (k === "c" && activeTab !== 5) return { action: "switch-tab", tab: 5 };

  // ── Trends: [T] cycles sub-view (You · Platform · Field) ──
  if (activeTab === 1 && k === "t")
    return { action: "trends-cycle-sub", sub: (state.trendSub + 1) % 3 };

  // ── Watch: [+]/[-] tune refresh interval ──
  if (activeTab === 4 && (k === "+" || k === "=")) return { action: "watch-refresh-up" };
  if (activeTab === 4 && (k === "-" || k === "_")) return { action: "watch-refresh-down" };

  // ── [P] cycles platform on Compare + Watch ──
  if (k === "p" && (activeTab === 2 || activeTab === 4)) {
    if (activeTab === 2) {
      const idx = CYCLE_PLATFORMS.indexOf(state.platform);
      const next = CYCLE_PLATFORMS[(idx + 1) % CYCLE_PLATFORMS.length];
      return { action: "cycle-platform", platform: next };
    } else {
      const cycle = ["all", ...CYCLE_PLATFORMS];
      const idx = cycle.indexOf(state.watchPlatform);
      const next = cycle[(idx + 1) % cycle.length];
      return { action: "cycle-platform", platform: next };
    }
  }

  // ── [W] cycles window on Watch + Board ──
  if (k === "w" && activeTab === 4) {
    const cycle = ["all-windows", "7d", "30d", "90d", "all"];
    const idx = cycle.indexOf(state.watchWindow);
    return { action: "cycle-window", window: cycle[(idx + 1) % cycle.length] };
  }
  if (k === "w" && activeTab === 3) {
    const windows = ["7d", "30d", "90d", "all"];
    const idx = windows.indexOf(state.boardWindow);
    return { action: "cycle-window", window: windows[(idx + 1) % windows.length] };
  }

  // ── Watch: [Enter] launches watcher ──
  if (activeTab === 4 && (rawKey === "\r" || rawKey === "\n"))
    return { action: "watch-launch" };

  // ── [R] refresh ──
  if (k === "r") return { action: "refresh" };

  // ── [S] submit (not on Connect) ──
  if (k === "s" && activeTab !== 5) {
    if (!signedIn) return { action: "switch-tab", tab: 5, reason: "sign-in-required" };
    return { action: "submit-preview" };
  }

  // ── [Y] toggle just-me mode (Board only, signed in) ──
  if (k === "y" && activeTab === 3 && signedIn) return { action: "board-toggle-you" };

  return { action: "noop" };
}

// ── Test runner ────────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

// Tab switching: number keys 1-6
test("1-6 keys switch to correct tab", () => {
  for (let i = 0; i < 6; i++) {
    const result = resolveKeyAction(String(i + 1), { activeTab: 0 });
    eq(result, { action: "switch-tab", tab: i }, `Key ${i + 1} should switch to tab ${i}`);
  }
});

// Tab switching: arrow keys
test("→ arrow advances tab", () => {
  eq(resolveKeyAction("\x1b[C", { activeTab: 0 }), { action: "switch-tab", tab: 1 }, "→ from Dashboard");
  eq(resolveKeyAction("\x1b[C", { activeTab: 4 }), { action: "switch-tab", tab: 5 }, "→ from Watch");
  eq(resolveKeyAction("\x1b[C", { activeTab: 5 }), { action: "switch-tab", tab: 5 }, "→ from Connect stays at 5 (max)");
});

test("← arrow goes back", () => {
  eq(resolveKeyAction("\x1b[D", { activeTab: 5 }), { action: "switch-tab", tab: 4 }, "← from Connect");
  eq(resolveKeyAction("\x1b[D", { activeTab: 1 }), { action: "switch-tab", tab: 0 }, "← from Trends");
  eq(resolveKeyAction("\x1b[D", { activeTab: 0 }), { action: "switch-tab", tab: 0 }, "← from Dashboard stays at 0 (min)");
});

// [C] → Connect from any non-Connect tab
test("[C] switches to Connect from any read tab", () => {
  for (let i = 0; i < 5; i++) {
    const result = resolveKeyAction("c", { activeTab: i });
    eq(result, { action: "switch-tab", tab: 5 }, `[C] from tab ${i} should go to Connect`);
  }
});

test("[C] does nothing on Connect tab", () => {
  const result = resolveKeyAction("c", { activeTab: 5 });
  assert(result.action !== "switch-tab", "[C] on Connect should not switch tabs");
});

// Esc → back to Dashboard
test("Esc goes back to Dashboard from any non-Dashboard tab", () => {
  for (let i = 1; i < 6; i++) {
    const result = resolveKeyAction("\x1b", { activeTab: i });
    eq(result, { action: "back-to-dashboard" }, `Esc from tab ${i}`);
  }
});

test("Esc does nothing on Dashboard", () => {
  const result = resolveKeyAction("\x1b", { activeTab: 0 });
  assert(result.action !== "back-to-dashboard", "Esc on Dashboard should not trigger back");
});

// Quit: q / Ctrl+C
test("q quits from any tab", () => {
  for (let i = 0; i < 6; i++) {
    const result = resolveKeyAction("q", { activeTab: i });
    eq(result, { action: "quit" }, `q from tab ${i}`);
  }
});

test("Ctrl+C quits from any tab", () => {
  const result = resolveKeyAction("\x03", { activeTab: 0 });
  eq(result, { action: "quit" }, "Ctrl+C should quit");
});

// [R] refresh
test("[R] triggers refresh from any tab", () => {
  for (let i = 0; i < 6; i++) {
    const result = resolveKeyAction("r", { activeTab: i });
    eq(result, { action: "refresh" }, `R from tab ${i}`);
  }
});

// [S] submit
test("[S] opens submit preview when signed in (not on Connect)", () => {
  for (let i = 0; i < 5; i++) {
    const result = resolveKeyAction("s", { activeTab: i, signedIn: true });
    eq(result, { action: "submit-preview" }, `S from tab ${i} when signed in`);
  }
});

test("[S] redirects to Connect when not signed in", () => {
  const result = resolveKeyAction("s", { activeTab: 0, signedIn: false });
  eq(result, { action: "switch-tab", tab: 5, reason: "sign-in-required" }, "S when not signed in");
});

test("[S] does not trigger submit on Connect tab", () => {
  const result = resolveKeyAction("s", { activeTab: 5, signedIn: true });
  assert(result.action !== "submit-preview", "S on Connect should not open submit preview");
});

// [P] cycle platform
test("[P] cycles platform on Compare", () => {
  const result = resolveKeyAction("p", { activeTab: 2, platform: "claude" });
  eq(result, { action: "cycle-platform", platform: "codex" }, "P on Compare cycles claude→codex");
});

test("[P] cycles platform on Watch (includes 'all')", () => {
  const result = resolveKeyAction("p", { activeTab: 4, watchPlatform: "all" });
  eq(result, { action: "cycle-platform", platform: "claude" }, "P on Watch cycles all→claude");
});

test("[P] does nothing on Dashboard", () => {
  const result = resolveKeyAction("p", { activeTab: 0 });
  assert(result.action !== "cycle-platform", "P on Dashboard should not cycle platform");
});

test("[P] does nothing on Board", () => {
  const result = resolveKeyAction("p", { activeTab: 3 });
  assert(result.action !== "cycle-platform", "P on Board should not cycle platform");
});

// [W] cycle window
test("[W] cycles window on Watch", () => {
  const result = resolveKeyAction("w", { activeTab: 4, watchWindow: "all-windows" });
  eq(result, { action: "cycle-window", window: "7d" }, "W on Watch cycles all-windows→7d");
});

test("[W] cycles window on Board", () => {
  const result = resolveKeyAction("w", { activeTab: 3, boardWindow: "7d" });
  eq(result, { action: "cycle-window", window: "30d" }, "W on Board cycles 7d→30d");
});

test("[W] does nothing on Dashboard", () => {
  const result = resolveKeyAction("w", { activeTab: 0 });
  assert(result.action !== "cycle-window", "W on Dashboard should not cycle window");
});

// [Y] toggle just-me on Board
test("[Y] toggles just-me on Board when signed in", () => {
  const result = resolveKeyAction("y", { activeTab: 3, signedIn: true });
  eq(result, { action: "board-toggle-you" }, "Y on Board when signed in");
});

test("[Y] does nothing on Board when not signed in", () => {
  const result = resolveKeyAction("y", { activeTab: 3, signedIn: false });
  assert(result.action !== "board-toggle-you", "Y on Board when not signed in should be noop");
});

test("[Y] does nothing on other tabs", () => {
  for (const tab of [0, 1, 2, 4, 5]) {
    const result = resolveKeyAction("y", { activeTab: tab, signedIn: true });
    assert(result.action !== "board-toggle-you", `Y on tab ${tab} should not toggle board`);
  }
});

// [T] Trends sub-view cycle
test("[T] cycles sub-view on Trends", () => {
  eq(resolveKeyAction("t", { activeTab: 1, trendSub: 0 }), { action: "trends-cycle-sub", sub: 1 }, "T cycles 0→1");
  eq(resolveKeyAction("t", { activeTab: 1, trendSub: 1 }), { action: "trends-cycle-sub", sub: 2 }, "T cycles 1→2");
  eq(resolveKeyAction("t", { activeTab: 1, trendSub: 2 }), { action: "trends-cycle-sub", sub: 0 }, "T cycles 2→0 (wraps)");
});

test("[T] does nothing on other tabs", () => {
  const result = resolveKeyAction("t", { activeTab: 0 });
  assert(result.action !== "trends-cycle-sub", "T on Dashboard should be noop");
});

// Watch: [+]/[-] refresh interval
test("[+] increases watch refresh interval", () => {
  eq(resolveKeyAction("+", { activeTab: 4 }), { action: "watch-refresh-up" }, "+ on Watch");
  eq(resolveKeyAction("=", { activeTab: 4 }), { action: "watch-refresh-up" }, "= on Watch (shifted +)");
});

test("[-] decreases watch refresh interval", () => {
  eq(resolveKeyAction("-", { activeTab: 4 }), { action: "watch-refresh-down" }, "- on Watch");
  eq(resolveKeyAction("_", { activeTab: 4 }), { action: "watch-refresh-down" }, "_ on Watch (shifted -)");
});

// Watch: [Enter] launches watcher
test("[Enter] launches watcher on Watch tab", () => {
  eq(resolveKeyAction("\r", { activeTab: 4 }), { action: "watch-launch" }, "Enter on Watch");
  eq(resolveKeyAction("\n", { activeTab: 4 }), { action: "watch-launch" }, "\\n on Watch");
});

test("[Enter] does not launch watcher on other tabs", () => {
  const result = resolveKeyAction("\r", { activeTab: 0 });
  assert(result.action !== "watch-launch", "Enter on Dashboard should not launch watcher");
});

// [X] sign out on Connect
test("[X] signs out on Connect (no code buffer)", () => {
  eq(resolveKeyAction("x", { activeTab: 5, codeBuf: "" }), { action: "sign-out" }, "X on Connect with empty code buffer");
});

test("[X] does nothing on other tabs", () => {
  for (const tab of [0, 1, 2, 3, 4]) {
    const result = resolveKeyAction("x", { activeTab: tab });
    assert(result.action !== "sign-out", `X on tab ${tab} should not sign out`);
  }
});

// [O] OMP toggle on Dashboard
test("[O] toggles OMP on Dashboard when available", () => {
  eq(resolveKeyAction("o", { activeTab: 0, ompAvailable: true }), { action: "omp-toggle" }, "O on Dashboard with OMP available");
});

test("[O] does nothing when OMP not available", () => {
  const result = resolveKeyAction("o", { activeTab: 0, ompAvailable: false });
  assert(result.action !== "omp-toggle", "O should not toggle when OMP unavailable");
});

test("[O] does nothing on other tabs", () => {
  const result = resolveKeyAction("o", { activeTab: 1, ompAvailable: true });
  assert(result.action !== "omp-toggle", "O on Trends should not toggle OMP");
});

// Submit preview mode
test("Enter confirms submit when in preview mode", () => {
  eq(resolveKeyAction("\r", { submitPreview: true }), { action: "submit-confirm" }, "Enter in submit preview");
});

test("Esc cancels submit when in preview mode", () => {
  eq(resolveKeyAction("\x1b", { submitPreview: true }), { action: "submit-cancel" }, "Esc in submit preview");
});

test("Other keys are swallowed in submit preview mode", () => {
  eq(resolveKeyAction("a", { submitPreview: true }), { action: "noop" }, "a in submit preview");
  eq(resolveKeyAction("1", { submitPreview: true }), { action: "noop" }, "1 in submit preview");
});

// Connect code entry
test("Connect tab with code buffer captures printable chars", () => {
  const result = resolveKeyAction("a", { activeTab: 5, codeBuf: "x" });
  eq(result, { action: "connect-type", char: "a" }, "Typing 'a' into code buffer");
});

test("Connect tab Enter submits code", () => {
  eq(resolveKeyAction("\r", { activeTab: 5, codeBuf: "abc" }), { action: "connect-submit" }, "Enter with code buffer");
});

test("Connect tab Esc cancels code entry", () => {
  eq(resolveKeyAction("\x1b", { activeTab: 5, codeBuf: "abc" }), { action: "connect-cancel" }, "Esc with code buffer");
});

test("Connect tab Backspace deletes char", () => {
  eq(resolveKeyAction("\x7f", { activeTab: 5, codeBuf: "abc" }), { action: "connect-backspace" }, "Backspace with code buffer");
});

// Dashboard scroll
test("Dashboard scroll keys work when scrollable", () => {
  const s = { activeTab: 0, cascadeScrollable: true };
  eq(resolveKeyAction("\x1b[A", s), { action: "scroll-up" }, "↑ scrolls up");
  eq(resolveKeyAction("\x1b[B", s), { action: "scroll-down" }, "↓ scrolls down");
  eq(resolveKeyAction("k", s), { action: "scroll-up" }, "k scrolls up");
  eq(resolveKeyAction("j", s), { action: "scroll-down" }, "j scrolls down");
  eq(resolveKeyAction("\x1b[5~", s), { action: "scroll-page-up" }, "PgUp scrolls page up");
  eq(resolveKeyAction("\x1b[6~", s), { action: "scroll-page-down" }, "PgDn scrolls page down");
});

test("Dashboard scroll keys do nothing when not scrollable", () => {
  const s = { activeTab: 0, cascadeScrollable: false };
  const up = resolveKeyAction("\x1b[A", s);
  assert(up.action !== "scroll-up", "↑ should not scroll when not scrollable");
});

// Unknown keys
test("Unknown keys return noop", () => {
  eq(resolveKeyAction("z", { activeTab: 0 }), { action: "noop" }, "z is noop");
  eq(resolveKeyAction("!", { activeTab: 0 }), { action: "noop" }, "! is noop");
});

// ── Run tests ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
