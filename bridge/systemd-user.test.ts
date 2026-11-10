import { describe, expect, test } from "bun:test";

import {
  insideOwnUnit,
  systemdUserSession,
  systemdUserSessionAsync,
  type SystemctlProbe,
} from "./systemd-user.ts";

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

describe("systemdUserSessionAsync: the same rule, awaited", () => {
  // The bridge's patient second pass (1.28.1 rehearsal d-B). It must answer exactly as the sync rule
  // does for every host above; only the waiting differs.
  const hosts: { name: string; env: Record<string, string>; answer: (envAdd: Readonly<Record<string, string>> | null) => { found?: boolean; code: number } }[] = [
    { name: "first time", env: {}, answer: () => ({ code: 0 }) },
    { name: "derived dir only", env: {}, answer: (e) => ({ code: e === null ? 1 : 0 }) },
    { name: "bus kept", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" }, answer: (e) => ({ code: e === null ? 1 : 0 }) },
    { name: "operator's own dir", env: { XDG_RUNTIME_DIR: "/mnt/wslg/runtime-dir" }, answer: () => ({ code: 1 }) },
    { name: "no manager", env: {}, answer: () => ({ code: 1 }) },
    { name: "no binary", env: {}, answer: () => ({ found: false, code: 127 }) },
    { name: "a timeout", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, answer: () => ({ code: 124 }) },
  ];
  for (const host of hosts) {
    test(`${host.name}: the async answer and attempts equal the sync ones`, async () => {
      const sync = recorder(host.answer);
      const awaited = recorder(host.answer);
      const asyncProbe = (envAdd: Readonly<Record<string, string>> | null) => Promise.resolve(awaited.probe(envAdd));
      expect(await systemdUserSessionAsync(asyncProbe, host.env, 1000)).toEqual(systemdUserSession(sync.probe, host.env, 1000));
      expect(awaited.attempts).toEqual(sync.attempts);
    });
  }
});

describe("insideOwnUnit: is this process in its own service's cgroup?", () => {
  // Real-looking `/proc/self/cgroup` lines. Only the instance's OWN unit is "inside": that is the one
  // cgroup the update stops (KillMode=control-group), so a child left in it dies with the service.
  const USER = "0::/user.slice/user-1000.slice/user@1000.service";
  const rows: { name: string; cgroup: string | null; unit: string; inside: boolean }[] = [
    { name: "a user unit, collie.service", cgroup: `${USER}/app.slice/collie.service\n`, unit: "collie", inside: true },
    { name: "a suffixed user unit, collie-core.service", cgroup: `${USER}/app.slice/collie-core.service\n`, unit: "collie-core", inside: true },
    { name: "another instance's unit is not ours", cgroup: `${USER}/app.slice/collie-core.service\n`, unit: "collie", inside: false },
    { name: "the default unit is not a suffixed instance's", cgroup: `${USER}/app.slice/collie.service\n`, unit: "collie-core", inside: false },
    { name: "a system-level unit of the same name", cgroup: "0::/system.slice/collie.service\n", unit: "collie", inside: true },
    { name: "a login session scope (ssh)", cgroup: "0::/user.slice/user-1000.slice/session-3.scope\n", unit: "collie", inside: false },
    { name: "tmux in an app.slice scope", cgroup: `${USER}/app.slice/tmux-spawn-6f1c2b9e-0d4a-4c1e-9a52-1b2c3d4e5f60.scope\n`, unit: "collie", inside: false },
    { name: "Herdr in a terminal's scope", cgroup: `${USER}/app.slice/app-gnome-ghostty-8514.scope\n`, unit: "collie", inside: false },
    { name: "a herdr-core pane under its holder unit", cgroup: `${USER}/app.slice/hc-hold-fa85289c.service\n`, unit: "collie", inside: false },
    { name: "the bridge's own transient update unit", cgroup: `${USER}/app.slice/collie-api-update-1794290019140.service\n`, unit: "collie", inside: false },
    { name: "the user manager itself", cgroup: `${USER}/init.scope\n`, unit: "collie", inside: false },
    { name: "a leaf that is user@1000.service", cgroup: `${USER}\n`, unit: "collie", inside: false },
    { name: "a container's own root", cgroup: "0::/\n", unit: "collie", inside: false },
    {
      name: "a cgroup v1 host, one line per hierarchy",
      cgroup: [
        "12:pids:/user.slice/user-1000.slice/user@1000.service/app.slice/collie.service",
        "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/collie.service",
        "0::/user.slice/user-1000.slice/user@1000.service/app.slice/collie.service",
        "",
      ].join("\n"),
      unit: "collie",
      inside: true,
    },
    { name: "macOS or Windows: no file", cgroup: null, unit: "collie", inside: false },
    { name: "an empty file", cgroup: "", unit: "collie", inside: false },
  ];
  for (const row of rows) {
    test(`${row.name} → ${row.inside ? "inside" : "not inside"}`, () => {
      expect(insideOwnUnit(row.cgroup, row.unit)).toBe(row.inside);
    });
  }
});
