import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import { parseFacts, partKey, type TrickFacts, type TrickTapReply } from "../../web/src/lib/tricks/schema.ts";
import { TRICKS_DIR } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { backoffAfter, BACKOFF_MS, TricksService, WATCH_WINDOW_MS, type TricksServiceDeps, type TapAnswer } from "./service.ts";
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

async function switchOn(stateDir: string, ...ids: string[]): Promise<void> {
  let switches: Switches = { on: new Map<string, string>() };
  for (const id of ids) switches = withSwitch(switches, id, true, "2026-11-08T09:00:00Z");
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
    host: () => HOST,
    world: (host) => ({
      sessions: [{ id: `${host}:w6X:3`, paneId: "w6X:3", name: "composer", agent: "claude", status: "working" }],
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
const belt = (face: string, extra: JsonObject = {}): string =>
  JSON.stringify({ v: 1, asOf: "2026-11-08T09:00:00Z", parts: [{ at: "belt", id: "belt", mark: { face } }], ...extra });
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
    expect(JSON.stringify(facts)).not.toContain(r.configDir.replace(/\/config$/, "/config/.env"));
    expect((await Bun.file(facts.trick.state).stat()).mode & 0o777).toBe(0o700);
    const reply = await r.service.reply(undefined);
    expect(reply.tricks[0]?.state).toBe("ok");
    expect(reply.parts.map((p) => partKey(p))).toEqual(["bluefin/legs/belt"]);
    expect(reply.parts[0]?.value).toEqual({ at: "belt", id: "belt", mark: { face: "23/34" } });
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
    expect(file.v).toBe(1);
    expect(Object.keys(file.on)).toEqual(["legs"]);
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

  test("failed runs wait 1, 5 and 30 minutes, then the trick stops; a folder change restarts it", async () => {
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
    // A change in the folder restarts it with a start run.
    await writeFile(join(dir, "legs.sh"), "#!/bin/sh\necho fixed\n");
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
        { at: "belt", id: "belt", mark: { face: a } },
        b === null ? { at: "session", id: "legs", name: "Browser leg", subtitle: "x".repeat(200), view: { kind: "text", text: "t", lines: 1 } } : { at: "session", id: "legs", name: "Browser leg", subtitle: b, view: { kind: "text", text: "t", lines: 1 } },
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
    expect(byPart.get("belt")?.value).toEqual({ at: "belt", id: "belt", mark: { face: "2" } });
    expect(byPart.get("belt")?.stale).toBeUndefined();
    expect(byPart.get("legs")?.stale).toBe(true);
    expect(byPart.get("legs")?.value).toMatchObject({ subtitle: "green" });
    expect(byPart.get("legs")?.problem).toContain("subtitle");
    expect(second.present.toSorted()).toEqual(["bluefin/legs/belt", "bluefin/legs/legs"]);
    expect(second.tricks[0]?.refusals?.[0]?.part).toBe("legs");

    await tickAt(r, T0 + 60_000);
    const third = await r.service.reply(second.rev);
    expect(third.parts.every((p) => p.stale === true)).toBe(true);
    expect(third.parts.find((p) => p.part === "belt")?.value).toEqual({ at: "belt", id: "belt", mark: { face: "2" } });
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
    expect(changed.parts.map((p) => p.value)).toEqual([{ at: "belt", id: "belt", mark: { face: "2" } }]);
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

  test("a part kind outside the core is refused for now (slice 08 adds it)", async () => {
    const doc = JSON.stringify({ v: 1, parts: [{ at: "session", id: "s", view: { kind: "divider" } }] });
    const r = await rig([exited(doc)]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    expect(reply.parts).toEqual([]);
    expect(reply.tricks[0]?.refusals?.[0]?.code).toBe("later");
  });
});

describe("taps", () => {
  const tapBody = (requestId = REQ, intent = "rerun") => ({ requestId, intent, args: { n: 24 }, part: "belt", from: { session: "bluefin:w6X:3" } });

  async function onRig(outcomes: Parameters<typeof rig>[0]): Promise<Rig> {
    const r = await rig(outcomes);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    return r;
  }

  test("a tap runs the provider with the tap trigger and replies applied with the new parts and the draft", async () => {
    const r = await onRig([exited(belt("24 red", { draft: { session: "bluefin:w6X:3", text: "fix case 24" } }))]);
    const answer = await r.service.tap(HOST, "legs", tapBody());
    expect(answer.status).toBe(200);
    const reply = ok200(answer);
    expect(reply.outcome).toBe("applied");
    expect(reply.parts?.map((p) => p.value)).toEqual([{ at: "belt", id: "belt", mark: { face: "24 red" } }]);
    expect(reply.present).toEqual(["bluefin/legs/belt"]);
    expect(reply.draft).toEqual({ session: "bluefin:w6X:3", text: "fix case 24" });
    expect(reply.rev).toBe(r.service.rev());
    expect(factsOf(r.specs[0]).trigger).toEqual({ kind: "tap", ...tapBody() });
  });

  test("the same request id runs nothing twice and answers replayed; another payload is refused", async () => {
    const r = await onRig([exited(belt("1"))]);
    const first = await r.service.tap(HOST, "legs", tapBody());
    const again = await r.service.tap(HOST, "legs", tapBody());
    expect(r.specs.length).toBe(1);
    expect(again.status).toBe(200);
    expect(ok200(again).outcome).toBe("replayed");
    expect({ ...ok200(again), outcome: "applied" }).toEqual(ok200(first));
    const reused = await r.service.tap(HOST, "legs", tapBody(REQ, "other"));
    expect(reused).toEqual({ status: 409, body: { error: "request-id-reused", requestId: REQ } });
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
    expect(ok200(await a).outcome).toBe("applied");
    expect(ok200(await b).outcome).toBe("replayed");
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
    expect(ok200(busy).outcome).toBe("failed");
    expect(ok200(busy).message).toContain("busy");
    release();
    await timer;
    const reply = ok200(await queued);
    expect(reply.outcome).toBe("applied");
    expect(r.specs.map((s) => factsOf(s).trigger.kind)).toEqual(["start", "tap"]);
    // The busy id kept no receipt, so it may simply be tried again.
    expect(ok200(await r.service.tap(HOST, "legs", tapBody(REQ2))).outcome).toBe("applied");
  });

  test("a timeout is unknown, a failure is failed with the masked line, and the tap restarts a stopped trick", async () => {
    const r = await onRig([
      { kind: "timeout", stderr: "", ms: 10_000, limitMs: 10_000 },
      { kind: "exited", code: 1, stdout: "", stderr: "curl: 401 for https://api/?token=sk-or-v1-0123456789abcdef0123456789", ms: 3 },
    ]);
    const unknown = ok200(await r.service.tap(HOST, "legs", tapBody(REQ)));
    expect(unknown.outcome).toBe("unknown");
    expect(unknown.message).toBe("The provider ran past 10 s and was stopped");
    const failed = ok200(await r.service.tap(HOST, "legs", tapBody(REQ2)));
    expect(failed.outcome).toBe("failed");
    expect(failed.message).toStartWith("The provider exited with 1: curl: 401");
    expect(failed.message).not.toContain("0123456789abcdef");
  });

  test("off, unknown, foreign and malformed taps", async () => {
    const r = await rig([exited(belt("1"))]);
    await makeTrick(r.configDir, "legs", MANIFEST);
    await r.service.refresh(true);
    expect(await r.service.tap("minibuch", "legs", tapBody())).toEqual({ status: 404, body: { error: "unknown-host" } });
    expect(await r.service.tap(HOST, "nope", tapBody())).toEqual({ status: 404, body: { error: "unknown-trick" } });
    const bad = await r.service.tap(HOST, "legs", { requestId: "nope", intent: "x", part: "belt" });
    expect(bad.status).toBe(400);
    const off = ok200(await r.service.tap(HOST, "legs", tapBody()));
    expect(off).toEqual({ requestId: REQ, outcome: "failed", message: "The trick is off." });
    expect(r.specs.length).toBe(0);
    // Off kept no receipt: switched on, the same id runs.
    await switchOn(r.stateDir, "legs");
    await r.service.refresh(true);
    expect(ok200(await r.service.tap(HOST, "legs", tapBody())).outcome).toBe("applied");
  });

  test("a draft from a timer run is refused (tap only), the parts still draw", async () => {
    const r = await onRig([exited(belt("1", { draft: { session: "bluefin:w6X:3", text: "x" } }))]);
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    expect(reply.present).toEqual(["bluefin/legs/belt"]);
    expect(reply.tricks[0]?.refusals?.map((x) => x.code)).toEqual(["tap-only"]);
  });
});

describe("real providers", () => {
  test("an sh provider and a bun provider run through the real runner", async () => {
    const r = await rig(null);
    await makeTrick(r.configDir, "hello", 'id = "hello"\nname = "Hello"\nrun = "./provider.sh"\nplaces = ["belt"]\n', {
      "provider.sh": `#!/bin/sh\nfacts=$(cat)\nn=$(printf '%s' "$facts" | grep -o '"paneId"' | wc -l | tr -d ' ')\nprintf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"face":"%s"}}]}' "$n"\n`,
    });
    await makeTrick(r.configDir, "bunny", 'id = "bunny"\nname = "Bunny"\nrun = "bun provider.ts"\nplaces = ["belt"]\n', {
      "provider.ts": [
        'import { appendFileSync } from "node:fs";',
        "const facts = JSON.parse(await Bun.stdin.text());",
        'appendFileSync(`${facts.trick.state}/runs.log`, facts.trigger.kind + "\\n");',
        'const leaked = Object.keys(process.env).filter((k) => k.startsWith("COLLIE_") || k.includes("KEY"));',
        'console.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { face: leaked.length === 0 ? "clean" : "leak" } }] }));',
      ].join("\n"),
    });
    await switchOn(r.stateDir, "hello", "bunny");
    await tickAt(r, T0);
    const reply = await r.service.reply(undefined);
    const faces = Object.fromEntries(reply.parts.map((p) => [p.trick, p.value.at === "belt" ? p.value.mark.face : undefined]));
    expect(faces).toEqual({ hello: "1", bunny: "clean" });
    expect(await readFile(join(r.stateDir, TRICKS_DIR, "bunny", "runs.log"), "utf8")).toBe("start\n");
  });
});
