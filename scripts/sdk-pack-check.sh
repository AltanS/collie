#!/usr/bin/env bash
# The pack check of the durable SDK (M55 spec 10, ADR 0105). It proves the package a program would install, not the
# source the repo imports:
#
#   1. `bun run sdk:build`, then `npm pack --dry-run --json` must list dist/** and the package's package.json,
#      README.md, CHANGELOG.md and LICENSE, and nothing else (no src/, no tsconfig, no test).
#   2. `npm pack` into a temp folder, and `npm install <tarball>` into a fresh project there. The Pi peers are
#      optional, so nothing else is installed.
#   3. A program in that project imports `@colliepwa/durable-sdk`, raises one requireApproval card, and Collie's own
#      adapter answers Allow; the receipt must say `decidedBy: "phone"`. Once under Node, once under Bun
#      (scripts/sdk-pack-check.ts).
#
# It never publishes and never logs in. Publishing is Altan's, by hand (packages/durable-sdk/README.md, "Publish").
# Needs node and npm (Node 22.19 or later), bun, and the example's install (the build reads its Pi packages).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
sdk="$root/packages/durable-sdk"

bun run sdk:build

# ── 1. What the tarball holds ───────────────────────────────────────────────────────────────────────────────────────
listing="$(cd "$sdk" && npm pack --dry-run --json --ignore-scripts 2>/dev/null)"
stray="$(printf '%s' "$listing" | bun -e '
  const [pack] = JSON.parse(await Bun.stdin.text());
  const allowed = new Set(["package.json", "README.md", "CHANGELOG.md", "LICENSE"]);
  const paths = pack.files.map((file) => file.path);
  for (const name of allowed) if (!paths.includes(name)) console.log(`missing: ${name}`);
  if (!paths.includes("dist/index.js") || !paths.includes("dist/index.d.ts")) console.log("missing: dist/index.js and dist/index.d.ts");
  for (const path of paths) if (!allowed.has(path) && !path.startsWith("dist/")) console.log(`not allowed: ${path}`);
')"
if [ -n "$stray" ]; then
  echo "✗ pack check: the tarball's file list is wrong:" >&2
  printf '%s\n' "$stray" | sed 's/^/    /' >&2
  exit 1
fi
count="$(printf '%s' "$listing" | bun -e 'console.log(JSON.parse(await Bun.stdin.text())[0].files.length)')"
echo "pack check: the tarball lists $count files, dist/** and the four package files only"

# ── 2. A fresh project installs the tarball ────────────────────────────────────────────────────────────────────────
work="$(mktemp -d "${TMPDIR:-/tmp}/collie-sdk-pack-XXXXXX")"
trap 'rm -rf "$work"' EXIT
(cd "$sdk" && npm pack --ignore-scripts --pack-destination "$work" >/dev/null 2>&1)
tarball="$(ls "$work"/*.tgz)"
mkdir "$work/app"
printf '{ "name": "sdk-pack-check", "private": true, "type": "module" }\n' > "$work/app/package.json"
(cd "$work/app" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error "$tarball" >/dev/null)
version="$(cd "$sdk" && node -p 'require("./package.json").version')"

# ── 3. The round trip, on Node and on Bun ──────────────────────────────────────────────────────────────────────────
bun scripts/sdk-pack-check.ts "$work/app" node "$version"
bun scripts/sdk-pack-check.ts "$work/app" bun "$version"

echo "pack check: ok"
