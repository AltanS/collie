import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collieBinary, hostFor } from "../bridge/host.ts";
import { capture, fakeFiles, fakeLinkFs } from "./fakes.ts";
import { POWERSHELL_UTF8 } from "./sys.ts";
import { EXIT } from "./io.ts";
import {
  cmdSupervise,
  formatRestartMarker,
  formatTaskRecord,
  GUARD_RETRY_MS,
  GUARD_TRIES,
  type GuardAnswer,
  holdGuardPipe,
  isOwnWindowsProcess,
  isTaskBridge,
  isTaskLauncher,
  type LaunchedBridge,
  LIVENESS_GRACE_MS,
  LIVENESS_INTERVAL_MS,
  LIVENESS_MISSES,
  livenessUrl,
  parseSuperviseArgs,
  parseTaskQuery,
  parseTaskRecord,
  realLiveness,
  HEALTHY_RUN_MS,
  RELAUNCH_DELAY_MAX_MS,
  RELAUNCH_DELAY_MIN_MS,
  RESTART_MARKER_TTL_MS,
  type SuperviseDeps,
  supervisePipeName,
  taskOwner,
  taskQueryScript,
  taskRecordPath,
  taskRestartPath,
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

  test("reads through a byte-order mark, CRLF and padding, and keeps bridge=0 as a record", () => {
    expect(parseTaskRecord("\uFEFFversion=2 launcher=7100 bridge=7200\r\n")).toEqual({ format: 2, launcher: 7100, bridge: 7200 });
    expect(parseTaskRecord("\uFEFF7100|7200\r\n")).toEqual({ format: 1, launcher: 7100, bridge: 7200 });
    expect(parseTaskRecord("  version=2 launcher=7100 bridge=0  \n")).toEqual({ format: 2, launcher: 7100, bridge: 0 });
  });

  test("an empty file, a torn write, an unknown version, two lines or UTF-16 are no record, never a throw", () => {
    for (const bad of [
      "",
      "\uFEFF",
      " \r\n",
      "version=2 launcher=71",
      "version=2 launcher=7100 bri",
      "version=3 launcher=7100 bridge=7200",
      "version=2 launcher=7100 bridge=7200\nversion=2 launcher=7100 bridge=7300",
      "\u0000v\u0000e\u0000r\u0000s\u0000i\u0000o\u0000n\u0000",
      "71\u0000|7200",
    ]) {
      expect(parseTaskRecord(bad)).toBeNull();
    }
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

  test("a binary install's task runs `current\\bin\\collie.exe`, and that is still this install", () => {
    // The process table names the junction path the task started, never the version folder behind it.
    const install = "C:\\Users\\pat\\.collie";
    const root = `${install}\\versions\\1.16.0`;
    const viaCurrent = `"${install}\\current\\bin\\collie.exe" _supervise "COLLIE_PLUGIN_ROOT=${install}\\current"`;
    expect(isTaskLauncher(viaCurrent, 2, root, null, WIN)).toBe(true);
    expect(isTaskLauncher(viaCurrent.replaceAll(".collie", ".other"), 2, root, null, WIN)).toBe(false);
    const query = parseTaskQuery(`Running\r\nC:\\conhost.exe\r\n--headless ${viaCurrent}\r\n`, WIN);
    expect(query === null ? null : taskOwner(query, root, WIN)).toBe("collie");
    const other = parseTaskQuery(`Running\r\nC:\\conhost.exe\r\n--headless D:\\x\\current\\bin\\collie.exe _supervise\r\n`, WIN);
    expect(other === null ? null : taskOwner(other, root, WIN)).toBe("foreign");
    // The bridge the launcher starts runs from the version folder `current` named at that launch.
    expect(isTaskBridge(`"${install}\\versions\\1.15.0\\bin\\collie.exe" _exec-bridge`, root, null, WIN)).toBe(true);
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

  /**
   * A launcher whose bridges exit with `codes` in turn; `null` is a launch that failed outright. A
   * `[code, ms]` pair is a bridge that lived `ms` before it exited; a bare code lived no time at all.
   */
  function launcher(codes: (number | null | [number, number])[], renameFailures: string[] = []) {
    const io = capture();
    const link = fakeLinkFs();
    const files = fakeFiles();
    const writes: string[] = [];
    const launched: { command: readonly string[]; cwd: string; env: Record<string, string>; logPath: string }[] = [];
    const notes: string[] = [];
    const slept: number[] = [];
    let next = 9000;
    let clock = 1_000_000;
    /** Every guard asked for, and what each ask answers in turn; past the list it is `held`. */
    const guards: string[] = [];
    const guardAnswers: GuardAnswer[] = [];
    const rows: Record<number, string> = {};
    const procs = { rows, unknown: false };
    const deps: SuperviseDeps = {
      io,
      files: {
        write: (p, text) => files.write(p, text),
        // `writes` is what a reader of the record could ever see: only what was renamed into place.
        rename(from, to) {
          const failure = renameFailures.shift();
          if (failure !== undefined) throw Object.assign(new Error(`${failure}: rename refused`), { code: failure });
          const text = files.read(from);
          files.rename(from, to);
          if (text !== null) writes.push(text);
        },
        remove: (p) => files.remove(p),
        list: (p) => files.list(p),
        read: (p) => files.read(p),
      },
      host: WIN,
      link,
      pid: 7100,
      env: { Path: "C:\\Windows", COLLIE_PORT: "1" },
      sleep(ms) {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      launch(command, opts): LaunchedBridge | null {
        const step = codes.shift();
        if (step === undefined) throw new Error("the loop launched more bridges than the test scripted");
        launched.push({ command, ...opts });
        if (step === null) return null;
        const [code, lived] = Array.isArray(step) ? step : [step, 0];
        clock += lived;
        return { pid: ++next, exited: Promise.resolve(code) };
      },
      note: (_p, line) => void notes.push(line),
      holdGuard: (pipe) => {
        guards.push(pipe);
        return Promise.resolve(guardAnswers.shift() ?? { kind: "held" });
      },
      // The process table: a pid in `procs` runs that command line, `unknown` does not answer.
      lookup: (pid) => {
        if (procs.unknown) return { kind: "unknown", why: "PowerShell did not answer within 5s" };
        const command = procs.rows[pid];
        return command === undefined ? { kind: "gone" } : { kind: "running", command };
      },
    };
    return { deps, io, files, link, writes, launched, notes, slept, renameFailures, guards, guardAnswers, procs };
  }

  test("relaunches a bridge that fails, after the pause, and stops with one that exits 0", async () => {
    const l = launcher([1, null, 3, 0]);
    expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
    expect(l.launched).toHaveLength(4);
    expect(l.slept).toEqual([5_000, 10_000, 20_000]);
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
    expect(l.notes.join("\n")).toContain("the bridge (pid 9002) exited 3; relaunching in 20s");
    expect(l.notes.join("\n")).toContain("could not start");
  });

  test("backs off from 5 s, doubling to a one-minute cap, and starts over after a bridge that lived", async () => {
    expect([RELAUNCH_DELAY_MIN_MS, RELAUNCH_DELAY_MAX_MS, HEALTHY_RUN_MS]).toEqual([5_000, 60_000, 60_000]);
    const crashLoop = launcher([1, 1, 1, 1, 1, 1, 1, [1, HEALTHY_RUN_MS], 1, [1, HEALTHY_RUN_MS - 1], 0]);
    expect(await cmdSupervise(crashLoop.deps, ARGS)).toBe(EXIT.OK);
    expect(crashLoop.slept).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
      // A bridge that lived a minute: its failure is a fresh one.
      5_000, 10_000,
      // One that lived just under a minute is still part of the loop.
      20_000,
    ]);
  });

  test("a bridge `collie restart` stopped is relaunched at once, three times in a row, with no backoff", async () => {
    const l = launcher([1, 1, 1, 0]);
    const marker = taskRestartPath(CONFIG, null, WIN);
    const launch = l.deps.launch;
    let killed = 0;
    // `collie restart` writes the marker, then kills the bridge; here the first three are killed so.
    l.deps.launch = (command, opts) => {
      const bridge = launch(command, opts);
      if (killed++ < 3) l.files.write(marker, formatRestartMarker(l.deps.now()));
      return bridge;
    };
    expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
    expect(l.launched).toHaveLength(4);
    expect(l.slept).toEqual([]);
    expect(l.notes.filter((n) => n.includes("was stopped by `collie restart`; relaunching now"))).toHaveLength(3);
    expect(l.files.exists(marker)).toBe(false);
  });

  test("a `collie restart` during a long pause relaunches at the next step and starts the ladder again", async () => {
    // Four crashes put the launcher in a 40 s pause. An update's rollback then runs `collie restart`,
    // which finds no bridge to kill and writes only the marker. Its health check waits 30 s.
    const l = launcher([1, 1, 1, 1, 1, 0]);
    l.deps = { ...l.deps, pauseStepMs: 500 };
    const marker = taskRestartPath(CONFIG, null, WIN);
    const sleep = l.deps.sleep;
    let total = 0;
    l.deps.sleep = (ms) => {
      total += ms;
      // 5 + 10 + 20 s of earlier pauses, then 2 s into the fourth one.
      if (total === 37_000) l.files.write(marker, formatRestartMarker(l.deps.now()));
      return sleep(ms);
    };
    expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
    expect(l.launched).toHaveLength(6);
    const steps: number[] = [];
    for (const ms of l.slept) steps.push((steps.at(-1) ?? 0) + ms);
    // The fourth pause ends 2 s in, not after 40 s; the fifth starts again at 5 s.
    expect(steps).toContain(37_000);
    expect(steps.at(-1)).toBe(37_000 + 5_000);
    expect(l.notes.join("\n")).toContain("asked for a relaunch during the pause; relaunching now");
    expect(l.files.exists(marker)).toBe(false);
  });

  describe("liveness (#386)", () => {
    /** One scripted health check: answered, silent, or a probe that throws. */
    type Answer = boolean | "throws";

    /**
     * The first launch is a bridge that runs until a kill takes, or until the test calls `exitFirst`;
     * every later launch follows `codes` as usual. The checks answer `answers` in turn, and the test
     * fails loudly if the launcher checks more often than that. `onProbe` runs before each answer with
     * how many checks came before it. `killsToEnd` is how many kills it takes to end the bridge.
     */
    function watched(
      codes: (number | [number, number])[],
      answers: Answer[],
      opts: { onProbe?: (n: number) => void; killsToEnd?: number } = {},
    ) {
      const l = launcher(codes);
      const launch = l.deps.launch;
      const killed: number[] = [];
      const envs: Readonly<Record<string, string>>[] = [];
      let probes = 0;
      let exit: (code: number) => void = () => {};
      let first = true;
      l.deps.launch = (command, launchOpts) => {
        if (!first) return launch(command, launchOpts);
        first = false;
        l.launched.push({ command, ...launchOpts });
        const exited = new Promise<number>((resolve) => (exit = resolve));
        return {
          pid: 8001,
          exited,
          kill: () => {
            killed.push(8001);
            if (killed.length >= (opts.killsToEnd ?? 1)) exit(1);
          },
        };
      };
      l.deps.liveness = (env) => {
        envs.push(env);
        return () => {
          opts.onProbe?.(probes);
          probes++;
          const answer = answers.shift();
          if (answer === undefined) throw new Error(`the launcher checked more than the ${probes - 1} times the test scripted`);
          return answer === "throws" ? Promise.reject(new Error("socket hang up")) : Promise.resolve(answer);
        };
      };
      return { ...l, killed, envs, probes: () => probes, exitFirst: (code: number) => exit(code) };
    }

    test("a bridge that stops answering is ended after three misses in a row, and relaunched", async () => {
      const l = watched([0], [false, false, false]);
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([8001]);
      expect(l.probes()).toBe(LIVENESS_MISSES);
      expect(l.launched).toHaveLength(2);
      // The grace and a pause between each check come before the kill, and the relaunch then takes
      // the ordinary pause of a bridge that lived, not a crash loop's longer one.
      expect(l.slept.slice(0, 3)).toEqual([LIVENESS_GRACE_MS, LIVENESS_INTERVAL_MS, LIVENESS_INTERVAL_MS]);
      expect(l.slept).toContain(RELAUNCH_DELAY_MIN_MS);
      expect(l.slept.filter((ms) => ms > RELAUNCH_DELAY_MIN_MS && ms < LIVENESS_INTERVAL_MS)).toEqual([]);
      expect(l.notes.join("\n")).toContain("the bridge (pid 8001) did not answer its health check 3 times in a row; ending it so it relaunches");
      // The check is built from the BRIDGE's environment: its command line wins over the launcher's own.
      expect(l.envs).toHaveLength(1);
      expect(l.envs[0]!.COLLIE_PORT).toBe("8787");
    });

    test("an answer resets the count: only misses in a row end the bridge", async () => {
      const l = watched([0], [false, false, true, false, false, false]);
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([8001]);
      expect(l.probes()).toBe(6);
    });

    test("a probe that throws counts as a check that got no answer", async () => {
      const l = watched([0], ["throws", "throws", "throws"]);
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([8001]);
    });

    test("a bridge the kill did not end is ended again at the next silent check", async () => {
      const l = watched([0], [false, false, false, false], { killsToEnd: 2 });
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([8001, 8001]);
      expect(l.launched).toHaveLength(2);
      expect(l.notes.filter((n) => n.includes("did not answer"))).toHaveLength(2);
    });

    test("a bridge that exits while its third check is in flight is not killed", async () => {
      const l = watched([0], [false, false, false], {
        onProbe: (n) => {
          if (n === 2) l.exitFirst(1);
        },
      });
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([]);
      expect(l.notes.join("\n")).not.toContain("did not answer");
      expect(l.notes.join("\n")).toContain("the bridge (pid 8001) exited 1");
    });

    test("a `collie restart` during the checks relaunches at once, and the old checks stop", async () => {
      const marker = taskRestartPath(CONFIG, null, WIN);
      const l = watched([0], [false, false], {
        onProbe: (n) => {
          // `collie restart` writes its marker, then kills the bridge.
          if (n === 1) {
            l.files.write(marker, formatRestartMarker(l.deps.now()));
            l.exitFirst(1);
          }
        },
      });
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([]);
      expect(l.launched).toHaveLength(2);
      expect(l.notes.join("\n")).toContain("was stopped by `collie restart`; relaunching now");
      expect(l.notes.join("\n")).not.toContain("did not answer");
    });

    test("a bridge that exits mid-grace stops the wait at the next step, not at the end of it", async () => {
      const l = watched([], []);
      l.deps = { ...l.deps, pauseStepMs: 500 };
      const sleep = l.deps.sleep;
      let waited = 0;
      l.deps.sleep = (ms) => {
        waited += ms;
        if (waited === 1_500) l.exitFirst(0);
        return sleep(ms);
      };
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      // Wait for the watcher's last step to settle: it stops on its own, never reaching the grace.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(waited).toBeLessThanOrEqual(2_000);
      expect(l.probes()).toBe(0);
    });

    test("a bridge that keeps answering is never ended", async () => {
      const l = watched([], [true, true, true, true, true], {
        onProbe: (n) => {
          if (n === 4) l.exitFirst(0);
        },
      });
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([]);
      expect(l.launched).toHaveLength(1);
      expect(l.notes.join("\n")).not.toContain("did not answer");
    });

    test("a bridge that cannot be asked gets no checks and is left to run", async () => {
      const l = watched([], []);
      l.deps.liveness = () => {
        // The bridge stops on its own a moment later; nothing may have ended it before that.
        setTimeout(() => l.exitFirst(0), 0);
        return null;
      };
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([]);
      expect(l.notes.join("\n")).not.toContain("did not answer");
    });

    test("a configuration that cannot be read is noted, and the bridge is left to run", async () => {
      const l = watched([], []);
      l.deps.liveness = () => {
        setTimeout(() => l.exitFirst(0), 0);
        throw new Error("config.toml: bad TOML");
      };
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.killed).toEqual([]);
      expect(l.notes.join("\n")).toContain("no health checks for this bridge: Error: config.toml: bad TOML");
    });

  });

  describe("livenessUrl", () => {
    const base = { host: "", port: 8787, standbyPort: null, pinsALead: false };

    test("asks the front door on loopback by default, and on the address the bridge bound", () => {
      expect(livenessUrl(base)).toBe("http://127.0.0.1:8787/api/health");
      expect(livenessUrl({ ...base, host: "100.64.0.8" })).toBe("http://100.64.0.8:8787/api/health");
    });

    test("dials loopback for a wildcard bind, which is not an address", () => {
      expect(livenessUrl({ ...base, host: "0.0.0.0" })).toBe("http://127.0.0.1:8787/api/health");
    });

    test("asks a peer at its standby door, and does not ask a peer that has none", () => {
      expect(livenessUrl({ ...base, pinsALead: true, standbyPort: 8790 })).toBe("http://127.0.0.1:8790/standby/health");
      expect(livenessUrl({ ...base, pinsALead: true })).toBeNull();
    });

    test("puts an IPv6 bind in brackets, so a healthy bridge on one is not read as silent", () => {
      expect(livenessUrl({ ...base, host: "fd7a:115c:a1e0::1" })).toBe("http://[fd7a:115c:a1e0::1]:8787/api/health");
    });
  });

  describe("realLiveness, over real HTTP", () => {
    /** A bridge's environment: a home and a config dir of its own, so no real config is read. */
    function bridgeEnv(port: number, configToml?: string) {
      const home = mkdtempSync(join(tmpdir(), "collie-liveness-home-"));
      const configDir = mkdtempSync(join(tmpdir(), "collie-liveness-config-"));
      if (configToml !== undefined) writeFileSync(join(configDir, "config.toml"), configToml);
      return { HOME: home, USERPROFILE: home, HERDR_PLUGIN_CONFIG_DIR: configDir, COLLIE_PORT: String(port) };
    }
    const files = { read: (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null) };

    test("any answer is alive, a 503 included: a cold standby door and a deposed member both answer so", async () => {
      using server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("deposed", { status: 503 }) });
      const probe = realLiveness(bridgeEnv(server.port!), files);
      expect(await probe!()).toBe(true);
    });

    test("a listener that accepts and never answers is a miss, at the end of the budget", async () => {
      // Accepts every connection, reads what it is sent, and never writes a byte back.
      const hung = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      try {
        const started = Date.now();
        expect(await realLiveness(bridgeEnv(hung.port), files, 300)!()).toBe(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      } finally {
        hung.stop(true);
      }
    });

    test("a closed port is a miss", async () => {
      using server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      const port = server.port!;
      server.stop(true);
      expect(await realLiveness(bridgeEnv(port), files, 1_000)!()).toBe(false);
    });

    test("asks the port the BRIDGE's configuration names, read from its own config dir", async () => {
      using server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
      // No COLLIE_PORT word on the command line: the port comes from the bridge's config.toml. The
      // launcher's own environment names a dead port, and must not be the one that is read.
      const { COLLIE_PORT: _drop, ...env } = bridgeEnv(0, `[network]\nport = ${server.port!}\n`);
      const before = process.env.COLLIE_PORT;
      process.env.COLLIE_PORT = "1";
      try {
        expect(await realLiveness(env, files, 1_000)!()).toBe(true);
      } finally {
        if (before === undefined) delete process.env.COLLIE_PORT;
        else process.env.COLLIE_PORT = before;
      }
    });
  });

  describe("one launcher per instance", () => {
    const taken: GuardAnswer = { kind: "taken" };

    test("takes the guard first, named after the instance and the record's path", async () => {
      const l = launcher([0]);
      expect(await cmdSupervise(l.deps, [...ARGS, "--instance", "next"])).toBe(EXIT.OK);
      const pipe = supervisePipeName(taskRecordPath(CONFIG, "next", WIN), "next");
      expect(l.guards).toEqual([pipe]);
      expect(pipe).toMatch(/^\\\\\.\\pipe\\collie-supervise-next-[0-9a-f]{12}$/);
      // Another account's config folder, or the default instance, is another guard.
      expect(supervisePipeName(taskRecordPath("C:\\Users\\kim\\cfg", "next", WIN), "next")).not.toBe(pipe);
      expect(supervisePipeName(taskRecordPath(CONFIG, null, WIN), null)).toContain("collie-supervise-default-");
      // Case does not make a second guard: Windows paths fold case.
      expect(supervisePipeName(RECORD.toUpperCase(), null)).toBe(supervisePipeName(RECORD, null));
    });

    /** The launcher a task of this install runs, as Win32_Process shows its command line. */
    const OUR_LAUNCHER = `"${BINARY}" _supervise HERDR_SOCKET_PATH=x COLLIE_PLUGIN_ROOT=${ROOT}`;

    test("a second launcher yields to a live launcher of this install: one log line, record and bridge untouched", async () => {
      const l = launcher([]);
      l.files.write(RECORD, formatTaskRecord(5000, 5001));
      l.procs.rows[5000] = OUR_LAUNCHER;
      l.guardAnswers.push(...Array.from({ length: GUARD_TRIES }, () => taken));
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.guards).toHaveLength(GUARD_TRIES);
      expect(l.slept).toEqual(Array.from({ length: GUARD_TRIES - 1 }, () => GUARD_RETRY_MS));
      expect(l.launched).toEqual([]);
      expect(l.writes).toEqual([]);
      expect(l.files.read(RECORD)).toBe(formatTaskRecord(5000, 5001));
      expect(l.notes).toEqual(["another Collie launcher (pid 5000) already runs for this instance; this one exits"]);
      expect(l.io.stdout).toEqual([]);
      expect(l.io.stderr).toEqual([]);
    });

    test("a pipe held by anything that is not a live launcher of this install is no reason to stay down", async () => {
      const strangers: [string, (l: ReturnType<typeof launcher>) => void][] = [
        ["no record at all", () => {}],
        ["a record whose launcher is dead", (l) => l.files.write(RECORD, formatTaskRecord(5000, 0))],
        ["a recycled pid that runs something else", (l) => {
          l.files.write(RECORD, formatTaskRecord(5000, 0));
          l.procs.rows[5000] = "C:\\Windows\\notepad.exe";
        }],
        ["a launcher of another install", (l) => {
          l.files.write(RECORD, formatTaskRecord(5000, 0));
          l.procs.rows[5000] = '"D:\\other\\bin\\collie.exe" _supervise COLLIE_PLUGIN_ROOT=D:\\other';
        }],
      ];
      for (const [, arrange] of strangers) {
        const l = launcher([0]);
        arrange(l);
        l.guardAnswers.push(...Array.from({ length: GUARD_TRIES }, () => taken));
        expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
        expect(l.launched).toHaveLength(1);
        expect(l.notes[0]).toBe("another process holds the guard pipe and is not a Collie launcher, running unguarded");
      }
    });

    test("a taken pipe and a process list that does not answer: exit, say so, and let the next try ask again", async () => {
      const l = launcher([]);
      l.files.write(RECORD, formatTaskRecord(5000, 5001));
      l.procs.unknown = true;
      l.guardAnswers.push(...Array.from({ length: GUARD_TRIES }, () => taken));
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.launched).toEqual([]);
      expect(l.notes[0]).toContain("the guard pipe is taken and the process list did not answer");
    });

    // The real pipe, on the one platform that has named pipes of this shape.
    test.skipIf(process.platform !== "win32")("on Windows, a second hold on one pipe name is refused while the first lives", async () => {
      const pipe = `\\\\.\\pipe\\collie-supervise-test-${process.pid}-${Date.now().toString(36)}`;
      expect(await holdGuardPipe(pipe)).toEqual({ kind: "held" });
      expect(await holdGuardPipe(pipe)).toEqual({ kind: "taken" });
    });

    test("a guard a killed launcher still held a moment ago is taken on a later ask", async () => {
      const l = launcher([0]);
      l.guardAnswers.push(taken, taken);
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.guards).toHaveLength(3);
      expect(l.slept).toEqual([GUARD_RETRY_MS, GUARD_RETRY_MS]);
      expect(l.launched).toHaveLength(1);
    });

    test("a guard that cannot be made at all costs a log line, never the bridge", async () => {
      const l = launcher([0]);
      l.guardAnswers.push({ kind: "unguarded", why: "EINVAL: bad pipe" });
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.launched).toHaveLength(1);
      expect(l.notes[0]).toBe("could not take the one-launcher guard (EINVAL: bad pipe); running without it");
    });
  });

  test("before every launch, the asides of the binary it launches are swept", async () => {
    const l = launcher([0]);
    const aside = `${BINARY}.old-41-a`;
    l.files.write(aside, "an old binary nothing runs");
    expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
    expect(l.files.exists(aside)).toBe(false);
  });

  test("a marker that is too old, or not a time, is consumed and the exit counts as a crash", async () => {
    const marker = taskRestartPath(CONFIG, null, WIN);
    for (const text of [formatRestartMarker(1_000_000 - RESTART_MARKER_TTL_MS - 1), "garbage\n"]) {
      const l = launcher([1, 0]);
      l.files.write(marker, text);
      expect(await cmdSupervise(l.deps, ARGS)).toBe(EXIT.OK);
      expect(l.slept).toEqual([RELAUNCH_DELAY_MIN_MS]);
      expect(l.files.exists(marker)).toBe(false);
    }
  });

  test("writes the record through a temporary file and a rename, leaving no temporary file behind", async () => {
    const l = launcher([1, 0]);
    await cmdSupervise(l.deps, ARGS);
    expect(l.writes).toEqual([
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 9001),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 0),
      formatTaskRecord(7100, 9002),
    ]);
    expect([...l.files.entries.keys()].filter((k) => k.endsWith(".tmp"))).toEqual([]);
  });

  test("a record Windows holds open is retried, and one that never frees up is skipped, not fatal", async () => {
    const busy = launcher([0], ["EBUSY", "EPERM"]);
    expect(await cmdSupervise(busy.deps, ARGS)).toBe(EXIT.OK);
    expect(busy.slept).toEqual([50, 100]);
    expect(busy.writes[0]).toBe(formatTaskRecord(7100, 0));

    const stuck = launcher([0], ["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
    expect(await cmdSupervise(stuck.deps, ARGS)).toBe(EXIT.OK);
    // The bridge was still launched: a record that cannot be written costs a log line, not the bridge.
    expect(stuck.launched).toHaveLength(1);
    expect(stuck.notes.join("\n")).toContain("could not write");
    expect([...stuck.files.entries.keys()].filter((k) => k.endsWith(".tmp"))).toEqual([]);

    // Any other failure is not waited on.
    const gone = launcher([0], ["ENOENT"]);
    expect(await cmdSupervise(gone.deps, ARGS)).toBe(EXIT.OK);
    expect(gone.slept).toEqual([]);
    expect(gone.notes.join("\n")).toContain("could not write");
  });

  test("logs the exact program it launches, on every launch", async () => {
    const l = launcher([1, null, 0]);
    await cmdSupervise(l.deps, ARGS);
    expect(l.notes.filter((n) => n.startsWith("launching "))).toEqual([
      `launching ${BINARY} _exec-bridge in ${ROOT}`,
      `launching ${BINARY} _exec-bridge in ${ROOT}`,
      `launching ${BINARY} _exec-bridge in ${ROOT}`,
    ]);
  });

  test("on a binary install, reads `current` again before every launch and never keeps the answer", async () => {
    const install = "C:\\Users\\pat\\.collie";
    const current = `${install}\\current`;
    const at = (v: string): string => `${install}\\versions\\${v}`;
    const l = launcher([1, 0]);
    l.link.entries.set(current, { kind: "symlink", target: at("1.15.0") });
    const launch = l.deps.launch;
    // `collie update` moves the junction while the first bridge runs; its `restart` then kills it.
    l.deps.launch = (command, opts) => {
      const bridge = launch(command, opts);
      l.link.entries.set(current, { kind: "symlink", target: at("1.16.0") });
      return bridge;
    };
    const args = [`COLLIE_PLUGIN_ROOT=${current}`, `HERDR_PLUGIN_CONFIG_DIR=${CONFIG}`];
    expect(await cmdSupervise(l.deps, args)).toBe(EXIT.OK);
    expect(l.launched.map((run) => run.command)).toEqual([
      [collieBinary(at("1.15.0"), WIN), "_exec-bridge"],
      [collieBinary(at("1.16.0"), WIN), "_exec-bridge"],
    ]);
    // The bridge's root is the version folder, as the systemd unit and the plist give it.
    expect(l.launched.map((run) => [run.cwd, run.env.COLLIE_PLUGIN_ROOT])).toEqual([
      [at("1.15.0"), at("1.15.0")],
      [at("1.16.0"), at("1.16.0")],
    ]);
    expect(l.notes.filter((n) => n.startsWith("launching "))[1]).toBe(
      `launching ${collieBinary(at("1.16.0"), WIN)} _exec-bridge in ${at("1.16.0")}`,
    );
  });

  describe("a missing `current` at launch", () => {
    const install = "C:\\Users\\pat\\.collie";
    const current = `${install}\\current`;
    const staged = `${install}\\.current.new`;
    const v = (name: string): string => `${install}\\versions\\${name}`;
    const args = [`COLLIE_PLUGIN_ROOT=${current}`, `HERDR_PLUGIN_CONFIG_DIR=${CONFIG}`];

    test("finishes an interrupted flip when `.current.new` is there, then launches what it names", async () => {
      const l = launcher([0]);
      l.link.entries.set(staged, { kind: "symlink", target: v("1.16.0") });
      // The fake keeps files and links apart; a real rename moves the junction, so this one does too.
      const rename = l.deps.files.rename;
      l.deps.files.rename = (from, to) => {
        const moved = l.link.entries.get(from);
        if (moved === undefined) return rename(from, to);
        l.link.entries.delete(from);
        l.link.entries.set(to, moved);
      };
      expect(await cmdSupervise(l.deps, args)).toBe(EXIT.OK);
      expect(l.notes.join("\n")).toContain(`finished the interrupted flip: ${staged} is now ${current}`);
      expect(l.launched[0]?.command[0]).toBe(collieBinary(v("1.16.0"), WIN));
    });

    test("with neither name, says so loudly, guesses nothing, and launches nothing that could be wrong", async () => {
      const l = launcher([null, 0]);
      l.files.write(`${v("1.15.0")}\\bin\\collie.exe`, "");
      l.files.write(`${v("1.16.0")}\\bin\\collie.exe`, "");
      const launch = l.deps.launch;
      // The operator repairs it during the backoff pause.
      l.deps.launch = (command, opts) => {
        const bridge = launch(command, opts);
        l.link.entries.set(current, { kind: "symlink", target: v("1.15.0") });
        return bridge;
      };
      expect(await cmdSupervise(l.deps, args)).toBe(EXIT.OK);
      const warning = l.notes.find((n) => n.startsWith("WARNING:")) ?? "";
      expect(warning).toContain("does not guess");
      expect(warning).toContain("1.15.0, 1.16.0");
      expect(warning).toContain(`cmd /c mklink /J "${current}" "${v("<version>")}"`);
      expect(l.link.ops.filter((op) => op.startsWith("junction") || op.startsWith("symlink"))).toEqual([]);
      // The first launch names `current` itself, which fails; no version folder was picked for it.
      expect(l.launched[0]?.command[0]).toBe(collieBinary(current, WIN));
      expect(l.launched[1]?.command[0]).toBe(collieBinary(v("1.15.0"), WIN));
    });
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

  test("off Windows it refuses with one line, writes nothing and launches nothing", async () => {
    for (const platform of ["linux", "darwin"]) {
      const l = launcher([]);
      const deps = { ...l.deps, host: hostFor(platform) };
      expect(await cmdSupervise(deps, ARGS)).toBe(EXIT.USAGE);
      expect(l.io.stderr).toEqual([
        "error: _supervise is the Windows Task Scheduler launcher; here the service manager runs the bridge",
      ]);
      expect(l.io.stdout).toEqual([]);
      expect(l.launched).toHaveLength(0);
      expect(l.files.entries.size).toBe(0);
    }
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

describe("the registered task, read back", () => {
  const CONHOST = "C:\\WINDOWS\\system32\\conhost.exe";
  test("the query is one PowerShell line, the task name quoted for it", () => {
    expect(taskQueryScript("herdr.collie")).toStartWith(
      `${POWERSHELL_UTF8}$t = Get-ScheduledTask -TaskName 'herdr.collie' -ErrorAction Stop;`,
    );
    expect(taskQueryScript("it's")).toContain("-TaskName 'it''s'");
  });

  test("a task under conhost names the program after --headless, and its words", () => {
    const q = parseTaskQuery(`Running\r\n${CONHOST}\r\n--headless "C:\\with space\\bin\\collie.exe" _supervise "A=b c"\r\n`, WIN);
    expect(q).toEqual({ state: "Running", program: "C:\\with space\\bin\\collie.exe", args: ["_supervise", "A=b c"] });
    expect(parseTaskQuery(`Ready\n${BINARY}\n_supervise\n`, WIN)).toEqual({ state: "Ready", program: BINARY, args: ["_supervise"] });
    expect(parseTaskQuery("", WIN)).toBeNull();
  });

  test("whose task: this install's launcher, this checkout's old script, or someone else's", () => {
    const query = (program: string, ...args: string[]) => ({ state: "Ready", program, args });
    expect(taskOwner(query(BINARY, "_supervise", "A=1"), ROOT, WIN)).toBe("collie");
    expect(taskOwner(query(BINARY.toUpperCase(), "_supervise"), ROOT, WIN)).toBe("collie");
    expect(taskOwner(query("C:\\ps\\powershell.exe", "-File", `${ROOT}\\contrib\\windows\\collie-ctl.ps1`, "_exec-bridge"), ROOT, WIN)).toBe("legacy");
    expect(taskOwner(query("D:\\other\\bin\\collie.exe", "_supervise"), ROOT, WIN)).toBe("foreign");
    expect(taskOwner(query("C:\\ps\\powershell.exe", "-File", "D:\\other\\contrib\\windows\\collie-ctl.ps1"), ROOT, WIN)).toBe("foreign");
    expect(taskOwner(query(BINARY, "status"), ROOT, WIN)).toBe("foreign");
    // A binary install's task from an earlier version is still this install's.
    const at = (v: string): string => `C:\\Users\\pat\\.collie\\versions\\${v}`;
    expect(taskOwner(query(collieBinary(at("1.15.0"), WIN), "_supervise"), at("1.16.0"), WIN)).toBe("collie");
  });
});
