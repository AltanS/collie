// The Windows gate (service.ts `gated`): on a Windows bridge no trick runs, nothing is switched on,
// approved, added or placed, no part draws and no agent view opens. The platform is a fact the bridge
// injects, so these tests pass "win32" and run on every host. Each case runs the same rig on "linux"
// too, so a gate that refused everything everywhere would fail here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRICKS_WINDOWS_LINE } from "../../web/src/lib/tricks/schema.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { OfficialTricks } from "./official-install.ts";
import type { OfficialEntry } from "./official.ts";
import { TRICKS_DIR } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { TricksService, type TricksServiceDeps } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-11-12T09:00:00Z");
const HOST = "lodge";
const RID = "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const MANIFEST = 'id = "legs"\nname = "Legs"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt"]\n';
const BELT = JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: "3", intent: "x" } }] });

interface Rig {
  configDir: string;
  stateDir: string;
  clock: { t: number };
  service: TricksService;
  specs: RunSpec[];
}

/** A bridge on `platform` with the trick `legs` in its folder, switched on at the folder's code hash. */
async function rig(platform: NodeJS.Platform): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "collie-tricks-gate-"));
  dirs.push(root);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "legs.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const code = await trickCodeHash(dir);
  const on: Switches = withSwitch({ on: new Map() }, "legs", true, "2026-11-12T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, "legs"));
  await writeSwitches(stateDir, on);
  const clock = { t: T0 };
  const specs: RunSpec[] = [];
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    memberId: HOST,
    platform,
    world: (memberId) => ({ machine: "desk", sessions: [], spaces: [{ name: "collie", folder: `/work/${memberId}` }] }),
    env: { PATH: "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => {},
    revBase: 1000,
    run: async (spec): Promise<RunOutcome> => {
      specs.push(spec);
      return { kind: "exited", code: 0, stdout: BELT, stderr: "", ms: 5 };
    },
  };
  return { configDir, stateDir, clock, service: new TricksService(deps), specs };
}

/** A phone looks, the clock moves, the scheduler ticks. */
async function tick(r: Rig, t: number): Promise<void> {
  r.clock.t = t;
  r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

describe("windows gate", () => {
  test("windows gate: no trick runs, at its start or on its timer, and the phone gets the gate and nothing else", async () => {
    const linux = await rig("linux");
    await tick(linux, T0);
    await tick(linux, T0 + 31_000);
    expect(linux.specs.length).toBeGreaterThan(0);
    expect((await linux.service.reply(undefined)).parts.length).toBeGreaterThan(0);

    const win = await rig("win32");
    await tick(win, T0);
    await tick(win, T0 + 31_000);
    expect(win.specs).toEqual([]);
    expect(win.service.rev()).toBe(1000);
    expect(await win.service.reply(undefined)).toEqual({ rev: 1000, tricks: [], parts: [], present: [], gate: "windows" });
    expect(win.service.sessionPanes()).toBeUndefined();
    // The folder is not even read: no approved copy is made beside it.
    expect(await readdir(join(win.configDir, TRICKS_DIR))).toEqual(["legs"]);
  });

  test("windows gate: auto, a version's yes and an undo answer the line and write nothing", async () => {
    const win = await rig("win32");
    await tick(win, T0);
    const before = await readFile(join(win.stateDir, TRICKS_DIR, "switches.json"), "utf8");
    const refused = { ok: false, code: "windows", message: TRICKS_WINDOWS_LINE } as const;
    expect(await win.service.setAuto("legs", true)).toEqual(refused);
    expect(await win.service.approvePending("legs", "a".repeat(64))).toEqual(refused);
    expect(await win.service.undo("legs")).toEqual(refused);
    expect(await win.service.autoRoute(HOST, "legs", true)).toEqual({ status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } });
    expect(await readFile(join(win.stateDir, TRICKS_DIR, "switches.json"), "utf8")).toBe(before);
    expect(win.specs).toEqual([]);
  });

  test("windows gate: a tap and a Decision's answer run nothing", async () => {
    const linux = await rig("linux");
    await tick(linux, T0);
    const runs = linux.specs.length;
    const tapped = await linux.service.tap(HOST, "legs", { rid: RID, node: "belt", intent: "x", rev: (await linux.service.reply(undefined)).parts[0]?.rev ?? 0 });
    expect(tapped.status === 200 && tapped.body.code).toBe("ok");
    expect(linux.specs.length).toBe(runs + 1);

    const win = await rig("win32");
    await tick(win, T0);
    expect(await win.service.tap(HOST, "legs", { rid: RID, node: "belt", intent: "x", rev: 1 })).toEqual({ status: 200, body: { rid: RID, code: "rejected", message: TRICKS_WINDOWS_LINE } });
    expect(await win.service.tapFromHill(HOST, "legs", { rid: RID, node: "hill:dc_abcdefabcdef", intent: "x", value: { text: "yes" } }, "dc_abcdefabcdef")).toBe(false);
    expect(win.specs).toEqual([]);
  });

  test("windows gate: nothing is switched on, and the switch file stays as it was", async () => {
    const win = await rig("win32");
    const before = await readFile(join(win.stateDir, TRICKS_DIR, "switches.json"), "utf8");
    expect(await win.service.setSwitch(HOST, "legs", true, null)).toEqual({ status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } });
    expect(await win.service.setSwitch(HOST, "legs", false, null)).toEqual({ status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } });
    expect(await readFile(join(win.stateDir, TRICKS_DIR, "switches.json"), "utf8")).toBe(before);
  });

  test("windows gate: the official list is empty with the gate, and an add fetches nothing and writes nothing", async () => {
    const win = await rig("win32");
    const entry: OfficialEntry = { id: "dash", name: "Dash", description: "A dash.", repo: "https://example.com/o/r", dir: "dash", commit: "a".repeat(40), hash: "b".repeat(64), extras: "c".repeat(64), rules: null, contract: 1, previous: [] };
    const list = new OfficialTricks({ configDir: win.configDir, stateDir: win.stateDir, env: {}, entries: () => [entry], gate: () => win.service.gateLine(), lane: (work) => win.service.officialLane(work) });
    expect(await list.reply()).toEqual({ tricks: [], gate: "windows" });
    expect(await list.install("dash", "add")).toEqual({ status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } });
    expect(await readdir(join(win.configDir, TRICKS_DIR))).toEqual(["legs"]);
    expect(await readdir(win.stateDir)).toEqual([TRICKS_DIR]);
    // The lane is the second lock: a write that reached it anyway is refused there.
    await expect(win.service.officialLane(async () => "written")).rejects.toThrow(TRICKS_WINDOWS_LINE);

    const linux = await rig("linux");
    expect(linux.service.gateLine()).toBeNull();
  });

  test("windows gate: a proposal is refused, and its yes places nothing and switches nothing on", async () => {
    const linux = await rig("linux");
    expect(await linux.service.proposalTarget("fresh")).toEqual({ kind: "new" });

    const win = await rig("win32");
    expect(await win.service.proposalTarget("fresh")).toEqual({ kind: "refused", reason: TRICKS_WINDOWS_LINE });
    const files = [{ rel: "trick.toml", bytes: new TextEncoder().encode('id = "fresh"\nname = "F"\nplaces = ["belt"]\n'), executable: false }];
    const origin = { by: "agent" as const, host: HOST, label: "composer", at: "2026-11-12T09:00:00Z" };
    expect(await win.service.installProposed("fresh", files, origin)).toEqual({ ok: false, message: TRICKS_WINDOWS_LINE });
    expect(await win.service.installProposedVersion("legs", files, origin, "c".repeat(64))).toEqual({ ok: false, message: TRICKS_WINDOWS_LINE });
    expect(await readdir(join(win.configDir, TRICKS_DIR))).toEqual(["legs"]);
  });

  test("windows gate: no agent view opens and no trick picture is served", async () => {
    const linux = await rig("linux");
    await tick(linux, T0);
    expect(linux.service.viewGate("legs")).toEqual({ ok: false, code: "not_a_view", error: 'the trick "legs" adds no agent view' });

    const win = await rig("win32");
    await tick(win, T0);
    expect(win.service.viewGate("legs")).toEqual({ ok: false, code: "trick_off", error: TRICKS_WINDOWS_LINE });
    expect(await win.service.viewGateFresh("legs")).toEqual({ ok: false, code: "trick_off", error: TRICKS_WINDOWS_LINE });
    expect(await win.service.media(HOST, "legs", "a.png")).toBeNull();
  });
});
