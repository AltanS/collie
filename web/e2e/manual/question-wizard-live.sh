#!/usr/bin/env bash
# question-wizard-live.sh — manual live trigger for sidebar-overlay wizard dialogs (issue #347).
#
# Reproduces the hand test as single steps: drive ONE idle opencode pane with the allowlisted
# trigger, wait for the tabbed dialog, capture the ANSI screen, verify the wizard lift, then
# clear the pane. Every step is one command, then capture, then clear — never a conversation.
#
# NOT A CI JOB. It needs a real Herdr session, a real opencode pane, and exactly one model call
# (which costs money — hence --allow-model-call). Run by hand, from the collie checkout:
#
#     web/e2e/manual/question-wizard-live.sh --pane <pane-id> --allow-model-call
#
# Allowlist (the ONLY inputs this script ever sends into a pane; this script enforces it):
#   /new ...................... the only reset command (clear step)
#   trigger file .............. exactly one prompt: two-question.trigger.txt beside this script
#   Enter ..................... submit the trigger / submit /new
#   Escape .................... dismiss the dialog again (clear step only)
# Forbidden: bare digits (a digit submits/selects without looking at the pointer — QUESTION_NOTES.md),
# free text of any other kind, answering anything, driving any other pane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANE=""
TRIGGER_FILE="$SCRIPT_DIR/two-question.trigger.txt"
CAPTURE=""
TIMEOUT_MS=180000
ALLOW_MODEL_CALL=0
CLEAR=1

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  echo "usage: $(basename "$0") --pane <pane-id> --allow-model-call [--trigger-file F] [--capture F] [--timeout MS] [--no-clear]"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pane) PANE="$2"; shift 2;;
    --trigger-file) TRIGGER_FILE="$2"; shift 2;;
    --capture) CAPTURE="$2"; shift 2;;
    --timeout) TIMEOUT_MS="$2"; shift 2;;
    --allow-model-call) ALLOW_MODEL_CALL=1; shift;;
    --no-clear) CLEAR=0; shift;;
    --help|-h) usage; exit 0;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2;;
  esac
done

[ -n "$PANE" ] || { echo "missing: --pane <pane-id>" >&2; exit 2; }
[ -f "$TRIGGER_FILE" ] || { echo "missing trigger file: $TRIGGER_FILE" >&2; exit 2; }
[ -n "$CAPTURE" ] || CAPTURE="/tmp/collie-wizard-${PANE/:/-}.ansi"
command -v herdr >/dev/null || { echo "missing: herdr on PATH" >&2; exit 2; }
if command -v bun >/dev/null; then BUN="bun";
elif [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun";
else echo "missing: bun on PATH (or ~/.bun/bin/bun)" >&2; exit 2; fi
command -v python3 >/dev/null || { echo "missing: python3 (snapshot guard)" >&2; exit 2; }

# Guard 1: the pane must be idle AND interactive_ready (herdr api snapshot, agents list).
# Herdr status alone is not proof — under a live question dialog it has read `idle` before
# (QUESTION_NOTES.md, round two) — so guard 2 checks the footer words as well.
echo "--- [1/6] snapshot guard: $PANE must be idle + interactive_ready"
SNAP_JSON="$(herdr api snapshot)"
PANE_STATUS="$(printf '%s' "$SNAP_JSON" | PANE_ID="$PANE" python3 -c "
import json, os, sys
raw = sys.stdin.read()
start = raw.find('{')
snap = json.loads(raw[start:raw.rfind('}')+1])
agents = snap['result']['snapshot'].get('agents', [])
for a in agents:
    if a.get('pane_id') == os.environ['PANE_ID']:
        print(('idle' if a.get('agent_status') == 'idle' else 'not-idle') + ' ' + ('ready' if a.get('interactive_ready') is True else 'not-ready'))
        sys.exit(0)
print('unknown-pane')
")"
echo "pane $PANE: $PANE_STATUS"
[ "$PANE_STATUS" = "idle ready" ] || { echo "REFUSING: pane is not idle+interactive_ready ($PANE_STATUS) — pick an idle tab, never drive a busy or foreign session" >&2; exit 1; }

# Guard 2: never type into a pane with an open dialog — digits would submit unseen options.
echo "--- [2/6] dialog guard: no open dialog on $PANE"
BEFORE="$(herdr pane read "$PANE" --source recent --lines 60 --format ansi)"
if printf '%s' "$BEFORE" | grep -Eq 'enter (confirm|submit|toggle)'; then
  echo "REFUSING: a dialog footer is already on screen — clear it by hand (/new) first" >&2
  exit 1
fi
echo "no dialog footer seen"

# Guard 3: the trigger is exactly one model call, and model calls cost money.
[ "$ALLOW_MODEL_CALL" -eq 1 ] || { echo "REFUSING: pass --allow-model-call — the trigger runs one model call, which costs money" >&2; exit 2; }

echo "--- [3/6] sending allowlisted trigger to $PANE"
herdr pane send-text "$PANE" "$(cat "$TRIGGER_FILE")"
herdr pane send-keys "$PANE" Enter

echo "--- [4/6] waiting for the tabbed dialog (enter confirm, ${TIMEOUT_MS}ms)"
herdr pane wait-output --match "enter confirm" --timeout "$TIMEOUT_MS" "$PANE"

echo "--- [5/6] capturing ANSI screen to $CAPTURE"
herdr pane read "$PANE" --source recent --lines 300 --format ansi > "$CAPTURE"
echo "capture: $(wc -l < "$CAPTURE") lines"

echo "--- [6/6] verifying the wizard lift"
"$BUN" "$SCRIPT_DIR/check-wizard-lift.ts" "$CAPTURE" question

if [ "$CLEAR" -eq 1 ]; then
  echo "--- [clear] dismiss + /new + idle check"
  herdr pane send-keys "$PANE" Escape
  sleep 2
  herdr pane send-text "$PANE" "/new"
  herdr pane send-keys "$PANE" Enter
  for _ in 1 2 3 4 5 6; do
    sleep 5
    AFTER="$(herdr api snapshot | PANE_ID="$PANE" python3 -c "
import json, os, sys
raw = sys.stdin.read()
snap = json.loads(raw[raw.find('{'):raw.rfind('}')+1])
for a in snap['result']['snapshot'].get('agents', []):
    if a.get('pane_id') == os.environ['PANE_ID']:
        print(a.get('agent_status', 'unknown'))
        break
")"
    [ "$AFTER" = "idle" ] && { echo "pane $PANE idle again"; break; }
  done
  [ "${AFTER:-}" = "idle" ] || { echo "WARNING: pane $PANE reads '$AFTER', not idle — check by hand" >&2; exit 1; }
else
  echo "--- [clear] skipped (--no-clear): dialog left open for manual inspection"
fi

echo "DONE: lift verified, pane clear. Capture kept at $CAPTURE (evidence, delete when done)."
