#!/bin/bash
set -euo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || { echo "not inside a git repository" >&2; exit 1; }
src="$root/.repo/git-hooks/pre-commit"
[ -f "$src" ] || { echo "hook source missing: $src" >&2; exit 1; }
configured="$(git -C "$root" config --get core.hooksPath || true)"
if [ -n "$configured" ]; then
  echo "warning: core.hooksPath is set to '$configured'; hooks in the default directory are ignored." >&2
fi
hooks="$(cd "$root" && git rev-parse --path-format=absolute --git-path hooks)"
mkdir -p "$hooks"
cp "$src" "$hooks/pre-commit"
chmod +x "$hooks/pre-commit"
echo "Installed Repository Standard pre-commit hook."
