// Whether the systemd USER manager can actually be asked to do something — the question every
// launcher must answer before it chooses a tier.
//
// ── WHY THIS LIVES IN `bridge/` ──────────────────────────────────────────────
// The callers are `cli/lifecycle.ts` (which decides how the bridge is supervised and whether an
// update can hand off through a manager) and `bridge/index.ts` (which decides how the phone's
// update button leaves this process). `cli/` may import from `bridge/`; nothing in `bridge/` may
// import from `cli/`, so the predicate lives here and the CLI wraps it — the same arrangement
// `bridge/tools.ts` already has.
//
// ── WHY "THE BINARY EXISTS" IS NOT THE QUESTION ──────────────────────────────
// A container commonly ships the systemd package without ever running a user instance, and a
// Herdr plugin action spawns with no login shell, so `systemd-run` is on disk while the user bus
// is nowhere. `systemd-run --user` then starts and dies with "Failed to connect to bus: No such
// file or directory" — without ever creating the unit it was asked for. `systemctl --user
// show-environment` succeeding is the fact that says the manager will answer; the presence of a
// binary says nothing. `cli/update.ts`'s `handOff` learned this the hard way, retrying a doomed
// `systemd-run` forever; `bridge/index.ts`'s update spawn still had to.
//
// ── WHY THE RETRY ────────────────────────────────────────────────────────────
// `systemctl --user` locates the manager through `XDG_RUNTIME_DIR` (or `DBUS_SESSION_BUS_ADDRESS`).
// A Herdr plugin action injects neither (`HERDR_SOCKET_PATH` / `HERDR_PLUGIN_CONFIG_DIR` and
// nothing else — no login shell), so a healthy host would fail that probe on this spawn path
// alone (#194). When `env` lacks `XDG_RUNTIME_DIR`, a failed first probe is retried once with a
// derived default (`/run/user/<uid>`, plus a derived `DBUS_SESSION_BUS_ADDRESS` when that is ALSO
// unset) layered under the caller's own environment — never into `process.env`, and never
// overriding a name `env` already carries, so an operator's own value (or the `.env` workaround)
// still wins. The container case is preserved: with no user manager at all, the retry fails too,
// and this still reports false.
//
// What the retry also buys is {@link SystemdUserSession.envAdd}: a caller that goes on to spawn
// `systemd-run` must hand it the SAME session variables, or the client cannot find the very bus
// the probe just reached. That is the half `cli/update.ts` used to drop on the floor.

/** What one `systemctl --user show-environment` answered. */
export interface SystemctlAnswer {
  /** The binary ran. `false` is "not found", which is a different fact from "could not connect". */
  readonly found: boolean;
  readonly code: number;
}

/**
 * Run the probe once. `null` is the first attempt, in the caller's own environment; a record is the
 * derived session variables the retry layers under that environment.
 */
export type SystemctlProbe = (envAdd: Readonly<Record<string, string>> | null) => SystemctlAnswer;

export interface SystemdUserSession {
  /** The user manager answered — not merely that its binaries are installed. */
  readonly reachable: boolean;
  /**
   * The session variables a client needs when the manager was reachable ONLY through the derived
   * default: the caller's own environment carries none, so `systemd-run --user` would fail to find
   * the bus without them. `null` when the caller's environment already reached the manager (or
   * when it did not reach it at all).
   */
  readonly envAdd: Readonly<Record<string, string>> | null;
}

/** `/run/user/<uid>`, and its bus socket when `withBus`. See {@link systemdUserSession}. */
function derivedSessionEnv(uid: number, withBus: boolean) {
  const runtimeDir = { XDG_RUNTIME_DIR: `/run/user/${uid}` };
  if (!withBus) return runtimeDir;
  return { ...runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` };
}

/**
 * Ask the probe whether the user manager is reachable, and answer what a launcher needs: the verdict,
 * and the session variables it must carry when only the derived default reached the manager.
 *
 * The uid is a parameter rather than a `process.getuid()` read so the rule is testable, and so a
 * caller that already resolved one passes it instead of consulting the process twice.
 */
export function systemdUserSession(
  probe: SystemctlProbe,
  env: Readonly<Record<string, string | undefined>>,
  uid: number,
): SystemdUserSession {
  const first = probe(null);
  if (first.found && first.code === 0) return { reachable: true, envAdd: null };
  if (env.XDG_RUNTIME_DIR !== undefined) return { reachable: false, envAdd: null };
  const envAdd = derivedSessionEnv(uid, env.DBUS_SESSION_BUS_ADDRESS === undefined);
  const retried = probe(envAdd);
  return retried.found && retried.code === 0
    ? { reachable: true, envAdd }
    : { reachable: false, envAdd: null };
}
