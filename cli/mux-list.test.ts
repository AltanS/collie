import { describe, expect, test } from "bun:test";

import { hookTargetFileName } from "../bridge/beacon/hook-targets.ts";
import { buildMuxRegistry, muxNames } from "../bridge/mux/registry.ts";
import { HOME, capture, context, fakeExec, fakeFiles } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdMux, cmdMuxList, muxListReport, PROBE_MS, PROGRAM_NOTE, renderMuxTable, startHint, type MuxListDeps, type MuxListReport } from "./mux-list.ts";

// `collie mux list` (M76 spec 02), driven through the seams: a fake filesystem for the socket files,
// the binaries and the hook target records, a scripted exec for tmux and zellij, a fake herdr-core
// dial. Nothing here touches the machine.

const REGISTRY = `${HOME}/.local/state/collie/hook-targets`;
const HERDR_SOCKET = "/home/pat/.config/herdr/herdr.sock";
const HC_SOCKET = "/run/user/1000/herdr-core/default.sock";
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };

const statOf = (pid: number, start: number): string => `${String(pid)} (bun) S 1 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${String(start)} 0 0`;

interface Target {
  readonly dir: string;
  readonly pid: number;
  readonly start: number;
  readonly extra?: Record<string, string | number>;
  readonly alive?: boolean;
}

function world(over: { files?: string[]; targets?: Target[]; exec?: Parameters<typeof fakeExec>[0]; dial?: MuxListDeps["dial"] } = {}) {
  const files = fakeFiles();
  for (const path of over.files ?? []) files.write(path, "");
  files.mkdirp(REGISTRY, 0o700);
  for (const t of over.targets ?? []) {
    const record = { schemaVersion: 1, stateDir: t.dir, pid: t.pid, pidStartTime: t.start, bootedAt: 1, ...t.extra };
    files.write(`${REGISTRY}/${hookTargetFileName(t.dir)}`, JSON.stringify(record), 0o600);
    if (t.alive !== false) files.write(`/proc/${String(t.pid)}/stat`, statOf(t.pid, t.start));
  }
  const io = capture();
  const exec = fakeExec(over.exec);
  const deps: MuxListDeps = { ctx: context(ENV), io, exec, files, uid: 1000, dial: over.dial };
  return { deps, io, files, exec };
}

const hcAnswers = () => Promise.resolve({ version: "0.1.14", generation: 1, live: 3 });

const NEXT: Target = { dir: "/s/next", pid: 101, start: 11, extra: { mux: "herdr", instance: "next", port: 8788 } };
const HC: Target = { dir: "/s/hc", pid: 102, start: 12, extra: { mux: "herdr-core", instance: "hc", port: 8794 } };

describe("the rows", () => {
  test("every registry entry appears once, present or not, with durable last", async () => {
    const { deps } = world();
    const { rows } = await muxListReport(deps);
    expect(rows.map((row) => row.mux).toSorted()).toEqual(muxNames(buildMuxRegistry()));
    expect(rows.at(-1)?.mux).toBe("durable");
    expect(new Set(rows.map((row) => row.mux)).size).toBe(rows.length);
  });

  test("durable is a program, not a terminal, and nothing is probed for it", async () => {
    const { deps } = world();
    const durable = (await muxListReport(deps)).rows.find((row) => row.mux === "durable");
    expect(durable).toMatchObject({ kind: "program", present: false, where: PROGRAM_NOTE, hint: "" });
    expect(renderMuxTable(await muxListReport(deps)).find((line) => line.startsWith("durable"))).toContain(PROGRAM_NOTE);
  });

  test("nothing on the machine: every terminal is absent, and no hint is printed", async () => {
    const { deps } = world();
    const { rows } = await muxListReport(deps);
    for (const row of rows) expect(row).toMatchObject({ present: false, drivenBy: [], drivenByText: "", hint: "" });
  });
});

describe("presence", () => {
  test("a herdr socket is present, and the version comes from `herdr --version`", async () => {
    const { deps } = world({ files: [HERDR_SOCKET], exec: { answers: [["herdr --version", { stdout: "herdr 0.9.5\n" }]] } });
    const herdr = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr");
    expect(herdr).toMatchObject({ present: true, answering: null, where: HERDR_SOCKET, version: "herdr 0.9.5" });
  });

  test("a herdr-core socket that answers carries its version", async () => {
    const { deps } = world({ files: [HC_SOCKET], dial: hcAnswers });
    const core = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr-core");
    expect(core).toMatchObject({ present: true, answering: true, where: HC_SOCKET, version: "0.1.14" });
  });

  test("a herdr-core dial that fails is present, not answering", async () => {
    const { deps } = world({ files: [HC_SOCKET], dial: () => Promise.reject(new Error("ECONNREFUSED")) });
    const core = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr-core");
    expect(core).toMatchObject({ present: true, answering: false, version: null });
    expect(renderMuxTable(await muxListReport(deps)).find((line) => line.startsWith("herdr-core"))).toContain("yes, not answering");
  });

  test("a herdr-core dial that never answers is cut off at the probe bound", async () => {
    const { deps } = world({ files: [HC_SOCKET], dial: () => new Promise(() => undefined) });
    const started = Date.now();
    const core = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr-core");
    expect(core).toMatchObject({ present: true, answering: false });
    expect(Date.now() - started).toBeLessThan(PROBE_MS + 400);
  });

  test("no herdr-core socket means the core is not dialled", async () => {
    let dialled = false;
    const { deps } = world({
      dial: () => {
        dialled = true;
        return hcAnswers();
      },
    });
    await muxListReport(deps);
    expect(dialled).toBe(false);
  });

  test("tmux with a server is present; tmux installed with no server is not", async () => {
    const running = world({ files: ["/usr/bin/tmux"], exec: { answers: [["/usr/bin/tmux list-sessions", { stdout: "main\nwork\n" }]] } });
    const tmux = (await muxListReport(running.deps)).rows.find((row) => row.mux === "tmux");
    expect(tmux).toMatchObject({ present: true, answering: true });
    expect(tmux?.where).toContain("2 sessions");
    const idle = world({ files: ["/usr/bin/tmux"], exec: { answers: [["/usr/bin/tmux list-sessions", { code: 1, stderr: "no server running" }]] } });
    expect((await muxListReport(idle.deps)).rows.find((row) => row.mux === "tmux")).toMatchObject({ present: false });
  });

  test("the exec probes carry the probe bound, and only read", async () => {
    const { deps, exec } = world({ files: ["/usr/bin/tmux", `${HOME}/.local/bin/zellij`, HERDR_SOCKET] });
    await muxListReport(deps);
    expect(exec.timeouts.length).toBeGreaterThanOrEqual(3);
    for (const call of exec.timeouts) expect(call.ms).toBe(PROBE_MS);
    for (const call of exec.calls) expect(call).toMatch(/--version|list-sessions/u);
  });

  test("zellij counts running sessions only", async () => {
    const { deps } = world({
      files: [`${HOME}/.local/bin/zellij`],
      exec: { answers: [[`${HOME}/.local/bin/zellij list-sessions`, { stdout: "alpha [Created 1h ago]\nbeta [Created 2d ago] (EXITED - attach to resurrect)\n" }]] },
    });
    const zellij = (await muxListReport(deps)).rows.find((row) => row.mux === "zellij");
    expect(zellij).toMatchObject({ present: true });
    expect(zellij?.where).toContain("1 running session: alpha");
  });

  test("tern and tuios are present on their daemon socket", async () => {
    const { deps } = world({ files: ["/run/user/1000/tern/daemon.sock", "/run/user/1000/tuios/tuios.sock"] });
    const { rows } = await muxListReport(deps);
    expect(rows.find((row) => row.mux === "tern")).toMatchObject({ present: true, where: "/run/user/1000/tern/daemon.sock" });
    expect(rows.find((row) => row.mux === "tuios")).toMatchObject({ present: true, where: "/run/user/1000/tuios/tuios.sock" });
  });
});

describe("who drives", () => {
  test("a live bridge drives the row of its multiplexer, with instance, port and pid", async () => {
    const { deps } = world({ files: [HERDR_SOCKET, HC_SOCKET], dial: hcAnswers, targets: [NEXT, HC] });
    const { rows } = await muxListReport(deps);
    const herdr = rows.find((row) => row.mux === "herdr");
    const core = rows.find((row) => row.mux === "herdr-core");
    expect(herdr?.drivenBy).toEqual([{ instance: "next", port: 8788, pid: 101 }]);
    expect(herdr?.drivenByText).toBe("next (8788)");
    expect(core?.drivenBy).toEqual([{ instance: "hc", port: 8794, pid: 102 }]);
    expect(herdr?.hint).toBe("");
    expect(core?.hint).toBe("");
  });

  test("a bridge whose pid is dead is not driving, and its record is removed", async () => {
    const { deps, files } = world({ files: [HERDR_SOCKET], targets: [{ ...NEXT, alive: false }] });
    const herdr = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr");
    expect(herdr?.drivenBy).toEqual([]);
    expect(files.read(`${REGISTRY}/${hookTargetFileName(NEXT.dir)}`)).toBeNull();
  });

  test("a reused pid counts as dead", async () => {
    const { deps, files } = world({ files: [HERDR_SOCKET], targets: [NEXT] });
    files.write(`/proc/${String(NEXT.pid)}/stat`, statOf(NEXT.pid, 9999));
    expect((await muxListReport(deps)).rows.find((row) => row.mux === "herdr")?.drivenBy).toEqual([]);
  });

  test("a record without the new fields parses, shows `?`, and is listed apart from the rows", async () => {
    const old: Target = { dir: "/s/old", pid: 103, start: 13 };
    const { deps, io } = world({ targets: [old] });
    const report = await muxListReport(deps);
    expect(report.unplaced).toEqual([{ mux: null, instance: null, port: null, pid: 103 }]);
    for (const row of report.rows) expect(row.drivenBy).toEqual([]);
    await cmdMuxList(deps);
    expect(io.stdout.join("\n")).toContain("?, pid 103");
  });

  test("a record with a mux but no instance shows `?` for the name", async () => {
    const { deps } = world({ files: [HERDR_SOCKET], targets: [{ dir: "/s/x", pid: 104, start: 14, extra: { mux: "herdr", port: 8787 } }] });
    const herdr = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr");
    expect(herdr?.drivenBy).toEqual([{ instance: null, port: 8787, pid: 104 }]);
    expect(herdr?.drivenByText).toBe("? (8787)");
  });

  test("two bridges on one multiplexer are both listed", async () => {
    const second: Target = { dir: "/s/two", pid: 105, start: 15, extra: { mux: "herdr", instance: "two", port: 8790 } };
    const { deps } = world({ files: [HERDR_SOCKET], targets: [NEXT, second] });
    expect((await muxListReport(deps)).rows.find((row) => row.mux === "herdr")?.drivenByText).toBe("next (8788), two (8790)");
  });

  test("a bridge that drives a multiplexer proves it is here, even where the default probe found nothing", async () => {
    const tmuxBridge: Target = { dir: "/s/tmux", pid: 106, start: 16, extra: { mux: "tmux", instance: "tmux", port: 8789 } };
    const { deps } = world({ targets: [tmuxBridge] });
    expect((await muxListReport(deps)).rows.find((row) => row.mux === "tmux")).toMatchObject({ present: true, drivenByText: "tmux (8789)" });
  });

  test("a record that names a multiplexer this build does not know is listed apart", async () => {
    const { deps } = world({ targets: [{ dir: "/s/f", pid: 107, start: 17, extra: { mux: "future", instance: "f", port: 9000 } }] });
    expect((await muxListReport(deps)).unplaced).toEqual([{ mux: "future", instance: "f", port: 9000, pid: 107 }]);
  });
});

describe("the hint", () => {
  test("a present multiplexer nobody drives gets the real start command, plain when no bridge runs", async () => {
    const { deps } = world({ files: [HC_SOCKET], dial: hcAnswers });
    expect((await muxListReport(deps)).rows.find((row) => row.mux === "herdr-core")?.hint).toBe("COLLIE_MUX=herdr-core collie start");
  });

  test("with another bridge running, the command names an instance and a port", async () => {
    const { deps } = world({ files: [HC_SOCKET], dial: hcAnswers, targets: [NEXT] });
    const core = (await muxListReport(deps)).rows.find((row) => row.mux === "herdr-core");
    expect(core?.hint).toBe("COLLIE_INSTANCE=<name> COLLIE_PORT=<port> COLLIE_MUX=herdr-core collie start");
    expect(startHint("tmux", true)).toBe("COLLIE_INSTANCE=<name> COLLIE_PORT=<port> COLLIE_MUX=tmux collie start");
  });

  test("an absent multiplexer has no hint, and neither has a driven one", async () => {
    const { deps } = world({ files: [HERDR_SOCKET], targets: [NEXT] });
    const { rows } = await muxListReport(deps);
    expect(rows.every((row) => row.hint === "")).toBe(true);
  });
});

describe("the output", () => {
  test("--json is one line: rows with a stable shape, and the unplaced bridges", async () => {
    const { deps, io } = world({ files: [HERDR_SOCKET, HC_SOCKET], dial: hcAnswers, targets: [NEXT, HC] });
    expect(await cmdMuxList(deps, ["--json"])).toBe(EXIT.OK);
    expect(io.stdout).toHaveLength(1);
    // SAFETY: the line is what `cmdMuxList --json` printed from a `MuxListReport`; the assertions below pin its keys.
    const doc = JSON.parse(io.stdout[0] ?? "") as MuxListReport;
    expect(Object.keys(doc)).toEqual(["rows", "unplaced"]);
    for (const row of doc.rows) {
      expect(Object.keys(row)).toEqual(["mux", "kind", "present", "answering", "where", "version", "drivenBy", "drivenByText", "hint"]);
    }
    const herdr = doc.rows.find((row) => row.mux === "herdr");
    expect(herdr).toEqual({
      mux: "herdr",
      kind: "terminal",
      present: true,
      answering: null,
      where: HERDR_SOCKET,
      version: null,
      drivenBy: [{ instance: "next", port: 8788, pid: 101 }],
      drivenByText: "next (8788)",
      hint: "",
    });
    expect(doc.unplaced).toEqual([]);
  });

  test("the table has the four columns and a row per multiplexer", async () => {
    const { deps, io } = world({ files: [HERDR_SOCKET], targets: [NEXT] });
    await cmdMuxList(deps);
    const lines = io.stdout;
    expect(lines[0]?.split(/\s{2,}/u)).toEqual(["MUX", "PRESENT", "DRIVEN BY", "HINT"]);
    expect(lines.find((line) => line.startsWith("herdr "))).toMatch(/^herdr\s+yes\s+next \(8788\)$/u);
    for (const mux of muxNames(buildMuxRegistry())) expect(lines.some((line) => line.startsWith(`${mux} `))).toBe(true);
  });

  test("an unknown option is a usage error, and writes nothing to stdout", async () => {
    const { deps, io } = world();
    expect(await cmdMuxList(deps, ["--wide"])).toBe(EXIT.USAGE);
    expect(io.stdout).toEqual([]);
  });
});

describe("the verb", () => {
  test("a bare `mux` prints the list, and `mux --json` prints the rows", async () => {
    const bare = world();
    expect(await cmdMux(bare.deps, [])).toBe(EXIT.OK);
    expect(bare.io.stdout[0]).toContain("MUX");
    const json = world();
    expect(await cmdMux(json.deps, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(json.io.stdout[0] ?? "")).toHaveProperty("rows");
  });

  test("a misspelt sub-verb is a usage error that names the real one", async () => {
    const { deps, io } = world();
    expect(await cmdMux(deps, ["lst"])).toBe(EXIT.USAGE);
    expect(io.stderr.join("\n")).toContain("unknown mux subcommand `lst`");
    expect(io.stderr.join("\n")).toContain("list");
  });

  test("the verb writes nothing", async () => {
    const { deps, files } = world({ files: [HERDR_SOCKET], targets: [NEXT] });
    const before = new Set(files.entries.keys());
    await cmdMuxList(deps);
    expect(new Set(files.entries.keys())).toEqual(before);
  });
});
