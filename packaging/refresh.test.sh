#!/usr/bin/env bash
# Pins scripts/refresh-packages.ts: the rewrite is field-scoped, it takes every value from the
# manifest, and it FAILS on a mismatch rather than publishing a stale hash.
#
# The whole run happens in a temporary copy of `packaging/`, against a fixture manifest with
# invented version and hashes. The tree you are sitting in is never written to, and the last check
# below asserts that.
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

# ── The fixture ────────────────────────────────────────────────────────────
# Version and hashes are invented and share no digits with the real release, so a field that was
# NOT rewritten is obvious rather than accidentally equal.
X64_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ARM_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MAC_SHA="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

cat > "$tmp/manifest.json" <<JSON
{
  "schemaVersion": 1,
  "repo": "AltanS/collie",
  "tag": "v9.9.9",
  "version": "9.9.9",
  "prerelease": false,
  "commit": "0000000000000000000000000000000000000000",
  "artifacts": [
    { "name": "collie-9.9.9-linux-x64.tar.gz",   "platform": "linux-x64",   "sha256": "$X64_SHA" },
    { "name": "collie-9.9.9-linux-arm64.tar.gz", "platform": "linux-arm64", "sha256": "$ARM_SHA" },
    { "name": "collie-9.9.9-macos-arm64.tar.gz", "platform": "macos-arm64", "sha256": "$MAC_SHA" }
  ],
  "extras": []
}
JSON

# A copy of the real packaging/ tree, so the fixture rewrite is exercised against the files that
# actually ship rather than against a mock of them.
mkdir -p "$tmp/root"
cp -R "$here" "$tmp/root/packaging"
pkgbuild="$tmp/root/packaging/aur/PKGBUILD"
sources="$tmp/root/packaging/nix/sources.json"

before_pkgbuild="$(sha256sum "$here/aur/PKGBUILD" | cut -d' ' -f1)"
before_sources="$(sha256sum "$here/nix/sources.json" | cut -d' ' -f1)"

# ── The rewrite ────────────────────────────────────────────────────────────
echo "the rewrite takes every field from the manifest:"
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" > "$tmp/write.log" 2>&1
rc=$?
check "the rewrite exits 0" "test $rc -eq 0"
[ "$rc" -eq 0 ] || cat "$tmp/write.log"

check "PKGBUILD pkgver is the manifest's version" "grep -qx 'pkgver=9.9.9' '$pkgbuild'"
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

# ── --check verifies what is on disk ───────────────────────────────────────
echo "--check verifies and writes nothing:"
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" --check > "$tmp/check.log" 2>&1
rc=$?
check "--check passes on a freshly rewritten tree" "test $rc -eq 0"
[ "$rc" -eq 0 ] || cat "$tmp/check.log"
cp "$pkgbuild" "$tmp/pkgbuild.before-check"
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" --check > /dev/null 2>&1
check "--check left the PKGBUILD byte-identical" "cmp -s '$pkgbuild' '$tmp/pkgbuild.before-check'"

# ── A deliberate mismatch must FAIL ────────────────────────────────────────
echo "a mismatch fails loudly:"
sed -i "s/sha256sums_x86_64=('$X64_SHA')/sha256sums_x86_64=('deadbeef00000000000000000000000000000000000000000000000000000000')/" "$pkgbuild"
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" --check > "$tmp/mismatch.log" 2>&1
mismatch_exit=$?
check "a wrong hash exits non-zero" "test $mismatch_exit -ne 0"
check "it names the field that disagreed" "grep -q 'sha256sums_x86_64' '$tmp/mismatch.log'"
check "it names the value it expected" "grep -q '$X64_SHA' '$tmp/mismatch.log'"

# A rewrite over the tampered file repairs it, because the manifest is the source of truth.
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" > /dev/null 2>&1
check "a rewrite repairs the tampered field" "grep -qx \"sha256sums_x86_64=('$X64_SHA')\" '$pkgbuild'"

# A field this script owns that has gone missing must fail, not be silently appended.
sed -i '/^pkgver=/d' "$pkgbuild"
bun "$script" --manifest "$tmp/manifest.json" --root "$tmp/root" > "$tmp/missing.log" 2>&1
rc=$?
check "a missing pkgver line exits non-zero" "test $rc -ne 0"
check "it says the field was not found once" "grep -q 'pkgver' '$tmp/missing.log'"

# ── A manifest that cannot answer must fail ────────────────────────────────
echo "an unusable manifest fails:"
sed 's/"platform": "linux-arm64"/"platform": "linux-riscv"/' "$tmp/manifest.json" > "$tmp/short.json"
cp -R "$here" "$tmp/root2-packaging"; mkdir -p "$tmp/root2"; mv "$tmp/root2-packaging" "$tmp/root2/packaging"
bun "$script" --manifest "$tmp/short.json" --root "$tmp/root2" > "$tmp/short.log" 2>&1
rc=$?
check "a manifest missing a platform exits non-zero" "test $rc -ne 0"
check "it names the missing platform" "grep -q 'linux-arm64' '$tmp/short.log'"
bun "$script" --manifest "$tmp/nope.json" --root "$tmp/root2" > /dev/null 2>&1
rc=$?
check "a manifest that does not exist exits non-zero" "test $rc -ne 0"
bun "$script" --root "$tmp/root2" > "$tmp/noargs.log" 2>&1
rc=$?
check "no --manifest exits non-zero" "test $rc -ne 0"
check "it says --manifest is required" "grep -q -- '--manifest' '$tmp/noargs.log'"

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
