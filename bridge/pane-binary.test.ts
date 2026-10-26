import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hostFor } from "./host.ts";
import type { ForegroundProcess } from "./journal/types.ts";
import { argvFromCmdline, createPaneProfile, paneBinaryOf, procProbe, sharedForegroundRead, type ForegroundOutcome, type ProcessProbe } from "./pane-binary.ts";
import { createVersionReader, VersionCache } from "./surface/binary-version.ts";
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
    const path = await lookup("omp");
    expect(path).toMatchObject({ version: "18.6.1", status: "verified" });
    expect(path?.binary).toBeUndefined();
    expect((await lookup("omp", "p1", () => Promise.resolve<ForegroundOutcome>({ ok: true, value: [ps(["/usr/local/bin/claude"])] })))?.binary).toBeUndefined();
    expect((await lookup("omp", "p1", () => Promise.resolve<ForegroundOutcome>({ ok: false })))?.version).toBe("18.6.1");
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
