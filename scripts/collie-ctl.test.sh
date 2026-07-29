#!/usr/bin/env bash
# Lifecycle tests for scripts/collie-ctl.sh — the first coverage the control script has ever had.
# Everything the script shells out to (tailscale, systemctl) is faked on a scratch PATH, with a
# throwaway $HOME and config dir, so these run anywhere and touch nothing real.
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
    *) fail "expected output to contain '$2'" ;;
  esac
}

setup_case() {
  CASE_DIR="${TMP_ROOT}/$1"
  HOME_DIR="${CASE_DIR}/home"
  CONFIG_DIR="${CASE_DIR}/config"
  BIN_DIR="${CASE_DIR}/bin"
  mkdir -p "$HOME_DIR" "$CONFIG_DIR" "$BIN_DIR"
  cat > "${BIN_DIR}/systemctl" <<'EOF'
#!/bin/sh
exit 1
EOF
  chmod +x "${BIN_DIR}/systemctl"
}

run_ctl() {
  HOME="$HOME_DIR" \
  HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" \
  PATH="${BIN_DIR}:${BASE_PATH}" \
  bash "$CTL" "$@"
}

# A fake `tailscale` whose serve state lives in a JSON file the test can read and rewrite — so a test
# can stage any ownership situation (ours, someone else's, absent) and assert what the script did.
install_fake_tailscale() {
  TS_STATUS="${CASE_DIR}/tailscale-status.json"
  printf '{}\n' > "$TS_STATUS"
  cat > "${BIN_DIR}/tailscale" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = status ] && [ "\${2:-}" = --json ]; then
  echo '{"Self":{"DNSName":"host.example."}}'
  exit 0
fi
if [ "\${1:-}" = serve ] && [ "\${2:-}" = status ] && [ "\${3:-}" = --json ]; then
  cat "$TS_STATUS"
  exit 0
fi
if [ "\${1:-}" = serve ] && [[ " \$* " == *" --bg "* ]]; then
  target="\${!#}"
  listener=443
  protocol=HTTPS
  for arg in "\$@"; do
    case "\$arg" in
      --http=*) listener="\${arg#--http=}"; protocol=HTTP ;;
    esac
  done
  cat > "$TS_STATUS" <<JSON
{"TCP":{"\${listener}":{"\${protocol}":true}},"Web":{"host.example:\${listener}":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:\${target}"}}}}}
JSON
  exit 0
fi
if [ "\${1:-}" = serve ] && [[ " \$* " == *" off "* ]]; then
  printf '{}\n' > "$TS_STATUS"
  exit 0
fi
exit 2
EOF
  chmod +x "${BIN_DIR}/tailscale"
}

# Publishing must move cleanly between ports and modes, and must never clobber a root mount Collie
# didn't create.
test_tailscale_cutovers_and_collisions() {
  setup_case tailscale
  install_fake_tailscale

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF
  run_ctl serve > "${CASE_DIR}/start-8787.out"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" \
    'http:8787|host.example:8787|http://127.0.0.1:8787'

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=http
COLLIE_PORT=9999
EOF
  run_ctl serve > "${CASE_DIR}/start-9999.out"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" \
    'http:9999|host.example:9999|http://127.0.0.1:9999'

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SKIP_SERVE=1
COLLIE_PORT=9999
EOF
  run_ctl serve > "${CASE_DIR}/to-proxy.out"
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "Tailscale ownership survived proxy cutover"
  assert_eq "$(cat "$TS_STATUS")" '{}'

  collision='{"TCP":{"8787":{"HTTP":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7000"}}}}}'
  printf '%s\n' "$collision" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/collision.out" 2>&1; then
    fail "unowned Tailscale root collision was overwritten"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$collision"
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "collision created ownership state"

  opposite_https='{"TCP":{"8787":{"HTTPS":true}},"Web":{"host.example:8787":{"Handlers":{"/other":{"Proxy":"http://127.0.0.1:7002"}}}}}'
  printf '%s\n' "$opposite_https" > "$TS_STATUS"
  if run_ctl serve > "${CASE_DIR}/opposite-https.out" 2>&1; then
    fail "HTTP publication replaced an unrelated HTTPS sibling listener"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$opposite_https"

  opposite_http='{"TCP":{"443":{"HTTP":true}},"Web":{"host.example:443":{"Handlers":{"/other":{"Proxy":"http://127.0.0.1:7003"}}}}}'
  printf '%s\n' "$opposite_http" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=https
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/opposite-http.out" 2>&1; then
    fail "HTTPS publication replaced an unrelated HTTP sibling listener"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$opposite_http"
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "protocol mismatch created ownership state"

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF

  # Once we own a root, someone replacing it out from under us must stop teardown cold: removing a
  # handler we no longer own would unpublish a service that isn't ours.
  printf '{}\n' > "$TS_STATUS"
  run_ctl serve > "${CASE_DIR}/owned.out"
  owned_state="$(cat "${CONFIG_DIR}/tailscale-managed-handler")"
  protocol_replacement='{"TCP":{"8787":{"HTTPS":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}'
  printf '%s\n' "$protocol_replacement" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SKIP_SERVE=1
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/protocol-replacement.out" 2>&1; then
    fail "protocol-only Tailscale root replacement was removed"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$protocol_replacement"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" "$owned_state"
  replacement='{"TCP":{"8787":{"HTTP":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7001"}}}}}'
  printf '%s\n' "$replacement" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SKIP_SERVE=1
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/replacement.out" 2>&1; then
    fail "externally replaced Tailscale root was removed"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$replacement"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" "$owned_state"
}

test_missing_tailscale_cli() {
  setup_case tailscale-missing
  ln -s "$(command -v dirname)" "${BIN_DIR}/dirname"
  ln -s "$(command -v tr)" "${BIN_DIR}/tr"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_PORT=8787
EOF

  set +e
  HOME="$HOME_DIR" \
  HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" \
  PATH="$BIN_DIR" \
  /bin/bash "$CTL" serve > "${CASE_DIR}/missing.out" 2>&1
  rc=$?
  set -e

  [ "$rc" -ne 0 ] || fail "missing Tailscale CLI reported success"
  output="$(cat "${CASE_DIR}/missing.out")"
  assert_contains "$output" 'tailscale not found'
  case "$output" in
    *"open:"*) fail "missing Tailscale CLI printed an open URL" ;;
  esac
}

# If the ownership record can't be deleted, teardown must report failure and KEEP the record —
# dropping it would orphan a live mapping with nothing left that knows Collie owns it.
test_state_delete_failures() {
  setup_case state-delete-failures
  cat > "${BIN_DIR}/tailscale" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "${BIN_DIR}/tailscale"

  local tailscale_state="${CONFIG_DIR}/tailscale-managed-handler"
  printf 'http:8787|host.example:8787|http://127.0.0.1:8787\n' > "$tailscale_state"

  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR"
export PATH="$BIN_DIR:$BASE_PATH"
source "$CTL"
have_systemd() { return 1; }
TAILSCALE_HANDLER_FILE="$tailscale_state"
rm() { return 1; }

tailscale_root_fingerprint() { echo absent; }
if stop_tailscale_serve; then
  exit 91
fi
[ -f "$tailscale_state" ] || exit 92

tailscale_root_fingerprint() { echo 'http|proxy:http://127.0.0.1:8787'; }
remove_tailscale_handler() { return 0; }
if stop_tailscale_serve; then
  exit 93
fi
[ -f "$tailscale_state" ] || exit 94
EOF

  bash "$harness" > "${CASE_DIR}/delete-failure.out" 2>&1
}

# An install that predates ownership tracking has Collie's OWN root mount and no record of it.
# Publishing must adopt that mount, not refuse it — refusing breaks start/restart/update on every
# deployment that upgrades into this feature.
test_adopts_preexisting_collie_mount() {
  setup_case adopt-preexisting
  install_fake_tailscale

  local preexisting='{"TCP":{"8787":{"HTTP":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}'
  printf '%s\n' "$preexisting" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "fixture already had ownership state"

  run_ctl serve > "${CASE_DIR}/adopt-http.out" 2>&1 ||
    fail "serve refused to adopt Collie's own pre-existing HTTP mount"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" \
    'http:8787|host.example:8787|http://127.0.0.1:8787'

  # Same for the HTTPS default, whose mount lives on :443 while the proxy target stays $PORT.
  setup_case adopt-preexisting-https
  install_fake_tailscale
  printf '%s\n' '{"TCP":{"443":{"HTTPS":true}},"Web":{"host.example:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}' > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_PORT=8787
EOF
  run_ctl serve > "${CASE_DIR}/adopt-https.out" 2>&1 ||
    fail "serve refused to adopt Collie's own pre-existing HTTPS mount"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" \
    'https:443|host.example:443|http://127.0.0.1:8787'

  # Negative control: a root mount proxying somewhere ELSE is still refused, so adoption can't be
  # used to justify clobbering a stranger's mapping.
  setup_case adopt-negative-control
  install_fake_tailscale
  foreign='{"TCP":{"8787":{"HTTP":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7000"}}}}}'
  printf '%s\n' "$foreign" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/adopt-foreign.out" 2>&1; then
    fail "adoption swallowed a foreign root mount"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$foreign"
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "foreign mount created ownership state"
}

# A failed front door must not abort `start` — the bridge is up on loopback and the banner still has
# to print, which is what the README's troubleshooting flow tells people to read.
test_serve_failure_does_not_abort_start() {
  setup_case serve-failure-start
  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR"
export PATH="$BIN_DIR:$BASE_PATH"
source "$CTL"
ensure_build() { return 0; }
have_systemd() { return 1; }
BUN=/bin/true
cmd_serve() { echo "error: simulated serve failure" >&2; return 1; }
print_status_banner() { echo "BANNER"; }
cmd_start
EOF
  bash "$harness" > "${CASE_DIR}/start.out" 2>&1 ||
    fail "a failing cmd_serve aborted cmd_start"
  assert_contains "$(cat "${CASE_DIR}/start.out")" 'BANNER'
}

# A bun that reports only how it was found: its own path, and the PATH it inherited.
install_fake_bun() {
  local target="$1" calls="$2"
  mkdir -p "$(dirname "$target")"
  cat > "$target" <<EOF
#!/bin/sh
printf '%s|%s\n' "\$0" "\$PATH" > "$calls"
exit 0
EOF
  chmod +x "$target"
}

# Herdr spawns plugin actions with a minimal environment — no login shell, so ~/.bun/bin is simply
# absent from PATH and resolving with \`command -v bun\` alone found nothing. Because \`update\` pulls
# BEFORE it builds, that left the checkout ahead of the web/dist still being served while every
# version string reported the new release. Pin both halves of the fix: which Bun gets chosen, and
# that its directory reaches child processes on PATH (the Tailscale ownership probe, and the children
# `bun run build` spawns, look up a bare `bun` themselves).
test_bun_resolution() {
  setup_case bun-resolution
  ln -s "$(command -v dirname)" "${BIN_DIR}/dirname"
  local calls="${CASE_DIR}/calls"

  install_fake_bun "${HOME_DIR}/.bun/bin/bun" "$calls"
  # PATH holds no bun at all — this IS the Herdr-action environment. Resolution has to reach into
  # $HOME, and the fixture wins over any real bun in /usr/bin because ~/.bun/bin is tried first.
  # $BUN_INSTALL is scrubbed: a developer running these tests from a shell where Bun's installer
  # exported it would otherwise resolve their REAL bun and the fixture would never be consulted.
  env -u BUN_INSTALL HOME="$HOME_DIR" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" PATH="$BIN_DIR" \
    /bin/bash "$CTL" push-test
  assert_eq "$(cut -d'|' -f1 "$calls")" "${HOME_DIR}/.bun/bin/bun"
  case "$(cut -d'|' -f2- "$calls")" in
    "${HOME_DIR}/.bun/bin:"*) ;;
    *) fail "resolved Bun's directory never reached children on PATH" ;;
  esac

  # $BUN_INSTALL is the operator's explicit choice, so it outranks the default ~/.bun.
  install_fake_bun "${CASE_DIR}/alt/bin/bun" "$calls"
  HOME="$HOME_DIR" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" PATH="$BIN_DIR" \
    BUN_INSTALL="${CASE_DIR}/alt" /bin/bash "$CTL" push-test
  assert_eq "$(cut -d'|' -f1 "$calls")" "${CASE_DIR}/alt/bin/bun"
}

# `command -v` reports a function or alias as a BARE word, and the plugin .env is sourced before we
# resolve — so a `bun()` defined there yields dirname `.`, and prepending that would hand every later
# `git` / `systemctl` / `tailscale` a cwd-relative lookup. Only absolute paths reach PATH.
test_non_absolute_bun_never_reaches_path() {
  setup_case bun-not-absolute
  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR"
export PATH="$BIN_DIR:$BASE_PATH"
bun() { :; }   # what a doctored .env would leave behind
source "$CTL"
echo "PATH=\$PATH"
EOF
  bash "$harness" > "${CASE_DIR}/path.out" 2>&1 ||
    fail "sourcing the script with a bun function failed"
  case "$(cat "${CASE_DIR}/path.out")" in
    *"PATH=.:"*|*":.:"*) fail "a non-absolute Bun put the CWD on PATH" ;;
  esac
}

# An empty resolution must still be reported and exit non-zero — that message is all an operator on a
# host genuinely without Bun gets, and it's what stops a build from half-finishing.
test_missing_bun_still_reports() {
  setup_case bun-missing
  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR"
export PATH="$BIN_DIR:$BASE_PATH"
source "$CTL"
BUN=""
cmd_build
EOF
  set +e
  bash "$harness" > "${CASE_DIR}/build.out" 2>&1
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "cmd_build with no Bun reported success"
  assert_contains "$(cat "${CASE_DIR}/build.out")" 'bun not found'
}

test_tailscale_cutovers_and_collisions
test_missing_tailscale_cli
test_state_delete_failures
test_adopts_preexisting_collie_mount
test_serve_failure_does_not_abort_start
test_bun_resolution
test_non_absolute_bun_never_reaches_path
test_missing_bun_still_reports

echo "collie-ctl lifecycle tests: passed"
