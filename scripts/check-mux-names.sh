#!/usr/bin/env bash
# Keeps multiplexer names out of the frontend's DECISIONS (M10/06) and out of the BRIDGE's, above the
# mux seam (M22/02).
#
# TWO SCANS, because the two halves are banned for different reasons and in different shapes. The web
# may not spell a name at all; the bridge may spell one (it configures them) but may not COMPARE one,
# because a comparison is a feature decided by a name instead of by the adapter's declaration.
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

# ── The bridge scan: above the seam, a name may not be COMPARED ───────────────
#
# WHAT IS BANNED: a comparison of a multiplexer name in `bridge/`, outside `bridge/mux/`, so a name
# literal or `DEFAULT_MUX` on either side of `===` / `!==`. That is the shape of a feature gate, and
# `bridge/index.ts`'s `multiSession: cfg.multiSession && cfg.mux === DEFAULT_MUX` was the last one
# (M22/02). A capability answers instead, and the adapter declares it.
#
# WHAT IS ALLOWED, and it is one thing: THE ENDPOINT DEFAULT. Herdr's endpoint IS its socket path, so
# three sites pick which config field holds the endpoint, bridge/config.ts, bridge/index.ts's target
# and the startup log line. They are recognised by SHAPE rather than by file and line, so the check
# does not have to be re-pinned every time a line moves: the ternary asks the default question and
# both of its arms are the two endpoint fields. Nothing else may compare a name.
#
# `bridge/mux/` is out of scope by design, because that is the ONE directory where a multiplexer's name is a
# behaviour rather than a branch (ADR 0022), and each adapter declares its own name there. Tests are
# out of scope for the reason the web scan gives: they assert the behaviour of the very thing above.
bridge_target="${2:-bridge}"
bridge_files=$(find "$bridge_target" -type f -name '*.ts' \
  | grep -v '/mux/' \
  | grep -v '\.test\.' || true)

if [ -z "$bridge_files" ]; then
  echo "✗ check-mux-names: no bridge files to scan under '$bridge_target'." >&2
  exit 1
fi

comparison="(===|!==) *(\"($alternation)\"|DEFAULT_MUX)|(\"($alternation)\"|DEFAULT_MUX) *(===|!==)"
bridge_hits=$(echo "$bridge_files" | xargs grep -HnE "$comparison" || true)

# The endpoint default, by shape: the ternary on the default name, whose arms are the socket path and
# the per-adapter endpoint. Both field names appear on the line in all three sites.
endpoint_default='=== DEFAULT_MUX \?'
permitted=$(echo "$bridge_hits" | grep -E "$endpoint_default" | grep 'socketPath' | grep 'muxEndpoint' || true)
gates=$(echo "$bridge_hits" | grep -vxF "$permitted" 2>/dev/null || true)
if [ -n "$bridge_hits" ] && [ -z "$permitted" ]; then gates="$bridge_hits"; fi

if [ -n "$gates" ]; then
  echo "✗ A multiplexer name is COMPARED above the mux seam:" >&2
  echo "$gates" | sed 's/^/    /' >&2
  echo >&2
  echo "  A feature is decided by the adapter's DECLARATION, never by which multiplexer it is" >&2
  echo "  (ADR 0022, ADR 0036). Add a capability in bridge/mux/capabilities.ts with its route, let" >&2
  echo "  the adapter declare it, and ask that. The only comparison allowed here is the endpoint" >&2
  echo "  default, which picks whether the endpoint is the herdr socket path or COLLIE_MUX_ENDPOINT_*." >&2
  exit 1
fi

echo "✓ no multiplexer name is compared in $bridge_target outside $bridge_target/mux ($(echo "$permitted" | grep -c . || true) endpoint-default site(s))"
