#!/usr/bin/env bash
# Tests for scripts/collie-ctl.sh — which, since M6/01, is a BOOTSTRAP SHIM and nothing else: find
# Bun, build `bin/collie` if it is missing, `exec` it with the original argv.
#
# So this suite asserts exactly that surface. Everything the script used to implement — the systemd
# unit, the launchd agent, `tailscale serve` ownership, the update strategies, the banner — now lives
# in `cli/` and is covered by `bun test ./cli` and scripts/collie-cli.test.sh against the compiled
# binary. Nothing here builds, starts or publishes anything: every case runs against a THROWAWAY
# checkout under $TMP_ROOT with a fake `bun` and a stub `bin/collie` on a scratch PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTL="${ROOT}/scripts/collie-ctl.sh"
BASE_PATH="$PATH"
TMP_ROOT="$(mktemp -d)"

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

# A throwaway checkout holding a copy of the shim under test. Copied rather than symlinked: the shim
# derives PLUGIN_ROOT from BASH_SOURCE, and that resolution is part of what is being tested — a
# symlink would point it back at the real repository, whose `bin/collie` and `cli/` are the LIVE
# ones on this host.
setup_case() {
  CASE_DIR="${TMP_ROOT}/$1"
  CHECKOUT="${CASE_DIR}/checkout"
  HOME_DIR="${CASE_DIR}/home"
  BIN_DIR="${CASE_DIR}/path-bin"
  CALLS="${CASE_DIR}/calls"
  mkdir -p "${CHECKOUT}/scripts" "${CHECKOUT}/bin" "$HOME_DIR" "$BIN_DIR"
  cp "$CTL" "${CHECKOUT}/scripts/collie-ctl.sh"
  SHIM="${CHECKOUT}/scripts/collie-ctl.sh"
  COLLIE_BIN="${CHECKOUT}/bin/collie"
  : > "$CALLS"
  # The handful of real tools the shim and the fakes use, on the scratch PATH — so a case can run
  # with PATH holding NOTHING ELSE, which is the Herdr-action environment the Bun cases stage.
  local tool
  for tool in bash dirname cp chmod; do
    ln -sf "$(command -v "$tool")" "${BIN_DIR}/${tool}"
  done
}

# The binary the shim is supposed to hand over to: records its argv and the environment it was given.
write_stub_binary() {
  cat > "$1" <<EOF
#!/bin/sh
echo "collie \$*" >> "$CALLS"
echo "env COLLIE_INSTANCE=\${COLLIE_INSTANCE:-} SKIP_VERSION_CHECK=\${SKIP_VERSION_CHECK:-} HERDR_SOCKET_PATH=\${HERDR_SOCKET_PATH:-}" >> "$CALLS"
exit "\${STUB_EXIT:-0}"
EOF
  chmod +x "$1"
}

install_stub_binary() { write_stub_binary "$COLLIE_BIN"; }

# A fake `bun` that records how it was invoked — with its cwd, which is load-bearing: `collie build`
# must run in the checkout root — and produces the artifact a real `collie build` would. A second
# argument makes the build fail instead.
install_fake_bun() {
  local target="$1" should_fail="${2:-}" product="${CASE_DIR}/stub-collie"
  mkdir -p "$(dirname "$target")"
  write_stub_binary "$product"
  cat > "$target" <<EOF
#!/bin/sh
echo "\${PWD}\\\$ bun \$*" >> "$CALLS"
echo "bun-path=\$0" >> "$CALLS"
echo "bun-PATH=\$PATH" >> "$CALLS"
[ -n "$should_fail" ] && exit 1
cp "$product" "$COLLIE_BIN"
chmod +x "$COLLIE_BIN"
exit 0
EOF
  chmod +x "$target"
}

run_shim() {
  local rc=0
  set +e
  HOME="$HOME_DIR" PATH="${BIN_DIR}:${BASE_PATH}" bash "$SHIM" "$@" > "${CASE_DIR}/out" 2> "${CASE_DIR}/err"
  rc=$?
  set -e
  OUT="$(cat "${CASE_DIR}/out")"
  ERR="$(cat "${CASE_DIR}/err")"
  return "$rc"
}

# ── Delegation ───────────────────────────────────────────────────────────────

# The whole point of the shim: argv reaches the binary unchanged, including arguments with spaces
# and the internal verbs, and the environment flows through untouched — COLLIE_INSTANCE and
# SKIP_VERSION_CHECK are read by the CLI, and HERDR_* is what Herdr injects into an action.
test_delegation_passes_argv_and_env() {
  setup_case delegation
  install_stub_binary

  COLLIE_INSTANCE=v1 SKIP_VERSION_CHECK=1 HERDR_SOCKET_PATH=/tmp/herdr.sock \
    run_shim logs 200 || fail "the shim failed to delegate: ${ERR}"
  assert_contains "$(cat "$CALLS")" "collie logs 200"
  assert_contains "$(cat "$CALLS")" \
    "env COLLIE_INSTANCE=v1 SKIP_VERSION_CHECK=1 HERDR_SOCKET_PATH=/tmp/herdr.sock"

  : > "$CALLS"
  run_shim push-test "hello there" || fail "an argument with a space was not passed through"
  assert_contains "$(cat "$CALLS")" "collie push-test hello there"

  # No argv at all is the binary's usage error to report, not the shim's.
  : > "$CALLS"
  run_shim || true
  assert_contains "$(cat "$CALLS")" "collie "

  # Every verb the manifest's frozen action set names still reaches the binary (ADR 0006: a
  # <0.8.0 managed install invokes `bash scripts/collie-ctl.sh <verb>` from its cached definition).
  local verb
  for verb in start stop restart uninstall update url status version push-keys push-test; do
    : > "$CALLS"
    run_shim "$verb" || fail "the shim failed on \`${verb}\`"
    assert_contains "$(cat "$CALLS")" "collie ${verb}"
  done
}

# The exit code is the binary's, not the shim's — a script that swallowed it would report a
# successful `update` over a failed one.
test_delegation_propagates_the_exit_code() {
  setup_case exit-code
  install_stub_binary
  STUB_EXIT=3 run_shim status && fail "the shim swallowed a non-zero exit"
  STUB_EXIT=3 run_shim status || assert_eq "$?" "3"
}

# ── Bootstrap ────────────────────────────────────────────────────────────────

# A checkout can legitimately have no binary: `herdr plugin link` never runs `[[build]]`, and `bin/`
# is git-ignored. The shim must build one — from SOURCE, since the binary is what the build produces
# — and then delegate as usual, in ONE invocation.
test_bootstrap_builds_a_missing_binary() {
  setup_case bootstrap
  install_fake_bun "${BIN_DIR}/bun"
  [ ! -e "$COLLIE_BIN" ] || fail "the fixture already had a binary"

  run_shim status || fail "the shim could not bootstrap: ${ERR}"
  assert_contains "$ERR" "first run — building the collie binary"
  # From the checkout root, and from source: `cli/main.ts`, not `bin/collie`.
  assert_contains "$(cat "$CALLS")" "${CHECKOUT}\$ bun run cli/main.ts build"
  # …and the freshly built binary got the original argv.
  assert_contains "$(cat "$CALLS")" "collie status"
  [ -x "$COLLIE_BIN" ] || fail "the bootstrap left no binary behind"

  # Second invocation: the binary is there, so nothing is built.
  : > "$CALLS"
  run_shim url || fail "the shim failed once the binary existed"
  assert_contains "$(cat "$CALLS")" "collie url"
  case "$(cat "$CALLS")" in
    *"bun run cli/main.ts build"*) fail "the shim rebuilt a binary that already existed" ;;
  esac
}

# A build that fails must say so and name the fix, rather than dying on a bare exec error from Herdr.
test_bootstrap_failure_names_the_fix() {
  setup_case bootstrap-failure
  install_fake_bun "${BIN_DIR}/bun" fail-the-build

  run_shim start && fail "a failed bootstrap reported success"
  assert_contains "$ERR" "could not build"
  assert_contains "$ERR" "herdr plugin action invoke update --plugin herdr.collie"
  [ ! -e "$COLLIE_BIN" ] || fail "a failed build still produced a binary"
}

# No binary AND no Bun is the one state the shim cannot resolve — the message is all an operator on
# such a host gets, so it names both ways out.
test_bootstrap_without_bun_reports_it() {
  setup_case bootstrap-no-bun
  # PATH holds only the scratch dir (which has no `bun`), and $HOME is a temp dir with no ~/.bun —
  # so every absolute fallback resolve_bun tries misses too, unless the host has a system Bun.
  if [ -x /usr/bin/bun ] || [ -x /usr/local/bin/bun ] || [ -x /opt/homebrew/bin/bun ]; then
    echo "  (skipping the no-Bun case: this host has Bun in a system location)" >&2
    return 0
  fi
  set +e
  HOME="$HOME_DIR" PATH="$BIN_DIR" BUN_INSTALL= bash "$SHIM" status \
    > "${CASE_DIR}/out" 2> "${CASE_DIR}/err"
  local rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "the shim reported success with no binary and no Bun"
  assert_contains "$(cat "${CASE_DIR}/err")" "bun is not installed"
  assert_contains "$(cat "${CASE_DIR}/err")" "herdr plugin action invoke update --plugin herdr.collie"
}

# ── Bun resolution ───────────────────────────────────────────────────────────

# Herdr spawns plugin actions with a minimal environment — no login shell, so ~/.bun/bin is simply
# absent from PATH and `command -v bun` alone found nothing. That is the bug that left the checkout
# ahead of the bundle being served across four `update` invocations, and it is why this logic stayed
# in the shim rather than moving into the binary: Bun is what BUILDS the binary. Pin both halves:
# which Bun gets chosen, and that its directory reaches children on PATH (`collie build` spawns
# children that look up a bare `bun` themselves).
test_bun_resolution() {
  setup_case bun-resolution
  install_fake_bun "${HOME_DIR}/.bun/bin/bun"
  # PATH holds no bun at all — this IS the Herdr-action environment. $BUN_INSTALL is emptied (which
  # `${BUN_INSTALL:-…}` treats as unset): a developer running these tests from a shell where Bun's
  # installer exported it would otherwise resolve their REAL bun and the fixture would never be
  # consulted.
  set +e
  HOME="$HOME_DIR" PATH="$BIN_DIR" BUN_INSTALL= bash "$SHIM" status \
    > "${CASE_DIR}/out" 2> "${CASE_DIR}/err"
  local rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "the shim failed with Bun only in \$HOME: $(cat "${CASE_DIR}/err")"
  assert_contains "$(cat "$CALLS")" "bun-path=${HOME_DIR}/.bun/bin/bun"
  assert_contains "$(grep '^bun-PATH=' "$CALLS" | head -1)" "${HOME_DIR}/.bun/bin"

  # $BUN_INSTALL is the operator's explicit choice, so it outranks the default ~/.bun.
  setup_case bun-resolution-install
  install_fake_bun "${CASE_DIR}/alt/bin/bun"
  set +e
  HOME="$HOME_DIR" PATH="$BIN_DIR" BUN_INSTALL="${CASE_DIR}/alt" bash "$SHIM" status \
    > "${CASE_DIR}/out" 2> "${CASE_DIR}/err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "BUN_INSTALL was not honoured: $(cat "${CASE_DIR}/err")"
  assert_contains "$(cat "$CALLS")" "bun-path=${CASE_DIR}/alt/bin/bun"
}

# `command -v` reports a function or alias as a BARE word, so a `bun()` in whatever sourced us yields
# dirname `.` — and prepending that would hand every later lookup a cwd-relative resolution. Only
# absolute paths reach PATH.
test_non_absolute_bun_never_reaches_path() {
  setup_case bun-not-absolute
  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export PATH="${BIN_DIR}:${BASE_PATH}"
bun() { :; }   # what a doctored profile would leave behind
source "$SHIM"
echo "PATH=\$PATH"
EOF
  bash "$harness" > "${CASE_DIR}/path.out" 2>&1 ||
    fail "sourcing the shim with a bun function failed"
  case "$(cat "${CASE_DIR}/path.out")" in
    *"PATH=.:"*|*":.:"*) fail "a non-absolute Bun put the CWD on PATH" ;;
  esac
}

# Sourcing must define the functions and STOP — before the bootstrap and before the exec. Without
# the guard, the harness above (and any future one) would build and then run a bridge.
test_sourced_guard_stops_before_the_exec() {
  setup_case sourced-guard
  install_stub_binary
  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export PATH="${BIN_DIR}:${BASE_PATH}"
source "$SHIM"
type -t resolve_bun
echo "SOURCED-AND-RETURNED"
EOF
  local out; out="$(bash "$harness" 2>&1)" || fail "sourcing the shim failed"
  assert_contains "$out" "function"
  assert_contains "$out" "SOURCED-AND-RETURNED"
  assert_eq "$(cat "$CALLS")" ""
}

test_delegation_passes_argv_and_env
test_delegation_propagates_the_exit_code
test_bootstrap_builds_a_missing_binary
test_bootstrap_failure_names_the_fix
test_bootstrap_without_bun_reports_it
test_bun_resolution
test_non_absolute_bun_never_reaches_path
test_sourced_guard_stops_before_the_exec

echo "✓ collie-ctl shim: argv + env passthrough, exit-code propagation, frozen action verbs"
echo "✓ collie-ctl shim: bootstrap from source, its two failure messages, Bun resolution, sourced guard"
