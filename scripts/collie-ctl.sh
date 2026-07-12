#!/usr/bin/env bash
# Control script for Collie (the Herdr web bridge service). Invoked by the plugin's actions and usable directly.
# The bridge runs as a systemd --user service (NOT a Herdr plugin pane — see ARCHITECTURE.md §3), so it
# survives Herdr restarts and is supervised independently.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="collie"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"
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
  tailscale status --json 2>/dev/null | node -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).Self.DNSName.replace(/\.\$/,''))}catch{}})"
}

bridge_url() {
  local name; name="$(self_dnsname)"
  if [ -z "$name" ]; then echo "http://127.0.0.1:${PORT} (Tailscale name unavailable)"; return; fi
  if [ "$SERVE_MODE" = "http" ]; then echo "http://${name}:${PORT}"; else echo "https://${name}"; fi
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
  echo "    tailnet   $(bridge_url)"
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
      nohup "$BUN" run "${PLUGIN_ROOT}/bridge/index.ts" >>"${CONFIG_DIR}/collie.log" 2>&1 &
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
# systemd --user unit, remove Collie's tailscale serve mapping, and drop the pidfile. Deliberately leaves your
# config (${CONFIG_DIR}/.env) and the on-disk checkout in place — `uninstall` removes only what
# `start` created. To remove the plugin registration too, run `herdr plugin uninstall herdr.collie`
# (or, for a linked clone, just delete the checkout).
cmd_uninstall() {
  cmd_stop
  cmd_unserve
  if have_systemd; then
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed "$UNIT" 2>/dev/null || true
  fi
  rm -f "${CONFIG_DIR}/collie.pid"
  echo "✓ uninstalled: service stopped & disabled, systemd unit removed, Collie's tailscale serve mapping removed"
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

# Remove ONLY Collie's tailscale serve mapping — the inverse of cmd_serve, NOT a blanket
# `tailscale serve reset` (which would wipe every unrelated mapping on the host). We turn off
# exactly the listener cmd_serve created, keyed off the same SERVE_MODE so the two stay symmetric:
# https:443 by default, or http:$PORT in http mode. Best-effort (|| true) so teardown is idempotent
# when the mapping is already gone.
cmd_unserve() {
  command -v tailscale >/dev/null || { echo "note: tailscale not found; no serve mapping to remove"; return; }
  if [ "$SERVE_MODE" = "http" ]; then
    tailscale serve --http="$PORT" off >/dev/null 2>&1 || true
    echo "tailscale serve: removed Collie's http :${PORT} mapping"
  else
    tailscale serve --https=443 off >/dev/null 2>&1 || true
    echo "tailscale serve: removed Collie's https :443 mapping"
  fi
}

cmd_status() {
  print_status_banner
  echo "  serve config:"; tailscale serve status 2>/dev/null | sed 's/^/    /' || true
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
