#!/usr/bin/env bash
# Version consistency gate for Collie.
#
# The plugin's version lives in three files that MUST agree, plus a matching CHANGELOG entry:
#   - herdr-plugin.toml   (canonical — this is what Herdr reads)
#   - package.json        (bridge / Bun server)
#   - web/package.json    (PWA frontend)
#   - CHANGELOG.md        (newest NUMBERED "## [x.y.z]" heading)
#
# "## [Unreleased]" is not a numbered heading and is ignored here: unreleased work collects under
# it and only the release commit renames it to "## [x.y.z] - YYYY-MM-DD".
#
# Exits non-zero with a clear message on any mismatch. Run by `collie-ctl.sh build` and the
# pre-commit hook. See CLAUDE.md → "Versioning" for the policy.
#
# AN EDGE TAG CARRIES ITS SUFFIX, THE FILES DO NOT (M60 spec 01). A `vX.Y.Z-edge.N` tag goes on a
# commit whose files say plain `X.Y.Z`, and that is what this gate checks everywhere. The release job
# then stamps `X.Y.Z-edge.N` into ITS OWN working copy of the three files before it builds
# (scripts/release-version.ts --stamp), so the payload reports the build it is. This gate accepts that
# stamped shape in one place only: where GITHUB_REF_NAME is that very tag. There the CHANGELOG still
# answers with the base `X.Y.Z` heading. Anywhere else a stamped file fails, so it cannot be committed.
#
# A CHECKOUT INSTALL STAMPS TOO (cli/update.ts `stampCheckout`): it builds an Edge tag on the
# operator's own machine, so it stamps the same three files after it checks the tag out, and marks
# them `assume-unchanged` so the tree reads clean. That is the second place the stamp is accepted:
# HEAD is the commit tag `vX.Y.Z-edge.N` names, and the manifest carries that mark. A stamp a person
# typed by hand carries no mark, and `git commit -a` never picks up a marked file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

toml_v="$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/herdr-plugin.toml" | head -1)"
pkg_v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
web_v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/web/package.json" | head -1)"
log_v="$(sed -n 's/^##[[:space:]]*\[\([0-9][^]]*\)\].*/\1/p' "$ROOT/CHANGELOG.md" 2>/dev/null | head -1)"

# The version the CHANGELOG heading must name: the canonical one, minus an Edge stamp.
base_v="$toml_v"
if [[ "$toml_v" =~ ^[0-9]+\.[0-9]+\.[0-9]+-edge\.(0|[1-9][0-9]*)$ ]]; then
  base_v="${toml_v%-edge.*}"
  stamped_here=0
  if [ "${GITHUB_REF_NAME:-}" = "v$toml_v" ]; then
    stamped_here=1
  elif command -v git >/dev/null 2>&1; then
    head_c="$(git -C "$ROOT" rev-parse -q --verify HEAD 2>/dev/null || true)"
    tag_c="$(git -C "$ROOT" rev-parse -q --verify "refs/tags/v$toml_v^{commit}" 2>/dev/null || true)"
    mark="$( (git -C "$ROOT" ls-files -v -- herdr-plugin.toml 2>/dev/null || true) | cut -c1)"
    if [ -n "$head_c" ] && [ "$head_c" = "$tag_c" ] && [ "$mark" = "h" ]; then stamped_here=1; fi
  fi
  if [ "$stamped_here" -ne 1 ]; then
    echo "✗ herdr-plugin.toml says $toml_v, and an -edge.N suffix belongs in the tag only." >&2
    echo "  The files in git keep plain $base_v; the release job stamps the suffix into its own copy" >&2
    echo "  while it builds tag v$toml_v (scripts/release-version.ts). Set the three files back to $base_v." >&2
    exit 1
  fi
fi

fail=0
note() { printf '  %-18s %s\n' "$1" "$2"; }

if [ -z "$toml_v" ]; then echo "✗ could not read version from herdr-plugin.toml" >&2; exit 1; fi

if [ "$pkg_v" != "$toml_v" ] || [ "$web_v" != "$toml_v" ] || [ "$log_v" != "$base_v" ]; then
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "✗ version mismatch — all four must equal the canonical herdr-plugin.toml version:" >&2
  note "herdr-plugin.toml" "$toml_v  (canonical)"
  note "package.json" "${pkg_v:-<missing>}"
  note "web/package.json" "${web_v:-<missing>}"
  note "CHANGELOG.md" "${log_v:-<missing>}"
  echo "  → bump all three files to the same version and add a matching CHANGELOG entry." >&2
  exit 1
fi

if [ "$base_v" != "$toml_v" ]; then
  echo "✓ version $toml_v (Edge build of $base_v) consistent across manifest, package.json, web/package.json, CHANGELOG"
else
  echo "✓ version $toml_v consistent across manifest, package.json, web/package.json, CHANGELOG"
fi
