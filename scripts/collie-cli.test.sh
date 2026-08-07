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
# The real PATH, for the two sections that need genuine `git` / `mkdir` / `bash` alongside the fakes
# (`build` and `update` drive real throwaway git repos and a real filesystem). Everything before them
# runs on a scratch PATH only; the fake directory always comes FIRST, so a fake never loses to a real
# tool of the same name — in particular the fake `bun`, which is what keeps a real build off this host.
BASE_PATH="$PATH"

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

# Every verb is now in the binary, so there is no "not ported yet" exit left to assert. What takes
# its place: a real verb that cannot do its job reports an OPERATIONAL failure (1), never a usage
# error (2). `build` on a tree with no version gate is the cheapest such case — and it proves the
# gate is still `scripts/check-version.sh` read from the checkout, not a second copy compiled in.
set +e
env -i PATH="$BIN_DIR" COLLIE_PLUGIN_ROOT="$EMPTY_ROOT" "$BIN" build >/dev/null 2>"${TMP_ROOT}/err"
rc=$?
set -e
assert_eq "$rc" "1"
assert_contains "$(cat "${TMP_ROOT}/err")" "the version gate failed"

# ── Config dir ───────────────────────────────────────────────────────────────
# A legacy ~/.config/collie/.env that is no longer the resolved dir must say so, or config silently
# stops applying (scripts/collie-ctl.sh:35-39).
: > "$CALLS"   # the exit-code probes above ran with a PATH, so they could reach the fake `herdr`
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
# A front door that won't come up must not abort `start` (scripts/collie-ctl.sh:431-434). This
# lifecycle fake answers `serve status --json` with prose, so the publish gate refuses rather than
# overwriting a root it can't reason about — and `start` still reached the banner and exited 0.
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

# ── The front door ───────────────────────────────────────────────────────────
# `serve` / `unserve` and the tailscale-managed-handler ownership record (ADR 0001): Collie manages
# exactly ONE mapping, records it, and only ever tears down a mapping still matching that record.
# Carried from scripts/collie-ctl.test.sh:102-311 — same technique, against the binary.
#
# SAFETY: `tailscale` here is a fake on a scratch PATH whose whole serve state is a JSON file this
# suite owns. Nothing in this section may reach the real tailnet; `serve` and `unserve` publish and
# tear down a live front door, and this is the deployment host.

FD_HOME="${TMP_ROOT}/frontdoor-home"
FD_CONFIG="${TMP_ROOT}/frontdoor-config"
FD_BIN="${TMP_ROOT}/frontdoor-bin"
FD_CALLS="${TMP_ROOT}/frontdoor-calls"
FD_STATUS="${TMP_ROOT}/frontdoor-serve-status.json"
FD_OFF_FAILS="${TMP_ROOT}/frontdoor-off-fails"
RECORD="${FD_CONFIG}/tailscale-managed-handler"
mkdir -p "$FD_HOME" "$FD_CONFIG" "$FD_BIN"

# A fake `tailscale` whose serve state lives in a JSON file the test can read and rewrite, so any
# ownership situation (ours, someone else's, absent) can be staged and the verdict asserted.
#
# NOTE: like every fake here it runs with the binary's own environment — under `env -i` that is a
# PATH holding nothing but this directory. SHELL BUILTINS ONLY: a `cat` would silently yield the
# empty string and the fake would lie about its own state.
cat > "${FD_BIN}/tailscale" <<EOF
#!/bin/sh
echo "tailscale \$*" >> "$FD_CALLS"
if [ "\$1" = status ] && [ "\$2" = --json ]; then
  echo '{"Self":{"DNSName":"host.example."}}'
  exit 0
fi
if [ "\$1" = serve ] && [ "\$2" = status ] && [ "\$3" = --json ]; then
  while IFS= read -r line; do echo "\$line"; done < "$FD_STATUS"
  exit 0
fi
if [ "\$1" = serve ] && [ "\$2" = --bg ]; then
  listener=443
  protocol=HTTPS
  for arg in "\$@"; do
    target="\$arg"
    case "\$arg" in
      --http=*) listener="\${arg#--http=}"; protocol=HTTP ;;
    esac
  done
  echo "{\"TCP\":{\"\${listener}\":{\"\${protocol}\":true}},\"Web\":{\"host.example:\${listener}\":{\"Handlers\":{\"/\":{\"Proxy\":\"http://127.0.0.1:\${target}\"}}}}}" > "$FD_STATUS"
  exit 0
fi
for arg in "\$@"; do
  [ "\$arg" = off ] || continue
  if [ -f "$FD_OFF_FAILS" ]; then
    echo "tailscale: refused" >&2
    exit 1
  fi
  echo '{}' > "$FD_STATUS"
  exit 0
done
exit 2
EOF
chmod +x "${FD_BIN}/tailscale"
cat > "${FD_BIN}/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >> "$FD_CALLS"
exit 0
EOF
chmod +x "${FD_BIN}/systemctl"

fd() {
  : > "$FD_CALLS"
  run_stripped HOME="$FD_HOME" HERDR_PLUGIN_CONFIG_DIR="$FD_CONFIG" PATH="$FD_BIN" \
    COLLIE_PORT=8787 "$@"
}
status_is() { printf '%s\n' "$1" > "$FD_STATUS"; }
read_status() { tr -d '\n' < "$FD_STATUS"; }

OURS='http://127.0.0.1:8787'
COLLIE_HTTP_ROOT="{\"TCP\":{\"8787\":{\"HTTP\":true}},\"Web\":{\"host.example:8787\":{\"Handlers\":{\"/\":{\"Proxy\":\"${OURS}\"}}}}}"
FOREIGN_ROOT='{"TCP":{"8787":{"HTTP":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7000"}}}}}'

# Publish onto a free root: the mapping is made AND recorded, and `serve` invoked directly says
# where to point a phone.
status_is '{}'
rm -f "$RECORD"
fd COLLIE_SERVE_MODE=http "$BIN" serve || fail "\`collie serve\` failed on a free root: ${STDERR}"
assert_eq "$(cat "$RECORD")" "http:8787|host.example:8787|http://127.0.0.1:8787"
assert_contains "$(cat "$FD_CALLS")" "tailscale serve --bg --http=8787 --set-path=/ 8787"
assert_contains "$STDOUT" "open: http://host.example:8787"

# Publish onto a FOREIGN root: refuse, change nothing, record nothing. `tailscale serve --bg … /`
# silently replaces an existing root handler, so this check is all that stands between a Collie
# start and a stranger's service going dark.
status_is "$FOREIGN_ROOT"
rm -f "$RECORD"
if fd COLLIE_SERVE_MODE=http "$BIN" serve; then
  fail "an unowned root collision was overwritten"
fi
assert_eq "$(read_status)" "$FOREIGN_ROOT"
[ ! -e "$RECORD" ] || fail "a refused publish created ownership state"
assert_contains "$STDERR" "unowned root mount on :8787"

# Publish onto a PRE-EXISTING Collie root: adopt it and record it. Every install predating ownership
# tracking is in exactly this state, so refusing here would brick start/restart/update on upgrade.
status_is "$COLLIE_HTTP_ROOT"
rm -f "$RECORD"
fd COLLIE_SERVE_MODE=http "$BIN" serve || fail "serve refused to adopt Collie's own root mount"
assert_contains "$STDOUT" "adopting the existing Collie root mount on :8787"
assert_eq "$(cat "$RECORD")" "http:8787|host.example:8787|http://127.0.0.1:8787"

# Teardown of a matching root: scoped to the listener and to `/`, never a blanket reset.
fd "$BIN" unserve || fail "\`collie unserve\` failed on a mapping we own"
assert_contains "$(cat "$FD_CALLS")" "tailscale serve --http=8787 --set-path=/ off"
[ ! -e "$RECORD" ] || fail "teardown left the ownership record behind"
assert_contains "$STDOUT" "removed Collie's managed http:8787 mapping"

# No record at all: success, and nothing is touched.
fd "$BIN" unserve || fail "unserve failed with no record"
assert_contains "$STDOUT" "no Collie-managed mapping recorded"

# An ABSENT root clears a stale record — otherwise it would refuse the next publish forever.
printf 'http:8787|host.example:8787|%s\n' "$OURS" > "$RECORD"
status_is '{}'
fd "$BIN" unserve || fail "unserve failed against an absent root"
[ ! -e "$RECORD" ] || fail "a stale record survived an absent root"
assert_contains "$STDOUT" "cleared stale ownership state"

# A REPLACED root is refused and the record RETAINED: removing a handler we no longer own would
# silently unpublish somebody else's service.
printf 'http:8787|host.example:8787|%s\n' "$OURS" > "$RECORD"
status_is "$FOREIGN_ROOT"
if fd "$BIN" unserve; then
  fail "an externally replaced root was removed"
fi
assert_contains "${STDOUT}${STDERR}" "refusing to remove"
assert_eq "$(cat "$RECORD")" "http:8787|host.example:8787|${OURS}"
assert_eq "$(read_status)" "$FOREIGN_ROOT"

# A FAILED removal keeps the record for retry — dropping it would orphan a live mapping with
# nothing left that knows Collie owns it.
status_is "$COLLIE_HTTP_ROOT"
: > "$FD_OFF_FAILS"
if fd "$BIN" unserve; then
  fail "a failed removal reported success"
fi
assert_contains "$STDERR" "retained ${RECORD} for retry"
assert_eq "$(cat "$RECORD")" "http:8787|host.example:8787|${OURS}"
rm -f "$FD_OFF_FAILS"

# COLLIE_SKIP_SERVE=1 (README Variants C/E): the operator owns the ingress, Collie publishes
# NOTHING — but still tears down a mapping published before the flag was flipped, which would
# otherwise stay reachable by a path the operator thinks is closed.
status_is "$COLLIE_HTTP_ROOT"
fd COLLIE_SKIP_SERVE=1 "$BIN" serve || fail "serve failed under COLLIE_SKIP_SERVE=1"
assert_contains "$STDOUT" "tailscale serve skipped (COLLIE_SKIP_SERVE=1)"
assert_contains "$STDOUT" "bridge is on 127.0.0.1:8787 only"
[ ! -e "$RECORD" ] || fail "the skipped front door left ownership state behind"
assert_eq "$(read_status)" "{}"
case "$(cat "$FD_CALLS")" in
  *" --bg "*) fail "COLLIE_SKIP_SERVE=1 published a mapping" ;;
esac

# ── uninstall ────────────────────────────────────────────────────────────────
# The inverse of `start`, and no more: stop + disable, remove the service definition, remove
# Collie's own mapping, drop the pidfile — and KEEP .env and the checkout.
FD_UNIT="${FD_HOME}/.config/systemd/user/collie.service"
mkdir -p "${FD_HOME}/.config/systemd/user"
printf '[Unit]\n' > "$FD_UNIT"
printf 'COLLIE_PORT=8787\n' > "${FD_CONFIG}/.env"
printf '4242\n' > "${FD_CONFIG}/collie.pid"
status_is "$COLLIE_HTTP_ROOT"
printf 'http:8787|host.example:8787|%s\n' "$OURS" > "$RECORD"

fd COLLIE_SUPERVISOR=systemd "$BIN" uninstall || fail "\`collie uninstall\` failed: ${STDERR}"
CALLS="$(cat "$FD_CALLS")"
assert_contains "$CALLS" "systemctl --user disable --now collie"
assert_contains "$CALLS" "systemctl --user daemon-reload"
assert_contains "$CALLS" "systemctl --user reset-failed collie"
assert_contains "$CALLS" "tailscale serve --http=8787 --set-path=/ off"
[ ! -e "$FD_UNIT" ] || fail "uninstall left the unit file behind"
[ ! -e "${FD_CONFIG}/collie.pid" ] || fail "uninstall left the pidfile behind"
[ ! -e "$RECORD" ] || fail "uninstall left the ownership record behind"
assert_eq "$(read_status)" "{}"
# The two things uninstall deliberately keeps.
[ -f "${FD_CONFIG}/.env" ] || fail "uninstall deleted the operator's .env"
[ -f "${ROOT}/herdr-plugin.toml" ] || fail "uninstall touched the checkout"
assert_contains "$STDOUT" "✓ uninstalled:"
assert_contains "$STDOUT" "kept: ${FD_CONFIG}/.env and the checkout"

# A teardown it cannot justify ABORTS the uninstall: reporting a clean uninstall over a front door
# that is still published would be a lie.
printf '[Unit]\n' > "$FD_UNIT"
printf 'http:8787|host.example:8787|%s\n' "$OURS" > "$RECORD"
status_is "$FOREIGN_ROOT"
if fd COLLIE_SUPERVISOR=systemd "$BIN" uninstall; then
  fail "uninstall carried on over a front door it refused to tear down"
fi
assert_contains "${STDOUT}${STDERR}" "refusing to remove"
[ -f "$FD_UNIT" ] || fail "an aborted uninstall still removed the unit"
case "$STDOUT" in
  *"✓ uninstalled"*) fail "an aborted uninstall reported success" ;;
esac

# ── build ────────────────────────────────────────────────────────────────────
# The five ordered steps, and the invariant they exist for: a build that fails leaves the previously
# served `web/dist` byte-identical, because the swap is a same-filesystem rename performed LAST.
#
# SAFETY: `bun` here is a FAKE on a scratch PATH, and the checkout is a throwaway tree under $TMP_ROOT
# addressed with COLLIE_PLUGIN_ROOT. Nothing in this section may build, typecheck or install anything
# in the real checkout — this is the deployment host, and its `web/dist` is served from disk at
# request time.

B_ROOT="${TMP_ROOT}/build-checkout"
B_BIN="${TMP_ROOT}/build-bin"
B_CONFIG="${TMP_ROOT}/build-config"
B_CALLS="${TMP_ROOT}/build-calls"
B_FAIL="${TMP_ROOT}/build-fail"          # present → the fake `bun run build` fails
B_GATE_FAIL="${TMP_ROOT}/build-gate-fail" # present → the fake version gate fails
mkdir -p "${B_ROOT}/web/dist/assets" "${B_ROOT}/scripts" "${B_ROOT}/bin" "$B_BIN" "$B_CONFIG"
printf 'id = "herdr.collie"\nversion = "9.9.9"\n' > "${B_ROOT}/herdr-plugin.toml"
printf 'LIVE BUNDLE\n' > "${B_ROOT}/web/dist/index.html"
printf 'LIVE ASSET\n' > "${B_ROOT}/web/dist/assets/app.js"
printf 'OLD BINARY\n' > "${B_ROOT}/bin/collie"

# The version gate is NOT reimplemented in the CLI — it is still `scripts/check-version.sh`, invoked
# from the checkout. So the fake checkout carries a fake one, and this proves the CLI runs whatever
# script is there rather than a second copy of the rule.
cat > "${B_ROOT}/scripts/check-version.sh" <<EOF
#!/bin/sh
echo "gate" >> "$B_CALLS"
[ -f "$B_GATE_FAIL" ] && exit 1
echo "✓ version 9.9.9 consistent across manifest, package.json, web/package.json, CHANGELOG"
exit 0
EOF
chmod +x "${B_ROOT}/scripts/check-version.sh"

# The fake Bun: records every invocation WITH ITS WORKING DIRECTORY (the cwd is the difference
# between installing the root tree and installing web/), and produces the artifacts the real one
# would, so the swap has something to swap.
cat > "${B_BIN}/bun" <<EOF
#!/bin/sh
echo "\${PWD}\\\$ bun \$*" >> "$B_CALLS"
case "\$1 \$2" in
  "build --compile")
    for a in "\$@"; do
      [ "\$prev" = --outfile ] && printf 'NEW BINARY\n' > "\$a" && chmod +x "\$a"
      prev="\$a"
    done
    exit 0 ;;
  "run build")
    [ -f "$B_FAIL" ] && { echo "vite: build failed" >&2; exit 1; }
    mkdir -p dist-staging/assets
    printf 'NEW BUNDLE\n' > dist-staging/index.html
    printf 'NEW ASSET\n' > dist-staging/assets/app.js
    exit 0 ;;
esac
exit 0
EOF
chmod +x "${B_BIN}/bun"

bld() {
  : > "$B_CALLS"
  run_stripped HOME="$HOME_DIR" HERDR_PLUGIN_CONFIG_DIR="$B_CONFIG" PATH="${B_BIN}:${BASE_PATH}" \
    COLLIE_PLUGIN_ROOT="$B_ROOT" "$@"
}

# The happy path: five steps, in order, each in the right tree.
bld "$BIN" build || fail "\`collie build\` failed: ${STDERR}"
assert_eq "$(cat "$B_CALLS")" "$(cat <<EOF
gate
${B_ROOT}\$ bun install
${B_ROOT}/web\$ bun install
${B_ROOT}\$ bun run typecheck
${B_ROOT}/web\$ bun run typecheck
${B_ROOT}\$ bun build --compile --target=bun ./cli/main.ts --outfile ${B_ROOT}/bin/collie.new
${B_ROOT}/web\$ bun run build -- --outDir dist-staging --emptyOutDir
EOF
)"
# Both artifacts were swapped in, and the staging paths are gone.
assert_eq "$(cat "${B_ROOT}/web/dist/index.html")" "NEW BUNDLE"
assert_eq "$(cat "${B_ROOT}/bin/collie")" "NEW BINARY"
[ ! -e "${B_ROOT}/web/dist-staging" ] || fail "build left the staging directory behind"
[ ! -e "${B_ROOT}/bin/collie.new" ] || fail "build left the staged binary behind"

# The binary is REPLACED BY RENAME, never written in place: a Bun single-file executable carries its
# payload inside the file and the supervised daemon may be executing it, so the old inode has to
# survive the swap. An open file descriptor still reading the old bytes is the proof.
printf 'INODE UNDER TEST\n' > "${B_ROOT}/bin/collie"
exec 9< "${B_ROOT}/bin/collie"
bld "$BIN" build || fail "second \`collie build\` failed: ${STDERR}"
assert_eq "$(cat <&9)" "INODE UNDER TEST"
exec 9<&-
assert_eq "$(cat "${B_ROOT}/bin/collie")" "NEW BINARY"

# A failed web build changes NOTHING: same served bundle, same binary, no staging leftovers.
printf 'LIVE BUNDLE\n' > "${B_ROOT}/web/dist/index.html"
printf 'LIVE ASSET\n' > "${B_ROOT}/web/dist/assets/app.js"
printf 'OLD BINARY\n' > "${B_ROOT}/bin/collie"
: > "$B_FAIL"
if bld "$BIN" build; then fail "a failed web build reported success"; fi
assert_contains "$STDERR" "building the web UI failed"
assert_eq "$(cat "${B_ROOT}/web/dist/index.html")" "LIVE BUNDLE"
assert_eq "$(cat "${B_ROOT}/web/dist/assets/app.js")" "LIVE ASSET"
assert_eq "$(cat "${B_ROOT}/bin/collie")" "OLD BINARY"
[ ! -e "${B_ROOT}/bin/collie.new" ] || fail "a failed build left a half-compiled binary in place"
rm -f "$B_FAIL"

# The version gate is a gate: it fails, and nothing after it runs.
: > "$B_GATE_FAIL"
if bld "$BIN" build; then fail "build ran with an inconsistent version"; fi
assert_eq "$(cat "$B_CALLS")" "gate"
assert_eq "$(cat "${B_ROOT}/web/dist/index.html")" "LIVE BUNDLE"
# … and SKIP_VERSION_CHECK=1 is the documented escape hatch, spelled exactly as it always was.
bld SKIP_VERSION_CHECK=1 SKIP_TYPECHECK=1 "$BIN" build || fail "the escape hatches stopped working"
case "$(cat "$B_CALLS")" in
  *gate*) fail "SKIP_VERSION_CHECK=1 still ran the version gate" ;;
  *typecheck*) fail "SKIP_TYPECHECK=1 still typechecked" ;;
esac
rm -f "$B_GATE_FAIL"

# ── update ───────────────────────────────────────────────────────────────────
# Both checkout shapes, against REAL throwaway git repos — carried from
# scripts/collie-ctl.test.sh:698-780. ADR 0006: `herdr plugin install` leaves a detached, shallow
# checkout with no branch, while a linked clone sits on one, and ONE predicate
# (`git symbolic-ref -q HEAD`) picks the strategy AND gates the re-link.
#
# SAFETY: every repo here is created under $TMP_ROOT and thrown away; `bun` is still the fake, so the
# post-pull half never builds anything real. `update` MUTATES A CHECKOUT — it may only ever see one
# of these.

U_DIR="${TMP_ROOT}/update"
U_BIN="${TMP_ROOT}/update-bin"
U_CALLS="${TMP_ROOT}/update-calls"
U_HERDR="${TMP_ROOT}/update-herdr-calls"
ORIGIN="${U_DIR}/origin"
mkdir -p "$U_DIR" "$U_BIN"

git_q() { git -c init.defaultBranch=main -c user.email=t@t -c user.name=t -c commit.gpgsign=false "$@"; }

# An upstream with two commits: the release the checkout is on, and the one it must advance to.
mkdir -p "$ORIGIN"
git_q -C "$ORIGIN" init -q
printf 'v1\n' > "${ORIGIN}/VERSION"
printf 'lock-v1\n' > "${ORIGIN}/bun.lock"
printf 'id = "herdr.collie"\nversion = "9.9.9"\n' > "${ORIGIN}/herdr-plugin.toml"
# Enough of a Collie tree for the post-pull half to run against: the version gate the CLI invokes
# from the checkout (never a copy compiled into the binary), and the `web/` tree it builds in.
mkdir -p "${ORIGIN}/scripts" "${ORIGIN}/web"
printf '#!/bin/sh\necho "✓ version 9.9.9 consistent across manifest, package.json, web/package.json, CHANGELOG"\n' \
  > "${ORIGIN}/scripts/check-version.sh"
chmod +x "${ORIGIN}/scripts/check-version.sh"
printf '{"name":"web","version":"9.9.9"}\n' > "${ORIGIN}/web/package.json"
git_q -C "$ORIGIN" add -A
git_q -C "$ORIGIN" commit -q -m "first"
advance_origin() {
  printf 'v2\n' > "${ORIGIN}/VERSION"
  git_q -C "$ORIGIN" add -A
  git_q -C "$ORIGIN" commit -q -m "second"
}

# The fake Bun for this section records the `_apply-update` handoff — the ONE thing `update` does
# after advancing the checkout — and otherwise behaves like the build fake.
cat > "${U_BIN}/bun" <<EOF
#!/bin/sh
echo "\${PWD}\\\$ bun \$*" >> "$U_CALLS"
case "\$1 \$2" in
  "build --compile")
    for a in "\$@"; do
      [ "\$prev" = --outfile ] && printf 'NEW BINARY\n' > "\$a" && chmod +x "\$a"
      prev="\$a"
    done
    exit 0 ;;
  "run build")
    mkdir -p dist-staging
    printf 'NEW BUNDLE\n' > dist-staging/index.html
    exit 0 ;;
esac
exit 0
EOF
chmod +x "${U_BIN}/bun"
cat > "${U_BIN}/herdr" <<EOF
#!/bin/sh
echo "\$*" >> "$U_HERDR"
exit 0
EOF
cat > "${U_BIN}/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >> "$U_CALLS"
[ "\$2" = "is-active" ] && echo active
exit 0
EOF
cat > "${U_BIN}/tailscale" <<EOF
#!/bin/sh
echo "tailscale \$*" >> "$U_CALLS"
[ "\$1" = "status" ] && echo '{"Self":{"DNSName":"host.example."}}'
exit 0
EOF
chmod +x "${U_BIN}/herdr" "${U_BIN}/systemctl" "${U_BIN}/tailscale"

upd() {
  local root="$1"; shift
  : > "$U_CALLS"
  run_stripped HOME="${TMP_ROOT}/update-home" HERDR_PLUGIN_CONFIG_DIR="${TMP_ROOT}/update-config" \
    PATH="${U_BIN}:${BASE_PATH}" COLLIE_PORT="$PORT" COLLIE_PLUGIN_ROOT="$root" "$@"
}

# Shape 1 — the Herdr-managed checkout, created verbatim the way herdr's plugin_install does.
MANAGED="${U_DIR}/managed"
mkdir -p "$MANAGED"
git_q -C "$MANAGED" init -q
git_q -C "$MANAGED" remote add origin "$ORIGIN"
git_q -C "$MANAGED" fetch -q --depth 1 origin HEAD
git_q -C "$MANAGED" checkout -q --detach FETCH_HEAD
advance_origin
# `bun install` can rewrite the TRACKED lockfile; a plain checkout would refuse on the dirty tree and
# re-break update permanently, which is why the detach is `--force`.
printf 'rewritten-by-bun-install\n' > "${MANAGED}/bun.lock"

upd "$MANAGED" "$BIN" update || fail "\`collie update\` failed on a managed checkout: ${STDERR}"
assert_contains "$STDOUT" "Herdr-managed checkout"
assert_contains "$STDOUT" "→ now at"
assert_eq "$(git -C "$MANAGED" rev-parse HEAD)" "$(git -C "$ORIGIN" rev-parse HEAD)"
assert_eq "$(cat "${MANAGED}/VERSION")" "v2"
assert_eq "$(cat "${MANAGED}/bun.lock")" "lock-v1"          # --force discarded the build's rewrite
assert_eq "$(git -C "$MANAGED" rev-parse --is-shallow-repository)" "true"
git -C "$MANAGED" symbolic-ref -q HEAD >/dev/null 2>&1 &&
  fail "the managed checkout should still be detached"
# The post-pull half runs the code that was just fetched, not the code that started the update.
assert_contains "$(cat "$U_CALLS")" "${MANAGED}\$ bun ${MANAGED}/cli/main.ts _apply-update"
# Idempotent: a second update with nothing new upstream is a no-op, not an error.
upd "$MANAGED" "$BIN" update || fail "a second \`collie update\` failed"

# Shape 2 — a dev clone linked with `herdr plugin link`. On a branch, so it fast-forwards, keeps its
# branch, and keeps its FULL history (no --depth truncation).
CLONE="${U_DIR}/clone"
git_q clone -q "$ORIGIN" "$CLONE"
git_q -C "$ORIGIN" commit -q --allow-empty -m "third"
upd "$CLONE" "$BIN" update || fail "\`collie update\` failed on a linked clone: ${STDERR}"
assert_contains "$STDOUT" "git pull --ff-only"
assert_eq "$(git -C "$CLONE" rev-parse HEAD)" "$(git -C "$ORIGIN" rev-parse HEAD)"
assert_eq "$(git -C "$CLONE" symbolic-ref --short HEAD)" "main"
assert_eq "$(git -C "$CLONE" rev-list --count HEAD)" "3"
assert_eq "$(git -C "$CLONE" rev-parse --is-shallow-repository)" "false"

# Shape 3 — not a git checkout at all (a copied tree). It must name the reinstall command rather than
# emit a raw git error about a missing origin, and it must not reach the rebuild.
PLAIN="${U_DIR}/plain"
mkdir -p "$PLAIN"
printf 'id = "herdr.collie"\nversion = "9.9.9"\n' > "${PLAIN}/herdr-plugin.toml"
if upd "$PLAIN" "$BIN" update; then fail "update on a non-git tree reported success"; fi
assert_contains "$STDERR" "herdr plugin install AltanS/collie --yes"
case "$(cat "$U_CALLS")" in
  *_apply-update*) fail "a checkout that could not advance still tried to rebuild" ;;
esac

# ── _apply-update ────────────────────────────────────────────────────────────
# The second half, run from the freshly fetched code: build → restart → refresh the registry.
: > "$U_HERDR"
upd "$MANAGED" "$BIN" _apply-update || fail "\`collie _apply-update\` failed: ${STDERR}"
assert_contains "$STDOUT" "✓ update complete"
assert_contains "$(cat "$U_CALLS")" "systemctl --user enable --now collie"
# The rebuilt artifacts are in place: the binary the restarted unit will execute, and the bundle the
# bridge serves from disk.
assert_eq "$(cat "${MANAGED}/bin/collie")" "NEW BINARY"
assert_eq "$(cat "${MANAGED}/web/dist/index.html")" "NEW BUNDLE"
# NEVER re-link a managed checkout: `plugin link` re-registers it as source.kind=local, after which
# Herdr REFUSES `plugin install` — the operator's only other way to refresh (ADR 0006).
assert_contains "$STDOUT" "registry left alone"
[ ! -s "$U_HERDR" ] || fail "re-linked a Herdr-managed checkout (would block \`herdr plugin install\`)"

# The linked clone is the shape where the re-link is safe, and still useful.
: > "$U_HERDR"
upd "$CLONE" "$BIN" _apply-update || fail "\`collie _apply-update\` failed on a linked clone: ${STDERR}"
assert_contains "$STDOUT" "herdr registry refreshed (re-linked)"
assert_contains "$(cat "$U_HERDR")" "plugin link ${CLONE}"

echo "✓ collie CLI: env-stripped invocation, exit codes, version parity, config-dir precedence"
echo "✓ collie CLI lifecycle: systemd + launchd + unsupervised tiers, banner, bootstrap retry, _exec-bridge"
echo "✓ collie CLI front door: ownership record, both refusal directions, adoption, COLLIE_SKIP_SERVE, uninstall"
echo "✓ collie CLI build: five ordered steps, rename-not-rewrite, a failed build leaves web/dist untouched"
echo "✓ collie CLI update: both checkout shapes on real repos, the post-pull re-exec, the managed re-link refusal"
