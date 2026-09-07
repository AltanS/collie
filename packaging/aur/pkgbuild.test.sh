#!/usr/bin/env bash
# Pins the SHAPE of packaging/aur/PKGBUILD, not its contents. Version and hashes move on every
# release (scripts/refresh-packages.ts writes them from the manifest); the promises below must not
# move at all. This test needs no Arch, no makepkg and no network — it reads the file.
#
# The live proof that the package installs and classifies as `packaged` is
# packaging/aur/vm-install.test.sh, which builds it in a container.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkgbuild="$here/PKGBUILD"
srcinfo="$here/.SRCINFO"

fails=0
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo "PKGBUILD shape:"

check "the file exists" "test -f '$pkgbuild'"
if [ ! -f "$pkgbuild" ]; then
  echo "packaging/aur/PKGBUILD is missing" >&2
  exit 1
fi

# ── Identity ───────────────────────────────────────────────────────────────
check "pkgname is collie-bin" "grep -q '^pkgname=collie-bin\$' '$pkgbuild'"
check "provides=('collie')" "grep -qF \"provides=('collie')\" '$pkgbuild'"
check "conflicts=('collie')" "grep -qF \"conflicts=('collie')\" '$pkgbuild'"
check "both shipped Linux architectures" "grep -qF \"arch=('x86_64' 'aarch64')\" '$pkgbuild'"
check "we are the maintainer" "grep -q '^# Maintainer: Altan Sarisin <altan@sportsight.de>\$' '$pkgbuild'"
check "no outside maintainer is named" "! grep -qniE 'co-?maintainer' '$pkgbuild'"

# ── It compiles nothing ────────────────────────────────────────────────────
# The concept's rule: every package wraps the release tarball, none of them builds Collie.
check "no build() function" "! grep -qE '^build\\(\\)' '$pkgbuild'"
check "no prepare() function" "! grep -qE '^prepare\\(\\)' '$pkgbuild'"
check "no toolchain makedepends" "! grep -qE '^makedepends=.*(bun|nodejs|npm|git)' '$pkgbuild'"
check "no makedepends at all" "! grep -qE '^makedepends=' '$pkgbuild'"

# ── The layout bridge/root.ts needs ────────────────────────────────────────
# /usr/bin/collie must be a SYMLINK into /usr/lib/collie/bin/collie. The binary resolves its root as
# dirname(dirname(realpath(argv0))) and accepts it only when herdr-plugin.toml sits there, so a file
# installed straight into /usr/bin would resolve its root to /usr and find no web/dist.
check "the tree lands under /usr/lib/collie" "grep -q '/usr/lib/' '$pkgbuild'"
check "/usr/bin/collie is a symlink" "grep -qE 'ln -s.*usr/bin/collie' '$pkgbuild'"
check "the binary is installed under the prefix" "grep -qE 'install -Dm755 .*bin/collie' '$pkgbuild'"
check "the licence is installed" "grep -q '/usr/share/licenses/' '$pkgbuild'"

# ── It does not take the operator's decisions ──────────────────────────────
check "no systemd unit is enabled or started" "! grep -qE 'systemctl (enable|start)' '$pkgbuild'"
check "no herdr plugin registration" "! grep -qE '^[^#]*herdr plugin (link|install)' '$pkgbuild'"

# ── Sources come from the release, and hashes come from the manifest ───────
check "x86_64 source is the linux-x64 release tarball" \
  "grep -qE '^source_x86_64=.*collie-\\\$pkgver-linux-x64\\.tar\\.gz' '$pkgbuild'"
check "aarch64 source is the linux-arm64 release tarball" \
  "grep -qE '^source_aarch64=.*collie-\\\$pkgver-linux-arm64\\.tar\\.gz' '$pkgbuild'"
check "one x86_64 sha256, 64 hex digits" \
  "grep -qE \"^sha256sums_x86_64=\\('[0-9a-f]{64}'\\)\$\" '$pkgbuild'"
check "one aarch64 sha256, 64 hex digits" \
  "grep -qE \"^sha256sums_aarch64=\\('[0-9a-f]{64}'\\)\$\" '$pkgbuild'"
check "pkgver is a bare semver" "grep -qE '^pkgver=[0-9]+\\.[0-9]+\\.[0-9]+\$' '$pkgbuild'"
check "pkgrel is a positive integer" "grep -qE '^pkgrel=[1-9][0-9]*\$' '$pkgbuild'"
# The needle is assembled rather than written out, so this file is not its own first hit.
needle="BEGIN OPENSSH PRIVATE"" KEY"
check "no private key is in the tree" "! grep -rqF \"\$needle\" '$here'"

# ── .SRCINFO is the AUR's copy of the same facts ───────────────────────────
# The AUR reads .SRCINFO, not the PKGBUILD, so a stale one publishes the wrong version.
echo ".SRCINFO agrees with the PKGBUILD:"
check "the file exists" "test -f '$srcinfo'"
if [ -f "$srcinfo" ]; then
  pkgver="$(sed -n 's/^pkgver=//p' "$pkgbuild" | head -1)"
  pkgrel="$(sed -n 's/^pkgrel=//p' "$pkgbuild" | head -1)"
  x64="$(sed -n "s/^sha256sums_x86_64=('\(.*\)')/\1/p" "$pkgbuild" | head -1)"
  a64="$(sed -n "s/^sha256sums_aarch64=('\(.*\)')/\1/p" "$pkgbuild" | head -1)"
  check "pkgver matches" "grep -qE '^[[:space:]]*pkgver = $pkgver\$' '$srcinfo'"
  check "pkgrel matches" "grep -qE '^[[:space:]]*pkgrel = $pkgrel\$' '$srcinfo'"
  check "x86_64 sha256 matches" "grep -qE '^[[:space:]]*sha256sums_x86_64 = $x64\$' '$srcinfo'"
  check "aarch64 sha256 matches" "grep -qE '^[[:space:]]*sha256sums_aarch64 = $a64\$' '$srcinfo'"
  check "pkgbase is collie-bin" "grep -q '^pkgbase = collie-bin\$' '$srcinfo'"
fi

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "PKGBUILD shape: all checks passed"
