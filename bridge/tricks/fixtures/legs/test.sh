#!/bin/sh
# Checks program.sh against the fixture logs: the document parses with zero refusals, the belt label,
# the decision key and who it is about, a tap that must not write outside the state folder.
# Needs sh, bun (for the schema parse only), and the Collie checkout that holds the schema:
# TRICKS_REPO, else the nearest parent with web/src/lib/tricks/schema.ts, else ~/.cache/collie-lab/tricks.
here=$(cd "$(dirname "$0")" && pwd)
fix=$here/fixtures

repo=${TRICKS_REPO:-}
if [ -z "$repo" ]; then
  d=$here
  while [ "$d" != / ]; do
    [ -f "$d/web/src/lib/tricks/schema.ts" ] && repo=$d && break
    d=$(dirname "$d")
  done
fi
[ -n "$repo" ] || repo=$HOME/.cache/collie-lab/tricks
schema=$repo/web/src/lib/tricks/schema.ts
[ -f "$schema" ] || { echo "no schema at $schema (set TRICKS_REPO)" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sed "s#SCHEMA#$schema#" "$fix/assert.ts.in" > "$tmp/assert.ts"

failed=0
# step NAME LOGDIR RUNNING FACTS EXPECT_JSON
step() {
  out=$(LEGS_LOG_DIR=$2 LEGS_RUNNING=$3 LEGS_NOW=1794130860 sh "$here/program.sh" < "$4") || { echo "FAIL $1: program exited non-zero"; failed=1; return; }
  if printf '%s' "$out" | bun "$tmp/assert.ts" "$5"; then echo "ok   $1"; else echo "FAIL $1"; failed=1; fi
}

mkfacts() { sed "s#STATE#$1#" "$fix/facts-timer.json" > "$tmp/facts.json"; }
mkdir "$tmp/state"
mkfacts "$tmp/state"

step "green log" "$fix/green" 0 "$tmp/facts.json" '{"label":"12/12","tone":"ok","decisions":[],"chips":3}'
step "red log" "$fix/red" 0 "$tmp/facts.json" '{"label":"10/12","tone":"danger","decisions":["case-8"],"about":"bluefin:w6X:3","chips":2}'
step "red log, still running" "$fix/red" 1 "$tmp/facts.json" '{"label":"10/12","tone":"danger","decisions":[]}'
step "no log in the folder" "$fix/empty" 0 "$tmp/facts.json" '{"label":"no leg","tone":"plain","decisions":[]}'
step "folder missing" "$tmp/none" 0 "$tmp/facts.json" '{"label":"no leg","decisions":[]}'

# No session names collie: the decision carries no about and no replyTo.
sed 's#collie#shop#g' "$tmp/facts.json" > "$tmp/facts-none.json"
step "no matching session" "$fix/red" 0 "$tmp/facts-none.json" '{"decisions":["case-8"],"about":null}'

# A rerun tap changes nothing: the decision stays and the state folder stays empty.
sed 's#"trigger":{"kind":"timer"}#"trigger":{"kind":"tap","rid":"r1","node":"hill/case-8","intent":"rerun","value":{"text":null},"from":{"session":"bluefin:w6X:9"}}#' "$tmp/facts.json" > "$tmp/facts-rerun.json"
step "tap rerun" "$fix/red" 0 "$tmp/facts-rerun.json" '{"label":"10/12","decisions":["case-8"],"about":"bluefin:w6X:9"}'
[ -z "$(ls -A "$tmp/state")" ] || { echo "FAIL tap rerun wrote to the state folder"; failed=1; }

# A skip tap closes it, and the state folder remembers it for the next timer run.
sed 's#"intent":"rerun"#"intent":"skip"#' "$tmp/facts-rerun.json" > "$tmp/facts-skip.json"
step "tap skip" "$fix/red" 0 "$tmp/facts-skip.json" '{"label":"10/12","decisions":[]}'
step "timer after skip" "$fix/red" 0 "$tmp/facts.json" '{"label":"10/12","decisions":[]}'
[ "$(ls "$tmp/state")" = skipped ] || { echo "FAIL skip wrote something else than the skipped file"; failed=1; }

[ "$failed" = 0 ] && echo "all ok" || { echo "FAILED"; exit 1; }
