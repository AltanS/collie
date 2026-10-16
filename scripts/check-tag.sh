#!/usr/bin/env bash
# Release-tag gate for Collie.
#
# A version is CUT when the three version files and the newest `## [x.y.z]` heading in CHANGELOG.md
# agree on it (scripts/check-version.sh proves that). A version is PUBLISHED when a `v<x.y.z>` tag
# reaches the remote, because .github/workflows/release.yml triggers on `push: tags: ["v*.*.*"]` and
# nothing else creates the GitHub Release the in-app update banner links to.
#
# Those two steps were never joined. Betas 33 to 41 were cut and never tagged — not even locally —
# so nine consecutive releases exist only as CHANGELOG headings and no tester could install any of
# them. The publishing automation was never broken; the manual `git tag` in front of it got skipped,
# and nothing said a word. This script is that word.
#
# Two modes:
#
#   check-tag.sh                 The version the repo currently claims — the newest CHANGELOG
#                                heading — must have a local `v<version>` tag.
#   check-tag.sh <rev-list…>     Every `chore(release):` commit the arguments select must have one.
#                                The arguments are handed to `git rev-list` untouched, so both
#                                `A..B` and a push's `<sha> --not --remotes` form work. The version
#                                is read from THAT COMMIT's herdr-plugin.toml, never from HEAD: a
#                                range usually carries a release commit plus the doc commits that
#                                followed it, and HEAD's version answers for the wrong one.
#
# Exits 1 and names the exact `git tag -a` command for every version it could not find. Run
# standalone, and by the pre-push hook (which reports it as a WARNING — see that hook for why).
#
# It reads LOCAL tags only. A local tag is what `git push --follow-tags` has to find, so a missing
# local tag is the failure that matters; a tag that exists locally and never reached the remote is a
# push away and git itself says so.
#
# Betas 33 to 41 stay unreachable ON PURPOSE. Do not back-fill them. Their commits are superseded by
# the betas that followed, and a tag cut today would claim a release nobody ever tested.
#
# THE SOFT RELEASE GATE (M44 spec 08, carried by M56 spec 10). When a release is about to be tagged,
# this script also asks `scripts/harness-drift.ts --strict` whether an installed agent is NEWER than its
# verified version (the rows of web/src/lib/harness/verified-versions.json). A drift stops it, names the agent, and prints no tag command. To tag anyway, name
# the drift on purpose: `check-tag.sh --accept-drift claude=2.1.301` (or ACCEPT_DRIFT=claude=2.1.301 for
# the pre-push hook). The version must be the installed one. The tag command it then prints carries a
# `Not verified: claude 2.1.301` line in the tag message, and release.yml puts that line in the release
# notes. The gate adds no network call and starts no agent. It is a reminder, not proof: it sees only
# the agents installed on this machine, so "nothing newer here" never means "the readers are right".
# A machine with no bun, or a checkout with no harness-drift.ts, skips the gate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# `--accept-drift agent=version[,agent=version]` is ours; every other argument is the caller's rev-list.
accept="${ACCEPT_DRIFT:-}"
rest=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --accept-drift)
      accept="${2:-}"
      shift
      [ "$#" -eq 0 ] || shift
      ;;
    *)
      rest+=("$1")
      shift
      ;;
  esac
done
set -- ${rest[@]+"${rest[@]}"}

# The canonical version, as of one commit. No argument reads the working tree.
read_toml_version() { sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | head -1; }

# Collected as "version<TAB>sha" lines; sha is what the tag would be cut on.
missing=""
checked=0

want_tag() {
  version="$1"
  sha="$2"
  [ -n "$version" ] || return 0
  checked=$((checked + 1))
  git rev-parse -q --verify "refs/tags/v${version}" >/dev/null 2>&1 && return 0
  missing="${missing}${version}	${sha}"$'\n'
}

if [ "$#" -eq 0 ]; then
  # Mode 1 — what the repo claims right now.
  version="$(sed -n 's/^##[[:space:]]*\[\([0-9][^]]*\)\].*/\1/p' CHANGELOG.md | head -1)"
  if [ -z "$version" ]; then
    echo "✗ check-tag: could not read a version heading from CHANGELOG.md" >&2
    exit 1
  fi
  want_tag "$version" "$(git rev-parse --short HEAD)"
else
  # Mode 2 — every release commit the caller's rev-list selects.
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    case "$(git log -1 --format=%s "$sha")" in
      "chore(release):"*) ;;
      *) continue ;;
    esac
    version="$(git show "${sha}:herdr-plugin.toml" 2>/dev/null | read_toml_version || true)"
    want_tag "$version" "$(git rev-parse --short "$sha")"
  done <<<"$(git rev-list "$@" 2>/dev/null || true)"
fi

if [ "$checked" -eq 0 ]; then
  echo "✓ no release to tag"
  exit 0
fi

if [ -z "$missing" ]; then
  echo "✓ every release checked ($checked) has a local v<version> tag"
  exit 0
fi

# The soft release gate. Only a release that is about to be tagged reaches it.
drift_script="${HARNESS_DRIFT_SCRIPT:-$ROOT/scripts/harness-drift.ts}"
accepted_note=""
if [ -f "$drift_script" ] && command -v bun >/dev/null 2>&1; then
  gate_flags=(--strict)
  [ -z "$accept" ] || gate_flags+=(--accept-drift "$accept")
  if ! gate_out="$(bun "$drift_script" "${gate_flags[@]}" 2>&1 >/dev/null)"; then
    {
      echo "✗ not tagging: an installed agent is newer than the version Collie's readers were verified on:"
      echo
      printf '%s\n' "$gate_out" | sed 's/^harness-drift: /    /'
      echo
      echo "  Run the lab (bun scripts/harness-canary/lab/main.ts) and merge its branch,"
      echo "  or tag with the drift named on purpose (the version must be the installed one):"
      echo "    scripts/check-tag.sh --accept-drift <agent>=<version>"
    } >&2
    exit 1
  fi
  accepted_note="$(printf '%s\n' "$gate_out" | sed -n 's/^harness-drift: accepted: \(.*\) is newer than its verified version: not verified$/\1/p' | paste -sd, - | sed 's/,/, /g')"
fi

{
  echo "✗ a release was cut but never tagged, so nothing can publish it:"
  echo
  while IFS=$'\t' read -r version sha; do
    [ -n "$version" ] || continue
    if [ -n "$accepted_note" ]; then
      echo "    git tag -a v${version} ${sha} -m \"Collie ${version}\" -m \"Not verified: ${accepted_note}\""
    else
      echo "    git tag -a v${version} ${sha} -m \"Collie ${version}\""
    fi
  done <<<"$missing"
  echo
  echo "  Then push the tag with the release: git push --follow-tags"
  echo "  The tag is what .github/workflows/release.yml waits for; without it the version exists"
  echo "  only in CHANGELOG.md and no operator can install it."
} >&2
exit 1
