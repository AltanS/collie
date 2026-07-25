#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTL="${ROOT}/scripts/collie-ctl.sh"
BASE_PATH="$PATH"
TMP_ROOT="$(mktemp -d)"
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_ROOT"
}
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

install_fake_tailscale() {
  TS_STATUS="${CASE_DIR}/tailscale-status.json"
  TS_CALLS="${CASE_DIR}/tailscale.calls"
  printf '{}\n' > "$TS_STATUS"
  cat > "${BIN_DIR}/tailscale" <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "\$*" >> "$TS_CALLS"
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

test_tailscale_cutovers_and_collisions() {
  setup_case tailscale
  install_fake_tailscale

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=tailscale
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF
  run_ctl serve > "${CASE_DIR}/start-8787.out"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" \
    'http:8787|host.example:8787|http://127.0.0.1:8787'

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=tailscale
COLLIE_SERVE_MODE=http
COLLIE_PORT=9999
EOF
  run_ctl serve > "${CASE_DIR}/start-9999.out"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" \
    'http:9999|host.example:9999|http://127.0.0.1:9999'

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=proxy
COLLIE_PORT=9999
EOF
  run_ctl serve > "${CASE_DIR}/to-proxy.out"
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "Tailscale ownership survived proxy cutover"
  assert_eq "$(cat "$TS_STATUS")" '{}'

  collision='{"TCP":{"8787":{"HTTP":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7000"}}}}}'
  printf '%s\n' "$collision" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=tailscale
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
COLLIE_FRONT_DOOR=tailscale
COLLIE_SERVE_MODE=https
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/opposite-http.out" 2>&1; then
    fail "HTTPS publication replaced an unrelated HTTP sibling listener"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$opposite_http"
  [ ! -e "${CONFIG_DIR}/tailscale-managed-handler" ] || fail "protocol mismatch created ownership state"

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=tailscale
COLLIE_SERVE_MODE=http
COLLIE_PORT=8787
EOF

  printf '{}\n' > "$TS_STATUS"
  run_ctl serve > "${CASE_DIR}/owned.out"
  owned_state="$(cat "${CONFIG_DIR}/tailscale-managed-handler")"
  protocol_replacement='{"TCP":{"8787":{"HTTPS":true}},"Web":{"host.example:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}'
  printf '%s\n' "$protocol_replacement" > "$TS_STATUS"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=proxy
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
COLLIE_FRONT_DOOR=proxy
COLLIE_PORT=8787
EOF
  if run_ctl serve > "${CASE_DIR}/replacement.out" 2>&1; then
    fail "externally replaced Tailscale root was removed"
  fi
  assert_eq "$(cat "$TS_STATUS")" "$replacement"
  assert_eq "$(cat "${CONFIG_DIR}/tailscale-managed-handler")" "$owned_state"
}

test_netbird_identity_mismatch() {
  setup_case netbird-identity
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=netbird
COLLIE_NETBIRD_PIN=123456
EOF

  sleep 30 &
  unrelated=$!
  PIDS+=("$unrelated")
  printf '%s\n' "$unrelated" > "${CONFIG_DIR}/netbird-expose.pid"
  printf 'proc:stale-start-time\n' > "${CONFIG_DIR}/netbird-expose.identity"
  printf 'URL: https://stale.example\n' > "${CONFIG_DIR}/netbird-expose.log"

  url_output="$(run_ctl url)"
  assert_contains "$url_output" 'NetBird URL unavailable'
  case "$url_output" in
    *stale.example*) fail "stale NetBird URL was reported live" ;;
  esac

  status_output="$(run_ctl status)"
  assert_contains "$status_output" 'process stale'
  assert_contains "$status_output" 'url     NetBird URL unavailable'

  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=proxy
EOF
  if run_ctl serve > "${CASE_DIR}/cutover.out" 2>&1; then
    fail "proxy cutover ignored NetBird identity mismatch"
  fi
  kill -0 "$unrelated" 2>/dev/null || fail "identity mismatch signaled unrelated process"
  [ -e "${CONFIG_DIR}/netbird-expose.pid" ] || fail "mismatched PID state was deleted"
  [ -e "${CONFIG_DIR}/netbird-expose.identity" ] || fail "mismatched identity state was deleted"
}

run_netbird_state_write_failure() {
  local kind="$1"
  setup_case "netbird-${kind}-write"
  local child_pid_file="${CASE_DIR}/child.pid"
  cat > "${BIN_DIR}/netbird" <<EOF
#!/bin/sh
echo \$\$ > "$child_pid_file"
while :; do sleep 1; done
EOF
  chmod +x "${BIN_DIR}/netbird"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=netbird
COLLIE_NETBIRD_PIN=123456
EOF

  local pid_state="${CONFIG_DIR}/netbird-expose.pid"
  local identity_state="${CONFIG_DIR}/netbird-expose.identity"
  local state_blocker="${CONFIG_DIR}/state-blocker"
  printf 'regular file, not a directory\n' > "$state_blocker"
  if [ "$kind" = identity ]; then
    identity_state="${state_blocker}/netbird-expose.identity"
  else
    pid_state="${state_blocker}/netbird-expose.pid"
  fi

  local harness="${CASE_DIR}/harness.sh"
  cat > "$harness" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$HOME_DIR"
export HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR"
export PATH="$BIN_DIR:$BASE_PATH"
source "$CTL"
stop_netbird_expose() { return 0; }
have_systemd() { return 1; }
NETBIRD_EXPOSE_PID="$pid_state"
NETBIRD_EXPOSE_IDENTITY="$identity_state"
if cmd_netbird_serve; then
  exit 99
fi
EOF

  bash "$harness" > "${CASE_DIR}/write-failure.out" 2>&1
  [ ! -e "$pid_state" ] || fail "$kind write failure retained partial PID state"
  [ ! -e "$identity_state" ] || fail "$kind write failure retained partial identity state"
  if [ -f "$child_pid_file" ]; then
    child_pid="$(cat "$child_pid_file")"
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
      fail "$kind write failure left NetBird child running"
    fi
  fi
}

test_missing_tailscale_cli() {
  setup_case tailscale-missing
  ln -s "$(command -v dirname)" "${BIN_DIR}/dirname"
  ln -s "$(command -v tr)" "${BIN_DIR}/tr"
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=tailscale
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

test_state_delete_failures() {
  setup_case state-delete-failures
  cat > "${BIN_DIR}/tailscale" <<'EOF'
#!/bin/sh
exit 0
EOF
  chmod +x "${BIN_DIR}/tailscale"

  local tailscale_state="${CONFIG_DIR}/tailscale-managed-handler"
  local pid_state="${CONFIG_DIR}/netbird-expose.pid"
  local identity_state="${CONFIG_DIR}/netbird-expose.identity"
  printf 'http:8787|host.example:8787|http://127.0.0.1:8787\n' > "$tailscale_state"
  printf '99999999\n' > "$pid_state"
  printf 'proc:dead\n' > "$identity_state"

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
NETBIRD_EXPOSE_PID="$pid_state"
NETBIRD_EXPOSE_IDENTITY="$identity_state"
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

if stop_netbird_expose; then
  exit 95
fi
[ -f "$pid_state" ] && [ -f "$identity_state" ] || exit 96
EOF

  bash "$harness" > "${CASE_DIR}/delete-failure.out" 2>&1
}

test_systemd_query_states() {
  setup_case systemd-query-states
  cat > "${CONFIG_DIR}/.env" <<'EOF'
COLLIE_FRONT_DOOR=proxy
EOF

  cat > "${BIN_DIR}/systemctl" <<'EOF'
#!/bin/sh
case "$*" in
  "--user show-environment") exit 0 ;;
  "--user disable --now collie-netbird-expose") exit 0 ;;
  "--user is-active collie-netbird-expose") echo "Failed to connect to bus" >&2; exit 1 ;;
  "--user is-enabled collie-netbird-expose") echo disabled; exit 1 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "${BIN_DIR}/systemctl"
  if run_ctl serve > "${CASE_DIR}/query-failure.out" 2>&1; then
    fail "systemd query failure was treated as stopped"
  fi
  assert_contains "$(cat "${CASE_DIR}/query-failure.out")" 'could not confirm NetBird expose unit is inactive'

  cat > "${BIN_DIR}/systemctl" <<'EOF'
#!/bin/sh
case "$*" in
  "--user show-environment") echo "Failed to connect to bus" >&2; exit 1 ;;
  *) exit 1 ;;
esac
EOF
  chmod +x "${BIN_DIR}/systemctl"
  mkdir -p "${HOME_DIR}/.config/systemd/user"
  printf '[Service]\nExecStart=/bin/false\n' > "${HOME_DIR}/.config/systemd/user/collie-netbird-expose.service"
  if run_ctl serve > "${CASE_DIR}/inaccessible-bus.out" 2>&1; then
    fail "inaccessible systemd bus with a known unit was treated as absent"
  fi
  assert_contains "$(cat "${CASE_DIR}/inaccessible-bus.out")" 'systemd user manager is inaccessible'
  rm -f "${HOME_DIR}/.config/systemd/user/collie-netbird-expose.service"

  cat > "${BIN_DIR}/systemctl" <<'EOF'
#!/bin/sh
case "$*" in
  "--user show-environment") exit 0 ;;
  "--user disable --now collie-netbird-expose") exit 0 ;;
  "--user is-active collie-netbird-expose") echo inactive; exit 3 ;;
  "--user is-enabled collie-netbird-expose") echo disabled; exit 1 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "${BIN_DIR}/systemctl"
  run_ctl serve > "${CASE_DIR}/explicit-stopped.out"
  assert_contains "$(cat "${CASE_DIR}/explicit-stopped.out")" 'managed serve skipped'
}

test_tailscale_cutovers_and_collisions
test_netbird_identity_mismatch
run_netbird_state_write_failure pid
run_netbird_state_write_failure identity
test_missing_tailscale_cli
test_state_delete_failures
test_systemd_query_states

echo "collie-ctl lifecycle tests: passed"
