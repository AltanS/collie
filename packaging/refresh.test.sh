#!/usr/bin/env bash
# Pins scripts/refresh-packages.ts: the rewrite is field-scoped, it takes every value from the
# manifest, it moves `pkgrel` by Arch's rule, and it FAILS on a mismatch rather than publishing a
# stale hash.
#
# The whole run happens in a temporary copy of `packaging/`, against fixture manifests with invented
# versions and hashes. The tree you are sitting in is never written to, and the last check below
# asserts that.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
script="$repo/scripts/refresh-packages.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

# Reads a field the way makepkg does, so the test does not share the writer's regex either.
sourced() { bash -c 'source "$1"; printf "%s" "${!2}"' bash "$1" "$2"; }

# ── The fixtures ───────────────────────────────────────────────────────────
# Versions and hashes are invented and share no digits with the real release, so a field that was
# NOT rewritten is obvious rather than accidentally equal.
X64_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ARM_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MAC_SHA="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
X64_SHA2="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

# $1 destination, $2 version, $3 x86_64 sha
write_manifest() {
  cat > "$1" <<JSON
{
  "schemaVersion": 1,
  "repo": "AltanS/collie",
  "tag": "v$2",
  "version": "$2",
  "prerelease": false,
  "commit": "0000000000000000000000000000000000000000",
  "artifacts": [
    { "name": "collie-$2-linux-x64.tar.gz",   "platform": "linux-x64",   "sha256": "$3" },
    { "name": "collie-$2-linux-arm64.tar.gz", "platform": "linux-arm64", "sha256": "$ARM_SHA" },
    { "name": "collie-$2-macos-arm64.tar.gz", "platform": "macos-arm64", "sha256": "$MAC_SHA" }
  ],
  "extras": []
}
JSON
}

write_manifest "$tmp/manifest.json" "9.9.9" "$X64_SHA"
write_manifest "$tmp/corrected.json" "9.9.9" "$X64_SHA2"

# A copy of the real packaging/ tree, so the fixture rewrite is exercised against the files that
# actually ship rather than against a mock of them.
fresh_root() {
  rm -rf "$1"
  mkdir -p "$1"
  cp -R "$here" "$1/packaging"
}
fresh_root "$tmp/root"
pkgbuild="$tmp/root/packaging/aur/PKGBUILD"
sources="$tmp/root/packaging/nix/sources.json"
srcinfo="$tmp/root/packaging/aur/.SRCINFO"

before_pkgbuild="$(sha256sum "$here/aur/PKGBUILD" | cut -d' ' -f1)"
before_sources="$(sha256sum "$here/nix/sources.json" | cut -d' ' -f1)"

# Stands in for `makepkg --printsrcinfo` on a machine that has no makepkg: the four fields this
# script compares, copied from the PKGBUILD into .SRCINFO. It is not a substitute for makepkg in the
# release job, only a way to give the comparator a file that agrees.
sync_srcinfo() {
  sed -i \
    -e "s/^\(\s*pkgver = \).*/\1$(sourced "$pkgbuild" pkgver)/" \
    -e "s/^\(\s*pkgrel = \).*/\1$(sourced "$pkgbuild" pkgrel)/" \
    -e "s/^\(\s*sha256sums_x86_64 = \).*/\1$(bash -c 'source "$1"; printf "%s" "${sha256sums_x86_64[0]}"' bash "$pkgbuild")/" \
    -e "s/^\(\s*sha256sums_aarch64 = \).*/\1$(bash -c 'source "$1"; printf "%s" "${sha256sums_aarch64[0]}"' bash "$pkgbuild")/" \
    "$srcinfo"
}

# ── The rewrite ────────────────────────────────────────────────────────────
echo "the rewrite takes every field from the manifest:"
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" > "$tmp/write.log" 2>&1
rc=$?
check "the rewrite exits 0" "test $rc -eq 0"
[ "$rc" -eq 0 ] || cat "$tmp/write.log"

check "PKGBUILD pkgver is the manifest's version" "test \"\$(sourced '$pkgbuild' pkgver)\" = 9.9.9"
check "PKGBUILD sha256sums_x86_64 is the linux-x64 hash" \
  "grep -qx \"sha256sums_x86_64=('$X64_SHA')\" '$pkgbuild'"
check "PKGBUILD sha256sums_aarch64 is the linux-arm64 hash" \
  "grep -qx \"sha256sums_aarch64=('$ARM_SHA')\" '$pkgbuild'"
check "sources.json version is the manifest's version" "grep -q '\"version\": \"9.9.9\"' '$sources'"
check "sources.json linux-x64 sha256" "grep -q '$X64_SHA' '$sources'"
check "sources.json linux-arm64 sha256" "grep -q '$ARM_SHA' '$sources'"
check "sources.json darwin-arm64 takes the macos-arm64 hash" "grep -q '$MAC_SHA' '$sources'"
check "sources.json url is built from repo, tag and asset name" \
  "grep -q 'https://github.com/AltanS/collie/releases/download/v9.9.9/collie-9.9.9-macos-arm64.tar.gz' '$sources'"

# The rewrite is FIELD-SCOPED, not a pass over the whole file: everything that is not a declared
# field survives it. The comment blocks and the package() body are the evidence.
echo "the rewrite touches nothing else:"
check "the maintainer line survives" "grep -q '^# Maintainer: Altan Sarisin' '$pkgbuild'"
check "package() survives" "grep -q '^package() {' '$pkgbuild'"
check "provides/conflicts survive" "grep -qF \"provides=('collie')\" '$pkgbuild'"
check "the symlink line survives" "grep -qE 'ln -s.*usr/bin/collie' '$pkgbuild'"
check "no stale 1.5.5 hash is left in the PKGBUILD" "! grep -q '16cd55c080a58f2fab' '$pkgbuild'"

# ── pkgrel follows Arch's rule ─────────────────────────────────────────────
# pacman compares `pkgver-pkgrel`. A corrected package for a version somebody already installed is
# only offered when pkgrel moves, and a new version must start again at 1.
echo "pkgrel follows the version:"
check "a new version resets pkgrel to 1" "test \"\$(sourced '$pkgbuild' pkgrel)\" = 1"

bun "$script" --manifest "$tmp/corrected.json" --root "$tmp/root" > "$tmp/corrected.log" 2>&1
rc=$?
check "a same-version rewrite exits 0" "test $rc -eq 0"
check "a corrected hash on the same version increments pkgrel" "test \"\$(sourced '$pkgbuild' pkgrel)\" = 2"
check "the corrected hash landed" "grep -qx \"sha256sums_x86_64=('$X64_SHA2')\" '$pkgbuild'"
check "pkgver did not move" "test \"\$(sourced '$pkgbuild' pkgver)\" = 9.9.9"

bun "$script" --manifest "$tmp/corrected.json" --root "$tmp/root" > /dev/null 2>&1
check "an idempotent re-run leaves pkgrel alone" "test \"\$(sourced '$pkgbuild' pkgrel)\" = 2"

write_manifest "$tmp/next.json" "9.9.10" "$X64_SHA"
bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" > /dev/null 2>&1
check "the next version resets pkgrel to 1 again" "test \"\$(sourced '$pkgbuild' pkgrel)\" = 1"
check "and pkgver moved with it" "test \"\$(sourced '$pkgbuild' pkgver)\" = 9.9.10"

# ── .SRCINFO is verified, not assumed ──────────────────────────────────────
# The AUR reads .SRCINFO and never the PKGBUILD, so a stale one publishes the wrong version with no
# other symptom. Where there is no makepkg the rewrite leaves it stale on purpose and --check says so.
echo ".SRCINFO is compared against the PKGBUILD:"
if command -v makepkg >/dev/null 2>&1; then
  ok "makepkg is present, so the rewrite regenerated .SRCINFO itself"
else
  bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" --check > "$tmp/stale.log" 2>&1
  rc=$?
  check "a stale .SRCINFO fails --check" "test $rc -ne 0"
  check "it names the .SRCINFO field" "grep -q '.SRCINFO pkgver' '$tmp/stale.log'"
  sync_srcinfo
fi

bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" --check > "$tmp/check.log" 2>&1
rc=$?
check "--check passes when .SRCINFO agrees" "test $rc -eq 0"
[ "$rc" -eq 0 ] || cat "$tmp/check.log"

sed -i 's/^\(\s*pkgrel = \).*/\19/' "$srcinfo"
bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" --check > "$tmp/srcinfo.log" 2>&1
rc=$?
check "a .SRCINFO pkgrel that drifted fails --check" "test $rc -ne 0"
check "it names the field that drifted" "grep -q '.SRCINFO pkgrel' '$tmp/srcinfo.log'"
sync_srcinfo

# ── --check writes nothing ─────────────────────────────────────────────────
echo "--check writes nothing:"
cp "$pkgbuild" "$tmp/pkgbuild.before-check"
bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" --check > /dev/null 2>&1
check "--check left the PKGBUILD byte-identical" "cmp -s '$pkgbuild' '$tmp/pkgbuild.before-check'"

# ── A deliberate mismatch must FAIL ────────────────────────────────────────
echo "a mismatch fails loudly:"
sed -i "s/sha256sums_x86_64=('$X64_SHA')/sha256sums_x86_64=('deadbeef00000000000000000000000000000000000000000000000000000000')/" "$pkgbuild"
bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" --check > "$tmp/mismatch.log" 2>&1
rc=$?
check "a wrong hash exits non-zero" "test $rc -ne 0"
check "it names the field that disagreed" "grep -q 'sha256sums_x86_64' '$tmp/mismatch.log'"
check "it names the value it expected" "grep -q '$X64_SHA' '$tmp/mismatch.log'"

# A rewrite over the tampered file repairs it, because the manifest is the source of truth.
bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" > /dev/null 2>&1
check "a rewrite repairs the tampered field" "grep -qx \"sha256sums_x86_64=('$X64_SHA')\" '$pkgbuild'"
check "repairing a hash on the same version bumped pkgrel" "test \"\$(sourced '$pkgbuild' pkgrel)\" = 2"

# A field this script owns that has gone missing must fail, not be silently appended.
sed -i '/^pkgver=/d' "$pkgbuild"
bun "$script" --manifest "$tmp/next.json" --root "$tmp/root" > "$tmp/missing.log" 2>&1
rc=$?
check "a missing pkgver line exits non-zero" "test $rc -ne 0"
check "it says the field was not found once" "grep -q 'pkgver' '$tmp/missing.log'"

# ── The manifest's platforms must match the tables ─────────────────────────
echo "the platform tables and the manifest must agree:"
fresh_root "$tmp/root2"

# A manifest carrying a fourth payload nobody mapped. A new release target is a packaging decision,
# so it must stop the job rather than be dropped without a word.
cat > "$tmp/extra.json" <<JSON
{
  "schemaVersion": 1, "repo": "AltanS/collie", "tag": "v9.9.9", "version": "9.9.9",
  "artifacts": [
    { "name": "collie-9.9.9-linux-x64.tar.gz",   "platform": "linux-x64",   "sha256": "$X64_SHA" },
    { "name": "collie-9.9.9-linux-arm64.tar.gz", "platform": "linux-arm64", "sha256": "$ARM_SHA" },
    { "name": "collie-9.9.9-macos-arm64.tar.gz", "platform": "macos-arm64", "sha256": "$MAC_SHA" },
    { "name": "collie-9.9.9-linux-riscv.tar.gz", "platform": "linux-riscv", "sha256": "$MAC_SHA" }
  ]
}
JSON
bun "$script" --manifest "$tmp/extra.json" --root "$tmp/root2" > "$tmp/extra.log" 2>&1
rc=$?
check "an unmapped platform exits non-zero" "test $rc -ne 0"
check "it names the unmapped platform" "grep -q 'linux-riscv' '$tmp/extra.log'"

# And the other direction: a payload the tables name that the release stopped shipping.
cat > "$tmp/short.json" <<JSON
{
  "schemaVersion": 1, "repo": "AltanS/collie", "tag": "v9.9.9", "version": "9.9.9",
  "artifacts": [
    { "name": "collie-9.9.9-linux-x64.tar.gz",   "platform": "linux-x64",   "sha256": "$X64_SHA" },
    { "name": "collie-9.9.9-linux-arm64.tar.gz", "platform": "linux-arm64", "sha256": "$ARM_SHA" }
  ]
}
JSON
bun "$script" --manifest "$tmp/short.json" --root "$tmp/root2" > "$tmp/short.log" 2>&1
rc=$?
check "a mapped platform the manifest lacks exits non-zero" "test $rc -ne 0"
check "it names the missing platform" "grep -q 'macos-arm64' '$tmp/short.log'"

bun "$script" --manifest "$tmp/nope.json" --root "$tmp/root2" > /dev/null 2>&1
rc=$?
check "a manifest that does not exist exits non-zero" "test $rc -ne 0"
bun "$script" --root "$tmp/root2" > "$tmp/noargs.log" 2>&1
rc=$?
check "no --manifest exits non-zero" "test $rc -ne 0"
check "it says --manifest is required" "grep -q -- '--manifest' '$tmp/noargs.log'"
check "root2 was never rewritten" "grep -q '^pkgver=1.5.5$' '$tmp/root2/packaging/aur/PKGBUILD'"

# ── The real tree was never written ────────────────────────────────────────
echo "the checked-in tree was not touched:"
check "packaging/aur/PKGBUILD is unchanged" \
  "test \"\$(sha256sum '$here/aur/PKGBUILD' | cut -d' ' -f1)\" = '$before_pkgbuild'"
check "packaging/nix/sources.json is unchanged" \
  "test \"\$(sha256sum '$here/nix/sources.json' | cut -d' ' -f1)\" = '$before_sources'"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "refresh-packages: all checks passed"
