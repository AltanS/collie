import { describe, expect, test } from "bun:test";

import { WINDOWS_KILL_TIMEOUT_MS, windowsTreeKill, type KillSpawn } from "./tree-kill.ts";

// The Windows tree kill (bridge/tree-kill.ts), shared by the trick runner and the local STT command. Its
// two programs start through a seam here, so the order and the limits are proven on any host; the real
// kill runs in the Windows VM through bridge/tricks/run.test.ts and bridge/stt/local-cli.test.ts.

describe("windowsTreeKill", () => {
  test("taskkill first, then the child itself, then the orphan pass, each by absolute path with a time limit", async () => {
    const steps: string[] = [];
    const spawn: KillSpawn = (argv, opts) => {
      steps.push(`${argv[0] ?? ""} ${String(opts.timeoutMs)}`);
      return { exited: Promise.resolve(0) };
    };
    await windowsTreeKill(4242, { startedAt: 1_000, env: { SystemRoot: "C:\\Win" }, leader: () => steps.push("leader"), spawn });
    expect(steps).toEqual([
      `C:\\Win\\System32\\taskkill.exe ${String(WINDOWS_KILL_TIMEOUT_MS)}`,
      "leader",
      `C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe ${String(WINDOWS_KILL_TIMEOUT_MS)}`,
    ]);
  });

  test("never throws: a kill program that cannot start still ends the child, and the orphan pass still runs", async () => {
    const steps: string[] = [];
    const spawn: KillSpawn = (argv) => {
      steps.push(argv[0]?.endsWith("taskkill.exe") === true ? "taskkill" : "orphans");
      throw new Error("ENOENT");
    };
    await windowsTreeKill(1, { startedAt: 0, env: {}, leader: () => steps.push("leader"), spawn });
    expect(steps).toEqual(["taskkill", "leader", "orphans"]);
    // A leader that throws does not reject the promise either.
    expect(
      await windowsTreeKill(1, {
        startedAt: 0,
        env: {},
        leader: () => {
          throw new Error("gone");
        },
        spawn: () => ({ exited: Promise.resolve(0) }),
      }),
    ).toBeUndefined();
  });

  test("a child that exited already gets only the orphan pass: no taskkill on a pid that may be another process's now", async () => {
    const steps: string[] = [];
    const spawn: KillSpawn = (argv) => {
      steps.push(argv[0]?.endsWith("taskkill.exe") === true ? "taskkill" : "orphans");
      return { exited: Promise.resolve(0) };
    };
    await windowsTreeKill(9, { startedAt: 0, env: {}, leader: () => steps.push("leader"), spawn, exited: true });
    expect(steps).toEqual(["orphans"]);
  });
});
