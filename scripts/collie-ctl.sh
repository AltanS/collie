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
# Records the ONE `tailscale serve` root mount Collie published, so teardown can prove the mapping
# it is about to remove is still the one it created. Format: `<mode>:<port>|<HostPort>|<proxy>`.
TAILSCALE_HANDLER_FILE="${CONFIG_DIR}/tailscale-managed-handler"
# Find Bun on PATH, then in the usual install locations.
#
# Herdr spawns plugin actions with a minimal environment — no login shell, so nothing has sourced the
# line `bun` puts in your profile and `~/.bun/bin` is simply absent from PATH. `update` therefore
# pulled the new commit and then failed its build, leaving the checkout AHEAD of the web/dist being
# served while every version string reported the new release. The systemd unit is written with an
# absolute ExecStart, so the running service kept working and the breakage was visible only in the
# plugin log — which is how it went unnoticed across four separate invocations.
#
# An empty result is still fine: callers already report "bun not found" and exit.
resolve_bun() {
  local candidate
  if candidate="$(command -v bun 2>/dev/null)"; then
    printf '%s' "$candidate"
    return 0
  fi
  for candidate in \
    "${BUN_INSTALL:-${HOME}/.bun}/bin/bun" \
    "${HOME}/.bun/bin/bun" \
    "${HOME}/.local/bin/bun" \
    /usr/local/bin/bun \
    /opt/homebrew/bin/bun \
    /usr/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 0
}
BUN="$(resolve_bun)"
# Put it on PATH too, not just in $BUN: this script shells out to a bare `bun` (the Tailscale
# ownership probe), and `bun run build` spawns children that expect to find it themselves.
if [ -n "$BUN" ]; then
  BUN_DIR="$(dirname "$BUN")"
  case ":${PATH}:" in
    *":${BUN_DIR}:"*) ;;
    *) PATH="${BUN_DIR}:${PATH}"; export PATH ;;
  esac
fi
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
  if [ "${COLLIE_SKIP_SERVE:-}" = "1" ]; then
    if [ -n "${COLLIE_PUBLIC_URL:-}" ]; then
      echo "    proxy     ${COLLIE_PUBLIC_URL}"
    else
      echo "    proxy     (COLLIE_SKIP_SERVE=1 — set COLLIE_PUBLIC_URL to your reverse-proxy URL)"
    fi
  else
    echo "    tailnet   $(bridge_url)"
  fi
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
  # A front door that won't come up must not abort `start`. The bridge is already running on
  # loopback, and the banner is what the README's troubleshooting flow tells people to read — under
  # `set -e` a bare `cmd_serve` would exit here and print nothing. cmd_serve reports its own reason.
  cmd_serve || echo "note: the tailnet front door did not come up; the bridge is still on 127.0.0.1:${PORT}" >&2
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

# `tailscale serve … off` for one handler, treating "already gone" as success so teardown is
# idempotent. Any other failure is real and must not be swallowed.
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

# Identify what currently owns the root mount we recorded: "absent", or "<protocol>|proxy:<target>".
# This is the evidence teardown checks before removing anything.
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

# Remove ONLY the mapping Collie recorded as its own — never a blanket `tailscale serve reset`, and
# never a blind `--https=443 off` that could take down a mapping someone else put there. With no
# ownership record there is nothing to remove. If the recorded root has since been replaced, refuse
# and keep the record: a wrong removal here silently unpublishes somebody else's service.
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

# Refuse to publish over a root mount we don't own. `tailscale serve --bg … /` silently REPLACES an
# existing root handler, so without this check a Collie start could unpublish an unrelated service
# that got there first.
#
# "Don't own" is decided by where the mount points, not by our ownership file. Every install that
# predates ownership tracking has Collie's own root mount and NO record of it, so a pure file check
# would refuse to republish on exactly the deployments that already work — bricking start/restart/
# update on upgrade. A root already proxying to our own `http://127.0.0.1:$PORT` is therefore
# adopted: republishing over it is a no-op, and we then record it. A foreground serve session is
# never adopted — it belongs to a live process that is not us.
ensure_tailscale_root_available() {
  local port="$1" protocol="$2" expected_proxy="$3" status_json result
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
      COLLIE_SERVE_PORT="$port" COLLIE_SERVE_PROTOCOL="$protocol" \
      COLLIE_SERVE_EXPECTED_PROXY="$expected_proxy" "$BUN" -e '
        let data = "";
        process.stdin.on("data", chunk => data += chunk).on("end", () => {
          try {
            const config = JSON.parse(data || "{}");
            const port = process.env.COLLIE_SERVE_PORT;
            const protocol = process.env.COLLIE_SERVE_PROTOCOL;
            const expectedProxy = process.env.COLLIE_SERVE_EXPECTED_PROXY;
            // Proxy targets of every root handler bound to our port, in one serve config level.
            const rootTargets = serveConfig =>
              Object.entries(serveConfig?.Web ?? {})
                .filter(([hostPort]) => hostPort.match(/:(\d+)$/)?.[1] === port)
                .map(([, server]) => server?.Handlers ?? {})
                .filter(handlers => Object.prototype.hasOwnProperty.call(handlers, "/"))
                .map(handlers => handlers["/"]?.Proxy);
            const foregroundTargets = serveConfig =>
              Object.values(serveConfig?.Foreground ?? {})
                .flatMap(fg => rootTargets(fg).concat(foregroundTargets(fg)));
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
            if (foregroundTargets(config).length > 0) {
              process.stdout.write("occupied");
              return;
            }
            const targets = rootTargets(config);
            if (targets.length === 0) {
              process.stdout.write("free");
              return;
            }
            process.stdout.write(
              targets.every(target => target === expectedProxy) ? "adoptable" : "occupied");
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
  if [ "$result" = "adoptable" ]; then
    echo "tailscale serve: adopting the existing Collie root mount on :${port}"
  fi
}

cmd_serve() {
  if [ "${COLLIE_SKIP_SERVE:-}" = "1" ]; then
    # Still tear down: skipping teardown would strand a mapping published before the flag was
    # flipped on, leaving the app reachable by a path the operator thinks is closed.
    stop_tailscale_serve || return 1
    echo "tailscale serve skipped (COLLIE_SKIP_SERVE=1) — bridge is on 127.0.0.1:${PORT} only"
    return
  fi
  stop_tailscale_serve || return 1
  command -v tailscale >/dev/null || {
    echo "error: tailscale not found; cannot publish the tailnet front door" >&2
    return 1
  }
  local tailscale_host; tailscale_host="$(self_dnsname)"
  if [ -z "$tailscale_host" ]; then
    echo "error: cannot determine Tailscale hostname; refusing to publish an untrackable root mount" >&2
    return 1
  fi
  local expected_proxy="http://127.0.0.1:${PORT}"
  local out="${CONFIG_DIR}/serve.out"
  if [ "$SERVE_MODE" = "http" ]; then
    ensure_tailscale_root_available "$PORT" http "$expected_proxy" || return 1
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
    ensure_tailscale_root_available 443 https "$expected_proxy" || return 1
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

# The inverse of cmd_serve: remove Collie's own mapping and nothing else.
cmd_unserve() { stop_tailscale_serve; }

cmd_status() {
  print_status_banner
  if [ "${COLLIE_SKIP_SERVE:-}" = "1" ]; then
    echo "  serve config: skipped (COLLIE_SKIP_SERVE=1)"
  else
    echo "  serve config:"; tailscale serve status 2>/dev/null | sed 's/^/    /' || true
  fi
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

# Sourced (by scripts/collie-ctl.test.sh) rather than run: define the functions and stop before the
# dispatch, so a test can call one function in isolation with its dependencies stubbed out.
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
