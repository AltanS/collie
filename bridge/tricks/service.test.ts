import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { JsonObject } from "../json.ts";
import { parseFacts, partKey, type TrickFacts, type TrickTapReply } from "../../web/src/lib/tricks/schema.ts";
import { trickCodeHash } from "./code-hash.ts";
import { TRICKS_DIR } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { payloadDigest } from "../worktree-receipts.ts";
import { memoryTrickReceipts, TrickReceiptStore } from "./receipts.ts";
import { backoffAfter, BACKOFF_MS, CHANGED_LINE, RUNS_MAX, TAP_LOST_LINE, TricksService, WATCH_WINDOW_MS, type TricksServiceDeps, type TapAnswer } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-service-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-11-08T09:00:00Z");
const HOST = "bluefin";
const REQ = "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const REQ2 = "8f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";
const REQ3 = "9f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5";

interface Rig {
  root: string;
  configDir: string;
  stateDir: string;
  clock: { t: number };
  warnings: string[];
  service: TricksService;
  /** Every spec the fake runner was handed. */
  specs: RunSpec[];
}

/** A trick folder with a manifest and files. */
async function makeTrick(configDir: string, id: string, manifest: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(configDir, TRICKS_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), manifest);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o755 });
  return dir;
}

/** Switch tricks on as a person does: each with the code hash of its folder as it is now. */
async function switchOn(stateDir: string, ...ids: string[]): Promise<void> {
  let switches: Switches = { on: new Map() };
  for (const id of ids) {
    const code = await trickCodeHash(join(dirname(stateDir), "config", TRICKS_DIR, id));
    switches = withSwitch(switches, id, true, "2026-11-08T09:00:00Z", code.ok ? code.hash : null);
  }
  await writeSwitches(stateDir, switches);
}

/** One scripted run: an outcome at once, or one that comes when the test lets it. */
type Scripted = RunOutcome | { later: () => Promise<RunOutcome> };

/** A rig with a scripted runner: each run takes the next outcome (the last one repeats). */
async function rig(outcomes: Scripted[] | null, extra: Partial<TricksServiceDeps> = {}): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const clock = { t: T0 };
  const warnings: string[] = [];
  const specs: RunSpec[] = [];
  let i = 0;
  const run =
    outcomes === null
      ? undefined
      : async (spec: RunSpec): Promise<RunOutcome> => {
          specs.push(spec);
          const next = outcomes[Math.min(i, outcomes.length - 1)];
          i += 1;
          if (next === undefined) throw new Error("no outcome scripted");
          return "later" in next ? await next.later() : next;
        };
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    memberId: HOST,
    world: (memberId) => ({
      machine: "desk",
      sessions: [{ id: `${memberId}:w6X:3`, memberId, sessionId: `${memberId}:w6X:3`, paneId: "w6X:3", host: "desk", name: "composer", agent: "claude", status: "working" }],
      spaces: [{ name: "collie", folder: "/work/collie" }],
    }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COLLIE_TOKEN: "tok", OPENROUTER_API_KEY: "sk-or-v1-0123456789abcdef0123456789" },
    now: () => clock.t,
    warn: (line) => warnings.push(line),
    revBase: 1000,
    ...extra,
  };
  if (run !== undefined) deps.run = run;
  const service = new TricksService(deps);
  return { root, configDir, stateDir, clock, warnings, service, specs };
}

const exited = (stdout: string, code = 0): RunOutcome => ({ kind: "exited", code, stdout, stderr: "", ms: 5 });
const belt = (label: string, extra: JsonObject = {}): string =>
  JSON.stringify({ v: 1, asOf: "2026-11-08T09:00:00Z", parts: [{ at: "belt", id: "belt", mark: { label } }], ...extra });
const MANIFEST = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nevery = "30s"\nplaces = ["belt", "session"]\n';

/** Watch, advance the clock, tick, wait for the scan the tick started. */
async function tickAt(r: Rig, t: number, watch = true): Promise<void> {
  r.clock.t = t;
  if (watch) r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

/** The reply of a tap that answered 200. */
function ok200(answer: TapAnswer): TrickTapReply {
  if (answer.status !== 200) throw new Error(`the tap answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

function factsOf(spec: RunSpec | undefined): TrickFacts {
  const parsed = parseFacts(JSON.parse(spec?.stdin ?? "null"));
  if (parsed.facts === undefined) throw new Error(`facts did not parse: ${JSON.stringify(parsed.refusals)}`);
  return parsed.facts;
}

describe("zero tricks", () => {
  test("no folder: no rev, an empty reply, no log line, no file", async () => {
    const r = await rig([exited(belt("x"))]);
    r.service.noteWatched();
    await r.service.refresh(true);
    await r.service.tick();
    expect(r.service.rev()).toBeUndefined();
    expect(await r.service.reply(undefined)).toEqual({ rev: 1000, tricks: [], parts: [], present: [] });
    expect(r.warnings).toEqual([]);
    expect(await readdir(r.stateDir)).toEqual([]);
    expect(r.specs).toEqual([]);
  });

  test("an empty tricks folder: a rev, still nothing listed", async () => {
    const r = await rig([exited(belt("x"))]);
    await mkdir(join(r.configDir, TRICKS_DIR));
    await r.service.refresh(true);
    expect(r.service.rev()).toBe(1000);
    expect((await r.service.reply(undefined)).tricks).toEqual([]);
  });
});

describe("discovery and the switch", () => {
  test("a new folder is listed OFF and never runs", async () => {
    const r = await rig([exited(belt("x"))]);
    await makeTrick(r.configDir, "legs", MANIFEST, { "legs.sh": "#!/bin/sh\n" });
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    expect(reply.tricks).toEqual([
      { host: HOST, id: "legs", name: "Browser leg", icon: "plug", on: false, state: "off", places: ["belt", "session"], provenance: { via: "folder" } },
    ]);
    expect(r.specs).toEqual([]);
  });

  test("a folder whose manifest is refused is listed with its refusals and never runs", async () => {
    const r = await rig([exited(belt("x"))]);
    await makeTrick(r.configDir, "bad", 'id = "bad"\nname = "Bad"\nrun = "./x.sh"\nplaces = ["nowhere"]\n');
    await switchOn(r.stateDir, "bad");
    await tickAt(r, T0);
    const info = (await r.service.reply(undefined)).tricks[0];
    expect(info?.state).toBe("skipped");
    expect(info?.refusals?.[0]?.path).toBe("/places/0");
    expect(info?.error).toStartWith("A place is one of");
    expect(r.specs).toEqual([]);
  });

  test("switched on: a start run with scrubbed env, cwd the folder, the facts on stdin, and a 0700 state folder", async () => {
    const r = await rig([exited(belt("23/34"))]);
    const dir = await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    expect(r.specs.length).toBe(1);
    const spec = r.specs[0];
    expect(spec?.command).toBe("./legs.sh");
    expect(spec?.cwd).toBe(dir);
    expect(spec?.env.COLLIE_TOKEN).toBeUndefined();
    expect(spec?.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(spec?.env.PATH).toBe(process.env.PATH ?? "/usr/bin:/bin");
    const facts = factsOf(spec);
    expect(facts.trigger).toEqual({ kind: "start" });
    expect(facts.trick).toEqual({ id: "legs", dir, state: join(r.stateDir, TRICKS_DIR, "legs") });
    expect(facts.sessions[0]?.id).toBe("bluefin:w6X:3");
    // `host` is the machine's display name; the keys a trick passes back stay on the tricks host name.
    expect(facts.host).toBe("desk");
    expect(facts.sessions[0]).toMatchObject({ memberId: "bluefin", sessionId: "bluefin:w6X:3", host: "desk" });
    expect(JSON.stringify(facts)).not.toContain(r.configDir.replace(/\/config$/, "/config/.env"));
    expect((await Bun.file(facts.trick.state).stat()).mode & 0o777).toBe(0o700);
    const reply = await r.service.reply(undefined);
    expect(reply.tricks[0]?.state).toBe("ok");
    expect(reply.parts.map((p) => partKey(p))).toEqual(["bluefin/legs/belt"]);
    expect(reply.parts[0]?.value).toEqual({ at: "belt", id: "belt", mark: { label: "23/34" } });
    expect(reply.parts[0]?.fresh).toBe("90s");
    expect(reply.path).toBe(process.env.PATH ?? "/usr/bin:/bin");
  });

  test("switched off: the parts go, and it does not run", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    expect((await r.service.reply(undefined)).present).toEqual(["bluefin/legs/belt"]);
    await writeSwitches(r.stateDir, { on: new Map() });
    await tickAt(r, T0 + 60_000);
    const reply = await r.service.reply(undefined);
    expect(reply.present).toEqual([]);
    expect(reply.tricks[0]?.state).toBe("off");
    expect(r.specs.length).toBe(1);
  });

  test("a folder that goes away takes the trick and its parts with it", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    await rm(dir, { recursive: true });
    await r.service.refresh(true);
    const reply = await r.service.reply(undefined);
    expect(reply.tricks).toEqual([]);
    expect(reply.present).toEqual([]);
  });
});

describe("the switch route", () => {
  test("on then off writes the file the CLI reads, moves tricksRev, and answers the trick as listed", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST, { "legs.sh": "#!/bin/sh\n" });
    await r.service.refresh(true);
    const before = (await r.service.reply(undefined)).rev;
    const on = await r.service.setSwitch(HOST, "legs", true);
    expect(on.status).toBe(200);
    if (on.status !== 200) return;
    expect(on.body).toMatchObject({ host: HOST, id: "legs", on: true });
    expect(on.body.state).not.toBe("off");
    expect((await r.service.reply(undefined)).rev).toBeGreaterThan(before);
    const file = JSON.parse(await readFile(join(r.stateDir, "tricks", "switches.json"), "utf8"));
    expect(file.v).toBe(2);
    expect(Object.keys(file.on)).toEqual(["legs"]);
    // On approves the code as it is now: the file holds its hash.
    const code = await trickCodeHash(join(r.configDir, TRICKS_DIR, "legs"));
    expect(file.on.legs.hash).toBe(code.ok ? code.hash : "");
    const off = await r.service.setSwitch(HOST, "legs", false);
    expect(off).toMatchObject({ status: 200, body: { id: "legs", on: false, state: "off" } });
    expect(JSON.parse(await readFile(join(r.stateDir, "tricks", "switches.json"), "utf8")).on).toEqual({});
  });

  test("a switch keeps the other tricks' switches", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await makeTrick(r.configDir, "other", MANIFEST.replace('"legs"', '"other"'));
    await switchOn(r.stateDir, "other");
    await r.service.setSwitch(HOST, "legs", true);
    expect(Object.keys(JSON.parse(await readFile(join(r.stateDir, "tricks", "switches.json"), "utf8")).on).toSorted()).toEqual(["legs", "other"]);
  });

  test("a trick whose manifest is refused can still be switched off", async () => {
    const r = await rig([exited(belt("x"))]);
    await makeTrick(r.configDir, "bad", 'id = "bad"\nname = "Bad"\nrun = "./x.sh"\nplaces = ["nowhere"]\n');
    await switchOn(r.stateDir, "bad");
    await r.service.refresh(true);
    const off = await r.service.setSwitch(HOST, "bad", false);
    expect(off).toMatchObject({ status: 200, body: { id: "bad", on: false, state: "skipped" } });
  });

  test("a foreign host and an unknown trick are 404 and write no file", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    expect(await r.service.setSwitch("minibuch", "legs", true)).toEqual({ status: 404, body: { error: "unknown-host" } });
    expect(await r.service.setSwitch(HOST, "nope", true)).toEqual({ status: 404, body: { error: "unknown-trick" } });
    expect(await Bun.file(join(r.stateDir, "tricks", "switches.json")).exists()).toBe(false);
  });

  test("two switches at once both land", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await makeTrick(r.configDir, "other", MANIFEST.replace('"legs"', '"other"'));
    await Promise.all([r.service.setSwitch(HOST, "legs", true), r.service.setSwitch(HOST, "other", true)]);
    expect(Object.keys(JSON.parse(await readFile(join(r.stateDir, "tricks", "switches.json"), "utf8")).on).toSorted()).toEqual(["legs", "other"]);
  });
});

describe("the watched gate and the timer", () => {
  test("no run until a phone watched; timers stop five minutes after the last look", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    await r.service.tick();
    expect(r.specs.length).toBe(0);
    await tickAt(r, T0);
    expect(r.specs.length).toBe(1);
    // Inside the 30 s: skipped.
    await tickAt(r, T0 + 10_000, false);
    expect(r.specs.length).toBe(1);
    // Due, and the look at T0 still counts.
    await tickAt(r, T0 + 30_000, false);
    expect(r.specs.length).toBe(2);
    expect(factsOf(r.specs[1]).trigger).toEqual({ kind: "timer" });
    // Past the watch window with no new look: nothing.
    await tickAt(r, T0 + WATCH_WINDOW_MS + 1, false);
    expect(r.specs.length).toBe(2);
    // A look again: the overdue tick runs.
    await tickAt(r, T0 + WATCH_WINDOW_MS + 2);
    expect(r.specs.length).toBe(3);
  });

  test("a trick with no `every` runs once at start and then only on taps", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "once", 'id = "once"\nname = "Once"\nrun = "./x"\nplaces = ["belt"]\n');
    await switchOn(r.stateDir, "once");
    await tickAt(r, T0);
    await tickAt(r, T0 + 3_600_000);
    expect(r.specs.length).toBe(1);
  });

  test("a tick while a run is going is skipped", async () => {
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(exited(belt("1")));
        }),
    };
    const r = await rig([slow, exited(belt("2"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    r.service.noteWatched();
    await r.service.refresh(true);
    const first = r.service.tick();
    await Bun.sleep(20);
    r.clock.t = T0 + 60_000;
    await r.service.tick();
    expect(r.specs.length).toBe(1);
    release();
    await first;
  });
});

describe("backoff", () => {
  test("the ladder is 1, 5, 30 minutes, then stop", () => {
    expect(BACKOFF_MS).toEqual([60_000, 300_000, 1_800_000]);
    expect([1, 2, 3, 4].map(backoffAfter)).toEqual([60_000, 300_000, 1_800_000, null]);
  });

  test("failed runs wait 1, 5 and 30 minutes, then the trick stops; a config.toml change restarts it", async () => {
    const r = await rig([exited("", 1)]);
    const dir = await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    expect(r.specs.length).toBe(1);
    expect((await r.service.reply(undefined)).tricks[0]?.state).toBe("failing");
    await tickAt(r, T0 + 59_000);
    expect(r.specs.length).toBe(1);
    await tickAt(r, T0 + 60_000);
    expect(r.specs.length).toBe(2);
    await tickAt(r, T0 + 60_000 + 299_000);
    expect(r.specs.length).toBe(2);
    await tickAt(r, T0 + 360_000);
    expect(r.specs.length).toBe(3);
    await tickAt(r, T0 + 360_000 + 1_800_000);
    expect(r.specs.length).toBe(4);
    const stopped = await r.service.reply(undefined);
    expect(stopped.tricks[0]?.state).toBe("stopped");
    expect(stopped.tricks[0]?.error).toBe("The provider exited with 1");
    await tickAt(r, T0 + 100 * 60 * 60_000);
    expect(r.specs.length).toBe(4);
    // A change of config.toml restarts it with a start run (an edit of the code would stop it instead).
    await writeFile(join(dir, "config.toml"), "fixed = true\n");
    await tickAt(r, T0 + 101 * 60 * 60_000);
    expect(r.specs.length).toBe(5);
    expect(factsOf(r.specs[4]).trigger).toEqual({ kind: "start" });
    // One log line per change of error, and one for the stop: never one per run.
    expect(r.warnings.filter((w) => w.includes("legs")).length).toBeLessThanOrEqual(3);
  });

  test("a failed start run is tried again as a start run", async () => {
    const r = await rig([exited("", 2), exited(belt("1"))]);
    await makeTrick(r.configDir, "once", 'id = "once"\nname = "Once"\nrun = "./x"\nplaces = ["belt"]\n');
    await switchOn(r.stateDir, "once");
    await tickAt(r, T0);
    await tickAt(r, T0 + 60_000);
    expect(r.specs.map((s) => factsOf(s).trigger.kind)).toEqual(["start", "start"]);
    expect((await r.service.reply(undefined)).tricks[0]?.state).toBe("ok");
  });
});

describe("last good, per part, and the rev", () => {
  const two = (a: string, b: string | null): string =>
    JSON.stringify({
      v: 1,
      asOf: "2026-11-08T09:00:00Z",
      parts: [
        { at: "belt", id: "belt", mark: { label: a } },
        b === null ? { at: "session", id: "legs", name: "Browser leg", subtitle: "x".repeat(200), view: [{ kind: "para", text: "t" }] } : { at: "session", id: "legs", name: "Browser leg", subtitle: b, view: [{ kind: "para", text: "t" }] },
      ],
    });

  test("a refused part keeps its last good value, stale; a failed run makes every part stale; a good run clears it", async () => {
    const r = await rig([exited(two("1", "green")), exited(two("2", null)), { kind: "timeout", stderr: "", ms: 10_000, limitMs: 10_000 }, exited(two("3", "green again"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    const first = await r.service.reply(undefined);
    expect(first.parts.map((p) => [p.part, p.stale ?? false])).toEqual([
      ["belt", false],
      ["legs", false],
    ]);

    await tickAt(r, T0 + 30_000);
    const second = await r.service.reply(first.rev);
    const byPart = new Map(second.parts.map((p) => [p.part, p]));
    expect(byPart.get("belt")?.value).toEqual({ at: "belt", id: "belt", mark: { label: "2" } });
    expect(byPart.get("belt")?.stale).toBeUndefined();
    expect(byPart.get("legs")?.stale).toBe(true);
    expect(byPart.get("legs")?.value).toMatchObject({ subtitle: "green" });
    expect(byPart.get("legs")?.problem).toContain("subtitle");
    expect(second.present.toSorted()).toEqual(["bluefin/legs/belt", "bluefin/legs/legs"]);
    expect(second.tricks[0]?.refusals?.[0]?.part).toBe("legs");

    await tickAt(r, T0 + 60_000);
    const third = await r.service.reply(second.rev);
    expect(third.parts.every((p) => p.stale === true)).toBe(true);
    expect(third.parts.find((p) => p.part === "belt")?.value).toEqual({ at: "belt", id: "belt", mark: { label: "2" } });
    expect(third.tricks[0]?.state).toBe("failing");

    await tickAt(r, T0 + 120_000);
    const fourth = await r.service.reply(third.rev);
    expect(fourth.parts.map((p) => p.stale ?? false)).toEqual([false, false]);
    expect(fourth.tricks[0]?.state).toBe("ok");
    expect(fourth.tricks[0]?.error).toBeUndefined();
  });

  test("tricksRev moves on a change and `since` gives only what changed", async () => {
    const r = await rig([exited(belt("1")), exited(belt("1")), exited(belt("2"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await r.service.refresh(true);
    const listed = r.service.rev() ?? 0;
    expect(listed).toBeGreaterThan(1000);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    const afterFirst = r.service.rev() ?? 0;
    expect(afterFirst).toBeGreaterThan(listed);
    // The same document again: the part does not move (only the list's lastRunAt does).
    await tickAt(r, T0 + 30_000);
    const same = await r.service.reply(afterFirst);
    expect(same.parts).toEqual([]);
    expect(same.present).toEqual(["bluefin/legs/belt"]);
    // A new face: the part comes back with a higher rev.
    await tickAt(r, T0 + 60_000);
    const changed = await r.service.reply(same.rev);
    expect(changed.parts.map((p) => p.value)).toEqual([{ at: "belt", id: "belt", mark: { label: "2" } }]);
    expect(changed.parts[0]?.rev ?? 0).toBeGreaterThan(same.rev);
    // A `since` from a future (a bridge before a restart with a clock behind) is everything.
    expect((await r.service.reply(changed.rev + 1_000_000)).parts.length).toBe(1);
  });

  test("a part the document drops goes away from `present`", async () => {
    const r = await rig([exited(two("1", "ok")), exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    await tickAt(r, T0 + 30_000);
    expect((await r.service.reply(undefined)).present).toEqual(["bluefin/legs/belt"]);
  });

  test("a removed kind is refused by name, and the runner keeps nothing of that part", async () => {
    const doc = JSON.stringify({ v: 1, parts: [{ at: "session", id: "s", view: [{ kind: "divider" }] }] });
    const r = await rig([exited(doc)]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    expect(reply.parts).toEqual([]);
    expect(reply.tricks[0]?.refusals?.[0]?.code).toBe("removed");
  });
});

describe("taps", () => {
  const tapBody = (rid = REQ, intent = "rerun") => ({ rid, node: "belt", intent, value: "24", from: { session: "bluefin:w6X:3" } });

  async function onRig(outcomes: Parameters<typeof rig>[0]): Promise<Rig> {
    const r = await rig(outcomes);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    return r;
  }

  test("a tap runs the provider with the tap trigger and replies ok with the new parts", async () => {
    const r = await onRig([exited(belt("24 red"))]);
    const answer = await r.service.tap(HOST, "legs", tapBody());
    expect(answer.status).toBe(200);
    const reply = ok200(answer);
    expect(reply.code).toBe("ok");
    expect(reply.parts?.map((p) => p.value)).toEqual([{ at: "belt", id: "belt", mark: { label: "24 red" } }]);
    expect(reply.present).toEqual(["bluefin/legs/belt"]);
    expect(reply.rev).toBe(r.service.rev());
    expect(factsOf(r.specs[0]).trigger).toEqual({ kind: "tap", ...tapBody() });
  });

  test("the same rid runs nothing twice and answers the same receipt again; another payload is refused", async () => {
    const r = await onRig([exited(belt("1"))]);
    const first = await r.service.tap(HOST, "legs", tapBody());
    const again = await r.service.tap(HOST, "legs", tapBody());
    expect(r.specs.length).toBe(1);
    expect(again.status).toBe(200);
    expect(ok200(again)).toEqual(ok200(first));
    expect(ok200(again).code).toBe("ok");
    const reused = await r.service.tap(HOST, "legs", tapBody(REQ, "other"));
    expect(reused).toEqual({ status: 409, body: { error: "request-id-reused", rid: REQ } });
  });

  test("a repeat while the first is in flight waits for it and runs nothing", async () => {
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(exited(belt("1")));
        }),
    };
    const r = await onRig([slow]);
    const a = r.service.tap(HOST, "legs", tapBody());
    await Bun.sleep(20);
    const b = r.service.tap(HOST, "legs", tapBody());
    await Bun.sleep(20);
    release();
    const first = ok200(await a);
    expect(first.code).toBe("ok");
    expect(ok200(await b)).toEqual(first);
    expect(r.specs.length).toBe(1);
  });

  test("a tap queues one deep ahead of the timer; a second waiting tap is busy and keeps no receipt", async () => {
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(exited(belt("timer")));
        }),
    };
    const r = await onRig([slow, exited(belt("tapped"))]);
    r.service.noteWatched();
    const timer = r.service.tick();
    await Bun.sleep(20);
    const queued = r.service.tap(HOST, "legs", tapBody(REQ));
    await Bun.sleep(20);
    const busy = await r.service.tap(HOST, "legs", tapBody(REQ2));
    expect(ok200(busy).code).toBe("rejected");
    expect(ok200(busy).message).toContain("busy");
    release();
    await timer;
    const reply = ok200(await queued);
    expect(reply.code).toBe("ok");
    expect(r.specs.map((s) => factsOf(s).trigger.kind)).toEqual(["start", "tap"]);
    // The busy id kept no receipt, so it may simply be tried again.
    expect(ok200(await r.service.tap(HOST, "legs", tapBody(REQ2))).code).toBe("ok");
  });

  test("a timeout is unknown, a failure is rejected with the masked line, and the tap restarts a stopped trick", async () => {
    const r = await onRig([
      { kind: "timeout", stderr: "", ms: 10_000, limitMs: 10_000 },
      { kind: "exited", code: 1, stdout: "", stderr: "curl: 401 for https://api/?token=sk-or-v1-0123456789abcdef0123456789", ms: 3 },
    ]);
    const unknown = ok200(await r.service.tap(HOST, "legs", tapBody(REQ)));
    expect(unknown.code).toBe("unknown");
    expect(unknown.message).toBe("The provider ran past 10 s and was stopped");
    const failed = ok200(await r.service.tap(HOST, "legs", tapBody(REQ2)));
    expect(failed.code).toBe("rejected");
    expect(failed.message).toStartWith("The provider exited with 1: curl: 401");
    expect(failed.message).not.toContain("0123456789abcdef");
  });

  test("off, unknown, foreign and malformed taps", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await r.service.refresh(true);
    expect(await r.service.tap("minibuch", "legs", tapBody())).toEqual({ status: 404, body: { error: "unknown-host" } });
    expect(await r.service.tap(HOST, "nope", tapBody())).toEqual({ status: 404, body: { error: "unknown-trick" } });
    const bad = await r.service.tap(HOST, "legs", { rid: "nope", node: "belt", intent: "x" });
    expect(bad.status).toBe(400);
    const off = ok200(await r.service.tap(HOST, "legs", tapBody()));
    expect(off).toEqual({ rid: REQ, code: "rejected", message: "The trick is off." });
    expect(r.specs.length).toBe(0);
    // Off kept no receipt: switched on, the same id runs.
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    expect(ok200(await r.service.tap(HOST, "legs", tapBody())).code).toBe("ok");
  });

  test("a tap under the id the bridge served before a crew join still lands; parts stay under the id it serves now", async () => {
    let kept = 0;
    const r = await rig([exited(belt("1"))], { previousId: "m_aaaaaaaaaa", keepId: () => (kept += 1) });
    // A scan alone keys nothing on the id: it is written down only before a program sees it.
    await makeTrick(r.configDir, "other", MANIFEST.replace('id = "legs"', 'id = "other"'));
    await r.service.refresh(true);
    expect(kept).toBe(0);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    const reply = ok200(await r.service.tap("m_aaaaaaaaaa", "legs", tapBody()));
    expect(reply.code).toBe("ok");
    expect(reply.parts?.map((part) => part.host)).toEqual([HOST]);
    expect((await r.service.reply(undefined)).tricks.map((trick) => trick.host)).toEqual([HOST, HOST]);
    // The facts the program got carry the id the bridge serves now, never the old one.
    expect(JSON.parse(r.specs[0]?.stdin ?? "{}")).toMatchObject({ memberId: HOST, host: "desk" });
    expect(await r.service.tap("m_bbbbbbbbbb", "legs", tapBody(REQ2))).toEqual({ status: 404, body: { error: "unknown-host" } });
    expect(kept).toBeGreaterThan(0);
  });

  test("a draft is refused as removed, from any run; the parts still draw", async () => {
    const r = await onRig([exited(belt("1", { draft: { session: "bluefin:w6X:3", text: "x" } }))]);
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    expect(reply.present).toEqual(["bluefin/legs/belt"]);
    expect(reply.tricks[0]?.refusals?.map((x) => x.code)).toEqual(["removed"]);
  });
});

describe("consent tied to the code", () => {
  /** A hill port that records what reached it. */
  function hillSpy() {
    const synced: string[][] = [];
    const offs: string[] = [];
    const port: NonNullable<TricksServiceDeps["decisions"]> = {
      sync: (_trick, run) => {
        synced.push(run.decisions.map((d) => d.key));
        return [];
      },
      off: (trick) => {
        offs.push(trick.id);
      },
      prune: () => {},
      seenOf: () => undefined,
    };
    return { synced, offs, port };
  }
  const ASK = { key: "a", title: "Rerun?", summary: "Case 8 failed." };

  test("an edited program stops the trick until it is switched on again; its parts go stale and its decisions stay", async () => {
    const spy = hillSpy();
    const r = await rig([exited(belt("1", { decisions: [ASK] }))], { decisions: spy.port });
    const dir = await makeTrick(r.configDir, "legs", MANIFEST, { "program.ts": "console.log(1)\n" });
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    expect(r.specs.length).toBe(1);
    await writeFile(join(dir, "program.ts"), "console.log(2)\n");
    await tickAt(r, T0 + 60_000);
    expect(r.specs.length).toBe(1);
    const reply = await r.service.reply(undefined);
    expect(reply.tricks[0]).toMatchObject({ on: true, changed: true, state: "stopped", error: CHANGED_LINE });
    expect(reply.parts[0]).toMatchObject({ stale: true, problem: CHANGED_LINE });
    expect(spy.offs).toEqual([]);
    // A tap is refused the same way, and runs nothing.
    expect(ok200(await r.service.tap(HOST, "legs", { rid: REQ, node: "belt", intent: "x" }))).toEqual({ rid: REQ, code: "rejected", message: CHANGED_LINE });
    // Switched on again: the new code is approved and runs at once.
    const on = await r.service.setSwitch(HOST, "legs", true);
    expect(on).toMatchObject({ status: 200, body: { on: true, state: "ok" } });
    if (on.status === 200) expect(on.body.changed).toBeUndefined();
    await tickAt(r, T0 + 61_000);
    expect(r.specs.length).toBe(2);
    expect(factsOf(r.specs[1]).trigger).toEqual({ kind: "start" });
  });

  test("a config.toml edit never turns a trick off: it reruns at once with the new settings", async () => {
    const r = await rig([exited(belt("1"))]);
    const dir = await makeTrick(r.configDir, "legs", MANIFEST, { "config.toml": "a = 1\n" });
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    await writeFile(join(dir, "config.toml"), "a = 2\n");
    await tickAt(r, T0 + 1000);
    expect(r.specs.length).toBe(2);
    expect((await r.service.reply(undefined)).tricks[0]?.changed).toBeUndefined();
  });

  test("an entry with no hash (a version 1 file) reads as changed", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await writeSwitches(r.stateDir, withSwitch({ on: new Map() }, "legs", true, "t"));
    await tickAt(r, T0);
    expect(r.specs.length).toBe(0);
    expect((await r.service.reply(undefined)).tricks[0]?.changed).toBe(true);
  });

  test("a program that appends to ./run.log keeps its interval and its backoff", async () => {
    let dir = "";
    let fail = false;
    const r = await rig(null, {
      run: async (spec) => {
        await appendFile(join(dir, "run.log"), "ran\n");
        await mkdir(join(dir, "media"), { recursive: true });
        await writeFile(join(dir, "media", "shot.png"), String(Math.random()));
        r.specs.push(spec);
        return fail ? exited("", 1) : exited(belt("1"));
      },
    });
    dir = await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    for (let s = 1; s < 30; s += 1) await tickAt(r, T0 + s * 1000);
    expect(r.specs.length).toBe(1);
    await tickAt(r, T0 + 30_000);
    expect(r.specs.length).toBe(2);
    fail = true;
    await tickAt(r, T0 + 60_000);
    expect(r.specs.length).toBe(3);
    for (let s = 61; s < 120; s += 5) await tickAt(r, T0 + s * 1000);
    expect(r.specs.length).toBe(3);
    await tickAt(r, T0 + 120_000);
    expect(r.specs.length).toBe(4);
    expect((await r.service.reply(undefined)).tricks[0]?.changed).toBeUndefined();
  });

  test("an absent decisions key leaves them as they are; an empty list withdraws them", async () => {
    const spy = hillSpy();
    const r = await rig([exited(belt("1", { decisions: [ASK] })), exited(belt("2")), exited(belt("3", { decisions: [] }))], { decisions: spy.port });
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    for (const rid of [REQ, REQ2, REQ3]) await r.service.tap(HOST, "legs", { rid, node: "belt", intent: "x" });
    expect(spy.synced).toEqual([["a"], []]);
  });
});

describe("taps, answers and slots", () => {
  /** A runner whose runs wait until the test lets them go, each one counted while it runs. */
  function gated() {
    const specs: RunSpec[] = [];
    const waiting: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    let open = false;
    return {
      specs,
      running: () => running,
      peak: () => peak,
      releaseAll: () => {
        open = true;
        for (const go of waiting.splice(0)) go();
      },
      run: async (spec: RunSpec): Promise<RunOutcome> => {
        specs.push(spec);
        running += 1;
        peak = Math.max(peak, running);
        if (!open) await new Promise<void>((go) => waiting.push(go));
        running -= 1;
        return exited(belt("1"));
      },
    };
  }

  test("three answers from the hill at once all reach the program, one at a time, ahead of the timer", async () => {
    const g = gated();
    const r = await rig(null, { run: g.run });
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    r.service.noteWatched();
    const timer = r.service.tick();
    await Bun.sleep(20);
    const answers = [REQ, REQ2, REQ3].map((rid, i) => r.service.tapFromHill(HOST, "legs", { rid, node: "hill/a", intent: "rerun", value: { text: String(i) } }, "dc_x"));
    await Bun.sleep(20);
    expect(g.running()).toBe(1);
    g.releaseAll();
    await timer;
    expect(await Promise.all(answers)).toEqual([true, true, true]);
    expect(g.specs.map((s) => factsOf(s).trigger.kind)).toEqual(["start", "tap", "tap", "tap"]);
    expect(g.specs.slice(1).map((s) => factsOf(s).trigger)).toMatchObject([{ rid: REQ }, { rid: REQ2 }, { rid: REQ3 }]);
    expect(g.peak()).toBe(1);
  });

  test("at most four programs run at once across all tricks", async () => {
    const g = gated();
    const r = await rig(null, { run: g.run });
    const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
    for (const id of ids) await makeTrick(r.configDir, id, MANIFEST.replace('"legs"', `"${id}"`));
    await switchOn(r.stateDir, ...ids);
    r.service.noteWatched();
    await r.service.refresh(true);
    const tick = r.service.tick();
    await Bun.sleep(30);
    expect(g.running()).toBe(RUNS_MAX);
    expect(r.service.runsHeld()).toBe(RUNS_MAX);
    g.releaseAll();
    await tick;
    expect(g.specs.length).toBe(6);
    expect(g.peak()).toBe(RUNS_MAX);
  });

  test("a tap that waited for a trick switched off answers rejected and runs nothing", async () => {
    const g = gated();
    const r = await rig(null, { run: g.run });
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    r.service.noteWatched();
    const timer = r.service.tick();
    await Bun.sleep(20);
    const queued = r.service.tap(HOST, "legs", { rid: REQ, node: "belt", intent: "x" });
    await Bun.sleep(10);
    await writeSwitches(r.stateDir, { on: new Map() });
    await r.service.refresh(true);
    g.releaseAll();
    await timer;
    expect(ok200(await queued)).toEqual({ rid: REQ, code: "rejected", message: "The trick is off." });
    expect(g.specs.length).toBe(1);
  });

  test("a tap writes its marker before the run; after a restart a marker alone answers unknown and never runs twice", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    expect(ok200(await r.service.tap(HOST, "legs", { rid: REQ, node: "belt", intent: "x" })).code).toBe("ok");
    const file = JSON.parse(await readFile(join(r.stateDir, "tricks", "receipts.json"), "utf8"));
    expect(file.receipts).toMatchObject([{ requestId: REQ, pending: false, reply: { code: "ok" } }]);
    // A bridge that died mid-run left only the marker of REQ2.
    const store = new TrickReceiptStore(r.stateDir);
    await store.load();
    await store.recordFirst({ requestId: REQ2, payloadDigest: payloadDigest(["legs", "belt", "x", "null", ""]), at: T0, pending: true, reply: null });
    // The same folders, a new bridge.
    const after = await rig([exited(belt("2"))], { configDir: r.configDir, stateDir: r.stateDir });
    const restarted = after.service;
    const lost = await restarted.tap(HOST, "legs", { rid: REQ2, node: "belt", intent: "x" });
    expect(ok200(lost)).toEqual({ rid: REQ2, code: "unknown", message: TAP_LOST_LINE });
    const replay = await restarted.tap(HOST, "legs", { rid: REQ, node: "belt", intent: "x" });
    expect(ok200(replay)).toMatchObject({ rid: REQ, code: "ok" });
    expect(after.specs.length).toBe(0);
  });

  test("a marker that cannot be written runs nothing", async () => {
    const r = await rig([exited(belt("1"))], { receipts: { ...memoryTrickReceipts(), recordFirst: async () => false } });
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    expect(ok200(await r.service.tap(HOST, "legs", { rid: REQ, node: "belt", intent: "x" })).code).toBe("rejected");
    expect(r.specs.length).toBe(0);
  });

  test("the switch answer reflects the write even while a scan is in flight", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await r.service.refresh(true);
    void r.service.refresh(true);
    const on = await r.service.setSwitch(HOST, "legs", true);
    expect(on).toMatchObject({ status: 200, body: { on: true } });
    void r.service.refresh(true);
    const off = await r.service.setSwitch(HOST, "legs", false);
    expect(off).toMatchObject({ status: 200, body: { on: false, state: "off" } });
  });
});

describe("real providers", () => {
  test("an sh provider and a bun provider run through the real runner", async () => {
    const r = await rig(null);
    await makeTrick(r.configDir, "hello", 'id = "hello"\nname = "Hello"\nrun = "./provider.sh"\nplaces = ["belt"]\n', {
      "provider.sh": `#!/bin/sh\nfacts=$(cat)\nn=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')\nprintf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"label":"%s"}}]}' "$n"\n`,
    });
    await makeTrick(r.configDir, "bunny", 'id = "bunny"\nname = "Bunny"\nrun = "bun provider.ts"\nplaces = ["belt"]\n', {
      "provider.ts": [
        'import { appendFileSync } from "node:fs";',
        "const facts = JSON.parse(await Bun.stdin.text());",
        'appendFileSync(`${facts.trick.state}/runs.log`, facts.trigger.kind + "\\n");',
        'const leaked = Object.keys(process.env).filter((k) => k.startsWith("COLLIE_") || k.includes("KEY"));',
        'console.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: leaked.length === 0 ? "clean" : "leak" } }] }));',
      ].join("\n"),
    });
    await switchOn(r.stateDir, "hello", "bunny");
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    const faces = Object.fromEntries(reply.parts.map((p) => [p.trick, p.value.at === "belt" ? p.value.mark.label : undefined]));
    expect(faces).toEqual({ hello: "1", bunny: "clean" });
    expect(await readFile(join(r.stateDir, TRICKS_DIR, "bunny", "runs.log"), "utf8")).toBe("start\n");
  });
});
