// connect.mjs — pure predicates for the TUI consolidation (the TUI is the whole app).
// No fs, no I/O, no side effects — unit-testable in isolation. Used by tui.mjs to
// decide sign-in state and to classify keystrokes while the Connect code field is focused.

/** True iff this device identity is signed in (bound to an operator). */
export function isSignedIn(id) {
  return !!(id && id.codename && id.operator_id);
}

/** True iff `s` is a single character a connect code can contain ([A-Za-z0-9-]). */
export function isCodeChar(s) {
  return typeof s === "string" && /^[A-Za-z0-9-]$/.test(s);
}
