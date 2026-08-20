#!/usr/bin/env bash
# Pack-wire decision gate for Collie.
#
# The pack link is a versioned protocol (PACK_PROTOCOL.md). Inside a protocol version every
# addition MUST be additive-optional with absent-means-closed semantics (§7.1); an addition that
# cannot be expressed that way bumps `X-Pack-Protocol` (PACK_PROTOCOL_VERSION). This script does
# not judge which of those a diff is — it refuses a wire-shape change that recorded NEITHER
# decision, so the choice is made by a human at commit time. See
# .adr/0025-the-wire-guard-forces-a-decision-never-a-bump.md.
#
# Runs against the STAGED diff. Called standalone and by the pre-commit hook (guard C).
# Override once with: SKIP_PACK_WIRE_CHECK=1 git commit …
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The wire-shape file list — the ONE place it lives.
#
# A file qualifies when a change to it can change bytes on the wire: the request/response shape,
# the header set, the signing input, the admission or gate decision a peer observes, or the way a
# forwarded body is composed. Files that only move data around inside one process (registry, lead,
# mode, config, identity, trust-store, ops-store, transport, notify, staleness) do NOT qualify —
# they are internal logic, and a change there is invisible to the other end.
WIRE_FILES=(
  bridge/pack/admission.ts
  bridge/pack/enrollment.ts
  bridge/pack/router.ts
  bridge/pack/peer-client.ts
  bridge/pack/forward.ts
  bridge/pack/merge.ts
  bridge/pack/peer-gate.ts
  bridge/pack/signing.ts
  bridge/pack/tags.ts
)

if [ "${SKIP_PACK_WIRE_CHECK:-}" = "1" ]; then
  echo "check-pack-wire: SKIP_PACK_WIRE_CHECK=1 — skipping pack-wire guard" >&2
  exit 0
fi

staged="${STAGED_FILES-}"
if [ -z "${STAGED_FILES+x}" ]; then
  staged="$(git diff --cached --name-only --diff-filter=ACMR)"
fi

# (1) The fixed list.
triggers=""
for f in "${WIRE_FILES[@]}"; do
  if printf '%s\n' "$staged" | grep -qxF "$f"; then
    triggers="${triggers}${f}"$'\n'
  fi
done

# (2) Any NEWLY ADDED non-test bridge/pack/*.ts file — a new wire file must not slip past the list.
added="$(git diff --cached --name-only --diff-filter=A \
  | grep -E '^bridge/pack/[^/]+\.ts$' \
  | grep -vE '\.test\.ts$' || true)"
if [ -n "$added" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s' "$triggers" | grep -qxF "$f" || triggers="${triggers}${f}"$'\n'
  done <<<"$added"
fi

if [ -z "$triggers" ]; then
  echo "✓ no pack wire-shape files staged"
  exit 0
fi

# Pass (a): the contract doc is staged in the same commit.
if printf '%s\n' "$staged" | grep -qxF 'PACK_PROTOCOL.md'; then
  echo "✓ pack wire-shape change is accompanied by a staged PACK_PROTOCOL.md"
  exit 0
fi

# Pass (b): the staged blob bumps PACK_PROTOCOL_VERSION relative to HEAD.
read_proto() { sed -n 's/^[[:space:]]*export const PACK_PROTOCOL_VERSION[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1; }
staged_proto="$(git show :bridge/pack/enrollment.ts 2>/dev/null | read_proto || true)"
head_proto="$(git show HEAD:bridge/pack/enrollment.ts 2>/dev/null | read_proto || true)"
if [ -n "$staged_proto" ] && [ -n "$head_proto" ] && [ "$staged_proto" != "$head_proto" ]; then
  echo "✓ pack wire-shape change bumps PACK_PROTOCOL_VERSION ($head_proto → $staged_proto)"
  exit 0
fi

{
  echo "✗ pack wire-shape files changed, but no protocol decision was recorded:"
  printf '%s' "$triggers" | sed 's/^/    /'
  echo
  echo "  A change here can change bytes on the wire. Pick the exit that matches your diff:"
  echo
  echo "  (i)   Additive-optional — document the field/route in PACK_PROTOCOL.md and stage that file"
  echo "        too. §7.1: an addition inside a version must be optional and absent-means-closed —"
  echo "        an older peer that omits it must be read as the closed/default case, never as an error."
  echo
  echo "  (ii)  Cannot be additive-optional (a field changes meaning, a route is removed, a gate"
  echo "        tightens) — bump PACK_PROTOCOL_VERSION in bridge/pack/enrollment.ts and spec the new"
  echo "        version in PACK_PROTOCOL.md. The protocol integer is the only thing that refuses."
  echo
  echo "  (iii) Pure refactor — no byte on the wire moves. Say so:"
  echo "        SKIP_PACK_WIRE_CHECK=1 git commit …"
} >&2
exit 1
