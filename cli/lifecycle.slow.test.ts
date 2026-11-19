// The slow cases of lifecycle.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { CONFIG, ROOT, type Scripted } from "./fakes.ts";
import { hostFor } from "../bridge/host.ts";
import { EXIT } from "./io.ts";
import { POWERSHELL_UTF8 } from "./sys.ts";
import { cmdRestart } from "./lifecycle.ts";
import { formatTaskRecord, taskRecordPath } from "./task-scheduler.ts";
import { binaryOn, Harness, HarnessOptions, harness } from "./lifecycle.rig.ts";

// On Windows the bridge runs under Task Scheduler: the task runs `collie _supervise`, which runs the
// bridge and records both pids in `collie-processes` (cli/task-scheduler.ts). These cases drive that
// tier with `hostFor("win32")` and fakes: they prove the logic, and the Windows VM proves Windows.
describe("the Task Scheduler tier (Windows)", () => {
  const WIN = hostFor("win32");

  const WIN_BINARY = binaryOn("win32");

  const RECORD = taskRecordPath(CONFIG, null, WIN);

  const OUR_LAUNCHER = `"C:${WIN_BINARY}" _supervise "COLLIE_PLUGIN_ROOT=C:${ROOT}"`;

  const OUR_BRIDGE = `"C:${WIN_BINARY}" _exec-bridge`;

  const V2 = (launcher: number, bridge: number): string => formatTaskRecord(launcher, bridge);

  // What `Get-ScheduledTask` prints for a registered task: the state, the command, the arguments.
  // The query opens with the UTF-8 line (`POWERSHELL_UTF8`), so a non-ASCII path comes back whole.
  const QUERY = `powershell -NoProfile -NonInteractive -Command ${POWERSHELL_UTF8}$t = Get-ScheduledTask`;

  const CONHOST = "C:\\WINDOWS\\system32\\conhost.exe";

  const OUR_TASK_ARGS = `--headless ${WIN_BINARY} _supervise HERDR_SOCKET_PATH=\\\\.\\pipe\\herdr COLLIE_PORT=8787`;

  // The fourth line is the task's Task Scheduler priority: 4 is what `taskXml` writes (#386).
  const taskAnswer = (args: string, state = "Running", priority = "4"): string =>
    `${state}\r\n${CONHOST}\r\n${args}\r\n${priority}\r\n`;

  const WHOAMI: Scripted["answers"] = [
    ["whoami /groups", { stdout: "Mandatory Label\\Medium Mandatory Level Label S-1-16-8192\n" }],
    ["whoami", { stdout: "desk\\pat\r\n" }],
    [QUERY, { stdout: taskAnswer(OUR_TASK_ARGS) }],
  ];

  const windows = (over: HarnessOptions = {}): Harness =>
    harness({
      ...over,
      host: WIN,
      answers: [...(over.answers ?? []), ...WHOAMI],
      files: { [WIN_BINARY]: "", ...over.files },
    });

  describe("restart", () => {
    const running = (over: HarnessOptions = {}): Harness =>
      windows({
        ...over,
        files: { [RECORD]: V2(7100, 7200), ...over.files },
        ps: { 7100: OUR_LAUNCHER, 7200: OUR_BRIDGE, ...over.ps },
      });

    test("a probe that never answers is cut off at the budget: the worst case is the budget", async () => {
      // A 2 s budget, the first second spent after the kill: the one probe left gets one second.
      const h = running({ env: { COLLIE_UPDATE_HEALTH_TIMEOUT_MS: "2000" } });
      let calls = 0;
      h.deps.ready = () => (++calls === 1 ? new Promise<boolean>(() => {}) : Promise.resolve(false));
      const started = performance.now();
      expect(await cmdRestart(h.deps)).toBe(EXIT.FAIL);
      expect(performance.now() - started).toBeLessThan(1_800);
      expect(h.io.stderr.join("\n")).toContain("within 2s");
    });
  });
});

