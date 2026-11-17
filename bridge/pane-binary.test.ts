import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hostFor, WSL_FLAGS } from "./host.ts";
import type { ForegroundProcess } from "./journal/types.ts";
import { piProcessOf } from "./journal/pi.ts";
import { argvFromCmdline, createPaneForeground, createPaneHarness, createPaneProfile, envFromEnviron, createPaneVersion, PANE_LAST_GOOD_MS, paneBinaryOf, paneForegroundOf, paneHarnessOf, SHELL_NAMES, procProbe, profileBinaries, sharedForegroundRead, type ForegroundOutcome, type ProcessProbe } from "./pane-binary.ts";
import { createVersionReader, VersionCache } from "./surface/binary-version.ts";
import { findTool } from "./tools.ts";
import { loadProfiles, type Profile } from "../web/src/lib/surface/profile.ts";

const linux = hostFor("linux");
const binaries: ReadonlyMap<string, string> = new Map([...loadProfiles().values()].map((profile) => [profile.identity.binary.toLowerCase(), profile.id]));
// A pid's own argv, as `/proc/<pid>/cmdline` shows it: a fake process in `ps` runs what Herdr reported of it,
// unless a test says otherwise.
const running = new Map<number, readonly string[]>();
const probe = (exe: string | null, cwd: string | null = null, cmdline?: readonly string[] | null): ProcessProbe => ({
  cmdlineOf: (pid) => (cmdline === undefined ? (running.get(pid) ?? null) : cmdline),
  exeOf: () => exe,
  cwdOf: () => cwd,
});
const ps = (argv: string[], pid?: number): ForegroundProcess => {
  if (pid !== undefined) running.set(pid, argv);
  return pid === undefined ? { argv } : { argv, pid };
};

describe("paneBinaryOf — the file the pane's harness runs", () => {
  test("an absolute argv[0] is the file", () => {
    expect(paneBinaryOf([ps(["/opt/omp-18.12.6/bin/omp", "--resume"])], binaries, probe(null), linux)).toEqual({ harness: "omp", command: ["/opt/omp-18.12.6/bin/omp"] });
  });

  test("a relative argv[0] resolves against the process's folder; with no folder it is no evidence", () => {
    expect(paneBinaryOf([ps(["./node_modules/.bin/omp"], 42)], binaries, probe(null, "/work/proj"), linux)?.command).toEqual(["/work/proj/node_modules/.bin/omp"]);
    expect(paneBinaryOf([ps(["./node_modules/.bin/omp"], 42)], binaries, probe(null, null), linux)).toBeNull();
  });

  test("a bare argv[0] takes the process's executable, unless that is an interpreter or gone", () => {
    expect(paneBinaryOf([ps(["claude"], 7)], binaries, probe("/home/op/.local/share/claude/versions/2.1.300"), linux)?.command).toEqual([
      "/home/op/.local/share/claude/versions/2.1.300",
    ]);
    // A program that renamed itself runs as its interpreter: that file prints the interpreter's version.
    expect(paneBinaryOf([ps(["pi"], 7)], binaries, probe("/usr/bin/node"), linux)).toBeNull();
    expect(paneBinaryOf([ps(["claude"], 7)], binaries, probe("/home/op/.local/share/claude/versions/2.1.299 (deleted)"), linux)).toBeNull();
    // No pid, or a host with no `/proc`: the PATH lookup stays.
    expect(paneBinaryOf([ps(["claude"])], binaries, probe("/x/claude"), linux)).toBeNull();
  });

  test("an interpreter and its script: the same interpreter, the script made absolute", () => {
    const omp = "/home/op/.cache/lab/omp-18.12.6/node_modules/.bin/omp";
    expect(paneBinaryOf([ps(["bun", omp], 9)], binaries, probe("/home/op/.bun/bin/bun"), linux)).toEqual({ harness: "omp", command: ["/home/op/.bun/bin/bun", omp] });
    // No executable to see: the bare interpreter name, which the version read resolves on its PATH.
    expect(paneBinaryOf([ps(["bun", omp])], binaries, probe(null), linux)?.command).toEqual(["bun", omp]);
    expect(paneBinaryOf([ps(["/usr/bin/node", "--no-warnings", "dist/cli.js"], 9)], binaries, probe(null, "/srv/pi"), linux)).toBeNull();
    expect(paneBinaryOf([ps(["node", "--no-warnings", "./bin/pi"], 9)], binaries, probe("/usr/bin/node", "/srv/pi"), linux)).toEqual({ harness: "pi", command: ["/usr/bin/node", "/srv/pi/bin/pi"] });
    // A relative script with no folder to resolve it against is no evidence.
    expect(paneBinaryOf([ps(["bun", "node_modules/.bin/omp"], 9)], binaries, probe(null, null), linux)).toBeNull();
  });

  test("a shell, or a process that runs no harness, is no evidence", () => {
    expect(paneBinaryOf([ps(["/bin/bash", "-l"], 3)], binaries, probe("/usr/bin/bash", "/home/op"), linux)).toBeNull();
    expect(paneBinaryOf([], binaries, probe(null), linux)).toBeNull();
  });

  test("the process /proc shows is the one Herdr named: another argv, an unreadable cmdline or a rewritten title leaves exe and cwd unread", () => {
    const reported = ps(["claude"], 7);
    const exe = "/home/op/.local/share/claude/versions/2.1.300";
    // Match: the same words, in the same order.
    expect(paneBinaryOf([reported], binaries, probe(exe, null, ["claude"]), linux)?.command).toEqual([exe]);
    // Mismatch (another pid namespace, a reused pid, a title rewritten to something else): no executable.
    expect(paneBinaryOf([reported], binaries, probe(exe, null, ["bash", "-l"]), linux)).toBeNull();
    expect(paneBinaryOf([reported], binaries, probe(exe, null, ["claude", "--resume"]), linux)).toBeNull();
    expect(paneBinaryOf([reported], binaries, probe(exe, null, []), linux)).toBeNull();
    // Unreadable: the same.
    expect(paneBinaryOf([reported], binaries, probe(exe, null, null), linux)).toBeNull();
    // The folder is no evidence either: a relative argv[0] resolves against nothing.
    const relative = ps(["./node_modules/.bin/omp"], 42);
    expect(paneBinaryOf([relative], binaries, probe(null, "/work/proj", ["./node_modules/.bin/omp"]), linux)?.command).toEqual(["/work/proj/node_modules/.bin/omp"]);
    expect(paneBinaryOf([relative], binaries, probe(null, "/work/proj", ["omp"]), linux)).toBeNull();
    expect(paneBinaryOf([relative], binaries, probe(null, "/work/proj", null), linux)).toBeNull();
    // An absolute argv path needs no process: it still answers on a mismatch or an unreadable cmdline.
    const absolute = ps(["/opt/omp-18.12.6/bin/omp"], 43);
    expect(paneBinaryOf([absolute], binaries, probe(null, null, ["omp"]), linux)?.command).toEqual(["/opt/omp-18.12.6/bin/omp"]);
    expect(paneBinaryOf([absolute], binaries, probe(null, null, null), linux)?.command).toEqual(["/opt/omp-18.12.6/bin/omp"]);
    // An interpreter's script keeps its absolute path; the interpreter's own file is read only on a match.
    const script = "/lab/omp-18.12.6/node_modules/.bin/omp";
    const bunRun = ps(["bun", script], 44);
    expect(paneBinaryOf([bunRun], binaries, probe("/home/op/.bun/bin/bun", null, ["bun", script]), linux)?.command).toEqual(["/home/op/.bun/bin/bun", script]);
    expect(paneBinaryOf([bunRun], binaries, probe("/home/op/.bun/bin/bun", null, ["other"]), linux)?.command).toEqual(["bun", script]);
  });

  test("argvFromCmdline splits NUL-separated words and drops the closing NUL", () => {
    expect(argvFromCmdline("bun\0/lab/omp\0--resume\0")).toEqual(["bun", "/lab/omp", "--resume"]);
    expect(argvFromCmdline("omp\0")).toEqual(["omp"]);
    expect(argvFromCmdline("")).toEqual([]);
    // An empty argument in the middle stays.
    expect(argvFromCmdline("omp\0\0x\0")).toEqual(["omp", "", "x"]);
  });

  test("a host with no /proc: the default probe answers a command for an absolute argv only, and never throws", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const host = hostFor(platform);
      const noProc = procProbe(host);
      expect(noProc.cmdlineOf(process.pid)).toBeNull();
      expect(noProc.exeOf(process.pid)).toBeNull();
      expect(noProc.cwdOf(process.pid)).toBeNull();
      const abs = platform === "win32" ? "C:\\Users\\op\\omp.exe" : "/opt/omp/bin/omp";
      expect(paneBinaryOf([ps([abs], process.pid)], binaries, noProc, host)?.command).toEqual([abs]);
      expect(paneBinaryOf([ps([platform === "win32" ? "omp.exe" : "omp"], process.pid)], binaries, noProc, host)).toBeNull();
      expect(paneBinaryOf([ps(["./bin/omp"], process.pid)], binaries, noProc, host)).toBeNull();
      expect(paneBinaryOf([ps(["bun", "./bin/omp"], process.pid)], binaries, noProc, host)).toBeNull();
      // An interpreter with an absolute script keeps the bare interpreter name.
      expect(paneBinaryOf([ps(["bun", abs], process.pid)], binaries, noProc, host)?.command).toEqual(["bun", abs]);
    }
  });

  test("Windows paths keep their own rules", () => {
    const win = hostFor("win32");
    expect(paneBinaryOf([ps(["C:\\Users\\op\\AppData\\Roaming\\npm\\omp.exe"])], binaries, probe(null), win)?.command).toEqual(["C:\\Users\\op\\AppData\\Roaming\\npm\\omp.exe"]);
    expect(paneBinaryOf([ps(["omp.exe"])], binaries, probe(null), win)).toBeNull();
  });

  test.skipIf(process.platform !== "linux")("procProbe sees a live process's executable and folder", () => {
    const real = procProbe(linux);
    expect(real.exeOf(process.pid)).toBe(process.execPath);
    expect(real.cwdOf(process.pid)).toBe(process.cwd());
    expect(real.cmdlineOf(process.pid)?.length).toBeGreaterThan(0);
    expect(real.cmdlineOf(2 ** 31 - 2)).toBeNull();
    const child = Bun.spawn(["sleep", "30"]);
    try {
      // The child's cmdline is empty until its exec has run.
      for (let i = 0; i < 100 && real.cmdlineOf(child.pid)?.length === 0; i++) Bun.sleepSync(10);
      expect(real.cmdlineOf(child.pid)).toEqual(["sleep", "30"]);
    } finally {
      child.kill();
    }
    expect(procProbe(hostFor("darwin")).exeOf(process.pid)).toBeNull();
  });
});

describe("sharedForegroundRead — one read per send", () => {
  const omp: ForegroundOutcome = { ok: true, value: [ps(["/opt/omp/bin/omp"], 5)] };

  test("absent when the multiplexer has no foreground read", () => {
    expect(sharedForegroundRead(undefined)).toBeUndefined();
  });

  test("a read in flight answers every asker, and its answer stands for the reuse window only", async () => {
    let now = 1_000;
    let reads = 0;
    const read = sharedForegroundRead(
      () => {
        reads++;
        return Promise.resolve(omp);
      },
      { now: () => now, reuseMs: 1_000 },
    )!;
    expect(await Promise.all([read("p1"), read("p1")])).toEqual([omp, omp]);
    expect(reads).toBe(1);
    now += 1_000;
    await read("p1");
    expect(reads).toBe(1);
    await read("p2");
    expect(reads).toBe(2);
    now += 1;
    await read("p1");
    expect(reads).toBe(3);
  });

  test("a refusal, a throw and a read past the bound answer no read", async () => {
    expect(await sharedForegroundRead(() => Promise.resolve({ ok: false }))!("p")).toEqual({ ok: false });
    expect(await sharedForegroundRead(() => Promise.reject(new Error("socket gone")))!("p")).toEqual({ ok: false });
    const started = Date.now();
    expect(await sharedForegroundRead(() => new Promise<ForegroundOutcome>(() => undefined), { bound: 20 })!("p")).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("createPaneProfile — the version of the pane's own program", () => {
  const ompProfile = loadProfiles().get("omp")!;

  test("a foreground process that runs the harness gives the program read, and the match names its file", async () => {
    const asked: Array<readonly string[] | undefined> = [];
    const versions = {
      programVersion: (_profile: Profile, pane?: readonly string[]) => {
        asked.push(pane);
        return Promise.resolve({ version: pane === undefined ? "18.6.1" : "18.12.6", command: pane });
      },
    };
    const lookup = createPaneProfile({ versions, binaries: () => binaries, probe: probe(null), platform: "linux", host: linux });
    const foreground = () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["/bin/sh"]), ps(["/lab/omp-18.12.6/node_modules/.bin/omp"])] });
    const pane = await lookup("omp", "p1", foreground);
    expect(pane).toMatchObject({ version: "18.12.6", status: "provisional", binary: "/lab/omp-18.12.6/node_modules/.bin/omp" });
    expect(pane?.profile.id).toBe(ompProfile.id);
    // No pane, no read, a read that shows another harness, or a refused read: the PATH binary, no file named.
    // (A fresh pane: on p1 the program's last answer would stand for PANE_LAST_GOOD_MS.)
    const path = await lookup("omp");
    expect(path).toMatchObject({ version: "18.6.1", status: "verified" });
    expect(path?.binary).toBeUndefined();
    expect((await lookup("omp", "p2", () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["/usr/local/bin/claude"])] })))?.binary).toBeUndefined();
    expect((await lookup("omp", "p3", () => Promise.resolve<ForegroundOutcome>({ ok: false })))?.version).toBe("18.6.1");
    expect(asked).toEqual([["/lab/omp-18.12.6/node_modules/.bin/omp"], undefined, undefined, undefined]);
  });

  test("the pane's id goes to the cache, and a cache that fell back to the PATH binary names no file", async () => {
    const paneIds: Array<string | undefined> = [];
    const versions = {
      programVersion: (_profile: Profile, _pane?: readonly string[], paneId?: string) => {
        paneIds.push(paneId);
        // Over the pane's read limit, or the file gone: the PATH binary answered.
        return Promise.resolve({ version: "18.6.1", command: undefined });
      },
    };
    const lookup = createPaneProfile({ versions, binaries: () => binaries, probe: probe(null), platform: "linux", host: linux });
    const foreground = () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["/lab/omp-18.12.6/bin/omp"])] });
    const answer = await lookup("omp", "p7", foreground);
    expect(answer).toMatchObject({ version: "18.6.1", status: "verified" });
    expect(answer?.binary).toBeUndefined();
    expect(paneIds).toEqual(["p7"]);
  });

  test("a harness with no profile reads nothing", async () => {
    let reads = 0;
    const lookup = createPaneProfile({ versions: { programVersion: () => Promise.resolve({ version: "1.0.0", command: undefined }) }, binaries: () => binaries });
    expect(
      await lookup("", "p1", () => {
        reads++;
        return Promise.resolve<ForegroundOutcome>({ ok: false });
      }),
    ).toBeNull();
    expect(reads).toBe(0);
  });
});

// Issues 594 and 797: pi under WSL takes ctrl+q for submit and queue only when WSL_DISTRO_NAME or
// WSL_INTEROP is in its own environment; without them it takes alt+Enter, kernel or not. The send's
// profile reads the pane's pi process environment under WSL.
describe("createPaneProfile — the keys of the pane's agent under WSL", () => {
  const versions = { programVersion: () => Promise.resolve({ version: "1.3.0", command: undefined }) };
  const piPid = 4242;
  const pi = (): ForegroundOutcome => ({ ok: true, value: [ps(["/bin/sh"]), ps(["/opt/pi/bin/pi"], piPid)] });
  const withEnv = (env: Record<string, string> | null, cmdline?: readonly string[] | null): ProcessProbe => ({
    ...probe(null, null, cmdline),
    environOf: (pid, names) => (pid === piPid && env !== null ? Object.fromEntries(Object.entries(env).filter(([name]) => names.includes(name))) : null),
  });
  const keysOf = async (platform: string, env: Record<string, string> | null, read: () => Promise<ForegroundOutcome> = () => Promise.resolve(pi()), cmdline?: readonly string[] | null) => {
    const lookup = createPaneProfile({ versions, binaries: () => binaries, probe: withEnv(env, cmdline), platform, host: linux });
    const match = await lookup("pi", "p1", read);
    return { submit: match?.profile.keys.submit, queueKey: match?.profile.keys.queueKey };
  };
  const ALT = { submit: ["alt+Enter"], queueKey: "alt+Enter" };
  const CTRL_Q = { submit: ["ctrl+q"], queueKey: "ctrl+q" };

  test("issue 797: a WSL bridge, a pi started with neither flag: alt+Enter", async () => {
    expect(await keysOf("wsl", { PATH: "/usr/bin", HOME: "/home/op" })).toEqual(ALT);
  });

  test("issue 594: a WSL bridge, a pi started with a WSL flag: ctrl+q", async () => {
    expect(await keysOf("wsl", { WSL_DISTRO_NAME: "Distro", WSL_INTEROP: "/run/WSL/9_interop" })).toEqual(CTRL_Q);
    expect(await keysOf("wsl", { WSL_INTEROP: "/run/WSL/9_interop" })).toEqual(CTRL_Q);
  });

  test("no proof of pi's environment keeps the bridge's answer: ctrl+q under WSL", async () => {
    // An environment that cannot be read, a pid whose argv is not the reported one, a refused read, no read.
    expect(await keysOf("wsl", null)).toEqual(CTRL_Q);
    expect(await keysOf("wsl", { PATH: "/usr/bin" }, undefined, ["/usr/bin/other"])).toEqual(CTRL_Q);
    expect(await keysOf("wsl", { PATH: "/usr/bin" }, () => Promise.resolve<ForegroundOutcome>({ ok: false }))).toEqual(CTRL_Q);
    const lookup = createPaneProfile({ versions, binaries: () => binaries, probe: withEnv({ PATH: "/usr/bin" }), platform: "wsl", host: linux });
    expect((await lookup("pi"))?.profile.keys.submit).toEqual(["ctrl+q"]);
  });

  test("linux, darwin and win32 keep their keys, whatever pi's environment holds", async () => {
    const envs: Array<Record<string, string> | null> = [{ WSL_DISTRO_NAME: "Distro" }, {}, null];
    for (const env of envs) {
      expect(await keysOf("linux", env)).toEqual(ALT);
      expect(await keysOf("darwin", env)).toEqual(ALT);
      expect(await keysOf("win32", env)).toEqual(CTRL_Q);
    }
  });
});

test("envFromEnviron reads NUL-separated NAME=value entries, only the named ones", () => {
  expect(envFromEnviron("A=1\0B=x=y\0EMPTY=\0junk\0", ["A", "B", "EMPTY", "junk"])).toEqual({ A: "1", B: "x=y", EMPTY: "" });
  expect(envFromEnviron("", ["A"])).toEqual({});
});

test("envFromEnviron drops every variable it is not asked for, a secret first", () => {
  const raw = "SOME_API_KEY=value\0WSL_INTEROP=/run/WSL/9_interop\0PATH=/usr/bin\0";
  const env = envFromEnviron(raw, WSL_FLAGS);
  expect(env).toEqual({ WSL_INTEROP: "/run/WSL/9_interop" });
  expect("SOME_API_KEY" in env).toBe(false);
  expect(JSON.stringify(env)).not.toContain("value");
  expect(envFromEnviron(raw, [])).toEqual({});
});

test.skipIf(process.platform !== "linux")("procProbe reads a live process's environment, and nothing on another host", () => {
  const child = Bun.spawn(["sleep", "30"], { env: { PATH: "/usr/bin:/bin", COLLIE_PROBE_MARK: "seen", SOME_API_KEY: "value" } });
  try {
    const real = procProbe(linux);
    for (let i = 0; i < 100 && real.cmdlineOf(child.pid)?.length === 0; i++) Bun.sleepSync(10);
    expect(real.environOf?.(child.pid, ["COLLIE_PROBE_MARK", "WSL_INTEROP"])).toEqual({ COLLIE_PROBE_MARK: "seen" });
    expect(real.environOf?.(2 ** 31 - 2, ["PATH"])).toBeNull();
    expect(procProbe(hostFor("darwin")).environOf?.(child.pid, ["PATH"])).toBeNull();
  } finally {
    child.kill();
  }
});

// Two copies of one harness on disk, as in the 1.24.1 live check (W5): the PATH holds one, the pane runs
// the other. Fake binaries only: scripts that print a version, no agent.
describe.skipIf(process.platform === "win32")("two copies of one harness: the pane's copy is the one read", () => {
  const root = mkdtempSync(join(tmpdir(), "collie-pane-binary-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const onPath = join(root, "path-bin");
  const lab = join(root, "lab", "node_modules", ".bin");
  mkdirSync(onPath, { recursive: true });
  mkdirSync(lab, { recursive: true });
  writeFileSync(join(onPath, "omp"), "#!/bin/sh\necho omp/18.6.1\n");
  chmodSync(join(onPath, "omp"), 0o755);
  // A script with no executable bit, run by its interpreter the way the pane runs it.
  writeFileSync(join(lab, "omp"), 'console.log("omp/18.12.6");\n');
  const path = [onPath, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  const versions = new VersionCache(createVersionReader({ env: { PATH: path }, loginPath: () => Promise.resolve(path) }));
  const lookup = createPaneProfile({ versions, binaries: () => binaries, probe: probe(null), platform: "linux" });

  test("the PATH binary with no pane, the pane's program with one, each cached on its own", async () => {
    expect((await lookup("omp"))?.version).toBe("18.6.1");
    const pane = await lookup("omp", "p1", () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["bun", join(lab, "omp")])] }));
    expect(pane).toMatchObject({ version: "18.12.6", status: "provisional", binary: join(lab, "omp") });
    expect((await lookup("omp"))?.version).toBe("18.6.1");
  });
});

// N9 (trouble check 2026-11-08): the Surface shadow read the PATH binary only, so a harness the login
// shell does not put on the PATH named no version in the report and the trouble count, while a send on
// the same pane read the pane's own program and named it. The shadow now reads through createPaneVersion.
describe.skipIf(process.platform === "win32")("createPaneVersion — a harness off the login PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "collie-pane-version-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  // An nvm global: no folder of the PATH search (the login PATH, the bridge's, tools.ts fallbackDirs) holds it.
  const offPath = join(root, "home", ".nvm", "versions", "node", "v24.0.0", "bin");
  mkdirSync(offPath, { recursive: true });
  writeFileSync(join(offPath, "omp"), "#!/bin/sh\necho omp/18.18.0\n");
  chmodSync(join(offPath, "omp"), 0o755);
  const path = ["/usr/bin", "/bin"].join(":");
  // The PATH search with a home of its own, so this host's `~/.bun/bin` or `~/.local/bin` cannot answer.
  const resolve = (binary: string, search: string | undefined): string | null => findTool(binary, { PATH: search }, join(root, "home"));
  const versions = new VersionCache(createVersionReader({ env: { PATH: path }, loginPath: () => Promise.resolve(path), resolve }));
  const versionOf = createPaneVersion({ versions, binaries: () => binaries, probe: probe(null) });
  const omp = loadProfiles().get("omp")!;

  test("the PATH finds no binary; the pane's program names the version", async () => {
    expect((await versionOf(omp)).version).toBeNull();
    const foreground = () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps([join(offPath, "omp")])] });
    expect(await versionOf(omp, "p1", foreground)).toEqual({ version: "18.18.0", command: [join(offPath, "omp")] });
  });
});

describe("createPaneVersion — the pane's last answer while its agent is gone from the foreground", () => {
  const omp = loadProfiles().get("omp")!;
  const claude = loadProfiles().get("claude")!;
  const versions = {
    programVersion: (_profile: Profile, pane?: readonly string[]) =>
      Promise.resolve({ version: pane === undefined ? "18.6.1" : "18.18.0", command: pane }),
  };
  const ompRunning = () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["/nvm/bin/omp"])] });
  const shell = () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["/bin/bash"])] });

  test("a shell in the foreground keeps the program's answer for PANE_LAST_GOOD_MS, then the PATH binary answers", async () => {
    let clock = 0;
    const versionOf = createPaneVersion({ versions, binaries: () => binaries, probe: probe(null), host: linux, now: () => clock });
    expect((await versionOf(omp, "p1", ompRunning)).version).toBe("18.18.0");
    clock += 5_000;
    expect(await versionOf(omp, "p1", shell)).toEqual({ version: "18.18.0", command: ["/nvm/bin/omp"] });
    // A failed or slow foreground read is no evidence either.
    expect((await versionOf(omp, "p1", () => Promise.resolve<ForegroundOutcome>({ ok: false }))).version).toBe("18.18.0");
    clock += PANE_LAST_GOOD_MS;
    expect((await versionOf(omp, "p1", shell)).version).toBe("18.6.1");
  });

  test("the answer is the pane's and the agent's: another pane or another agent reads its own", async () => {
    const versionOf = createPaneVersion({ versions, binaries: () => binaries, probe: probe(null), host: linux, now: () => 0 });
    await versionOf(omp, "p1", ompRunning);
    expect((await versionOf(omp, "p2", shell)).version).toBe("18.6.1");
    expect((await versionOf(claude, "p1", shell)).command).toBeUndefined();
  });
});

// #793: a pane the multiplexer names no agent on (pi started by hand in a shell) was taken for a shell,
// and a send there took the blind road. The send path now names it by its foreground program, with the
// profiles' binary table, and the journal asks the same function.
describe("paneHarnessOf: which harness runs in the pane, by its foreground program (#793)", () => {
  /** The argv shapes one binary takes in a pane: by name, by path, as an interpreter's script. */
  const launches = (binary: string): string[][] => [
    [binary],
    [`/home/dev/.local/bin/${binary}`, "--continue"],
    ["node", `/home/dev/.npm-global/bin/${binary}`],
    ["/usr/bin/node", "--no-warnings", `/home/dev/.nvm/versions/node/v24.0.0/bin/${binary}`],
    ["bun", `/home/dev/.bun/install/global/node_modules/.bin/${binary}`],
    ["node", `/home/dev/.cache/npx/0a1b/node_modules/.bin/${binary}`, "--model", "x"],
  ];
  let pid = 5_000;

  test("every profile's binary, in every shape, with a proven pid: that harness", () => {
    expect(profileBinaries()).toEqual(binaries);
    for (const [binary, harness] of binaries) {
      for (const argv of launches(binary)) expect([argv, paneHarnessOf([ps(argv, ++pid)], binaries, probe(null))?.harness]).toEqual([argv, harness]);
    }
  });

  test("a wrapper and the agent it runs, both in the foreground, name the agent once", () => {
    const wrapper = ps(["bash", "/home/dev/bin/run-pi.sh"], ++pid);
    const agent = ps(["node", "/home/dev/.npm-global/bin/pi"], ++pid);
    expect(paneHarnessOf([wrapper, agent], binaries, probe(null))?.harness).toBe("pi");
    expect(paneHarnessOf([agent, ps(["pi"], ++pid)], binaries, probe(null))?.harness).toBe("pi");
  });

  test("a pid whose /proc/<pid>/cmdline is not the reported argv, or a host with no /proc: no name", () => {
    expect(paneHarnessOf([ps(["pi"], ++pid)], binaries, probe(null, null, ["bash"]))).toBeNull();
    expect(paneHarnessOf([ps(["pi"], ++pid)], binaries, probe(null, null, null))).toBeNull();
    // One proven process of the harness is enough; an unproven one beside it adds nothing.
    const proven = ps(["pi"], ++pid);
    expect(paneHarnessOf([{ argv: ["node", "/x/pi"], pid: 1 }, proven], binaries, probe(null))?.process).toBe(proven);
  });

  test("a process the multiplexer reports with no pid counts on its argv alone", () => {
    expect(paneHarnessOf([ps(["omp"])], binaries, probe(null, null, null))?.harness).toBe("omp");
  });

  test("two harnesses in the foreground: no name, a wrong profile types the wrong keys", () => {
    expect(paneHarnessOf([ps(["pi"], ++pid), ps(["omp"], ++pid)], binaries, probe(null))).toBeNull();
    expect(paneHarnessOf([ps(["claude"], ++pid), ps(["node", "/home/dev/.bun/bin/codex"], ++pid)], binaries, probe(null))).toBeNull();
  });

  test("a program the table does not name exactly: no name", () => {
    const unknown = [
      ["bash"],
      ["ssh", "dev@box", "pi"],
      ["docker", "exec", "-it", "box", "pi"],
      ["distrobox", "enter", "box", "--", "pi"],
      ["bun", "x", "pi"],
      ["node", "/home/dev/.local/share/pnpm/global/5/node_modules/pi-agent/dist/cli.js"],
      ["python3", "pi.py"],
      ["pi-dev"],
      ["/home/dev/bin/run-pi.sh"],
      [],
    ];
    for (const argv of unknown) expect([argv, paneHarnessOf([ps(argv, ++pid)], binaries, probe(null))]).toEqual([argv, null]);
    expect(paneHarnessOf([], binaries, probe(null))).toBeNull();
  });

  test("createPaneHarness: over the pane's read; a refused read names nothing", async () => {
    const reads = new Map<string, ForegroundOutcome>([["p1", { ok: true, value: [ps(["pi"], ++pid)] }], ["p2", { ok: false }], ["p3", { ok: true, value: [] }]]);
    const named = createPaneHarness({ read: (paneId) => Promise.resolve(reads.get(paneId) ?? { ok: false }), binaries: () => binaries, probe: probe(null) });
    expect(await named("p1")).toBe("pi");
    expect(await named("p2")).toBeNull();
    expect(await named("p3")).toBeNull();
  });

  test("the journal and the send path give the same answer for every case", async () => {
    const cases: ForegroundProcess[][] = [
      [ps(["pi"], ++pid)],
      [ps(["omp", "--resume", "abc"], ++pid)],
      [ps(["node", "/home/dev/.npm-global/bin/pi", "--session", "/x.jsonl"], ++pid)],
      [ps(["bun", "/home/dev/.bun/install/global/node_modules/.bin/omp"])],
      [ps(["bash", "/home/dev/bin/run-pi.sh"], ++pid), ps(["pi"], ++pid)],
      [ps(["pi"], ++pid), ps(["omp"], ++pid)],
      [ps(["claude"], ++pid), ps(["pi"], ++pid)],
      [ps(["claude"], ++pid)],
      [ps(["bash"], ++pid)],
      [ps(["ssh", "dev@box"], ++pid)],
      [],
    ];
    for (const processes of cases) {
      const send = await createPaneHarness({ read: () => Promise.resolve({ ok: true, value: processes }), binaries: profileBinaries, probe: probe(null) })("p1");
      // The journal reads pi and omp logs only: for any other harness it has no answer, by design.
      const journal = piProcessOf(processes)?.harness ?? null;
      expect([processes.map((p) => p.argv.join(" ")), journal]).toEqual([processes.map((p) => p.argv.join(" ")), send === "pi" || send === "omp" ? send : null]);
    }
  });
});

describe("paneForegroundOf: what stands in the pane's foreground, for the blind road (M102 spec 12)", () => {
  const p = (...argv: string[]): ForegroundProcess => ({ argv });

  test("every shell of the table, bare, by path, as a login shell or with flags only, is a shell", () => {
    for (const name of SHELL_NAMES) {
      expect(paneForegroundOf([p(name)])).toBe("shell");
      expect(paneForegroundOf([p(`/usr/bin/${name}`, "-l")])).toBe("shell");
      expect(paneForegroundOf([p(`-${name}`)])).toBe("shell");
    }
    expect(paneForegroundOf([p("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo")])).toBe("shell");
    expect(paneForegroundOf([p("python3", "/usr/bin/xonsh")])).toBe("shell");
  });

  test("a child in the foreground, a shell running a script or a command, is a program", () => {
    expect(paneForegroundOf([p("apt", "upgrade")])).toBe("program");
    expect(paneForegroundOf([p("bash", "deploy.sh")])).toBe("program");
    expect(paneForegroundOf([p("sh", "-c", "read -p 'ok? ' x")])).toBe("program");
    expect(paneForegroundOf([p("zsh"), p("less", "README.md")])).toBe("program");
    expect(paneForegroundOf([p("node", "/opt/agent/cli.js")])).toBe("program");
  });

  test("no process, or one with no argv, is unknown", () => {
    expect(paneForegroundOf([])).toBe("unknown");
    expect(paneForegroundOf([p()])).toBe("unknown");
    expect(paneForegroundOf([p("bash"), p("")])).toBe("unknown");
  });

  test("over the shared read: a failed read is unknown", async () => {
    const ok = createPaneForeground(() => Promise.resolve({ ok: true, value: [p("fish")] }));
    const failed = createPaneForeground(() => Promise.resolve({ ok: false }));
    expect(await ok("%1")).toBe("shell");
    expect(await failed("%1")).toBe("unknown");
  });
});
