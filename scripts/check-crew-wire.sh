#!/usr/bin/env bash
# Crew-wire decision gate for Collie.
#
# The crew link is a versioned protocol (CREW_PROTOCOL.md). Inside a protocol version every
# addition MUST be additive-optional with absent-means-closed semantics (§7.1); an addition that
# cannot be expressed that way bumps `X-Crew-Protocol` (CREW_PROTOCOL_VERSION). This script does
# not judge which of those a diff is — it refuses a wire-shape change that recorded NEITHER
# decision, so the choice is made by a human at commit time. See
# .adr/0025-the-wire-guard-forces-a-decision-never-a-bump.md.
#
# Runs against the STAGED diff. Called standalone and by the pre-commit hook (guard C).
# Override once with: SKIP_CREW_WIRE_CHECK=1 git commit …
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
  bridge/crew/admission.ts
  bridge/crew/enrollment.ts
  bridge/crew/router.ts
  bridge/crew/peer-client.ts
  bridge/crew/forward.ts
  bridge/crew/merge.ts
  bridge/crew/peer-gate.ts
  bridge/crew/signing.ts
  bridge/crew/tags.ts
  # The version 1 overlap (CREW_PROTOCOL.md §0.1). It IS the wire — the old prefix, the old headers
  # and the old dial domain live here and nowhere else — so a change to it is a change to what a
  # 1.7.0 member reads. REMOVE_IN_1_9_0, together with the file.
  bridge/crew/v1-overlap.ts
)

# The overlap is deliberate, and this guard must not be the thing that deletes it by accident. So
# while the file exists it has to carry its removal marker; a file that lost the marker is a file
# nobody will remember to remove. `bridge/removal-schedule.test.ts` fails at package minor 9 while it
# is still here, which is the other half of the same promise.
OVERLAP_FILE="bridge/crew/v1-overlap.ts"
OVERLAP_MARKER="REMOVE_IN_1_9_0"
if [ -f "$OVERLAP_FILE" ] && ! grep -q "$OVERLAP_MARKER" "$OVERLAP_FILE"; then
  echo "✗ $OVERLAP_FILE exists but carries no $OVERLAP_MARKER marker" >&2
  echo "  The version 1 overlap is removed in 1.9.0. Keep the marker, or delete the file." >&2
  exit 1
fi

if [ "${SKIP_CREW_WIRE_CHECK:-}" = "1" ]; then
  echo "check-crew-wire: SKIP_CREW_WIRE_CHECK=1 — skipping crew-wire guard" >&2
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

# (2) Any NEWLY ADDED non-test bridge/crew/*.ts file — a new wire file must not slip past the list.
added="$(git diff --cached --name-only --diff-filter=A \
  | grep -E '^bridge/crew/[^/]+\.ts$' \
  | grep -vE '\.test\.ts$' || true)"
if [ -n "$added" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s' "$triggers" | grep -qxF "$f" || triggers="${triggers}${f}"$'\n'
  done <<<"$added"
fi

if [ -z "$triggers" ]; then
  echo "✓ no crew wire-shape files staged"
  exit 0
fi

# Pass (a): the contract doc is staged in the same commit.
if printf '%s\n' "$staged" | grep -qxF 'CREW_PROTOCOL.md'; then
  echo "✓ crew wire-shape change is accompanied by a staged CREW_PROTOCOL.md"
  exit 0
fi

# Pass (b): the staged blob bumps CREW_PROTOCOL_VERSION relative to HEAD.
read_proto() { sed -n 's/^[[:space:]]*export const CREW_PROTOCOL_VERSION[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1; }
staged_proto="$(git show :bridge/crew/enrollment.ts 2>/dev/null | read_proto || true)"
head_proto="$(git show HEAD:bridge/crew/enrollment.ts 2>/dev/null | read_proto || true)"
if [ -n "$staged_proto" ] && [ -n "$head_proto" ] && [ "$staged_proto" != "$head_proto" ]; then
  echo "✓ crew wire-shape change bumps CREW_PROTOCOL_VERSION ($head_proto → $staged_proto)"
  exit 0
fi

{
  echo "✗ crew wire-shape files changed, but no protocol decision was recorded:"
  printf '%s' "$triggers" | sed 's/^/    /'
  echo
  echo "  A change here can change bytes on the wire. Pick the exit that matches your diff:"
  echo
  echo "  (i)   Additive-optional — document the field/route in CREW_PROTOCOL.md and stage that file"
  echo "        too. §7.1: an addition inside a version must be optional and absent-means-closed —"
  echo "        an older peer that omits it must be read as the closed/default case, never as an error."
  echo
  echo "  (ii)  Cannot be additive-optional (a field changes meaning, a route is removed, a gate"
  echo "        tightens) — bump CREW_PROTOCOL_VERSION in bridge/crew/enrollment.ts and spec the new"
  echo "        version in CREW_PROTOCOL.md. The protocol integer is the only thing that refuses."
  echo
  echo "  (iii) Pure refactor — no byte on the wire moves. Say so:"
  echo "        SKIP_CREW_WIRE_CHECK=1 git commit …"
} >&2
exit 1
