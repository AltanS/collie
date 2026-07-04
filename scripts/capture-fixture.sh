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

curl -sf "http://127.0.0.1:${PORT}/api/pane/${pane_enc}?lines=${LINES}" | jq -j '.text' > "$out"

bytes=$(wc -c < "$out")
echo "captured $PANE → ${out#"$PWD"/} (${bytes} bytes, ${LINES} lines requested)"
echo "review before committing: less -R '$out'"
