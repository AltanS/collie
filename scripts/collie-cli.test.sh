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
env -i "$BIN" build >/dev/null 2>"${TMP_ROOT}/err"
rc=$?
set -e
assert_eq "$rc" "1"
assert_contains "$(cat "${TMP_ROOT}/err")" "scripts/collie-ctl.sh build"

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

# ── Lifecycle ────────────────────────────────────────────────────────────────
# Carried over from scripts/collie-ctl.test.sh:312-578 — `start`/`status`/`restart`/`stop` on all
# three supervision tiers, the launchd bootstrap retry, and the front door that must not abort
# `start`. Same technique (fakes on a scratch PATH, throwaway $HOME), one difference: the shell
# suite could `source` the script and redefine `have_launchd`, and a compiled binary cannot be
# monkey-patched — so the tier is pinned with COLLIE_SUPERVISOR instead.
#
# NOT carried over: scripts/collie-ctl.test.sh:580-696 (`test_bun_resolution`,
# `test_non_absolute_bun_never_reaches_path`, `test_missing_bun_still_reports`). Those pin a fix for
# a problem the compiled binary deletes outright — finding Bun with no login shell, and keeping a
# `bun()` from a sourced .env off PATH. There is no interpreter to find and the .env is parsed, not
# sourced (asserted above). What replaces them is this whole file running under `env -i`.

L_HOME="${TMP_ROOT}/lifecycle-home"
L_CONFIG="${TMP_ROOT}/lifecycle-config"
L_BIN="${TMP_ROOT}/lifecycle-bin"
L_CALLS="${TMP_ROOT}/lifecycle-calls"
mkdir -p "$L_HOME" "$L_CONFIG" "$L_BIN"
: > "$L_CALLS"

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
pick_port() {
  local p
  for p in "$@"; do
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  fail "no free port among: $*"
}
PORT="$(pick_port 48787 48887 48987)"
DEAD_PORT="$(pick_port 48788 48888 48988)"
BRIDGE_PORT="$(pick_port 48789 48889 48989)"

# Something has to answer on $PORT or every banner pays the readiness probe's full ~5s budget. The
# probe is a real TCP connect (never a `systemctl is-active` reading), so a bare listener is enough.
bun -e "Bun.serve({ port: ${PORT}, hostname: '127.0.0.1', fetch: () => new Response('ok') })" \
  >/dev/null 2>&1 &
LISTENER_PID=$!
cleanup_lifecycle() {
  kill "$LISTENER_PID" 2>/dev/null || true
  [ -f "${L_CONFIG}/collie.pid" ] && kill "$(cat "${L_CONFIG}/collie.pid")" 2>/dev/null || true
}
trap 'cleanup_lifecycle; cleanup' EXIT
for _ in $(seq 1 40); do port_free "$PORT" || break; sleep 0.1; done
port_free "$PORT" && fail "the readiness listener never came up on ${PORT}"

# systemctl, with the two answers the tier gate and the banner actually read.
cat > "${L_BIN}/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >> "$L_CALLS"
[ "\$2" = "is-active" ] && echo active
exit 0
EOF
cat > "${L_BIN}/launchctl" <<EOF
#!/bin/sh
echo "launchctl \$*" >> "$L_CALLS"
exit 0
EOF
cat > "${L_BIN}/journalctl" <<EOF
#!/bin/sh
echo "journalctl \$*" >> "$L_CALLS"
exit 0
EOF
cat > "${L_BIN}/tailscale" <<EOF
#!/bin/sh
echo "tailscale \$*" >> "$L_CALLS"
[ "\$1" = "status" ] && echo '{"Self":{"DNSName":"host.example."}}'
[ "\$1" = "serve" ] && [ "\$2" = "status" ] && echo 'https://host.example (tailnet only)'
exit 0
EOF
chmod +x "${L_BIN}"/systemctl "${L_BIN}"/launchctl "${L_BIN}"/journalctl "${L_BIN}"/tailscale

cli() {
  : > "$L_CALLS"
  run_stripped HOME="$L_HOME" HERDR_PLUGIN_CONFIG_DIR="$L_CONFIG" PATH="$L_BIN" \
    COLLIE_PORT="$PORT" "$@"
}

# ── systemd: start → status → restart → stop ────────────────────────────────
UNIT_FILE="${L_HOME}/.config/systemd/user/collie.service"

cli "$BIN" start || fail "\`collie start\` failed under env -i: ${STDERR}"
assert_contains "$(cat "$L_CALLS")" "systemctl --user daemon-reload"
assert_contains "$(cat "$L_CALLS")" "systemctl --user enable --now collie"
[ -f "$UNIT_FILE" ] || fail "start wrote no unit"
UNIT="$(cat "$UNIT_FILE")"
# The unit runs the BINARY — this is what takes Bun out of the runtime dependency set.
assert_contains "$UNIT" "ExecStart=${ROOT}/bin/collie _exec-bridge"
assert_contains "$UNIT" "Environment=COLLIE_PLUGIN_ROOT=${ROOT}"
assert_contains "$UNIT" "EnvironmentFile=-${L_CONFIG}/.env"
assert_contains "$UNIT" "StartLimitIntervalSec=0"
case "$UNIT" in *bun*) fail "the generated unit still names an interpreter" ;; esac
# The banner: `start` and `status` render it from one function, so they can never disagree.
assert_contains "$STDOUT" "bridge started (systemd --user: collie)"
assert_contains "$STDOUT" "✓ Collie is running"
assert_contains "$STDOUT" "service   systemd --user (collie) · active"
assert_contains "$STDOUT" "local     http://127.0.0.1:${PORT}"
assert_contains "$STDOUT" "tailnet   https://host.example"
# A front door that won't come up must not abort `start` (scripts/collie-ctl.sh:431-434): `serve` is
# still the shell's (M3/03), so it fails here — and `start` still reached the banner and exited 0.
assert_contains "$STDERR" "the tailnet front door did not come up"

cli "$BIN" status || fail "\`collie status\` failed"
assert_contains "$STDOUT" "✓ Collie is running"
assert_contains "$STDOUT" "serve config:"
assert_contains "$STDOUT" "    https://host.example (tailnet only)"

cli "$BIN" restart || fail "\`collie restart\` failed"
assert_contains "$(cat "$L_CALLS")" "systemctl --user disable --now collie"
assert_contains "$(cat "$L_CALLS")" "systemctl --user enable --now collie"
assert_contains "$STDOUT" "bridge stopped"

cli "$BIN" stop || fail "\`collie stop\` failed"
assert_contains "$(cat "$L_CALLS")" "systemctl --user disable --now collie"
assert_eq "$STDOUT" "bridge stopped"

# Not answering: the banner names the port and points at the logs rather than claiming success.
run_stripped HOME="$L_HOME" HERDR_PLUGIN_CONFIG_DIR="$L_CONFIG" PATH="$L_BIN" \
  COLLIE_PORT="$DEAD_PORT" "$BIN" status || fail "status failed against a dead port"
assert_contains "$STDOUT" "⚠ Collie isn't answering on :${DEAD_PORT} yet"

# ── url and logs ────────────────────────────────────────────────────────────
cli "$BIN" url || fail "\`collie url\` failed"
assert_eq "$STDOUT" "https://host.example"

cli COLLIE_SERVE_MODE=http "$BIN" url || fail "\`collie url\` failed in http mode"
assert_eq "$STDOUT" "http://host.example:${PORT}"

cli "$BIN" logs 7 || fail "\`collie logs\` failed"
assert_contains "$(cat "$L_CALLS")" "journalctl --user -u collie -n 7 --no-pager"

printf 'one\ntwo\nthree\n' > "${L_CONFIG}/collie.log"
cli COLLIE_SUPERVISOR=unsupervised "$BIN" logs 2 || fail "\`collie logs\` failed off systemd"
assert_eq "$STDOUT" "$(printf 'two\nthree')"
rm -f "${L_CONFIG}/collie.log"

# ── launchd ─────────────────────────────────────────────────────────────────
# The plist must never carry a config value: .env is mode 600 and may hold COLLIE_VAPID_PRIVATE
# while launchd refuses a world-writable plist, so the obvious port (EnvironmentVariables from the
# sourced .env) copies a Web Push signing key into a readable file.
cat > "${L_CONFIG}/.env" <<'ENV'
COLLIE_VAPID_PRIVATE=super-secret-signing-key
ENV
PLIST="${L_HOME}/Library/LaunchAgents/herdr.collie.plist"

cli COLLIE_SUPERVISOR=launchd "$BIN" start || fail "\`collie start\` failed on the launchd path"
[ -f "$PLIST" ] || fail "start wrote no LaunchAgent plist"
assert_contains "$(cat "$PLIST")" "<string>${ROOT}/bin/collie</string>"
assert_contains "$(cat "$PLIST")" "<string>_exec-bridge</string>"
case "$(cat "$PLIST")" in
  */bin/bash*) fail "the plist still wraps the daemon in a shell" ;;
  *super-secret-signing-key*) fail "the plist leaked a .env value" ;;
esac
assert_eq "$(stat -c '%a' "$PLIST" 2>/dev/null || stat -f '%A' "$PLIST")" "644"
CALLS="$(cat "$L_CALLS")"
assert_contains "$CALLS" "launchctl bootout gui/$(id -u)/herdr.collie"
assert_contains "$CALLS" "launchctl enable gui/$(id -u)/herdr.collie"
assert_contains "$CALLS" "launchctl bootstrap gui/$(id -u) ${PLIST}"
assert_contains "$STDOUT" "bridge started (launchd: herdr.collie)"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$PLIST" >/dev/null || fail "the generated plist is not a valid property list"
fi

cli COLLIE_SUPERVISOR=launchd "$BIN" stop || fail "\`collie stop\` failed on the launchd path"
CALLS="$(cat "$L_CALLS")"
assert_contains "$CALLS" "launchctl disable gui/$(id -u)/herdr.collie"
assert_contains "$CALLS" "launchctl bootout gui/$(id -u)/herdr.collie"

# `bootout` doesn't wait for teardown and the bridge drains connections, so `restart` (and so
# `update`) can reach `bootstrap` while the old job is still going: EIO. Retry across the window.
# NOTE: these fakes run with the binary's own environment, which under `env -i` is a PATH holding
# nothing but this directory — so they may use shell BUILTINS only. A `$(cat …)` here silently
# yields the empty string and the fake lies about its own state.
install_flaky_launchctl() {
  cat > "${L_BIN}/launchctl" <<EOF
#!/bin/sh
echo "launchctl \$*" >> "$L_CALLS"
[ "\$1" = bootstrap ] || exit 0
n=0
[ -f "${TMP_ROOT}/bootstrap.count" ] && read n < "${TMP_ROOT}/bootstrap.count"
n=\$((n + 1))
echo "\$n" > "${TMP_ROOT}/bootstrap.count"
[ "\$n" -gt $1 ] && exit 0
echo "Bootstrap failed: 5: Input/output error" >&2
exit 5
EOF
  chmod +x "${L_BIN}/launchctl"
  rm -f "${TMP_ROOT}/bootstrap.count"
}

install_flaky_launchctl 1
cli COLLIE_SUPERVISOR=launchd "$BIN" start || fail "start gave up on a transient bootstrap failure"
assert_contains "$STDOUT" "bridge started (launchd: herdr.collie)"
assert_eq "$(grep -c '^launchctl bootstrap ' "$L_CALLS")" "2"

# Permanent: EIO is also how launchd reports "gui/<uid> doesn't exist" — every Mac administered
# purely over SSH. Giving up would take a working host to NO bridge at all, since `stop` already
# killed the unsupervised one on the way in. Degrade instead: warn, keep serving, stay recoverable.
install_flaky_launchctl 99
cli COLLIE_SUPERVISOR=launchd "$BIN" start || fail "a Mac that cannot bootstrap was left with no bridge"
assert_eq "$(grep -c '^launchctl bootstrap ' "$L_CALLS")" "3"
assert_contains "$STDERR" "warn: launchctl bootstrap failed after 3 attempts"
assert_contains "$STDERR" "no console login"
assert_contains "$STDERR" "unsupervised"
case "$STDOUT" in
  *"bridge started (launchd:"*) fail "reported a launchd start after bootstrap failed" ;;
esac
assert_contains "$STDOUT" "unsupervised)"
[ -f "${L_CONFIG}/collie.pid" ] || fail "the unsupervised fallback left no pidfile to stop later"
# The fallback spawns the real binary, which loses the race for $PORT and exits — but the pidfile
# must not outlive it as a live record, and `stop` is what clears it.
cli COLLIE_SUPERVISOR=unsupervised "$BIN" stop || fail "stop failed on the unsupervised tier"
[ ! -e "${L_CONFIG}/collie.pid" ] || fail "stop left the pidfile behind"
rm -f "${L_CONFIG}/.env"

# ── _exec-bridge: the bridge is IN the binary ───────────────────────────────
# The role the supervisor watches. Nothing is spawned — the bridge runs in this process after argv
# dispatch, because launchd watches the pid it started and a wrapper would make KeepAlive guard the
# wrapper while a crashed bridge looked alive. This is also the only end-to-end proof that the whole
# bridge (including its optional `web-push` import) survives `bun build --compile`.
BRIDGE_STATE="${TMP_ROOT}/bridge-state"
mkdir -p "$BRIDGE_STATE"
env -i HOME="$L_HOME" HERDR_PLUGIN_CONFIG_DIR="$L_CONFIG" PATH="$L_BIN" \
  COLLIE_PORT="$BRIDGE_PORT" HERDR_PLUGIN_STATE_DIR="$BRIDGE_STATE" \
  HERDR_SOCKET_PATH="${TMP_ROOT}/absent.sock" \
  "$BIN" _exec-bridge > "${TMP_ROOT}/bridge.out" 2>&1 &
BRIDGE_PID=$!
for _ in $(seq 1 100); do
  port_free "$BRIDGE_PORT" || break
  kill -0 "$BRIDGE_PID" 2>/dev/null || break
  sleep 0.1
done
if port_free "$BRIDGE_PORT"; then
  kill "$BRIDGE_PID" 2>/dev/null || true
  fail "\`collie _exec-bridge\` never listened on ${BRIDGE_PORT}: $(cat "${TMP_ROOT}/bridge.out")"
fi
assert_contains "$(cat "${TMP_ROOT}/bridge.out")" "[bridge] listening on http://127.0.0.1:${BRIDGE_PORT}"
# It is THIS process, not a child: the pid we backgrounded is the one holding the port.
kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
for _ in $(seq 1 50); do port_free "$BRIDGE_PORT" && break; sleep 0.1; done
port_free "$BRIDGE_PORT" || fail "killing the supervised pid left a bridge behind — _exec-bridge spawned a child"

echo "✓ collie CLI: env-stripped invocation, exit codes, version parity, config-dir precedence"
echo "✓ collie CLI lifecycle: systemd + launchd + unsupervised tiers, banner, bootstrap retry, _exec-bridge"
