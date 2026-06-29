#!/usr/bin/env bash
# Control script for Collie (the Herdr web bridge service). Invoked by the plugin's actions and usable directly.
# The bridge runs as a systemd --user service (NOT a Herdr plugin pane — see CONCEPT §4), so it
# survives Herdr restarts and is supervised independently.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="collie"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"
CONFIG_DIR="${HERDR_PLUGIN_CONFIG_DIR:-${HOME}/.config/collie}"

# Source the plugin .env so both this script and the systemd unit share one config source.
if [ -f "${CONFIG_DIR}/.env" ]; then set -a; . "${CONFIG_DIR}/.env"; set +a; fi

PORT="${COLLIE_PORT:-8787}"
SOCKET="${HERDR_SOCKET_PATH:-${HOME}/.config/herdr/herdr.sock}"
# How tailscale serve exposes the bridge: "https" (default, needs a cert from the control
# server) or "http" (plain HTTP over the tailnet — use this on Headscale / .internal domains).
SERVE_MODE="${COLLIE_SERVE_MODE:-https}"
BUN="$(command -v bun || true)"
WEB_DIST="${PLUGIN_ROOT}/web/dist/index.html"

have_systemd() { command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }

# Build the Vite/React PWA into web/dist. The bridge serves that directory; without it the API
# still runs but the UI 503s. Safe to call repeatedly (no-op if already built, unless forced).
cmd_build() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  # Version gate: refuse to build a release whose version files / CHANGELOG disagree.
  # Override (e.g. mid-refactor) with SKIP_VERSION_CHECK=1.
  if [ "${SKIP_VERSION_CHECK:-}" != "1" ]; then
    bash "${PLUGIN_ROOT}/scripts/check-version.sh"
  fi
  ( cd "${PLUGIN_ROOT}/web" && "$BUN" install && "$BUN" run build )
}

ensure_build() {
  [ -f "$WEB_DIST" ] && return 0
  [ -n "$BUN" ] || { echo "note: bun not found; cannot build web UI" >&2; return 1; }
  echo "building web UI (first run)…"
  cmd_build || { echo "warn: web build failed; API will run but the UI will 503 until built" >&2; return 1; }
}

self_dnsname() {
  tailscale status --json 2>/dev/null | node -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).Self.DNSName.replace(/\.\$/,''))}catch{}})"
}

bridge_url() {
  local name; name="$(self_dnsname)"
  if [ -z "$name" ]; then echo "http://127.0.0.1:${PORT} (Tailscale name unavailable)"; return; fi
  if [ "$SERVE_MODE" = "http" ]; then echo "http://${name}:${PORT}"; else echo "https://${name}"; fi
}

write_unit() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$UNIT_FILE")" "$CONFIG_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Collie
After=default.target

[Service]
Type=simple
WorkingDirectory=${PLUGIN_ROOT}
ExecStart=${BUN} run ${PLUGIN_ROOT}/src/index.ts
Restart=on-failure
RestartSec=2
Environment=HERDR_SOCKET_PATH=${SOCKET}
Environment=COLLIE_PORT=${PORT}
Environment=HERDR_PLUGIN_CONFIG_DIR=${CONFIG_DIR}
EnvironmentFile=-${CONFIG_DIR}/.env

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

cmd_start() {
  ensure_build || true
  if have_systemd; then
    write_unit
    systemctl --user enable --now "$UNIT"
    echo "bridge started (systemd --user: ${UNIT})"
  else
    # Fallback: background process with a pidfile (e.g. macOS without lingering systemd).
    mkdir -p "$CONFIG_DIR"
    [ -n "$BUN" ] || { echo "error: bun not found" >&2; exit 1; }
    HERDR_SOCKET_PATH="$SOCKET" COLLIE_PORT="$PORT" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" \
      nohup "$BUN" run "${PLUGIN_ROOT}/src/index.ts" >>"${CONFIG_DIR}/collie.log" 2>&1 &
    echo $! > "${CONFIG_DIR}/collie.pid"
    echo "bridge started (pid $(cat "${CONFIG_DIR}/collie.pid"), no systemd)"
  fi
  cmd_serve
  echo "open: $(bridge_url)"
}

cmd_stop() {
  if have_systemd; then
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
  elif [ -f "${CONFIG_DIR}/collie.pid" ]; then
    kill "$(cat "${CONFIG_DIR}/collie.pid")" 2>/dev/null || true
    rm -f "${CONFIG_DIR}/collie.pid"
  fi
  echo "bridge stopped"
}

cmd_restart() { cmd_stop; cmd_start; }

cmd_serve() {
  command -v tailscale >/dev/null || { echo "note: tailscale not found; bridge is on 127.0.0.1:${PORT} only"; return; }
  local out="${CONFIG_DIR}/serve.out"
  if [ "$SERVE_MODE" = "http" ]; then
    if tailscale serve --bg --http="$PORT" "$PORT" >"$out" 2>&1; then
      echo "tailscale serve (http) → tailnet :${PORT} -> 127.0.0.1:${PORT}"
    else
      echo "note: tailscale serve failed (try 'sudo tailscale set --operator=\$USER'):"; cat "$out"
    fi
  else
    if tailscale serve --bg "$PORT" >"$out" 2>&1; then
      echo "tailscale serve (https) → tailnet :443 -> 127.0.0.1:${PORT}"
    else
      echo "note: tailscale serve (https) failed — on Headscale/.internal domains use COLLIE_SERVE_MODE=http:"; cat "$out"
    fi
  fi
}

cmd_unserve() {
  command -v tailscale >/dev/null && tailscale serve reset >/dev/null 2>&1 || true
  echo "tailscale serve reset"
}

cmd_status() {
  if have_systemd; then systemctl --user --no-pager status "$UNIT" 2>&1 | head -12 || true; fi
  echo "url: $(bridge_url)"
  echo "serve config:"; tailscale serve status 2>/dev/null || true
}

cmd_logs() {
  if have_systemd; then journalctl --user -u "$UNIT" -n "${1:-50}" --no-pager
  else tail -n "${1:-50}" "${CONFIG_DIR}/collie.log" 2>/dev/null || echo "(no log)"; fi
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  build)   cmd_build ;;
  serve)   cmd_serve; echo "open: $(bridge_url)" ;;
  unserve) cmd_unserve ;;
  status)  cmd_status ;;
  url)     bridge_url ;;
  logs)    cmd_logs "${2:-50}" ;;
  *) echo "usage: collie-ctl.sh {start|stop|restart|build|serve|unserve|status|url|logs}" >&2; exit 2 ;;
esac
