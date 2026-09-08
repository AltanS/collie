#!/usr/bin/env bash
# Tests for scripts/check-payload-links.sh — the gate that keeps a loader input outside the target
# machine's own system roots out of a released binary (#184).
#
# There is no real Mach-O here and no real Mac. Every case runs the script against a stand-in file
# with FAKE `otool` and `readelf` on a scratch PATH, printing canned output the case chose, and with
# `CHECK_PAYLOAD_OS` naming the branch to take. That is the whole point of both hooks: the bug is a
# STRING in a loader table, and a string is testable on any host.
#
# The scratch PATH is a toolbox of symlinks rather than the real PATH, so the "missing tool" case is
# honest on a Mac too — where `otool` really is installed and prepending a directory would not hide
# it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/check-payload-links.sh"
BASH_BIN="$(command -v bash)"
TMP_ROOT="$(mktemp -d)"

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

# The stand-in payload. The script only ever asks a tool about it; it never reads its bytes.
BINARY="${TMP_ROOT}/collie"
printf 'not really a binary\n' > "$BINARY"

# A PATH holding exactly what the script needs from outside bash, plus whichever fakes a case put
# there. `with_tools <name> <tool…>` builds one and echoes its path.
with_tools() {
  local dir="${TMP_ROOT}/$1"
  shift
  mkdir -p "$dir"
  local t
  for t in "$@"; do
    ln -sf "$(command -v "$t")" "$dir/$t"
  done
  printf '%s' "$dir"
}

# The real otool answers two questions and so does this one: `-L` lists the load commands, `-l`
# dumps every load command, which is where LC_RPATH lives.
fake_otool() {
  cat > "$1/otool" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  -L) cat "$FAKE_OTOOL_L" ;;
  -l) cat "$FAKE_OTOOL_CMDS" ;;
  *) echo "fake otool: unexpected flag $1" >&2; exit 2 ;;
esac
FAKE
  chmod 0755 "$1/otool"
}

fake_readelf() {
  cat > "$1/readelf" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  -l) cat "$FAKE_READELF_L" ;;
  -d) cat "$FAKE_READELF_D" ;;
  *) echo "fake readelf: unexpected flag $1" >&2; exit 2 ;;
esac
FAKE
  chmod 0755 "$1/readelf"
}

# Run the script on a scratch PATH; collect stdout and stderr together.
run_check() {
  local dir="$1"
  shift
  local out rc=0
  set +e
  out="$(PATH="$dir" env "$@" "$BASH_BIN" "$SCRIPT" "$BINARY" 2>&1)"
  rc=$?
  set -e
  OUT="$out"
  return "$rc"
}

TOOLS="$(with_tools tools awk bash cat env grep sed uname)"
fake_otool "$TOOLS"
fake_readelf "$TOOLS"

# A Mach-O with no LC_RPATH at all, which is what a Bun single-file executable should look like.
cat > "${TMP_ROOT}/otool-cmds-none" <<'OUT'
Load command 0
      cmd LC_SEGMENT_64
  cmdsize 72
  segname __PAGEZERO
Load command 1
      cmd LC_SYMTAB
  cmdsize 24
OUT

# ── 1. Darwin, a binary linked the way 1.5.3 was ────────────────────────────
cat > "${TMP_ROOT}/otool-clean" <<'OUT'
/tmp/collie:
	/usr/lib/libicucore.A.dylib (compatibility version 1.0.0, current version 66.1.0)
	/usr/lib/libresolv.9.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1600.157.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
OUT
run_check "$TOOLS" CHECK_PAYLOAD_OS=Darwin FAKE_OTOOL_L="${TMP_ROOT}/otool-clean" \
  FAKE_OTOOL_CMDS="${TMP_ROOT}/otool-cmds-none" \
  || fail "a system-linked Mach-O with no LC_RPATH must pass: $OUT"
assert_contains "$OUT" "✓"
assert_contains "$OUT" "otool -L"
assert_contains "$OUT" "otool -l"

# ── 2. Darwin, the 1.5.4/1.5.5 binary ───────────────────────────────────────
cat > "${TMP_ROOT}/otool-nix" <<'OUT'
/tmp/collie:
	/nix/store/1a2b3c4d5e6f7g8h9i0j-ICU-73.2/lib/libicucore.A.dylib (compatibility version 1.0.0, current version 66.1.0)
	/usr/lib/libresolv.9.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Darwin FAKE_OTOOL_L="${TMP_ROOT}/otool-nix" \
  FAKE_OTOOL_CMDS="${TMP_ROOT}/otool-cmds-none"; then
  fail "a Nix-linked Mach-O must fail: $OUT"
fi
assert_contains "$OUT" "Nix store"
# The operator is told WHICH path, not just that there was one.
assert_contains "$OUT" "/nix/store/1a2b3c4d5e6f7g8h9i0j-ICU-73.2/lib/libicucore.A.dylib"
assert_contains "$OUT" "outside the system roots"
assert_contains "$OUT" "#184"

# ── 3. Darwin, a clean load table and an LC_RPATH into the store ────────────
# The load commands can be spotless and the search path still point at the build machine, so the
# rpaths are read as their own question.
cat > "${TMP_ROOT}/otool-cmds-nix-rpath" <<'OUT'
Load command 12
      cmd LC_RPATH
  cmdsize 88
     path /nix/store/9q8w7e6r-icu4c-73.2/lib (offset 12)
Load command 13
      cmd LC_SYMTAB
  cmdsize 24
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Darwin FAKE_OTOOL_L="${TMP_ROOT}/otool-clean" \
  FAKE_OTOOL_CMDS="${TMP_ROOT}/otool-cmds-nix-rpath"; then
  fail "an LC_RPATH into the store must fail even when otool -L is clean: $OUT"
fi
assert_contains "$OUT" "LC_RPATH"
assert_contains "$OUT" "/nix/store/9q8w7e6r-icu4c-73.2/lib"

# ── 4. Darwin, Homebrew instead of Nix ──────────────────────────────────────
# The allowlist is the point: this path never appears in #184, and it breaks a Mac without Homebrew
# exactly the same way.
cat > "${TMP_ROOT}/otool-brew" <<'OUT'
/tmp/collie:
	/opt/homebrew/opt/icu4c/lib/libicucore.A.dylib (compatibility version 1.0.0, current version 66.1.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Darwin FAKE_OTOOL_L="${TMP_ROOT}/otool-brew" \
  FAKE_OTOOL_CMDS="${TMP_ROOT}/otool-cmds-none"; then
  fail "a Homebrew-linked Mach-O must fail: $OUT"
fi
assert_contains "$OUT" "/opt/homebrew/opt/icu4c/lib/libicucore.A.dylib"
assert_contains "$OUT" "outside the system roots"

# ── 5. Linux, an ordinary glibc payload ─────────────────────────────────────
# Bare sonames, no slash: the loader finds them through the machine's own search path, so they are
# not paths and are not judged.
cat > "${TMP_ROOT}/readelf-l-clean" <<'OUT'
Program Headers:
  Type           Offset             VirtAddr
  INTERP         0x0000000000000318 0x0000000000000318
      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
  LOAD           0x0000000000000000 0x0000000000000000
OUT
cat > "${TMP_ROOT}/readelf-d-clean" <<'OUT'
Dynamic section at offset 0x5a0 contains 26 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
OUT
run_check "$TOOLS" CHECK_PAYLOAD_OS=Linux \
  FAKE_READELF_L="${TMP_ROOT}/readelf-l-clean" FAKE_READELF_D="${TMP_ROOT}/readelf-d-clean" \
  || fail "bare sonames and a /lib64 interpreter must pass: $OUT"
assert_contains "$OUT" "✓"
assert_contains "$OUT" "readelf"

# ── 6. Linux, an interpreter inside the store ───────────────────────────────
# The Linux shape of the same mistake: autopatchelf's work reaching the artifact.
cat > "${TMP_ROOT}/readelf-l-nix" <<'OUT'
Program Headers:
  Type           Offset             VirtAddr
  INTERP         0x0000000000000318 0x0000000000000318
      [Requesting program interpreter: /nix/store/0zyx-glibc-2.40/lib/ld-linux-x86-64.so.2]
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Linux \
  FAKE_READELF_L="${TMP_ROOT}/readelf-l-nix" FAKE_READELF_D="${TMP_ROOT}/readelf-d-clean"; then
  fail "a Nix-linked ELF must fail: $OUT"
fi
assert_contains "$OUT" "Nix store"
assert_contains "$OUT" "/nix/store/0zyx-glibc-2.40/lib/ld-linux-x86-64.so.2"

# ── 7. Linux, one bad element in a RUNPATH list ─────────────────────────────
# A RUNPATH is a colon-separated list. The good half must not hide the bad half.
cat > "${TMP_ROOT}/readelf-d-runner" <<'OUT'
Dynamic section at offset 0x5a0 contains 26 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
 0x000000000000001d (RUNPATH)            Library runpath: [/tmp/runner/x:/usr/lib]
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Linux \
  FAKE_READELF_L="${TMP_ROOT}/readelf-l-clean" FAKE_READELF_D="${TMP_ROOT}/readelf-d-runner"; then
  fail "a RUNPATH element outside the roots must fail: $OUT"
fi
assert_contains "$OUT" "/tmp/runner/x"
assert_contains "$OUT" "outside the system roots"

# ── 8. Linux, $ORIGIN in a RUNPATH ──────────────────────────────────────────
# Relative to the binary's own directory, which a single-file executable has no use for. Named
# rather than quietly allowed.
cat > "${TMP_ROOT}/readelf-d-origin" <<'OUT'
Dynamic section at offset 0x5a0 contains 26 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]
 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN/../lib:/usr/lib]
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Linux \
  FAKE_READELF_L="${TMP_ROOT}/readelf-l-clean" FAKE_READELF_D="${TMP_ROOT}/readelf-d-origin"; then
  fail "\$ORIGIN in a RUNPATH must fail: $OUT"
fi
assert_contains "$OUT" 'ORIGIN'

# ── 9. Linux, a NEEDED entry that carries a path ────────────────────────────
cat > "${TMP_ROOT}/readelf-d-needed-path" <<'OUT'
Dynamic section at offset 0x5a0 contains 26 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [/nix/store/44aa-openssl-3.3/lib/libssl.so.3]
OUT
if run_check "$TOOLS" CHECK_PAYLOAD_OS=Linux \
  FAKE_READELF_L="${TMP_ROOT}/readelf-l-clean" FAKE_READELF_D="${TMP_ROOT}/readelf-d-needed-path"; then
  fail "a NEEDED entry carrying a path must fail: $OUT"
fi
assert_contains "$OUT" "/nix/store/44aa-openssl-3.3/lib/libssl.so.3"

# ── 10. No inspection tool at all ───────────────────────────────────────────
# The case that would otherwise pass silently, which is the only outcome this script must never
# have. The toolbox carries no `otool`, and it is the WHOLE PATH, so a real one cannot answer.
BARE="$(with_tools bare awk bash cat env grep sed uname)"
if run_check "$BARE" CHECK_PAYLOAD_OS=Darwin FAKE_OTOOL_L="${TMP_ROOT}/otool-clean" \
  FAKE_OTOOL_CMDS="${TMP_ROOT}/otool-cmds-none"; then
  fail "a missing otool must fail, not pass: $OUT"
fi
assert_contains "$OUT" "otool is not on PATH"
assert_contains "$OUT" "has not looked"

echo "✓ check-payload-links.test.sh — all cases passed"
