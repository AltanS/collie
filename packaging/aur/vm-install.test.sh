#!/usr/bin/env bash
# Builds and installs collie-bin in a throwaway Arch container, then asks the installed binary what
# kind of install it is. The answer must be `packaged`.
#
#   bash packaging/aur/vm-install.test.sh
#
# This is the live proof behind spec 01's predicate and spec 05's layout: `/usr/lib/collie` is
# root-owned and outside $HOME, `herdr-plugin.toml` sits at its root, there is no `.git` and no
# `versions/`, so `classifyInstall` answers `packaged` and `collie update` declines. Nothing here
# is mocked — makepkg downloads the real release tarball and checks it against the PKGBUILD's
# sha256, so a wrong hash fails this test at the unpack step.
#
# It needs a container runtime, the network, and about two minutes. It is deliberately NOT part of
# `bun run test`; the shape checks that run everywhere are in pkgbuild.test.sh beside it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

runtime=""
for candidate in podman docker; do
  if command -v "$candidate" >/dev/null 2>&1; then runtime="$candidate"; break; fi
done
if [ -z "$runtime" ]; then
  echo "✗ no podman and no docker on this machine; this test needs one of them" >&2
  exit 1
fi

# The x86_64 package is the one built here, because that is what `sha256sums_x86_64` covers.
arch="$(uname -m)"
if [ "$arch" != "x86_64" ]; then
  echo "✗ this test builds the x86_64 package and this host is $arch" >&2
  exit 1
fi

echo "Building collie-bin with $runtime, from $here/PKGBUILD"

# The directory is mounted READ-ONLY. makepkg needs a writable build directory, so the PKGBUILD is
# copied out of the mount into the builder's home; a writable mount plus `chown builder` would
# leave the checkout owned by a container subuid.
"$runtime" run --rm -i -v "$here:/pkg:ro,z" archlinux:latest bash -s <<'CONTAINER'
set -euo pipefail

pacman -Sy --noconfirm --needed base-devel sudo >/dev/null
useradd -m builder
echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder

install -d -o builder /home/builder/build
install -o builder /pkg/PKGBUILD /home/builder/build/PKGBUILD

# -s installs missing dependencies, -i installs the built package. No build() runs, because the
# PKGBUILD has none: makepkg downloads the tarball, verifies its sha256 and unpacks it.
su builder -c 'cd /home/builder/build && makepkg -si --noconfirm'

echo "== what landed =============================================="
pacman -Qi collie-bin | head -10
ls -l /usr/bin/collie
ls /usr/lib/collie

echo "== the install kind, read from the installed binary ========="
# Run as the ordinary user, which is the case that matters: the root is outside this user's $HOME
# and not writable by them, so the packaged predicate holds on facts and not on being root.
su builder -c '/usr/bin/collie doctor' > /tmp/doctor.out 2>&1 || true
grep -E '\binstall\b' /tmp/doctor.out || head -20 /tmp/doctor.out

echo "== collie update declines ==================================="
su builder -c '/usr/bin/collie update' > /tmp/update.out 2>&1 || true
head -4 /tmp/update.out

echo "== the verdict =============================================="
if grep -q 'packaged install at /usr/lib/collie' /tmp/doctor.out; then
  echo "VERDICT: this install classifies as packaged"
else
  echo "VERDICT: NOT packaged — collie doctor did not report a packaged install" >&2
  cat /tmp/doctor.out >&2
  exit 1
fi
CONTAINER
