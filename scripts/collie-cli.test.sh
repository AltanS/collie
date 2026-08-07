#!/usr/bin/env bash
# Robustness tests for the compiled `collie` binary — the ones that cannot be written in `bun test`,
# because what they check is the ABSENCE of an environment.
#
# Herdr spawns plugin actions with no login shell: no PATH worth the name, no HOME exported, nothing
# sourced. `update` once pulled a new commit and then failed its build across four invocations for
# exactly that reason (scripts/collie-ctl.sh:52-81), and every version string reported the new
# release while the served bundle stayed behind. So "runs under `env -i`" is the binary's primary
# contract, and it is asserted here rather than asserted in prose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${ROOT}/bin/collie"
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

# ── Build ────────────────────────────────────────────────────────────────────
# Built here rather than assumed, so the suite tests the binary that matches the tree it is run in.
( cd "$ROOT" && bun run --silent build:cli >/dev/null ) || fail "bun run build:cli failed"
[ -x "$BIN" ] || fail "bun run build:cli produced no executable at bin/collie"

# `bin/` must stay out of the repo — a 95 MB artifact is built from the checkout, never committed.
if command -v git >/dev/null && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" check-ignore -q "$BIN" || fail "bin/collie is not git-ignored"
fi

# ── Sandbox ──────────────────────────────────────────────────────────────────
HOME_DIR="${TMP_ROOT}/home"
CONFIG_DIR="${TMP_ROOT}/config"
BIN_DIR="${TMP_ROOT}/bin"
CALLS="${TMP_ROOT}/calls"
mkdir -p "$HOME_DIR" "$CONFIG_DIR" "$BIN_DIR"

# Fakes for every external tool the CLI will ever reach for, on a scratch PATH, each recording its
# argv. Nothing in this suite may touch the developer's real service, tailnet or checkout.
for tool in git systemctl tailscale journalctl herdr launchctl; do
  cat > "${BIN_DIR}/${tool}" <<EOF
#!/bin/sh
echo "${tool} \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "${BIN_DIR}/${tool}"
done
: > "$CALLS"

# Run the binary with NO inherited environment, plus only the vars named as arguments.
# `env -i` is the point: if any of this needed PATH, it would fail here.
run_stripped() {
  local out rc=0
  set +e
  out="$(env -i "$@" 2>"${TMP_ROOT}/stderr")"
  rc=$?
  set -e
  STDOUT="$out"
  STDERR="$(cat "${TMP_ROOT}/stderr")"
  return "$rc"
}

# ── Negative control ─────────────────────────────────────────────────────────
# A compiled binary that IS PATH-dependent, built and invoked exactly as `collie` is. It must fail
# under this harness — otherwise `env -i` is not really stripping anything and every assertion below
# would pass for the wrong reason.
cat > "${TMP_ROOT}/path-dependent.ts" <<'EOF'
const path = process.env.PATH;
if (!path) {
  console.error("no PATH");
  process.exit(1);
}
console.log(path);
EOF
( cd "$ROOT" && bun build --compile --target=bun "${TMP_ROOT}/path-dependent.ts" \
    --outfile "${TMP_ROOT}/path-dependent" >/dev/null ) || fail "could not build the negative control"
if run_stripped "${TMP_ROOT}/path-dependent"; then
  fail "negative control passed under env -i — the harness is not stripping the environment"
fi
assert_contains "$STDERR" "no PATH"

# ── version ──────────────────────────────────────────────────────────────────
# The one verb ported in the skeleton, and the one that proves the checkout root was resolved
# without `import.meta.dir` — under --compile that would point into the embedded bundle instead.
run_stripped "$BIN" version || fail "\`collie version\` failed under env -i (rc=$?)"
[ -n "$STDOUT" ] || fail "\`collie version\` printed nothing"
assert_eq "$(printf '%s\n' "$STDOUT" | wc -l | tr -d ' ')" "1"

# Parity with the shell it replaces. A different answer here means the two entry points disagree
# about what is running — the class of bug the config-dir precedence comment records.
assert_eq "$STDOUT" "$(bash "${ROOT}/scripts/collie-ctl.sh" version)"

# COLLIE_PLUGIN_ROOT is the explicit escape hatch for a binary outside its checkout — and the way
# this suite exercises the manifest/unknown fallbacks without a real build.
FAKE_ROOT="${TMP_ROOT}/fake-checkout"
mkdir -p "${FAKE_ROOT}/web/dist"
printf 'id = "herdr.collie"\nversion = "9.9.9"\n' > "${FAKE_ROOT}/herdr-plugin.toml"
run_stripped COLLIE_PLUGIN_ROOT="$FAKE_ROOT" "$BIN" version || fail "version failed on a fake root"
assert_eq "$STDOUT" "9.9.9 (manifest; web not built)"

printf '{"id":"x","version":"9.9.9","sha":"deadbee"}\n' > "${FAKE_ROOT}/web/dist/build-info.json"
run_stripped COLLIE_PLUGIN_ROOT="$FAKE_ROOT" "$BIN" version || fail "version failed on a built root"
assert_eq "$STDOUT" "9.9.9+deadbee"

EMPTY_ROOT="${TMP_ROOT}/empty"
mkdir -p "$EMPTY_ROOT"
run_stripped COLLIE_PLUGIN_ROOT="$EMPTY_ROOT" "$BIN" version || fail "version failed on an empty root"
assert_eq "$STDOUT" "unknown"

# ── Exit codes ───────────────────────────────────────────────────────────────
set +e
env -i "$BIN" nonsense >"${TMP_ROOT}/out" 2>"${TMP_ROOT}/err"
rc=$?
set -e
assert_eq "$rc" "2"
assert_eq "$(cat "${TMP_ROOT}/out")" ""
assert_contains "$(cat "${TMP_ROOT}/err")" "usage: collie {"
assert_contains "$(cat "${TMP_ROOT}/err")" "unknown command \`nonsense\`"

set +e
env -i "$BIN" >/dev/null 2>"${TMP_ROOT}/err"
rc=$?
set -e
assert_eq "$rc" "2"

set +e
env -i "$BIN" --help >"${TMP_ROOT}/out" 2>&1
rc=$?
set -e
assert_eq "$rc" "0"
for verb in start stop restart uninstall update build serve unserve status url version push-test logs; do
  assert_contains "$(cat "${TMP_ROOT}/out")" "$verb"
done

# A verb the shell still owns is an operational failure (1), not a usage error (2) — it is a real
# verb, it just is not here yet.
set +e
env -i "$BIN" start >/dev/null 2>"${TMP_ROOT}/err"
rc=$?
set -e
assert_eq "$rc" "1"
assert_contains "$(cat "${TMP_ROOT}/err")" "scripts/collie-ctl.sh start"

# ── Config dir ───────────────────────────────────────────────────────────────
# A legacy ~/.config/collie/.env that is no longer the resolved dir must say so, or config silently
# stops applying (scripts/collie-ctl.sh:35-39).
mkdir -p "${HOME_DIR}/.config/collie"
printf 'COLLIE_PORT=9999\n' > "${HOME_DIR}/.config/collie/.env"
run_stripped HOME="$HOME_DIR" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" PATH="$BIN_DIR" "$BIN" version \
  || fail "version failed with a sandboxed config dir"
assert_contains "$STDERR" "ignoring legacy ${HOME_DIR}/.config/collie/.env"

# With the config dir injected, Herdr is never asked — and no verb in the skeleton shells out at all.
assert_eq "$(cat "$CALLS")" ""

# ── The .env is parsed, never executed ───────────────────────────────────────
# The shell had to `source` it, so a `bun()` defined in there shadowed the real binary and poisoned
# every later lookup (scripts/collie-ctl.sh:83-97). Parsing removes the hazard; prove it.
cat > "${CONFIG_DIR}/.env" <<EOF
COLLIE_PORT=9999
bun() { touch "${TMP_ROOT}/PWNED"; }
EOF
run_stripped HOME="$HOME_DIR" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" "$BIN" version \
  || fail "version failed with a hostile .env"
if [ -f "${TMP_ROOT}/PWNED" ]; then fail ".env was executed, not parsed"; fi

echo "✓ collie CLI: env-stripped invocation, exit codes, version parity, config-dir precedence"
