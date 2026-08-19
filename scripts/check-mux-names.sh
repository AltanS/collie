#!/usr/bin/env bash
# Keeps multiplexer names out of the frontend's DECISIONS (M10/06).
#
# WHAT IS BANNED, and why it is this shape. A string literal whose whole content is a registered
# multiplexer name — `"herdr"`, `'tmux'`, `` `zellij` `` — is the branch: `mux === "tmux"`, a lookup
# table keyed by name, a `hasFeature(name)` helper. Every one of those re-welds the app to one
# multiplexer, which is the thing this milestone exists to undo. The phone asks
# `/api/config`'s capability declaration instead, and that answer arrives already true for whichever
# multiplexer is underneath.
#
# WHAT IS NOT BANNED, deliberately:
#
#   • **Prose.** A comment explaining that Herdr's `truncated` flag is always false is documentation
#     of a real bridge, and deleting the word would delete the fact.
#   • **Explanation text.** A sentence like "tmux keeps no agent session log for Collie to read" is
#     the ADAPTER's own note, published on `/api/config` (bridge/types.ts `MuxConfig.notes`) and
#     interpolated. It reaches the phone as data, so no literal appears here at all — which is the
#     property this check leans on rather than a carve-out it has to make.
#   • **Tests.** A test that fabricates a config for a named multiplexer is asserting the behaviour
#     of the very thing above; banning the literal there would ban testing it.
#
# KNOWN OUTSTANDING (not enforced, and not silently forgiven): three connection-status strings still
# spell "Herdr" inside a longer sentence — agent-list.tsx's "Waiting for Herdr…",
# connection-banner.tsx's "Herdr is down on the host", connection-info.tsx's "Herdr offline". They
# are not branches, and they are the one surface that must render when `/api/config` itself cannot
# be read, so their wording cannot be sourced from it. Fixing them needs a name that arrives without
# a fetch; that is its own change, not this one.
#
# THE NAME LIST IS DERIVED, never typed here: every adapter declares its registry key as
# `export const <X>_MUX = "<name>";`, so a fourth adapter is covered the day it lands rather than the
# day someone remembers this file.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# ── The names, from the adapters themselves ──────────────────────────────────
names=$(grep -hoE '^export const [A-Z0-9_]+_MUX = "[a-z0-9-]+";' bridge/mux/*/adapter.ts \
  | sed -E 's/.*"([a-z0-9-]+)".*/\1/' | sort -u)

if [ -z "$names" ]; then
  echo "✗ check-mux-names: found no adapter names to ban." >&2
  echo "  Expected 'export const <X>_MUX = \"<name>\";' in bridge/mux/*/adapter.ts." >&2
  echo "  A guard that bans nothing passes everything — refusing rather than pretending." >&2
  exit 1
fi

alternation=$(echo "$names" | paste -sd '|' -)

# ── The scan ─────────────────────────────────────────────────────────────────
# Non-test sources under web/src only. `web/src/test/` is the MSW harness; `*.test.*` are tests.
# `find`, not `git ls-files`, for one reason: the negative control in check-mux-names.test.ts plants a
# violation in a scratch directory, and a guard that can only see tracked files cannot be shown to
# catch anything. There is no build output under web/src for it to wander into.
target="${1:-web/src}"
files=$(find "$target" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  | grep -v '\.test\.' \
  | grep -v '/test/' || true)

if [ -z "$files" ]; then
  echo "✗ check-mux-names: no files to scan under '$target'." >&2
  exit 1
fi

# A quote, one name (any case), the matching quote — the literal, and nothing longer.
pattern="(\"($alternation)\"|'($alternation)'|\`($alternation)\`)"
hits=$(echo "$files" | xargs grep -HniE "$pattern" || true)

if [ -n "$hits" ]; then
  echo "✗ A multiplexer name is hard-coded in the frontend:" >&2
  echo "$hits" | sed 's/^/    /' >&2
  echo >&2
  echo "  The frontend reads CAPABILITIES, never a multiplexer name (.tracker M10/06)." >&2
  echo "  Ask the capability instead — web/src/lib/mux-capability.ts — and take any wording" >&2
  echo "  an operator reads from the adapter's own note on /api/config." >&2
  exit 1
fi

echo "✓ no multiplexer name is branched on in $target ($(echo "$names" | paste -sd ' ' -))"
