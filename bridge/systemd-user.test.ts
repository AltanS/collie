import { describe, expect, test } from "bun:test";

import { systemdUserSession, type SystemctlProbe } from "./systemd-user.ts";

// The predicate the CLI's supervision/handoff and the bridge's update spawn both read. The cases are
// the ones the real hosts produce: a healthy bus, a container with the binaries and no manager, a
// Herdr action's bare environment (#194), and the CLI's rule that an operator's own
// `XDG_RUNTIME_DIR` is never overridden by the retry.

/** A probe that answers from a script, recording the envAdd each attempt carried. */
function recorder(answer: (envAdd: Readonly<Record<string, string>> | null) => { found?: boolean; code: number }) {
  const attempts: (Readonly<Record<string, string>> | null)[] = [];
  const probe: SystemctlProbe = (envAdd) => {
    attempts.push(envAdd);
    const a = answer(envAdd);
    return { found: a.found ?? true, code: a.code };
  };
  return { probe, attempts };
}

describe("systemdUserSession", () => {
  test("a manager that answers first time is reachable with nothing to add", () => {
    const r = recorder(() => ({ code: 0 }));
    expect(systemdUserSession(r.probe, {}, 501)).toEqual({ reachable: true, envAdd: null });
    expect(r.attempts).toEqual([null]);
  });

  test("a bare environment retries once with the derived dir and bus, and hands them back", () => {
    // A Herdr plugin action injects neither variable: the plain probe fails on a healthy host, and
    // only the derived session dir reaches the manager (#194).
    const r = recorder((envAdd) => ({ code: envAdd === null ? 1 : 0 }));
    expect(systemdUserSession(r.probe, {}, 501)).toEqual({
      reachable: true,
      envAdd: { XDG_RUNTIME_DIR: "/run/user/501", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus" },
    });
    expect(r.attempts).toEqual([
      null,
      { XDG_RUNTIME_DIR: "/run/user/501", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus" },
    ]);
  });

  test("a bus address already present is kept, so only the runtime dir is derived", () => {
    const r = recorder((envAdd) => ({ code: envAdd === null ? 1 : 0 }));
    const session = systemdUserSession(r.probe, { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" }, 7);
    expect(session).toEqual({ reachable: true, envAdd: { XDG_RUNTIME_DIR: "/run/user/7" } });
  });

  test("an operator's own XDG_RUNTIME_DIR is never overridden — no retry, and unreachable", () => {
    // The WSLg shape: the variable is set to a live directory no user manager answers on. Retrying
    // over it would be overriding a value the operator (or the host) deliberately set.
    const r = recorder(() => ({ code: 1 }));
    expect(systemdUserSession(r.probe, { XDG_RUNTIME_DIR: "/mnt/wslg/runtime-dir" }, 1000)).toEqual({
      reachable: false,
      envAdd: null,
    });
    expect(r.attempts).toEqual([null]);
  });

  test("container with the binaries and no manager: both attempts fail, and nothing is claimed", () => {
    const r = recorder(() => ({ code: 1 }));
    expect(systemdUserSession(r.probe, {}, 1000)).toEqual({ reachable: false, envAdd: null });
    expect(r.attempts).toHaveLength(2);
  });

  test("a missing systemctl binary is retried like a failed probe, and never reads as reachable", () => {
    const r = recorder(() => ({ found: false, code: 127 }));
    expect(systemdUserSession(r.probe, {}, 1000)).toEqual({ reachable: false, envAdd: null });
    expect(r.attempts).toHaveLength(2);
  });
});
