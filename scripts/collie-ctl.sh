#!/usr/bin/env bash
# Bootstrap shim for Collie. Its ONLY job: make sure `bin/collie` exists, then hand it the argv.
#
# Every verb — start/stop/restart/build/serve/unserve/status/url/qr/version/update/_apply-update/
# _exec-bridge/uninstall/push-test/logs and the pack verbs — is implemented ONCE, in `cli/`, and
# compiled into `bin/collie` (M6/01). Nothing about a systemd unit, a launchd agent, `tailscale
# serve` or a git checkout lives here any more; if you are about to add such a thing, it belongs in
# `cli/`.
#
# Why the plugin's actions still name this script instead of the binary: `herdr-plugin.toml`'s
# `command` strings are FROZEN. On Herdr <0.8.0 a managed install invokes the action set cached at
# install time, so the path in that cache must keep working (ADR 0006) — and README recipes and
# muscle memory spell every verb `collie-ctl.sh <verb>`. Delegating keeps all three true, and gives
# a checkout with no binary yet ONE legible path to getting one.
#
# `update` runs through here like any other verb, and nothing here has to survive it: the shim
# bootstraps (if needed) and `exec`s the binary, whose `cmdUpdate` advances the checkout and then
# re-execs `bun cli/main.ts _apply-update` FROM THE FETCHED SOURCE (cli/update.ts) — so the code that
# rebuilds is always the code that was just pulled, and this file is out of the picture by then.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COLLIE_BIN="${PLUGIN_ROOT}/bin/collie"

# Find Bun on PATH, then in the usual install locations.
#
# This survived the port because it is the BOOTSTRAP's job, not the CLI's: Bun is what compiles the
# binary, so it has to be found before there is a binary to do the finding. Herdr spawns plugin
# actions with a minimal environment — no login shell, so nothing has sourced the line `bun` puts in
# your profile and `~/.bun/bin` is simply absent from PATH. `update` therefore pulled the new commit
# and then failed its build, leaving the checkout AHEAD of the web/dist being served while every
# version string reported the new release — unnoticed across four invocations.
#
# An empty result is still fine: the caller below reports it and exits.
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
# Put it on PATH too, not just in $BUN: `collie build` spawns children that expect to find `bun`
# themselves.
#
# ABSOLUTE paths only. `command -v` reports a shell function or alias as a bare word, so a `bun()`
# in whatever sourced us would resolve to `bun`, whose dirname is `.`, and we would prepend the CWD
# to the PATH every later lookup uses.
case "$BUN" in
  /*)
    BUN_DIR="$(dirname "$BUN")"
    case ":${PATH}:" in
      *":${BUN_DIR}:"*) ;;
      *) PATH="${BUN_DIR}:${PATH}"; export PATH ;;
    esac
    ;;
esac

# Sourced (by scripts/collie-ctl.test.sh) rather than run: define the functions and stop before the
# bootstrap, so a test can exercise resolution without executing anything.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

# The bootstrap. A checkout can legitimately arrive with no binary: `herdr plugin link` never runs
# `[[build]]`, and a fresh clone has an empty `bin/` (the 95 MB artifact is built, never committed).
# Build it from SOURCE with Bun — `cli/main.ts` imports nothing outside the checkout and `node:*`, so
# it runs before `bun install` has ever been run here, and `collie build` then installs both trees,
# typechecks, compiles the binary and builds the PWA, swapping both artifacts in last.
if [ ! -x "$COLLIE_BIN" ]; then
  if [ -z "$BUN" ]; then
    echo "error: no collie binary at ${COLLIE_BIN}, and bun is not installed to build one." >&2
    echo "       Install Bun from https://bun.sh and re-run, or:" >&2
    echo "       herdr plugin action invoke update --plugin herdr.collie" >&2
    exit 1
  fi
  echo "first run — building the collie binary…" >&2
  if ! ( cd "$PLUGIN_ROOT" && "$BUN" run cli/main.ts build ); then
    echo "error: could not build ${COLLIE_BIN}. Fix the build and re-run, or:" >&2
    echo "       herdr plugin action invoke update --plugin herdr.collie" >&2
    exit 1
  fi
  if [ ! -x "$COLLIE_BIN" ]; then
    echo "error: the build reported success but left no binary at ${COLLIE_BIN}." >&2
    exit 1
  fi
fi

# Full argv passthrough, and the environment flows through untouched — COLLIE_INSTANCE,
# COLLIE_PLUGIN_ROOT, SKIP_VERSION_CHECK, SKIP_TYPECHECK and Herdr's injected HERDR_* are all read
# by the CLI itself. `exec` so the binary inherits this pid: nothing here should outlive it, least
# of all under a supervisor watching the pid it spawned.
exec "$COLLIE_BIN" "$@"
