#!/usr/bin/env bash
# Builds and installs collie-bin in a throwaway Arch container, then asks the installed binary what
# kind of install it is. The answer must be `packaged`.
#
#   bash packaging/aur/vm-install.test.sh
#
# This is the live proof behind spec 01's predicate and spec 05's layout: `/opt/collie` is
# root-owned and outside $HOME, `herdr-plugin.toml` sits at its root, there is no `.git` and no
# `versions/`, so `classifyInstall` answers `packaged` and `collie update` declines. Nothing here
# is mocked — makepkg downloads the real release tarball and checks it against the PKGBUILD's
# sha256, so a wrong hash fails this test at the unpack step.
#
# It needs a container runtime, the network, and about two minutes. It is deliberately NOT part of
# `bun run test`; the shape checks that run everywhere are in pkgbuild.test.sh beside it.
#
# The binary the package carries is the PUBLISHED one, so it answers with the prefixes that release
# knew. To prove what THIS tree answers from the packaged root, compile the CLI and point
# COLLIE_LOCAL_BINARY at it:
#
#   bun build --compile --target=bun ./cli/main.ts --outfile /tmp/collie-local
#   COLLIE_LOCAL_BINARY=/tmp/collie-local bash packaging/aur/vm-install.test.sh
#
# That binary replaces /opt/collie/bin/collie inside the throwaway container only, and the run then
# also asserts the package command is named. Without it the step says it was skipped.
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
local_mount=()
if [ -n "${COLLIE_LOCAL_BINARY:-}" ]; then
  if [ ! -x "$COLLIE_LOCAL_BINARY" ]; then
    echo "✗ COLLIE_LOCAL_BINARY=$COLLIE_LOCAL_BINARY is not an executable file" >&2
    exit 1
  fi
  local_mount=(-v "$(realpath "$COLLIE_LOCAL_BINARY"):/local/collie:ro,z")
  echo "Also proving this tree's own binary from the packaged root: $COLLIE_LOCAL_BINARY"
fi

"$runtime" run --rm -i -v "$here:/pkg:ro,z" "${local_mount[@]}" archlinux:latest bash -s <<'CONTAINER'
set -euo pipefail

pacman -Sy --noconfirm --needed base-devel sudo >/dev/null
useradd -m builder
echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder

install -d -o builder /home/builder/build
install -o builder /pkg/PKGBUILD /home/builder/build/PKGBUILD
# `install=collie-bin.install` names it, and makepkg refuses a PKGBUILD whose install file is
# missing — so the scriptlet is part of what this test builds, and pacman runs it on -i.
install -o builder /pkg/collie-bin.install /home/builder/build/collie-bin.install

# -s installs missing dependencies, -i installs the built package. No build() runs, because the
# PKGBUILD has none: makepkg downloads the tarball, verifies its sha256 and unpacks it.
su builder -c 'cd /home/builder/build && makepkg -si --noconfirm'

echo "== what landed =============================================="
pacman -Qi collie-bin | head -12
ls -l /usr/bin/collie
ls -A /opt/collie

echo "== the documentation, read out of the built package ========="
# The Arch container image sets NoExtract for /usr/share/doc, so those files are not on the
# filesystem HERE even though the package carries them. The package itself is the truth, and on a
# real Arch or Omarchy host they are extracted normally.
su builder -c 'cd /home/builder/build && bsdtar -tf collie-bin-*.pkg.tar.zst' \
  | grep -E '^usr/share/(doc|licenses)/collie-bin/' | head -8

echo "== the version, read through the PATH name =================="
su builder -c '/usr/bin/collie version'

echo "== .SRCINFO, regenerated from this PKGBUILD ================="
# Printed so the copy committed beside the PKGBUILD can be compared by eye on a machine that has
# no makepkg. The AUR reads .SRCINFO and not the PKGBUILD, so a stale one publishes wrong facts.
su builder -c 'cd /home/builder/build && makepkg --printsrcinfo'

echo "== the install kind, read from the installed binary ========="
# Run as the ordinary user, which is the case that matters: the root is outside this user's $HOME
# and not writable by them, so the packaged predicate holds on facts and not on being root.
su builder -c '/usr/bin/collie doctor' > /tmp/doctor.out 2>&1 || true
grep -E '\binstall\b' /tmp/doctor.out || head -20 /tmp/doctor.out

echo "== collie update declines ==================================="
su builder -c '/usr/bin/collie update' > /tmp/update.out 2>&1 || true
head -4 /tmp/update.out

echo "== this tree's binary, from the same packaged root =========="
# The package carries the PUBLISHED binary, which names the prefixes that release knew. Swapping in
# a binary compiled from the working tree — in this throwaway container and nowhere else — is what
# proves the root /opt/collie is both classified as packaged AND named with its manager.
if [ -x /local/collie ]; then
  install -m755 /local/collie /opt/collie/bin/collie
  su builder -c '/usr/bin/collie version'
  su builder -c '/usr/bin/collie doctor' > /tmp/doctor-local.out 2>&1 || true
  grep -E '\binstall\b' /tmp/doctor-local.out | head -2
  su builder -c '/usr/bin/collie update' > /tmp/update-local.out 2>&1 || true
  head -4 /tmp/update-local.out
  if grep -q 'sudo pacman -Syu collie-bin' /tmp/doctor-local.out && \
     grep -q 'sudo pacman -Syu collie-bin' /tmp/update-local.out; then
    echo "VERDICT: /opt/collie is named with sudo pacman -Syu collie-bin"
  else
    echo "VERDICT: /opt/collie was NOT named with its package command" >&2
    exit 1
  fi
else
  echo "skipped: set COLLIE_LOCAL_BINARY to a compiled bin/collie to run this step"
fi

echo "== the verdict =============================================="
if grep -q 'packaged install at /opt/collie' /tmp/doctor.out; then
  echo "VERDICT: this install classifies as packaged"
else
  echo "VERDICT: NOT packaged — collie doctor did not report a packaged install" >&2
  cat /tmp/doctor.out >&2
  exit 1
fi
CONTAINER
