#!/usr/bin/env bash
# Control script for Collie (the Herdr web bridge service). Invoked by the plugin's actions and usable directly.
# The bridge runs as a systemd --user service (NOT a Herdr plugin pane — see ARCHITECTURE.md §3), so it
# survives Herdr restarts and is supervised independently.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="collie"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"
NETBIRD_EXPOSE_UNIT="collie-netbird-expose"
NETBIRD_EXPOSE_UNIT_FILE="${HOME}/.config/systemd/user/${NETBIRD_EXPOSE_UNIT}.service"
PLUGIN_ID="herdr.collie"

# Resolve the plugin config dir (where .env lives) the SAME way no matter how we're launched.
# Herdr injects HERDR_PLUGIN_CONFIG_DIR when it runs our actions, but a direct `collie-ctl.sh` call
# doesn't get it — so we ask Herdr for the canonical path (`herdr plugin config-dir`, plain text).
# Without this, the two entry points read DIFFERENT .env files (Herdr's dir vs a ~/.config/collie
# fallback), so a setting like COLLIE_SERVE_MODE applied one way and was silently ignored the other.
# Order: injected env → Herdr CLI → Herdr's conventional path (if it has a .env) → ~/.config/collie.
resolve_config_dir() {
  if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then echo "$HERDR_PLUGIN_CONFIG_DIR"; return; fi
  if command -v herdr >/dev/null; then
    local d; d="$(herdr plugin config-dir "$PLUGIN_ID" 2>/dev/null || true)"
    if [ -n "$d" ]; then echo "$d"; return; fi
  fi
  local conventional="${HOME}/.config/herdr/plugins/config/${PLUGIN_ID}"
  if [ -f "${conventional}/.env" ]; then echo "$conventional"; return; fi
  echo "${HOME}/.config/collie"
}
CONFIG_DIR="$(resolve_config_dir)"

# If a legacy ~/.config/collie/.env exists but isn't the resolved dir, it's being ignored — say so
# rather than silently dropping config that used to apply via the old fallback.
if [ "$CONFIG_DIR" != "${HOME}/.config/collie" ] && [ -f "${HOME}/.config/collie/.env" ]; then
  echo "note: ignoring legacy ${HOME}/.config/collie/.env — config now lives in ${CONFIG_DIR}/.env (move it there)." >&2
fi

# Source the plugin .env so both this script and the systemd unit share one config source.
if [ -f "${CONFIG_DIR}/.env" ]; then set -a; . "${CONFIG_DIR}/.env"; set +a; fi

PORT="${COLLIE_PORT:-8787}"
SOCKET="${HERDR_SOCKET_PATH:-${HOME}/.config/herdr/herdr.sock}"
# Which ingress fronts the loopback bridge:
#   tailscale (default): durable tailnet-only `tailscale serve`
#   netbird:             supervised `netbird expose` sidecar (public URL; require NetBird auth)
#   proxy:               no managed ingress; an operator-run reverse proxy owns the front door
FRONT_DOOR="$(printf '%s' "${COLLIE_FRONT_DOOR:-tailscale}" | tr '[:upper:]' '[:lower:]')"
FRONT_DOOR="${FRONT_DOOR//[[:space:]]/}"
if [ "${COLLIE_SKIP_SERVE:-}" = "1" ]; then FRONT_DOOR="proxy"; fi
# Tailscale-only mode: "https" (default, needs a cert from the control server) or "http"
# (plain HTTP over the tailnet — use this on Headscale / .internal domains).
SERVE_MODE="${COLLIE_SERVE_MODE:-https}"
NETBIRD_EXPOSE_LOG="${CONFIG_DIR}/netbird-expose.log"
NETBIRD_EXPOSE_PID="${CONFIG_DIR}/netbird-expose.pid"
NETBIRD_EXPOSE_IDENTITY="${CONFIG_DIR}/netbird-expose.identity"
NETBIRD_EXPOSE_RUNNER="${CONFIG_DIR}/netbird-expose.sh"
TAILSCALE_HANDLER_FILE="${CONFIG_DIR}/tailscale-managed-handler"
BUN="$(command -v bun || true)"
resolve_netbird_bin() {
  local path
  path="$(type -P netbird || true)"
  [ -n "$path" ] || return 0
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$(cd "$(dirname "$path")" && pwd -P)" "$(basename "$path")" ;;
  esac
}
NETBIRD_BIN="$(resolve_netbird_bin)"

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
  # Install BOTH dependency trees before typechecking. The root typecheck (tsconfig `types: ["bun"]`)
  # resolves @types/bun from the ROOT node_modules; a fresh Herdr checkout ships neither tree, so
  # without a root install the very first build dies with TS2688 "Cannot find type definition file
  # for 'bun'" and Herdr rolls the install back (issue #9). It works on the dev host only because a
  # manual `bun install` left root node_modules behind.
  ( cd "${PLUGIN_ROOT}" && "$BUN" install )
  ( cd "${PLUGIN_ROOT}/web" && "$BUN" install )
  # Typecheck BOTH sides before building — the Vite build itself does not typecheck, so a type
  # error would otherwise ship silently. Skip with SKIP_TYPECHECK=1 (same hatch as the pre-push hook).
  if [ "${SKIP_TYPECHECK:-}" != "1" ]; then
    ( cd "${PLUGIN_ROOT}" && "$BUN" run typecheck )
    ( cd "${PLUGIN_ROOT}/web" && "$BUN" run typecheck )
  fi
  # Staged build + atomic swap. Vite empties its output dir first, so building straight into web/dist
  # would leave it EMPTY with no rollback if the build failed — and the bridge serves web/dist from
  # disk at request time. Build into web/dist-staging, then swap it in only on success. `set -e`
  # aborts the function before the swap on any build failure, so a live web/dist survives untouched.
  local staging="${PLUGIN_ROOT}/web/dist-staging"
  rm -rf "$staging"
  ( cd "${PLUGIN_ROOT}/web" && "$BUN" run build -- --outDir dist-staging --emptyOutDir )
  # Swap is the LAST step (a near-atomic same-filesystem rename) so the served dir is never half-built.
  rm -rf "${PLUGIN_ROOT}/web/dist"
  mv "$staging" "${PLUGIN_ROOT}/web/dist"
}

ensure_build() {
  [ -f "$WEB_DIST" ] && return 0
  [ -n "$BUN" ] || { echo "note: bun not found; cannot build web UI" >&2; return 1; }
  echo "building web UI (first run)…"
  cmd_build || { echo "warn: web build failed; API will run but the UI will 503 until built" >&2; return 1; }
}

self_dnsname() {
  tailscale status --json 2>/dev/null | bun -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).Self.DNSName.replace(/\.\$/,''))}catch{}})"
}

tailscale_bridge_url() {
  local name; name="$(self_dnsname)"
  if [ -z "$name" ]; then echo "http://127.0.0.1:${PORT} (Tailscale name unavailable)"; return; fi
  if [ "$SERVE_MODE" = "http" ]; then echo "http://${name}:${PORT}"; else echo "https://${name}"; fi
}

netbird_process_running() {
  local pid="$1" state
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
  [ -n "$state" ] || return 1
  case "$state" in
    Z*) return 1 ;;
    *) return 0 ;;
  esac
}
netbird_process_identity() {
  local pid="$1" stat rest started
  if [ -r "/proc/${pid}/stat" ]; then
    stat="$(cat "/proc/${pid}/stat" 2>/dev/null)" || return 1
    rest="${stat##*) }"
    set -- $rest
    [ "$#" -ge 20 ] || return 1
    printf 'proc:%s\n' "${20}"
    return 0
  fi
  started="$(ps -o lstart= -p "$pid" 2>/dev/null || true)"
  [ -n "$started" ] || return 1
  printf 'ps:%s\n' "$started"
}


netbird_expose_running() {
  if have_systemd; then
    systemctl --user is-active "$NETBIRD_EXPOSE_UNIT" >/dev/null 2>&1
    return
  fi
  local pid expected_identity current_identity
  [ -f "$NETBIRD_EXPOSE_PID" ] && [ -f "$NETBIRD_EXPOSE_IDENTITY" ] || return 1
  pid="$(cat "$NETBIRD_EXPOSE_PID" 2>/dev/null || true)"
  case "$pid" in
    ''|0|*[!0-9]*) return 1 ;;
  esac
  netbird_process_running "$pid" || return 1
  expected_identity="$(cat "$NETBIRD_EXPOSE_IDENTITY" 2>/dev/null || true)"
  current_identity="$(netbird_process_identity "$pid" 2>/dev/null || true)"
  [ -n "$expected_identity" ] && [ "$current_identity" = "$expected_identity" ]
}

netbird_url_from_log() {
  netbird_expose_running || return 0
  [ -f "$NETBIRD_EXPOSE_LOG" ] || return 0
  sed -n 's/^[[:space:]]*URL:[[:space:]]*//p' "$NETBIRD_EXPOSE_LOG" | tail -1
}

netbird_bridge_url() {
  if [ -n "${COLLIE_PUBLIC_URL:-}" ]; then echo "$COLLIE_PUBLIC_URL"; return; fi
  if [ -n "${COLLIE_NETBIRD_CUSTOM_DOMAIN:-}" ]; then echo "https://${COLLIE_NETBIRD_CUSTOM_DOMAIN}"; return; fi
  local url; url="$(netbird_url_from_log)"
  [ -n "$url" ] && echo "$url" || echo "NetBird URL unavailable yet (check 'collie-ctl.sh status')"
}

bridge_url() {
  case "$FRONT_DOOR" in
    tailscale) tailscale_bridge_url ;;
    netbird)   netbird_bridge_url ;;
    proxy)
      [ -n "${COLLIE_PUBLIC_URL:-}" ] && echo "$COLLIE_PUBLIC_URL" || echo "http://127.0.0.1:${PORT} (set COLLIE_PUBLIC_URL to your proxy URL)"
      ;;
    *) echo "http://127.0.0.1:${PORT} (unknown COLLIE_FRONT_DOOR=${FRONT_DOOR})" ;;
  esac
}

# The version Collie is actually serving — read from the built bundle's stamp
# (web/dist/build-info.json, the same id the PWA footer and /api/config report), e.g. "0.16.0+3441656".
# Falls back to the manifest version (tagged "web not built") when web/dist doesn't exist yet. This is
# the authoritative "what's running", unlike Herdr's registry value which is cached at link time.
collie_version() {
  local bi="${PLUGIN_ROOT}/web/dist/build-info.json" v sha
  if [ -f "$bi" ]; then
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$bi" | head -1)"
    sha="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$bi" | head -1)"
    if [ -n "$v" ]; then [ -n "$sha" ] && echo "${v}+${sha}" || echo "$v"; return; fi
  fi
  v="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${PLUGIN_ROOT}/herdr-plugin.toml" | head -1)"
  [ -n "$v" ] && echo "${v} (manifest; web not built)" || echo "unknown"
}

# True once the bridge accepts a TCP connection on its loopback port — i.e. the HTTP server is
# actually up, not merely that the unit went "active". Uses bash's /dev/tcp (no curl dependency);
# polls for up to ~5s to cover a just-launched service still binding.
bridge_ready() {
  local i
  for i in $(seq 1 25); do
    # Open the probe socket on fd 3, then close both directions so the fd never leaks. `&&` (not `;`)
    # is load-bearing: a refused connection must short-circuit, else the trailing close would mask it.
    if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}" && exec 3>&- 3<&-) 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# One scannable "is Collie up?" summary — readiness, how it's supervised, and both URLs. Shared by
# `start` (post-launch confirmation) and `status` (on demand) so the two always agree.
print_status_banner() {
  local svc
  if have_systemd; then
    svc="systemd --user (${UNIT}) · $(systemctl --user is-active "$UNIT" 2>/dev/null || echo unknown)"
  elif [ -f "${CONFIG_DIR}/collie.pid" ]; then
    svc="pid $(cat "${CONFIG_DIR}/collie.pid" 2>/dev/null) (no systemd)"
  else
    svc="not supervised"
  fi
  local ver; ver="$(collie_version)"
  echo
  if bridge_ready; then
    echo "  ✓ Collie is running  ·  v${ver}"
  else
    echo "  ⚠ Collie isn't answering on :${PORT} yet (v${ver}) — check 'collie-ctl.sh logs'"
  fi
  echo "    service   ${svc}"
  echo "    local     http://127.0.0.1:${PORT}"
  case "$FRONT_DOOR" in
    proxy)
      if [ -n "${COLLIE_PUBLIC_URL:-}" ]; then
        echo "    proxy     ${COLLIE_PUBLIC_URL}"
      else
        echo "    proxy     (COLLIE_FRONT_DOOR=proxy — set COLLIE_PUBLIC_URL to your reverse-proxy URL)"
      fi
      ;;
    netbird)
      echo "    netbird   $(netbird_bridge_url)"
      ;;
    tailscale)
      echo "    tailnet   $(tailscale_bridge_url)"
      ;;
    *)
      echo "    ingress   unknown COLLIE_FRONT_DOOR=${FRONT_DOOR}"
      ;;
  esac
  echo
}

write_unit() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$UNIT_FILE")" "$CONFIG_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Collie
After=default.target
# Never give up restarting — a phone-only operator can't run 'systemctl reset-failed'.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${PLUGIN_ROOT}
ExecStart=${BUN} run ${PLUGIN_ROOT}/bridge/index.ts
Restart=on-failure
RestartSec=5
# Hardening: the bridge is remote shell access, so deny privilege escalation and give it a private
# /tmp. ProtectSystem is intentionally NOT set — the only write path is the env-driven state dir,
# which Herdr may inject to an arbitrary location, so it can't be enumerated in a static ReadWritePaths.
NoNewPrivileges=yes
PrivateTmp=yes
Environment=HERDR_SOCKET_PATH=${SOCKET}
Environment=COLLIE_PORT=${PORT}
Environment=COLLIE_FRONT_DOOR=${FRONT_DOOR}
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
    HERDR_SOCKET_PATH="$SOCKET" COLLIE_PORT="$PORT" COLLIE_FRONT_DOOR="$FRONT_DOOR" \
      HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" nohup "$BUN" run "${PLUGIN_ROOT}/bridge/index.ts" >>"${CONFIG_DIR}/collie.log" 2>&1 &
    echo $! > "${CONFIG_DIR}/collie.pid"
    echo "bridge started (pid $(cat "${CONFIG_DIR}/collie.pid"), no systemd)"
  fi
  cmd_serve
  print_status_banner
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

# Tear the service down completely (the inverse of `start`): stop + disable it, remove the
# systemd --user unit, remove Collie's managed ingress, and drop the pidfile. Deliberately leaves your
# config (${CONFIG_DIR}/.env) and the on-disk checkout in place — `uninstall` removes only what
# `start` created. To remove the plugin registration too, run `herdr plugin uninstall herdr.collie`
# (or, for a linked clone, just delete the checkout).
cmd_uninstall() {
  cmd_stop
  cmd_unserve
  rm -f "$UNIT_FILE" "$NETBIRD_EXPOSE_UNIT_FILE"
  if have_systemd; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed "$UNIT" "$NETBIRD_EXPOSE_UNIT" 2>/dev/null || true
  fi
  rm -f "${CONFIG_DIR}/collie.pid"
  echo "✓ uninstalled: service stopped & disabled, systemd unit removed, Collie's managed ingress removed"
  echo "  kept: ${CONFIG_DIR}/.env and the checkout — delete those to remove every trace"
}

# Update to the latest release. Collie is a link-mode Herdr plugin, so the checkout on disk IS the
# plugin (Herdr has no `plugin update`) — this is the turnkey refresh: pull, rebuild the UI, restart
# the backend. The pull can rewrite THIS script, and bash reads scripts by byte offset, so we re-exec
# the freshly-pulled copy (via the internal `_apply-update` step) to run build + restart.
cmd_update() {
  echo "updating Collie (git pull --ff-only)…"
  git -C "$PLUGIN_ROOT" pull --ff-only
  exec bash "${PLUGIN_ROOT}/scripts/collie-ctl.sh" _apply-update
}

# After an update, Herdr's plugin registry still has the action set + version CACHED from the last
# `plugin link` — so a newly added action (e.g. `version`) returns `plugin_action_not_found`, and
# `herdr plugin list` shows the old version, until a re-link. Re-link here so `update` self-heals it.
# Best-effort: never fails the update (Herdr may be down, or this may be a non-link install) — it just
# prints how to do it by hand.
refresh_registry() {
  command -v herdr >/dev/null || return 0
  if herdr plugin link "$PLUGIN_ROOT" >/dev/null 2>&1; then
    echo "herdr registry refreshed (re-linked) — new actions are invokable now"
  else
    echo "note: couldn't refresh the Herdr registry (is the Herdr server running?) —"
    echo "      run: herdr plugin link \"$PLUGIN_ROOT\""
  fi
}

# Second half of `update`, run from the just-pulled script. cmd_build re-runs the version gate (a
# half-bumped release can't go live) and rebuilds web/dist; cmd_restart picks up any bridge/ changes;
# refresh_registry re-links so Herdr learns any newly added actions / the new version.
cmd_apply_update() {
  cmd_build
  cmd_restart
  refresh_registry
  echo "✓ update complete"
}

write_netbird_expose_runner() {
  mkdir -p "$CONFIG_DIR"
  local netbird_bin_literal
  printf -v netbird_bin_literal '%q' "$NETBIRD_BIN"
  cat > "$NETBIRD_EXPOSE_RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CONFIG_DIR="\${1:?config dir required}"
if [ -f "\${CONFIG_DIR}/.env" ]; then set -a; . "\${CONFIG_DIR}/.env"; set +a; fi
PORT="\${COLLIE_PORT:-8787}"
NETBIRD_BIN=${netbird_bin_literal}

has_auth=0
[ -n "\${COLLIE_NETBIRD_PIN:-}" ] && has_auth=1
[ -n "\${COLLIE_NETBIRD_PASSWORD:-}" ] && has_auth=1
[ -n "\${COLLIE_NETBIRD_USER_GROUPS:-}" ] && has_auth=1
if [ "\$has_auth" -eq 0 ] && [ "\${COLLIE_NETBIRD_ALLOW_PUBLIC:-}" != "1" ]; then
  echo "error: refusing unauthenticated netbird expose for Collie; set COLLIE_NETBIRD_PIN, COLLIE_NETBIRD_PASSWORD, COLLIE_NETBIRD_USER_GROUPS, or COLLIE_NETBIRD_ALLOW_PUBLIC=1" >&2
  exit 2
fi

args=(expose "\$PORT" --with-name-prefix "\${COLLIE_NETBIRD_NAME_PREFIX:-collie}")
[ -n "\${COLLIE_NETBIRD_CUSTOM_DOMAIN:-}" ] && args+=(--with-custom-domain "\$COLLIE_NETBIRD_CUSTOM_DOMAIN")
[ -n "\${COLLIE_NETBIRD_PIN:-}" ] && args+=(--with-pin "\$COLLIE_NETBIRD_PIN")
[ -n "\${COLLIE_NETBIRD_PASSWORD:-}" ] && args+=(--with-password "\$COLLIE_NETBIRD_PASSWORD")
[ -n "\${COLLIE_NETBIRD_USER_GROUPS:-}" ] && args+=(--with-user-groups "\$COLLIE_NETBIRD_USER_GROUPS")

exec "\$NETBIRD_BIN" "\${args[@]}"
EOF
  chmod 700 "$NETBIRD_EXPOSE_RUNNER"
}

write_netbird_expose_unit() {
  write_netbird_expose_runner
  mkdir -p "$(dirname "$NETBIRD_EXPOSE_UNIT_FILE")"
  cat > "$NETBIRD_EXPOSE_UNIT_FILE" <<EOF
[Unit]
Description=Collie NetBird expose
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${PLUGIN_ROOT}
ExecStart=${NETBIRD_EXPOSE_RUNNER} ${CONFIG_DIR}
Restart=on-failure
RestartSec=5
Environment=HERDR_PLUGIN_CONFIG_DIR=${CONFIG_DIR}
StandardOutput=append:${NETBIRD_EXPOSE_LOG}
StandardError=append:${NETBIRD_EXPOSE_LOG}
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

wait_netbird_expose() {
  local i url
  for i in $(seq 1 25); do
    url="$(netbird_url_from_log)"
    if [ -n "$url" ]; then
      echo "netbird expose → ${url} -> 127.0.0.1:${PORT}"
      return
    fi
    if [ -f "$NETBIRD_EXPOSE_LOG" ] && grep -qi '^error:' "$NETBIRD_EXPOSE_LOG"; then
      echo "note: netbird expose failed:"
      cat "$NETBIRD_EXPOSE_LOG"
      return 1
    fi
    if ! netbird_expose_running; then
      echo "note: netbird expose exited before publishing a URL:"
      cat "$NETBIRD_EXPOSE_LOG" 2>/dev/null || true
      return 1
    fi
    sleep 0.2
  done
  echo "note: netbird expose did not publish a URL before the startup timeout" >&2
  return 1
}

discard_netbird_child() {
  local pid="$1" stopped=0 i
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 25); do
    if ! netbird_process_running "$pid"; then
      stopped=1
      break
    fi
    sleep 0.1
  done
  if [ "$stopped" -ne 1 ]; then
    kill -KILL "$pid" 2>/dev/null || true
    for i in $(seq 1 25); do
      if ! netbird_process_running "$pid"; then
        stopped=1
        break
      fi
      sleep 0.1
    done
  fi
  if [ "$stopped" -ne 1 ]; then
    echo "error: spawned NetBird expose process ${pid} could not be stopped; retained partial state" >&2
    return 1
  fi
  wait "$pid" 2>/dev/null || true
  if ! rm -f "$NETBIRD_EXPOSE_PID" "$NETBIRD_EXPOSE_IDENTITY"; then
    echo "error: could not remove partial NetBird expose state" >&2
    return 1
  fi
}

cmd_netbird_serve() {
  local pid identity
  # Stop the old sidecar before checking for a replacement binary, so a missing CLI cannot leave
  # stale credentials and a stale public URL active.
  stop_netbird_expose || return 1
  if [ -z "$NETBIRD_BIN" ] || [ ! -x "$NETBIRD_BIN" ]; then
    echo "error: netbird not found; cannot start NetBird expose" >&2
    return 1
  fi
  : > "$NETBIRD_EXPOSE_LOG"
  if have_systemd; then
    write_netbird_expose_unit
    if systemctl --user enable "$NETBIRD_EXPOSE_UNIT" >/dev/null && systemctl --user restart "$NETBIRD_EXPOSE_UNIT"; then
      if ! wait_netbird_expose; then
        if ! stop_netbird_expose; then
          echo "error: NetBird expose failed and cleanup could not confirm it stopped" >&2
        fi
        return 1
      fi
    else
      echo "note: netbird expose service failed to start:"
      cat "$NETBIRD_EXPOSE_LOG" 2>/dev/null || true
      if ! stop_netbird_expose; then
        echo "error: failed NetBird systemd start left teardown incomplete" >&2
      fi
      return 1
    fi
  else
    write_netbird_expose_runner
    nohup "$NETBIRD_EXPOSE_RUNNER" "$CONFIG_DIR" >>"$NETBIRD_EXPOSE_LOG" 2>&1 &
    pid=$!
    if ! printf '%s\n' "$pid" > "$NETBIRD_EXPOSE_PID"; then
      discard_netbird_child "$pid" || true
      echo "error: could not record NetBird expose PID" >&2
      return 1
    fi
    if ! identity="$(netbird_process_identity "$pid")"; then
      discard_netbird_child "$pid" || true
      echo "error: could not record NetBird expose process identity" >&2
      return 1
    fi
    if ! printf '%s\n' "$identity" > "$NETBIRD_EXPOSE_IDENTITY"; then
      discard_netbird_child "$pid" || true
      echo "error: could not persist NetBird expose process identity" >&2
      return 1
    fi
    if ! wait_netbird_expose; then
      if ! stop_netbird_expose; then
        echo "error: NetBird expose failed and cleanup could not confirm it stopped" >&2
      fi
      return 1
    fi
  fi
}

stop_netbird_expose() {
  local failed=0 pid="" stopped=0 i expected_identity="" current_identity=""
  local active_state="" enabled_state=""
  if have_systemd; then
    systemctl --user disable --now "$NETBIRD_EXPOSE_UNIT" >/dev/null 2>&1 || true
    active_state="$(systemctl --user is-active "$NETBIRD_EXPOSE_UNIT" 2>/dev/null || true)"
    case "$active_state" in
      inactive|failed|unknown) ;;
      active|activating|reloading|deactivating)
        echo "error: NetBird expose unit is still ${active_state}" >&2
        failed=1
        ;;
      *)
        echo "error: could not confirm NetBird expose unit is inactive" >&2
        failed=1
        ;;
    esac
    enabled_state="$(systemctl --user is-enabled "$NETBIRD_EXPOSE_UNIT" 2>/dev/null || true)"
    case "$enabled_state" in
      disabled|masked|not-found) ;;
      enabled|enabled-runtime|static|indirect|generated|transient|linked|linked-runtime|alias)
        echo "error: NetBird expose unit is not disabled (${enabled_state})" >&2
        failed=1
        ;;
      *)
        echo "error: could not confirm NetBird expose unit is disabled" >&2
        failed=1
        ;;
    esac
  elif [ -f "$NETBIRD_EXPOSE_UNIT_FILE" ]; then
    echo "error: NetBird expose unit exists but the systemd user manager is inaccessible" >&2
    failed=1
  fi
  if [ -f "$NETBIRD_EXPOSE_PID" ]; then
    pid="$(cat "$NETBIRD_EXPOSE_PID" 2>/dev/null || true)"
    case "$pid" in
      ''|0|*[!0-9]*)
        echo "error: invalid NetBird expose PID state; retained ${NETBIRD_EXPOSE_PID}" >&2
        failed=1
        ;;
      *)
        if ! netbird_process_running "$pid"; then
          stopped=1
        elif [ ! -f "$NETBIRD_EXPOSE_IDENTITY" ]; then
          echo "error: missing identity for live NetBird expose PID ${pid}; refusing to signal it" >&2
          failed=1
        else
          expected_identity="$(cat "$NETBIRD_EXPOSE_IDENTITY" 2>/dev/null || true)"
          current_identity="$(netbird_process_identity "$pid" 2>/dev/null || true)"
          if [ -z "$expected_identity" ] || [ "$current_identity" != "$expected_identity" ]; then
            echo "error: NetBird expose PID ${pid} identity mismatch; refusing to signal it" >&2
            failed=1
          elif ! kill "$pid" 2>/dev/null; then
            if netbird_process_running "$pid"; then
              echo "error: failed to stop NetBird expose process ${pid}; retained PID state" >&2
              failed=1
            else
              stopped=1
            fi
          else
            for i in $(seq 1 25); do
              if ! netbird_process_running "$pid"; then
                stopped=1
                break
              fi
              sleep 0.1
            done
            if [ "$stopped" -ne 1 ]; then
              echo "error: NetBird expose process ${pid} did not stop; retained PID state" >&2
              failed=1
            fi
          fi
        fi
        if [ "$stopped" -eq 1 ] && ! rm -f "$NETBIRD_EXPOSE_PID" "$NETBIRD_EXPOSE_IDENTITY"; then
          echo "error: NetBird expose stopped but PID/identity state could not be removed" >&2
          failed=1
        fi
        ;;
    esac
  elif [ -f "$NETBIRD_EXPOSE_IDENTITY" ]; then
    echo "error: NetBird expose identity exists without PID state; retained identity for investigation" >&2
    failed=1
  fi
  if [ "$failed" -ne 0 ]; then
    return 1
  fi
  echo "netbird expose: stopped Collie's expose session"
}


remove_tailscale_handler() {
  local description="$1" output
  shift
  if output="$(tailscale serve "$@" off 2>&1)"; then
    return 0
  fi
  case "$output" in
    *"handler does not exist"*) return 0 ;;
  esac
  [ -z "$output" ] || printf '%s\n' "$output" >&2
  echo "error: failed to remove Collie's ${description} mapping" >&2
  return 1
}

tailscale_root_fingerprint() {
  local host_port="$1" port="$2" status_json result
  [ -n "$BUN" ] || return 1
  status_json="$(tailscale serve status --json 2>/dev/null)" || return 1
  result="$(
    printf '%s' "$status_json" |
      COLLIE_SERVE_HOST_PORT="$host_port" COLLIE_SERVE_PORT="$port" "$BUN" -e '
        let data = "";
        process.stdin.on("data", chunk => data += chunk).on("end", () => {
          try {
            const config = JSON.parse(data || "{}");
            const hostPort = process.env.COLLIE_SERVE_HOST_PORT;
            const port = process.env.COLLIE_SERVE_PORT;
            const handlers = config?.Web?.[hostPort]?.Handlers ?? {};
            if (!Object.prototype.hasOwnProperty.call(handlers, "/")) {
              process.stdout.write("absent");
              return;
            }
            const listener = config?.TCP?.[port];
            const protocol = listener?.HTTP === true ? "http" :
              listener?.HTTPS === true ? "https" : "other";
            const proxy = handlers["/"]?.Proxy;
            process.stdout.write(typeof proxy === "string" && proxy ?
              `${protocol}|proxy:${proxy}` : `${protocol}|other`);
          } catch {
            process.exitCode = 2;
          }
        });
      '
  )" || return 1
  printf '%s\n' "$result"
}

stop_tailscale_serve() {
  local managed_state="" managed_handler="" managed_mode="" managed_port=""
  local managed_host_port="" managed_proxy="" extra="" current_fingerprint=""
  if [ -f "$TAILSCALE_HANDLER_FILE" ]; then
    managed_state="$(cat "$TAILSCALE_HANDLER_FILE" 2>/dev/null || true)"
    IFS='|' read -r managed_handler managed_host_port managed_proxy extra <<< "$managed_state"
    case "$managed_handler" in
      http:*)
        managed_mode="http"
        managed_port="${managed_handler#http:}"
        case "$managed_port" in
          ''|*[!0-9]*) managed_mode="" ;;
        esac
        ;;
      https:443)
        managed_mode="https"
        managed_port="443"
        ;;
    esac
    if [ -z "$managed_mode" ] || [ -z "$managed_host_port" ] || [ -z "$managed_proxy" ] || [ -n "$extra" ]; then
      echo "error: invalid managed Tailscale handler state: ${managed_state}" >&2
      return 1
    fi
    case "$managed_host_port" in
      *":${managed_port}") ;;
      *)
        echo "error: managed Tailscale HostPort does not match its listener: ${managed_state}" >&2
        return 1
        ;;
    esac
    case "$managed_proxy" in
      http://127.0.0.1:[0-9]*) ;;
      *)
        echo "error: invalid managed Tailscale proxy target: ${managed_state}" >&2
        return 1
        ;;
    esac
  else
    echo "tailscale serve: no Collie-managed mapping recorded"
    return 0
  fi
  if ! command -v tailscale >/dev/null; then
    echo "error: tailscale not found; retained the managed ${managed_handler} state for retry" >&2
    return 1
  fi
  if ! current_fingerprint="$(tailscale_root_fingerprint "$managed_host_port" "$managed_port")"; then
    echo "error: cannot inspect the managed Tailscale root; retained ownership state" >&2
    return 1
  fi
  if [ "$current_fingerprint" = "absent" ]; then
    if ! rm -f "$TAILSCALE_HANDLER_FILE"; then
      echo "error: managed Tailscale root is absent but ownership state could not be removed" >&2
      return 1
    fi
    echo "tailscale serve: managed root is already absent; cleared stale ownership state"
    return 0
  fi
  if [ "$current_fingerprint" != "${managed_mode}|proxy:${managed_proxy}" ]; then
    echo "error: managed Tailscale root was replaced; refusing to remove the current handler" >&2
    return 1
  fi
  if [ "$managed_mode" = "http" ]; then
    remove_tailscale_handler "HTTP :${managed_port} root mount" --http="$managed_port" --set-path=/ || {
      echo "error: managed ingress cleanup incomplete; retained ${TAILSCALE_HANDLER_FILE} for retry" >&2
      return 1
    }
  else
    remove_tailscale_handler "HTTPS :443 root mount" --https=443 --set-path=/ || {
      echo "error: managed ingress cleanup incomplete; retained ${TAILSCALE_HANDLER_FILE} for retry" >&2
      return 1
    }
  fi
  if ! rm -f "$TAILSCALE_HANDLER_FILE"; then
    echo "error: Tailscale root was removed but ownership state could not be removed" >&2
    return 1
  fi
  echo "tailscale serve: removed Collie's managed ${managed_handler} mapping"
}

ensure_tailscale_root_available() {
  local port="$1" protocol="$2" status_json result
  [ -n "$BUN" ] || {
    echo "error: bun is required to inspect Tailscale serve ownership before publishing" >&2
    return 1
  }
  if ! status_json="$(tailscale serve status --json 2>/dev/null)"; then
    echo "error: cannot inspect Tailscale serve status; refusing to overwrite the root mount on :${port}" >&2
    return 1
  fi
  if ! result="$(
    printf '%s' "$status_json" |
      COLLIE_SERVE_PORT="$port" COLLIE_SERVE_PROTOCOL="$protocol" "$BUN" -e '
        let data = "";
        process.stdin.on("data", chunk => data += chunk).on("end", () => {
          try {
            const config = JSON.parse(data || "{}");
            const port = process.env.COLLIE_SERVE_PORT;
            const protocol = process.env.COLLIE_SERVE_PROTOCOL;
            const hasRoot = serveConfig =>
              Object.entries(serveConfig?.Web ?? {}).some(([hostPort, server]) => {
                const match = hostPort.match(/:(\d+)$/);
                const handlers = server?.Handlers ?? {};
                return match?.[1] === port && Object.prototype.hasOwnProperty.call(handlers, "/");
              }) ||
              Object.values(serveConfig?.Foreground ?? {}).some(hasRoot);
            const hasProtocolMismatch = serveConfig => {
              const listener = serveConfig?.TCP?.[port];
              const mismatch = listener !== undefined &&
                (protocol === "http" ? listener?.HTTP !== true : listener?.HTTPS !== true);
              return mismatch ||
                Object.values(serveConfig?.Foreground ?? {}).some(hasProtocolMismatch);
            };
            if (hasProtocolMismatch(config)) {
              process.stdout.write("protocol-mismatch");
              return;
            }
            const occupied = hasRoot(config);
            process.stdout.write(occupied ? "occupied" : "free");
          } catch {
            process.exitCode = 2;
          }
        });
      '
  )"; then
    echo "error: invalid Tailscale serve status; refusing to overwrite the root mount on :${port}" >&2
    return 1
  fi
  if [ "$result" = "protocol-mismatch" ]; then
    echo "error: Tailscale serve :${port} already uses the opposite listener protocol" >&2
    return 1
  fi
  if [ "$result" = "occupied" ]; then
    echo "error: Tailscale serve already has an unowned root mount on :${port}; refusing to overwrite it" >&2
    return 1
  fi
}

cmd_serve() {
  local cleanup_failed=0 tailscale_host="" expected_proxy=""
  case "$FRONT_DOOR" in
    proxy)
      stop_tailscale_serve || cleanup_failed=1
      stop_netbird_expose || cleanup_failed=1
      [ "$cleanup_failed" -eq 0 ] || return 1
      echo "managed serve skipped (COLLIE_FRONT_DOOR=proxy) — bridge is on 127.0.0.1:${PORT} only"
      return
      ;;
    netbird)
      stop_tailscale_serve || return 1
      cmd_netbird_serve
      return
      ;;
    tailscale)
      stop_netbird_expose || return 1
      stop_tailscale_serve || return 1
      ;;
    *)
      stop_tailscale_serve >/dev/null 2>&1 || true
      stop_netbird_expose >/dev/null 2>&1 || true
      echo "error: unknown COLLIE_FRONT_DOOR=${FRONT_DOOR} (expected tailscale, netbird, or proxy)" >&2
      return 1
      ;;
  esac
  command -v tailscale >/dev/null || {
    echo "error: tailscale not found; cannot publish the selected Tailscale front door" >&2
    return 1
  }
  tailscale_host="$(self_dnsname)"
  if [ -z "$tailscale_host" ]; then
    echo "error: cannot determine Tailscale hostname; refusing to publish an untrackable root mount" >&2
    return 1
  fi
  expected_proxy="http://127.0.0.1:${PORT}"
  local out="${CONFIG_DIR}/serve.out"
  if [ "$SERVE_MODE" = "http" ]; then
    ensure_tailscale_root_available "$PORT" http || return 1
    printf '%s|%s|%s\n' "http:${PORT}" "${tailscale_host}:${PORT}" "$expected_proxy" > "$TAILSCALE_HANDLER_FILE"
    if tailscale serve --bg --http="$PORT" --set-path=/ "$PORT" >"$out" 2>&1; then
      echo "tailscale serve (http) → tailnet :${PORT} -> 127.0.0.1:${PORT}"
    else
      rm -f "$TAILSCALE_HANDLER_FILE"
      echo "note: tailscale serve failed (try 'sudo tailscale set --operator=\$USER'):"
      cat "$out"
      return 1
    fi
  else
    ensure_tailscale_root_available 443 https || return 1
    printf '%s|%s|%s\n' "https:443" "${tailscale_host}:443" "$expected_proxy" > "$TAILSCALE_HANDLER_FILE"
    if tailscale serve --bg --set-path=/ "$PORT" >"$out" 2>&1; then
      echo "tailscale serve (https) → tailnet :443 -> 127.0.0.1:${PORT}"
    else
      rm -f "$TAILSCALE_HANDLER_FILE"
      echo "note: tailscale serve (https) failed — on Headscale/.internal domains use COLLIE_SERVE_MODE=http:"
      cat "$out"
      return 1
    fi
  fi
}

# Remove Collie's managed ingress from both supported front-door implementations. This is deliberately
# not `tailscale serve reset`, which would wipe every unrelated mapping on the host.
cmd_unserve() {
  local failed=0
  stop_tailscale_serve || failed=1
  stop_netbird_expose || failed=1
  return "$failed"
}


cmd_status() {
  print_status_banner
  case "$FRONT_DOOR" in
    proxy)
      echo "  serve config: skipped (COLLIE_FRONT_DOOR=proxy)"
      ;;
    netbird)
      echo "  netbird expose:"
      if have_systemd; then
        echo "    service $(systemctl --user is-active "$NETBIRD_EXPOSE_UNIT" 2>/dev/null || echo inactive)"
      elif netbird_expose_running; then
        echo "    pid     $(cat "$NETBIRD_EXPOSE_PID" 2>/dev/null)"
      elif [ -f "$NETBIRD_EXPOSE_PID" ] || [ -f "$NETBIRD_EXPOSE_IDENTITY" ]; then
        echo "    process stale (stopped or identity mismatch; state retained)"
      else
        echo "    process inactive"
      fi
      echo "    url     $(netbird_bridge_url)"
      [ -f "$NETBIRD_EXPOSE_LOG" ] && tail -n 8 "$NETBIRD_EXPOSE_LOG" | sed 's/^/    /' || true
      ;;
    tailscale)
      echo "  serve config:"; tailscale serve status 2>/dev/null | sed 's/^/    /' || true
      ;;
    *)
      echo "  serve config: unknown COLLIE_FRONT_DOOR=${FRONT_DOOR}"
      ;;
  esac
}

cmd_logs() {
  if have_systemd; then journalctl --user -u "$UNIT" -n "${1:-50}" --no-pager
  else tail -n "${1:-50}" "${CONFIG_DIR}/collie.log" 2>/dev/null || echo "(no log)"; fi
}

cmd_version() { collie_version; }

# Fire a one-off Web Push to every subscribed device — verify push end-to-end without waiting for an
# agent to actually block. Delegates to scripts/push-test.ts, which reuses the bridge's Push class;
# the plugin .env sourced at the top of this script gives it the VAPID keys. Args: [title] [body] [paneId].
cmd_push_test() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  "$BUN" run "${PLUGIN_ROOT}/scripts/push-test.ts" "$@"
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  uninstall) cmd_uninstall ;;
  update)  cmd_update ;;
  _apply-update) cmd_apply_update ;;  # internal: second half of `update`, run post-pull
  build)   cmd_build ;;
  serve)   cmd_serve; echo "open: $(bridge_url)" ;;
  unserve) cmd_unserve ;;
  status)  cmd_status ;;
  url)     bridge_url ;;
  version) cmd_version ;;
  push-test) shift || true; cmd_push_test "$@" ;;
  logs)    cmd_logs "${2:-50}" ;;
  *) echo "usage: collie-ctl.sh {start|stop|restart|uninstall|update|version|push-test|build|serve|unserve|status|url|logs}" >&2; exit 2 ;;
esac
