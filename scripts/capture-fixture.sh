#!/usr/bin/env bash
# Capture a live pane buffer as a byte-faithful test fixture for the block-renderer grammars
# (web/src/fixtures/panes/). Run on the deployment host; talks to the local bridge over loopback.
#
#   scripts/capture-fixture.sh <paneId> <name> [lines]
#
#   paneId  e.g. "wF:p1" (see /api/snapshot)
#   name    fixture file name, no extension — convention: <agent>--<state>[--variant]
#           e.g. claude--select-menu, claude--working--tool-run
#   lines   scrollback lines to request (default 300, bridge clamps at 10000)
#
# The buffer is written EXACTLY as the bridge returns it (real ESC bytes, no trailing
# newline added), because the grammar tests must see what the renderer sees.
#
# THE TOKEN. A pane read needs a paired device's token (ADR 0086): set COLLIE_TOKEN
# (`collie pair`, then claim the code; docs/upgrading.md, "Scripts must pair once").
# The bridge's own local key ($COLLIE_STATE_DIR/local-secret) reads no screen, so it is no
# fallback here. The header goes to curl through a file descriptor, so the token never shows in `ps`.
# The bridge masks known secret shapes (COLLIE_REDACT, docs/security.md), so a key on screen is
# captured as `•` marks.
#
# ⚠ This repo is PUBLIC. Review every captured fixture for private content/secrets
#   before `git add` — pane buffers are real terminal output.
set -euo pipefail

PANE="${1:?usage: capture-fixture.sh <paneId> <name> [lines]}"
NAME="${2:?usage: capture-fixture.sh <paneId> <name> [lines]}"
LINES="${3:-300}"
PORT="${COLLIE_PORT:-8787}"

DIR="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)/web/src/fixtures/panes"
mkdir -p "$DIR"

pane_enc="$(jq -rn --arg s "$PANE" '$s|@uri')"
out="$DIR/$NAME.txt"

TOKEN="$(printf '%s' "${COLLIE_TOKEN:-}" | tr -d '[:space:]')"
if [[ -z "$TOKEN" ]]; then
  echo "capture-fixture: set COLLIE_TOKEN to a paired device's token (collie pair); the bridge's local key reads no pane" >&2
  exit 2
fi

status=$(curl -s -o "$out.json" -w '%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
  "http://127.0.0.1:${PORT}/api/pane/${pane_enc}?lines=${LINES}") || status=000
if [[ "$status" != 200 ]]; then
  echo "capture-fixture: the bridge answered ${status}: $(head -c 200 "$out.json" 2>/dev/null)" >&2
  rm -f "$out.json"
  exit 1
fi
jq -j '.text' < "$out.json" > "$out"
rm -f "$out.json"

bytes=$(wc -c < "$out")
echo "captured $PANE → ${out#"$PWD"/} (${bytes} bytes, ${LINES} lines requested)"
echo "review before committing: less -R '$out'"
