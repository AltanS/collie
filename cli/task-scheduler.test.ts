import { describe, expect, test } from "bun:test";

import { collieBinary, hostFor } from "../bridge/host.ts";
import { capture, fakeFiles } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdSupervise,
  formatTaskRecord,
  isOwnWindowsProcess,
  isTaskBridge,
  isTaskLauncher,
  type LaunchedBridge,
  parseSuperviseArgs,
  parseTaskRecord,
  RELAUNCH_DELAY_MS,
  type SuperviseDeps,
  taskRecordPath,
} from "./task-scheduler.ts";

// The Windows supervisor's own pieces, driven on Linux with `hostFor("win32")` and fakes. The VM
// proves the spawn, the console and the process table; these prove the logic around them.

const WIN = hostFor("win32");
const ROOT = "C:\\Users\\pat\\collie";
const BINARY = collieBinary(ROOT, WIN);
const CONFIG = "C:\\Users\\pat\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie";

describe("the record", () => {
  test("reads the community script's `<launcher>|<bridge>` as format 1", () => {
    expect(parseTaskRecord("7100|7200")).toEqual({ format: 1, launcher: 7100, bridge: 7200 });
    expect(parseTaskRecord("7100|0\r\n")).toEqual({ format: 1, launcher: 7100, bridge: 0 });
  });

  test("writes and reads its own versioned line", () => {
    const line = formatTaskRecord(7100, 7200);
    expect(line).toBe("version=2 launcher=7100 bridge=7200\n");
    expect(parseTaskRecord(line)).toEqual({ format: 2, launcher: 7100, bridge: 7200 });
  });

  test("anything else says nothing", () => {
    for (const bad of [
      "",
      "not a record",
      "7100|",
      "-1|2",
      "version=3 launcher=1 bridge=2",
      "version=2 launcher=1",
      "version=2 launcher=-1 bridge=2",
      "version=2 launcher=1.5 bridge=2",
      '{"version":2,"launcher":1,"bridge":2}',
    ]) {
      expect(parseTaskRecord(bad)).toBeNull();
    }
  });

  test("sits in the config dir, one per instance, under the name the script used", () => {
    expect(taskRecordPath(CONFIG, null, WIN)).toBe(`${CONFIG}\\collie-processes`);
    expect(taskRecordPath(CONFIG, "v1", WIN)).toBe(`${CONFIG}\\collie-v1-processes`);
  });
});

describe("whose process is this", () => {
  test("our launcher and our bridge, however Windows spells the path", () => {
    expect(isOwnWindowsProcess(`"${BINARY}" _supervise COLLIE_PORT=8787`, BINARY, "_supervise", null)).toBe(true);
    expect(isOwnWindowsProcess(`"${BINARY.toUpperCase()}" _exec-bridge`, BINARY, "_exec-bridge", null)).toBe(true);
    expect(isOwnWindowsProcess(`C:/users/pat/collie/bin/collie.exe _exec-bridge`, BINARY, "_exec-bridge", null)).toBe(true);
    // The role decides: the launcher is not the bridge, and a CLI run is neither.
    expect(isOwnWindowsProcess(`"${BINARY}" _supervise`, BINARY, "_exec-bridge", null)).toBe(false);
    expect(isOwnWindowsProcess(`"${BINARY}" status`, BINARY, "_exec-bridge", null)).toBe(false);
    expect(isOwnWindowsProcess(`"D:\\other\\bin\\collie.exe" _exec-bridge`, BINARY, "_exec-bridge", null)).toBe(false);
  });

  test("the instance marker is checked in both directions", () => {
    const solo = `"${BINARY}" _exec-bridge`;
    const v1 = `"${BINARY}" _exec-bridge --instance v1`;
    expect(isOwnWindowsProcess(solo, BINARY, "_exec-bridge", null)).toBe(true);
    expect(isOwnWindowsProcess(v1, BINARY, "_exec-bridge", null)).toBe(false);
    expect(isOwnWindowsProcess(v1, BINARY, "_exec-bridge", "v1")).toBe(true);
    expect(isOwnWindowsProcess(solo, BINARY, "_exec-bridge", "v1")).toBe(false);
    expect(isOwnWindowsProcess(`"${BINARY}" _exec-bridge --instance v10`, BINARY, "_exec-bridge", "v1")).toBe(false);
  });

  test("a binary install's bridge is recognised across a version flip", () => {
    const at = (v: string): string => `C:\\Users\\pat\\.collie\\versions\\${v}\\bin\\collie.exe`;
    expect(isOwnWindowsProcess(`"${at("1.15.0")}" _exec-bridge`, at("1.16.0"), "_exec-bridge", null)).toBe(true);
    expect(
      isOwnWindowsProcess(`"C:\\Users\\pat\\.other\\versions\\1.15.0\\bin\\collie.exe" _exec-bridge`, at("1.16.0"), "_exec-bridge", null),
    ).toBe(false);
  });

  test("the launcher of each format, and nobody else's", () => {
    const ours = `"${BINARY}" _supervise COLLIE_PLUGIN_ROOT=${ROOT}`;
    const script = `powershell.exe -NoProfile -File "${ROOT}\\contrib\\windows\\collie-ctl.ps1" -TaskConfigDir "${CONFIG}" _exec-bridge`;
    expect(isTaskLauncher(ours, 2, ROOT, null, WIN)).toBe(true);
    expect(isTaskLauncher(script, 1, ROOT, null, WIN)).toBe(true);
    // The format the record names decides which shape is accepted.
    expect(isTaskLauncher(script, 2, ROOT, null, WIN)).toBe(false);
    expect(isTaskLauncher(ours, 1, ROOT, null, WIN)).toBe(false);
    // Another checkout's script, and the script run for another verb.
    expect(isTaskLauncher(script.replace(ROOT, "D:\\other"), 1, ROOT, null, WIN)).toBe(false);
    expect(isTaskLauncher(script.replace("_exec-bridge", "status"), 1, ROOT, null, WIN)).toBe(false);
  });

  test("a bridge in either shape: `collie.exe _exec-bridge`, or Bun running this checkout's bridge", () => {
    expect(isTaskBridge(`"${BINARY}" _exec-bridge`, ROOT, null, WIN)).toBe(true);
    expect(isTaskBridge(`C:\\bun\\bun.exe run "${ROOT}\\bridge\\index.ts"`, ROOT, null, WIN)).toBe(true);
    expect(isTaskBridge(`C:\\bun\\bun.exe run "D:\\other\\bridge\\index.ts"`, ROOT, null, WIN)).toBe(false);
    expect(isTaskBridge("C:\\Windows\\notepad.exe", ROOT, null, WIN)).toBe(false);
  });
});

describe("the launcher's arguments", () => {
  test("an instance and KEY=value words, values kept whole", () => {
    expect(parseSuperviseArgs(["--instance", "v1", "A=1", "COLLIE_PLUGIN_ROOT=C:\\with space\\x", "B=x=y"])).toEqual({
      instance: "v1",
      env: { A: "1", COLLIE_PLUGIN_ROOT: "C:\\with space\\x", B: "x=y" },
    });
    expect(parseSuperviseArgs([])).toEqual({ instance: null, env: {} });
  });

  test("anything else is refused", () => {
    expect(parseSuperviseArgs(["--instance"])).toBeNull();
    expect(parseSuperviseArgs(["start"])).toBeNull();
    expect(parseSuperviseArgs(["=x"])).toBeNull();
  });
});

describe("_supervise, the loop", () => {
  const ARGS = [`COLLIE_PLUGIN_ROOT=${ROOT}`, `HERDR_PLUGIN_CONFIG_DIR=${CONFIG}`, "COLLIE_PORT=8787"];
  const RECORD = taskRecordPath(CONFIG, null, WIN);

  /** A launcher whose bridges exit with `codes` in turn; `null` is a launch that failed outright. */
  function launcher(codes: (number | null)[]) {
    const io = capture();
    const files = fakeFiles();
    const writes: string[] = [];
    const launched: { command: readonly string[]; cwd: string; env: Record<string, string>; logPath: string }[] = [];
    const notes: string[] = [];
    const slept: number[] = [];
    let next = 9000;
    const deps: SuperviseDeps = {
      io,
      files: {
        write(p, text) {
          writes.push(text);
          files.write(p, text);
        },
        remove: (p) => files.remove(p),
      },
      host: WIN,
      pid: 7100,
      env: { Path: "C:\\Windows", COLLIE_PORT: "1" },
      sleep(ms) {
        slept.push(ms);
        return Promise.resolve();
      },
      launch(command, opts): LaunchedBridge | null {
        const code = codes.shift();
        if (code === undefined) throw new Error("the loop launched more bridges than the test scripted");
        launched.push({ command, ...opts });
        return code === null ? null : { pid: ++next, exited: Promise.resolve(code) };
      },
      note: (_p, line) => void notes.push(line),
    };
    return { deps, io, files, writes, launched, notes, slept };
  }

  test("relaunches a bridge that fails, after the pause, and stops with one that exits 0", async () => {
    const l = launcher([1, null, 3, 0]);
    expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
    expect(l.launched).toHaveLength(4);
    expect(l.slept).toEqual([RELAUNCH_DELAY_MS, RELAUNCH_DELAY_MS, RELAUNCH_DELAY_MS]);
    // The record follows every launch: bridge 0 between two, the live pid while one runs.
    expect(l.writes).toEqual([
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 9001),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 9002),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 9003),
    ]);
    // A bridge that chose to stop leaves nothing to own, so no record either.
    expect(l.files.exists(RECORD)).toBe(false);
    expect(l.notes.join("\n")).toContain("the bridge (pid 9001) exited 1; relaunching in 5s");
    expect(l.notes.join("\n")).toContain("could not start");
  });

  test("runs the same bridge every supervisor runs, from the checkout, with its env on top", async () => {
    const l = launcher([0]);
    await cmdSupervise(l.deps, ARGS);
    const [run] = l.launched;
    expect(run?.command).toEqual([BINARY, "_exec-bridge"]);
    expect(run?.cwd).toBe(ROOT);
    expect(run?.logPath).toBe(`${CONFIG}\\collie.log`);
    // The task's words win over what the launcher inherited; the rest of the environment passes.
    expect(run?.env.COLLIE_PORT).toBe("8787");
    expect(run?.env.Path).toBe("C:\\Windows");
  });

  test("a suffixed instance runs its own bridge, record and log", async () => {
    const l = launcher([1, 0]);
    await cmdSupervise(l.deps, ["--instance", "v1", ...ARGS]);
    expect(l.launched[0]?.command).toEqual([BINARY, "_exec-bridge", "--instance", "v1"]);
    expect(l.launched[0]?.logPath).toBe(`${CONFIG}\\collie-v1.log`);
    expect(l.files.exists(taskRecordPath(CONFIG, "v1", WIN))).toBe(false);
    expect(l.writes).toContain(formatTaskRecord(7100, 9001));
  });

  test("refuses to run without the root and the config dir, and launches nothing", async () => {
    for (const args of [[], [`COLLIE_PLUGIN_ROOT=${ROOT}`], [`HERDR_PLUGIN_CONFIG_DIR=${CONFIG}`], ["nonsense"]]) {
      const l = launcher([]);
      expect(await cmdSupervise(l.deps, args)).toBe(EXIT.USAGE);
      expect(l.launched).toHaveLength(0);
      expect(l.io.stderr.join("\n")).toContain("Task Scheduler runs it");
    }
  });
});
