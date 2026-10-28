// Pure-logic tests of web/e2e/rig/rig-scope.ts: which cgroup may own a rig, the scope's name, the settings read
// from the environment, how rig.ts splits its command line, and when a failed systemd-run may be replaced by the
// plain spawn. NO systemd, no rig, no /proc read: strings in, values out, so they hold on macOS and Windows too.
// It sits in scripts/ for the reason browser-leg-nightly.test.ts does: `bun test ./scripts` runs it there.
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_PANES,
  DEFAULT_RUNTIME_MAX_SEC,
  DEFAULT_TASKS_MAX,
  DEFAULT_TASKS_MAX_CREW,
  OWNER_MISSES_TO_TEARDOWN,
  SCOPE_NAME,
  daemonScript,
  maxPanes,
  nextOwnerMisses,
  ownerCgroupFrom,
  ownerCheckOf,
  paneCapReached,
  positiveInt,
  scopeRuntimeMaxSec,
  scopeTasksMax,
  scopeUnitName,
  scopeUnitsFrom,
  shouldFallBack,
  sliceFrom,
  splitArgs,
  taskCapWarning,
  type StartObservation,
} from "../web/e2e/rig/rig-scope";

const CLAUDE_SCOPE = "/user.slice/user-1000.slice/user@1000.service/app.slice/claude-4242.scope";

describe("ownerCgroupFrom", () => {
  test("a transient scope such as a Claude session's can own a rig", () => {
    expect(ownerCgroupFrom(`0::${CLAUDE_SCOPE}\n`)).toBe(CLAUDE_SCOPE);
  });

  test("a login session, a desktop app scope and any other scope are no owner: only claude-*.scope is", () => {
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal-1234.scope\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1a2b.scope\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1a2b.scope\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/rig-0123abcd-5.scope\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/claude-.scope\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/claude-4242.service\n")).toBeNull();
  });

  test("a service, a bare slice and the root cgroup are no owner", () => {
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice/user@1000.service/app.slice/herdr.service\n")).toBeNull();
    expect(ownerCgroupFrom("0::/user.slice/user-1000.slice\n")).toBeNull();
    expect(ownerCgroupFrom("0::/\n")).toBeNull();
  });

  test("a cgroup v1 listing (no 0:: line) and an empty text give none", () => {
    expect(ownerCgroupFrom("12:pids:/user.slice\n1:name=systemd:/user.slice/foo.scope\n")).toBeNull();
    expect(ownerCgroupFrom("")).toBeNull();
  });

  test("the 0:: line is found among others", () => {
    expect(ownerCgroupFrom(`1:name=systemd:/x\n0::${CLAUDE_SCOPE}\n`)).toBe(CLAUDE_SCOPE);
  });
});

describe("the owner check", () => {
  test("only ENOENT is gone; any other error is ignored", () => {
    expect(ownerCheckOf("ENOENT")).toBe("gone");
    expect(ownerCheckOf("EACCES")).toBe("unknown");
    expect(ownerCheckOf("EMFILE")).toBe("unknown");
    expect(ownerCheckOf(undefined)).toBe("unknown");
  });

  test("the rig goes down at the second miss in a row, not the first", () => {
    let misses = 0;
    misses = nextOwnerMisses(misses, "gone");
    expect(misses).toBeLessThan(OWNER_MISSES_TO_TEARDOWN);
    misses = nextOwnerMisses(misses, "gone");
    expect(misses).toBeGreaterThanOrEqual(OWNER_MISSES_TO_TEARDOWN);
  });

  test("a present owner resets the count, and an unknown answer changes nothing", () => {
    expect(nextOwnerMisses(1, "present")).toBe(0);
    expect(nextOwnerMisses(1, "unknown")).toBe(1);
    expect(nextOwnerMisses(0, "unknown")).toBe(0);
  });
});

describe("scopeUnitName", () => {
  test("rig-<8 hex>-<pid>.scope, the form rig.ts will stop", () => {
    const name = scopeUnitName("/home/u/.cache/collie-lab/browser-leg-state", 31337);
    expect(name).toMatch(/^rig-[0-9a-f]{8}-31337\.scope$/);
    expect(SCOPE_NAME.test(name)).toBe(true);
  });

  test("the hash follows the state root, the pid follows the caller", () => {
    expect(scopeUnitName("/a", 1).slice(0, 12)).toBe(scopeUnitName("/a", 2).slice(0, 12));
    expect(scopeUnitName("/a", 1).slice(0, 12)).not.toBe(scopeUnitName("/b", 1).slice(0, 12));
  });

  test("SCOPE_NAME refuses a session's scope and a path", () => {
    expect(SCOPE_NAME.test("claude-1234.scope")).toBe(false);
    expect(SCOPE_NAME.test("rig-abcd1234-1.scope/../x")).toBe(false);
    expect(SCOPE_NAME.test("rig-abcd1234-1.service")).toBe(false);
  });
});

describe("scopeUnitsFrom", () => {
  const ROOT = "/state/root/a";
  const mine = scopeUnitName(ROOT, 4242);
  const other = scopeUnitName("/state/root/b", 4243);

  test("lists this root's scopes from list-units output, whatever the columns", () => {
    const out = `${mine} loaded active running  /usr/bin/bun\n${scopeUnitName(ROOT, 99)} loaded active abandoned /usr/bin/bun\n`;
    expect(scopeUnitsFrom(out, ROOT)).toEqual([mine, scopeUnitName(ROOT, 99)]);
  });

  test("another root's scope, a session scope and stray words are left alone", () => {
    const out = `${other} loaded active running x\nsession-3.scope loaded active running y\nrig-${"0".repeat(8)}-1.scope loaded active running z\n${mine}.bak loaded\nnot a unit\n`;
    expect(scopeUnitsFrom(out, ROOT)).toEqual([]);
  });

  test("empty output, blank lines, leading blanks and a repeated line", () => {
    expect(scopeUnitsFrom("", ROOT)).toEqual([]);
    expect(scopeUnitsFrom("\n\n", ROOT)).toEqual([]);
    expect(scopeUnitsFrom(`  ${mine} loaded active running\n${mine} loaded active running\n`, ROOT)).toEqual([mine]);
  });
});

describe("the settings read from the environment", () => {
  test("positiveInt takes plain digits only", () => {
    expect(positiveInt("700")).toBe(700);
    for (const bad of [undefined, "", "0", "-3", "7.5", "1e3", "0x10", " 5", "5 ", "abc", "007", "99999999999999999999"]) expect(positiveInt(bad)).toBeUndefined();
  });

  test("COLLIE_RIG_TASKS_MAX overrides the solo and the crew default alike", () => {
    expect(scopeTasksMax(undefined, false)).toBe(DEFAULT_TASKS_MAX);
    expect(scopeTasksMax(undefined, true)).toBe(DEFAULT_TASKS_MAX_CREW);
    expect(scopeTasksMax("900", false)).toBe(900);
    expect(scopeTasksMax("900", true)).toBe(900);
    expect(scopeTasksMax("lots", true)).toBe(DEFAULT_TASKS_MAX_CREW);
    expect(scopeTasksMax("0", false)).toBe(DEFAULT_TASKS_MAX);
  });

  test("COLLIE_RIG_MAX_PANES: a positive integer, else 6", () => {
    expect(maxPanes(undefined)).toBe(DEFAULT_MAX_PANES);
    expect(DEFAULT_MAX_PANES).toBe(6);
    expect(maxPanes("2")).toBe(2);
    expect(maxPanes("0")).toBe(6);
    expect(maxPanes("-1")).toBe(6);
    expect(maxPanes("many")).toBe(6);
  });

  test("COLLIE_RIG_RUNTIME_MAX_SEC: a positive integer, else 6 hours", () => {
    expect(scopeRuntimeMaxSec(undefined)).toBe(DEFAULT_RUNTIME_MAX_SEC);
    expect(DEFAULT_RUNTIME_MAX_SEC).toBe(6 * 3600);
    expect(scopeRuntimeMaxSec("120")).toBe(120);
    expect(scopeRuntimeMaxSec("0")).toBe(DEFAULT_RUNTIME_MAX_SEC);
    expect(scopeRuntimeMaxSec("1h")).toBe(DEFAULT_RUNTIME_MAX_SEC);
  });

  test("COLLIE_RIG_SLICE: a slice name, else none (systemd picks its default slice)", () => {
    expect(sliceFrom(undefined)).toBeNull();
    expect(sliceFrom("")).toBeNull();
    expect(sliceFrom("rig.slice")).toBe("rig.slice");
    expect(sliceFrom("my-group_1.sub@x:y.slice")).toBe("my-group_1.sub@x:y.slice");
    for (const bad of ["rig", "rig.service", ".slice", "a b.slice", "a/b.slice", "rig.slice\n", "rig.slice;x", "$(id).slice", "--slice=x.slice"]) expect(sliceFrom(bad)).toBeNull();
  });
});

describe("daemonScript", () => {
  test("core dumps are off by default and kept with COLLIE_RIG_CORES=1", () => {
    expect(daemonScript(false)).toContain("ulimit -c 0");
    expect(daemonScript(true)).not.toContain("ulimit");
  });

  test("the daemon's stderr joins its stdout, so systemd-run.err holds only systemd-run's words", () => {
    expect(daemonScript(true).startsWith("exec 2>&1;")).toBe(true);
    expect(daemonScript(false).endsWith('exec "$0" "$@"')).toBe(true);
  });
});

describe("splitArgs", () => {
  test("flags before the command count; the command is left whole", () => {
    expect(splitArgs(["pane", "--replace", "sleep", "600"])).toMatchObject({ verb: "pane", rest: ["sleep", "600"], replace: true, crew: false, on: null });
    expect(splitArgs(["pane", "--crew", "--on", "member", "--replace", "sleep", "600"])).toMatchObject({ rest: ["sleep", "600"], replace: true, crew: true, on: "member" });
  });

  test("flags after the command's first word reach the pane", () => {
    expect(splitArgs(["pane", "sh", "-c", "echo --replace"])).toMatchObject({ rest: ["sh", "-c", "echo --replace"], replace: false });
    expect(splitArgs(["pane", "sleep", "600", "--replace"])).toMatchObject({ rest: ["sleep", "600", "--replace"], replace: false });
    expect(splitArgs(["pane", "echo", "--crew", "--on", "member"])).toMatchObject({ rest: ["echo", "--crew", "--on", "member"], crew: false, on: null });
  });

  test("a literal -- ends the flags, and is not passed on", () => {
    const s = splitArgs(["pane", "--replace", "--", "sleep", "600", "--replace"]);
    expect(s).toMatchObject({ rest: ["sleep", "600", "--replace"], replace: true, literal: true });
    expect(splitArgs(["pane", "--", "--replace", "x"])).toMatchObject({ rest: ["--replace", "x"], replace: false });
  });

  test("-- makes ls and close an ordinary command", () => {
    expect(splitArgs(["pane", "--", "ls", "-la"])).toMatchObject({ rest: ["ls", "-la"], literal: true });
    expect(splitArgs(["pane", "ls", "-la"])).toMatchObject({ rest: ["ls", "-la"], literal: false });
  });

  test("pane ls and pane close keep their flags: --on may follow them", () => {
    expect(splitArgs(["pane", "ls", "--on", "member"])).toMatchObject({ rest: ["ls"], on: "member" });
    expect(splitArgs(["pane", "close", "w3:p1", "--on", "member"])).toMatchObject({ rest: ["close", "w3:p1"], on: "member" });
    expect(splitArgs(["pane", "close", "--all", "--crew"])).toMatchObject({ rest: ["close", "--all"], crew: true });
  });

  test("the other verbs read their flags anywhere", () => {
    expect(splitArgs(["up", "--crew"])).toMatchObject({ verb: "up", crew: true, rest: [] });
    expect(splitArgs(["start", "omp", "--on", "member", "--replace"])).toMatchObject({ verb: "start", rest: ["omp"], on: "member", replace: true });
    expect(splitArgs(["--crew", "status"])).toMatchObject({ verb: "status", crew: true });
    expect(splitArgs(["read", "w1:p1", "40", "--on", "member"])).toMatchObject({ rest: ["w1:p1", "40"], on: "member" });
  });

  test("other flags stay where they are, and --on with no value is an empty word for the caller to refuse", () => {
    expect(splitArgs(["crew", "start-member", "--env", "COLLIE_WALKY=off"])).toMatchObject({ verb: "crew", rest: ["start-member", "--env", "COLLIE_WALKY=off"] });
    expect(splitArgs(["start", "pi", "--on"])).toMatchObject({ on: "" });
  });

  test("no arguments: no verb", () => {
    expect(splitArgs([])).toMatchObject({ verb: undefined, rest: [] });
  });
});

describe("paneCapReached", () => {
  test("the pane at the cap is refused, one under it is not", () => {
    expect(paneCapReached(5, 6)).toBe(false);
    expect(paneCapReached(6, 6)).toBe(true);
    expect(paneCapReached(9, 6)).toBe(true);
    expect(paneCapReached(0, 1)).toBe(false);
  });
});

describe("shouldFallBack: the plain spawn replaces systemd-run only when systemd-run itself failed", () => {
  const BUS = "Failed to connect to bus: No medium found\n";
  const failed: StartObservation = { exited: { code: 1, afterMs: 120 }, spawnFailed: false, daemonWrote: false, stderr: BUS };

  test("a quick non-zero exit with a bus error and no rig.json falls back", () => {
    expect(shouldFallBack(failed)).toBe(true);
    expect(shouldFallBack({ ...failed, exited: { code: null, afterMs: 100 } })).toBe(true);
  });

  test("a systemd-run that could not even be spawned falls back", () => {
    expect(shouldFallBack({ ...failed, exited: null, spawnFailed: true, stderr: "" })).toBe(true);
  });

  test("a child still alive is no failure", () => {
    expect(shouldFallBack({ ...failed, exited: null })).toBe(false);
  });

  test("an exit after 1.5 s is the daemon's, not systemd-run's", () => {
    expect(shouldFallBack({ ...failed, exited: { code: 1, afterMs: 1500 } })).toBe(true);
    expect(shouldFallBack({ ...failed, exited: { code: 1, afterMs: 1501 } })).toBe(false);
  });

  test("a daemon that wrote rig.json is never replaced", () => {
    expect(shouldFallBack({ ...failed, daemonWrote: true })).toBe(false);
  });

  test("an exit with no stderr, or with the 'Running scope' line, ran the daemon: no second one", () => {
    expect(shouldFallBack({ ...failed, stderr: "" })).toBe(false);
    expect(shouldFallBack({ ...failed, stderr: "  \n" })).toBe(false);
    expect(shouldFallBack({ ...failed, stderr: "Running scope as unit: rig-abcd1234-1.scope\n" })).toBe(false);
    expect(shouldFallBack({ ...failed, stderr: "Running as unit: rig-abcd1234-1.scope; invocation ID: 3f3bddc6\n" })).toBe(false);
    expect(shouldFallBack({ ...failed, stderr: `Running scope as unit: rig-abcd1234-1.scope\n${BUS}` })).toBe(false);
  });

  test("a clean exit is never a fallback", () => {
    expect(shouldFallBack({ ...failed, exited: { code: 0, afterMs: 50 } })).toBe(false);
  });
});

describe("taskCapWarning", () => {
  test("no warning when pids.max is the cap asked for", () => {
    expect(taskCapWarning("700\n", 700)).toBeNull();
  });

  test("a different number, max and an unreadable file each give one warning line", () => {
    for (const read of ["max", "1000", "", null]) {
      const line = taskCapWarning(read, 700);
      expect(line).toContain("WARNING");
      expect(line).toContain("not enforced");
      expect(line).not.toContain("\n");
    }
  });
});
