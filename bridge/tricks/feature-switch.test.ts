// The switch for tricks as a whole (feature-switch.ts) and every door of the runner it closes (service.ts
// `switchedOff`). Off is the default: no file. Each refusal is held against the same rig with the switch on,
// so a door that refused everything everywhere would fail here.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRICKS_OFF_LINE, TRICKS_WINDOWS_LINE } from "../../web/src/lib/tricks/schema.ts";
import { tricksFeatureRoute, TRICKS_SWITCH_LOCAL_TEXT } from "../server.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { parseTricksFeature, readTricksFeature, TRICKS_FEATURE_FILE, TricksFeatureSwitch, tricksFeaturePath, writeTricksFeature } from "./feature-switch.ts";
import { OfficialTricks } from "./official-install.ts";
import type { OfficialEntry } from "./official.ts";
import { TRICKS_DIR } from "./paths.ts";
import { proposalHash } from "./propose-wire.ts";
import { TRICKS_ROUTE_RIGHTS } from "./routes.ts";
import { runProgram, type RunOutcome, type RunSpec } from "./run.ts";
import { TricksService, type TricksHillPort, type TricksServiceDeps } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-11-17T09:00:00Z");
const HOST = "lodge";
const RID = "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const MANIFEST = 'id = "legs"\nname = "Legs"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt"]\n';
const BELT = JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: "3", intent: "x" } }] });
const EXITED: RunOutcome = { kind: "exited", code: 0, stdout: BELT, stderr: "", ms: 5 };

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "collie-tricks-feature-"));
  dirs.push(root);
  return root;
}

interface Rig {
  configDir: string;
  stateDir: string;
  clock: { t: number };
  service: TricksService;
  specs: RunSpec[];
  /** The withdrawals the runner asked of the Hill, by trick id. */
  withdrawn: string[];
  audit: { action: string; detail: Record<string, string> }[];
  /** The next run waits for this, when set. */
  gate: { wait: Promise<void> | null };
}

interface RigOptions {
  platform?: NodeJS.Platform;
  /** Write the switch file before the runner starts: true on, false off, undefined no file (the default). */
  switched?: boolean;
  /** Leave the runner's `feature` dep out, so it builds the file switch itself (fail closed). */
  defaultSwitch?: boolean;
  /** The trick's program: the body of legs.sh after the shebang. With it set, the run seam starts a REAL child (`runProgram`). */
  program?: string;
  /** The Decision's content hash the Hill port gives back for any card, so an answer from the Hill queues and runs. */
  seen?: string;
}

/** A bridge with the trick `legs` in its folder, switched on at the folder's code hash, as after a restart. */
async function rig(opts: RigOptions = {}): Promise<Rig> {
  const root = await tempRoot();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dir = join(configDir, TRICKS_DIR, "legs");
  await mkdir(dir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), MANIFEST);
  await writeFile(join(dir, "legs.sh"), `#!/bin/sh\n${opts.program ?? ""}`, { mode: 0o755 });
  const code = await trickCodeHash(dir);
  const on: Switches = withSwitch({ on: new Map() }, "legs", true, "2026-11-17T08:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, "legs"));
  await writeSwitches(stateDir, on);
  if (opts.switched !== undefined) writeTricksFeature(stateDir, opts.switched, T0);
  const clock = { t: T0 };
  const specs: RunSpec[] = [];
  const withdrawn: string[] = [];
  const audit: Rig["audit"] = [];
  const gate: Rig["gate"] = { wait: null };
  const decisions: TricksHillPort = {
    sync: () => [],
    off: (trick) => withdrawn.push(trick.id),
    prune: () => {},
    seenOf: () => opts.seen,
  };
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    memberId: HOST,
    platform: opts.platform ?? "linux",
    world: (memberId) => ({ machine: "desk", sessions: [], spaces: [{ name: "collie", folder: `/work/${memberId}` }] }),
    env: { PATH: "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => {},
    revBase: 1000,
    decisions,
    audit: (entry) => audit.push(entry),
    run: async (spec): Promise<RunOutcome> => {
      specs.push(spec);
      if (opts.program !== undefined) return await runProgram(spec);
      if (gate.wait !== null) await gate.wait;
      return EXITED;
    },
  };
  if (opts.defaultSwitch !== true) deps.feature = new TricksFeatureSwitch(stateDir, () => {}, () => clock.t);
  return { configDir, stateDir, clock, service: new TricksService(deps), specs, withdrawn, audit, gate };
}

/** A phone looks, the clock moves, the scheduler ticks. */
async function tick(r: Rig, t: number): Promise<void> {
  r.clock.t = t;
  r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

const switchesText = (r: Rig): Promise<string> => readFile(join(r.stateDir, TRICKS_DIR, "switches.json"), "utf8");

describe("the switch file", () => {
  test("no file reads as off and unset; each write sets the whole value, 0600, through a temp file", async () => {
    const stateDir = await tempRoot();
    expect(readTricksFeature(stateDir)).toEqual({ on: false, problem: null, reading: "unset" });
    expect(writeTricksFeature(stateDir, true, T0)).toBe(true);
    expect(writeTricksFeature(stateDir, true, T0)).toBe(false);
    expect(readTricksFeature(stateDir)).toEqual({ on: true, problem: null, reading: "on" });
    expect(JSON.parse(await readFile(tricksFeaturePath(stateDir), "utf8"))).toEqual({ v: 1, on: true, at: "2026-11-17T09:00:00.000Z" });
    if (process.platform !== "win32") expect((await stat(tricksFeaturePath(stateDir))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(stateDir, TRICKS_DIR))).toEqual([TRICKS_FEATURE_FILE]);
    expect(writeTricksFeature(stateDir, false, T0)).toBe(true);
    expect(readTricksFeature(stateDir).reading).toBe("off");
  });

  test("a file that does not read is off, with one warning per change of the file", async () => {
    expect(parseTricksFeature("{}")).toEqual({ on: false, problem: `${TRICKS_FEATURE_FILE} is not a version 1 switch file; tricks read as off` });
    expect(parseTricksFeature('{"v":1,"on":"yes"}').on).toBe(false);
    const stateDir = await tempRoot();
    await mkdir(join(stateDir, TRICKS_DIR), { recursive: true });
    await writeFile(tricksFeaturePath(stateDir), '{"v":1,"on":true');
    const warned: string[] = [];
    const sw = new TricksFeatureSwitch(stateDir, (line) => warned.push(line));
    expect(sw.on()).toBe(false);
    expect(sw.reading()).toBe("off");
    expect(warned).toHaveLength(1);
  });

  test("the bridge's switch follows a terminal's write with no restart, and tells its listeners once per move", async () => {
    const stateDir = await tempRoot();
    const sw = new TricksFeatureSwitch(stateDir, () => {});
    const heard: boolean[] = [];
    const stop = sw.onChange((on) => heard.push(on));
    expect(sw.on()).toBe(false);
    writeTricksFeature(stateDir, true, T0);
    expect(sw.on()).toBe(true);
    expect(sw.on()).toBe(true);
    expect(sw.set(false)).toBe(true);
    expect(readTricksFeature(stateDir).on).toBe(false);
    expect(heard).toEqual([true, false]);
    stop();
    writeTricksFeature(stateDir, true, T0 + 1);
    expect(sw.on()).toBe(true);
    expect(heard).toEqual([true, false]);
  });
});

describe("with no switch file, nothing of a trick runs or draws", () => {
  test("a restart with tricks that were on: no start run, no timer run, no part, no Tricks Space; the list stays readable", async () => {
    // The control: the same rig with tricks switched on runs and draws.
    const on = await rig({ switched: true });
    await tick(on, T0);
    await tick(on, T0 + 31_000);
    expect(on.specs.length).toBeGreaterThan(0);
    expect((await on.service.reply(undefined)).parts.length).toBeGreaterThan(0);

    // No `feature` dep and no file: the runner builds the file switch itself and reads it as off.
    const off = await rig({ defaultSwitch: true });
    await tick(off, T0);
    await tick(off, T0 + 31_000);
    await tick(off, T0 + 62_000);
    expect(off.specs).toEqual([]);
    const reply = await off.service.reply(undefined);
    expect(reply.off).toBe(true);
    expect(reply.parts).toEqual([]);
    expect(reply.present).toEqual([]);
    // Name, kind and About stay; the row shows the trick's own switch, and its state is off.
    expect(reply.tricks.map((trick) => ({ id: trick.id, name: trick.name, on: trick.on, state: trick.state, places: trick.places }))).toEqual([{ id: "legs", name: "Legs", on: true, state: "off", places: ["belt"] }]);
    expect(off.service.sessionPanes()).toBeUndefined();
    expect(off.service.switchedOn()).toBe(false);
    // Its open Decisions are not withdrawn: the Hill holds them back (hill/service.ts `tricksOff`).
    expect(off.withdrawn).toEqual([]);
  });

  test("a phone's tap and a Decision's answer run nothing and keep no receipt", async () => {
    const off = await rig();
    await tick(off, T0);
    expect(await off.service.tap(HOST, "legs", { rid: RID, node: "belt", intent: "x", rev: 1 })).toEqual({ status: 200, body: { rid: RID, code: "rejected", message: TRICKS_OFF_LINE } });
    expect(await off.service.tapFromHill(HOST, "legs", { rid: RID, node: "hill/ship", intent: "yes", value: { text: null } }, "dc_abcdefabcdef")).toBe(false);
    expect(off.specs).toEqual([]);
    expect(await readdir(join(off.stateDir, TRICKS_DIR))).not.toContain("receipts.json");
  });

  test("no agent view opens, no picture is served, and the agent view's rules are not handed out", async () => {
    const off = await rig();
    await tick(off, T0);
    expect(off.service.viewGate("legs")).toEqual({ ok: false, code: "trick_off", error: TRICKS_OFF_LINE });
    expect(await off.service.viewGateFresh("legs")).toEqual({ ok: false, code: "trick_off", error: TRICKS_OFF_LINE });
    expect(await off.service.media(HOST, "legs", "a.png")).toBeNull();
  });

  test("a trick's own switch, auto, a version's yes or no and an undo are refused, and switches.json stays as it was", async () => {
    const off = await rig();
    await tick(off, T0);
    const before = await switchesText(off);
    const refused = { status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } } as const;
    expect(await off.service.setSwitch(HOST, "legs", false, null)).toEqual(refused);
    expect(await off.service.setSwitch(HOST, "legs", true, null)).toEqual(refused);
    expect(await off.service.autoRoute(HOST, "legs", true)).toEqual(refused);
    expect(await off.service.undoRoute(HOST, "legs")).toEqual(refused);
    const answer = { ok: false, code: "tricks-off", message: TRICKS_OFF_LINE } as const;
    expect(await off.service.approvePending("legs", "a".repeat(64))).toEqual(answer);
    expect(await off.service.declinePending("legs", "a".repeat(64))).toEqual(answer);
    expect(await switchesText(off)).toBe(before);
  });

  test("an add from the official list is refused before anything is fetched; the list stays readable", async () => {
    const off = await rig();
    const entry: OfficialEntry = { id: "dash", name: "Dash", description: "A dash.", repo: "https://example.com/o/r", dir: "dash", commit: "a".repeat(40), hash: "b".repeat(64), extras: "c".repeat(64), rules: null, contract: 1, places: ["belt"], previous: [] };
    const list = new OfficialTricks({ configDir: off.configDir, stateDir: off.stateDir, env: {}, entries: () => [entry], gate: () => off.service.gateLine(), offLine: () => off.service.offLine(), lane: (work) => off.service.officialLane(work) });
    expect((await list.reply()).tricks.map((t) => t.id)).toEqual(["dash"]);
    expect(await list.install("dash", "add")).toEqual({ status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } });
    expect(await list.install("dash", "update")).toEqual({ status: 409, body: { error: "tricks-off", message: TRICKS_OFF_LINE } });
    expect(await readdir(join(off.configDir, TRICKS_DIR))).toEqual(["legs"]);
    // The lane is the second lock.
    await expect(off.service.officialLane(async () => "written")).rejects.toThrow(TRICKS_OFF_LINE);
  });

  test("a proposal is refused with the sentence, and a yes to an older card places nothing", async () => {
    const off = await rig();
    expect(await off.service.proposalTarget("fresh")).toEqual({ kind: "refused", reason: TRICKS_OFF_LINE, code: "no_tricks" });
    const files = [{ rel: "trick.toml", bytes: new TextEncoder().encode('id = "fresh"\nname = "F"\nplaces = ["belt"]\n'), executable: false }];
    const origin = { by: "agent" as const, host: HOST, label: "composer", at: "2026-11-17T09:00:00Z" };
    expect(await off.service.installProposed("fresh", files, origin, proposalHash(files))).toEqual({ ok: false, message: TRICKS_OFF_LINE });
    expect(await off.service.installProposedVersion("legs", files, origin, "c".repeat(64), proposalHash(files))).toEqual({ ok: false, message: TRICKS_OFF_LINE });
    expect(await readdir(join(off.configDir, TRICKS_DIR))).toEqual(["legs"]);

    const on = await rig({ switched: true });
    expect(await on.service.proposalTarget("fresh")).toEqual({ kind: "new" });
  });
});

describe("moving the switch", () => {
  test("off while a run is in flight: the run ends by the old rules and leaves nothing, and no new run starts", async () => {
    const r = await rig({ switched: true });
    let release = (): void => {};
    r.gate.wait = new Promise<void>((go) => {
      release = go;
    });
    r.clock.t = T0;
    r.service.noteWatched();
    await r.service.refresh(true);
    const running = r.service.tick();
    // The start run is in its program now.
    for (let i = 0; i < 50 && r.specs.length === 0; i += 1) await Bun.sleep(5);
    expect(r.specs).toHaveLength(1);
    expect(r.service.switchTo(false, "phone-a")).toBe(false);
    release();
    await running;
    r.gate.wait = null;
    expect((await r.service.reply(undefined)).parts).toEqual([]);
    await tick(r, T0 + 31_000);
    await tick(r, T0 + 62_000);
    expect(r.specs).toHaveLength(1);
  });

  // POSIX only: the trick runs `./legs.sh`, a `#!/bin/sh` program, which the runner refuses on Windows.
  test.skipIf(process.platform === "win32")("off while a program RUNS: the child is killed, and the tap and the answer waiting behind it never start", async () => {
    const pids = await tempRoot();
    const pidFile = join(pids, "pids");
    // The first run answers at once (it draws the belt); every later run records its pid and sleeps.
    const program = `if [ -f '${join(pids, "first")}' ]; then echo $$ >> '${pidFile}'; exec sleep 30; fi\ntouch '${join(pids, "first")}'\nprintf '%s' '${BELT}'\n`;
    const r = await rig({ switched: true, program, seen: "seen" });
    const pidsNow = async (): Promise<number[]> => (await readFile(pidFile, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").map(Number);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let slow: Promise<void> | undefined;
    try {
      await tick(r, T0);
      expect(r.specs).toHaveLength(1);
      const rev = (await r.service.reply(undefined)).parts[0]?.rev;
      expect(rev).toBeGreaterThan(0);
      r.clock.t = T0 + 31_000;
      slow = r.service.tick();
      for (let i = 0; i < 200 && (await pidsNow()).length === 0; i += 1) await Bun.sleep(10);
      const [child] = await pidsNow();
      expect(child).toBeGreaterThan(0);
      expect(alive(child!)).toBe(true);
      // One phone tap and one answer from the Hill wait behind the running program.
      const tap = r.service.tap(HOST, "legs", { rid: RID, node: "belt", intent: "x", rev });
      const answer = r.service.tapFromHill(HOST, "legs", { rid: "8a1d2e3f-4b5c-4d6e-8f70-8192a3b4c5d6", node: "hill/ship", intent: "yes", value: { text: null } }, "dc_abcdefabcdef");
      await Bun.sleep(50);
      expect(r.specs).toHaveLength(2);
      expect(r.service.switchTo(false, "phone-a")).toBe(false);
      // The program is gone, and the run it belonged to ends now, not at the 10 s limit.
      for (let i = 0; i < 200 && alive(child!); i += 1) await Bun.sleep(10);
      expect(alive(child!)).toBe(false);
      await slow;
      // Neither waiting run started a program: no third spec, no second pid.
      expect(await tap).toEqual({ status: 200, body: { rid: RID, code: "rejected", message: TRICKS_OFF_LINE } });
      expect(await answer).toBe(false);
      expect(r.specs).toHaveLength(2);
      expect(await pidsNow()).toEqual([child!]);
      await tick(r, T0 + 62_000);
      expect(r.specs).toHaveLength(2);
      expect((await r.service.reply(undefined)).parts).toEqual([]);
    } finally {
      for (const pid of await pidsNow()) if (alive(pid)) process.kill(pid, "SIGKILL");
      await slow?.catch(() => {});
    }
  });

  test("on, off, on: each trick keeps its own switch, the file of switches is never written, and the trick runs again", async () => {
    const r = await rig({ switched: true });
    const before = await switchesText(r);
    await tick(r, T0);
    const runs = r.specs.length;
    expect(runs).toBeGreaterThan(0);
    expect(r.service.switchTo(false, null)).toBe(false);
    await tick(r, T0 + 31_000);
    expect(r.specs.length).toBe(runs);
    expect((await r.service.reply(undefined)).tricks[0]?.on).toBe(true);
    expect(r.service.switchTo(true, null)).toBe(true);
    await tick(r, T0 + 62_000);
    expect(r.specs.length).toBeGreaterThan(runs);
    expect(await switchesText(r)).toBe(before);
    expect(r.withdrawn).toEqual([]);
    expect(r.audit.filter((entry) => entry.action === "tricks.switch").map((entry) => entry.detail.on)).toEqual(["false", "true"]);
  });

  test("a second phone sees the move: the value the snapshot reads moves at once, and the tricks revision moves with the next scan", async () => {
    const r = await rig({ switched: true });
    await tick(r, T0);
    const rev = r.service.rev();
    // Phone A writes; phone B's next snapshot reads `switchedOn()` (server.ts `tricksOff`).
    expect(r.service.switchTo(false, "phone-a")).toBe(false);
    expect(r.service.switchedOn()).toBe(false);
    await r.service.refresh(true);
    expect(r.service.rev()).not.toBe(rev);
  });

  test("a trick switched off by its own switch while tricks were off loses its open Decisions then", async () => {
    const r = await rig();
    await tick(r, T0);
    expect(r.withdrawn).toEqual([]);
    await writeSwitches(r.stateDir, { on: new Map() });
    await r.service.refresh(true);
    expect(r.withdrawn).toEqual(["legs"]);
  });

  test("Windows: the gate answers first, and the switch does not move there", async () => {
    const win = await rig({ platform: "win32" });
    expect(await win.service.tap(HOST, "legs", { rid: RID, node: "belt", intent: "x", rev: 1 })).toEqual({ status: 200, body: { rid: RID, code: "rejected", message: TRICKS_WINDOWS_LINE } });
    expect(await win.service.setSwitch(HOST, "legs", true, null)).toEqual({ status: 409, body: { error: "windows", message: TRICKS_WINDOWS_LINE } });
    expect(win.service.switchTo(true, null)).toBeNull();
    expect(readTricksFeature(win.stateDir).reading).toBe("unset");
    expect(win.service.switchedOn()).toBe(false);
  });
});

describe("the route", () => {
  const ctx = { device: "phone-a", acceptEncoding: null };

  test("GET answers { on }, POST takes exactly { on: boolean }, Windows answers its line, a failed write 503", async () => {
    /** The fake runner's switch: its value, the Windows line or none, and whether a write lands. */
    interface Held {
      on: boolean;
      gate: string | null;
      writes: boolean;
    }
    const held: Held = { on: false, gate: null, writes: true };
    const surface = {
      switchedOn: () => held.on,
      switchTo: (on: boolean) => {
        if (!held.writes) return null;
        held.on = on;
        return on;
      },
      gateLine: () => held.gate,
    };
    expect(await tricksFeatureRoute(surface, null, ctx).json()).toEqual({ on: false });
    expect((await tricksFeatureRoute(surface, { body: { on: true, more: 1 } }, ctx)).status).toBe(400);
    expect((await tricksFeatureRoute(surface, { body: { on: "yes" } }, ctx)).status).toBe(400);
    expect(await tricksFeatureRoute(surface, { body: { on: true } }, ctx).json()).toEqual({ on: true });
    held.writes = false;
    expect((await tricksFeatureRoute(surface, { body: { on: false } }, ctx)).status).toBe(503);
    held.gate = TRICKS_WINDOWS_LINE;
    const win = tricksFeatureRoute(surface, { body: { on: true } }, ctx);
    expect(win.status).toBe(409);
    expect(await win.text()).toBe(TRICKS_WINDOWS_LINE);
    expect(tricksFeatureRoute(undefined, null, ctx).status).toBe(404);
  });

  test("the write needs the Hill switch's device level, and the snapshot carries the value outside the crew cut", async () => {
    const src = await readFile(join(import.meta.dir, "..", "server.ts"), "utf8");
    // The Hill's switch route moves with the write right ...
    const hill = src.slice(src.indexOf('if (pathname === "/api/hill/switch"'));
    expect(hill.slice(0, 300)).toContain('browserGate(req.method === "GET" ? "read" : "write")');
    // ... and so does this one: one level, read from the rights table.
    expect(TRICKS_ROUTE_RIGHTS.feature).toBe("write");
    const route = src.slice(src.indexOf("if (pathname === TRICKS_FEATURE_ROUTE"));
    expect(route.slice(0, 300)).toContain('guard(req, cfg, req.method === "GET" ? TRICKS_ROUTE_RIGHTS.reply : TRICKS_ROUTE_RIGHTS.feature, pairingGate)');
    // `?h=<member>` is refused with 400, as on the Hill's switch: the switch is this machine's only.
    expect(route.slice(0, 600)).toContain('if (host.kind === "member") return text(TRICKS_SWITCH_LOCAL_TEXT, 400);');
    expect(hill.slice(0, 400)).toContain('if (host.kind === "member") return text(HILL_LOCAL_TEXT, 400);');
    expect(TRICKS_SWITCH_LOCAL_TEXT).toContain("this machine");
    const snapshot = src.slice(src.indexOf("const localSnapshot = ("), src.indexOf("const watchedPaneIds = ()"));
    const cut = snapshot.indexOf("if (forCrew) return body;");
    const carried = snapshot.indexOf("if (opts.tricks !== undefined && !opts.tricks.switchedOn()) body.tricksOff = true;");
    expect(cut).toBeGreaterThan(0);
    expect(carried).toBeGreaterThan(cut);
  });
});
