import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseFacts, type TrickEvent, type TrickFacts } from "../../web/src/lib/tricks/schema.ts";
import { EventBus } from "../events/bus.ts";
import { encodeSessionId } from "../events/session-id.ts";
import { powersHash, powersOf, powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { TRICKS_DIR } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { PENDING_SETTLE_MS, PENDING_LINE, RIGHTS_LINE, TricksService, type TricksServiceDeps } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";
import { REACT_FLOOR_MS, TrickReactions, type Admit, type FloorTimers, type ReactionHost, type ReactionTarget, type ReactTrigger } from "./triggers.ts";
import { type FsWatchHandle, type WatchFactory, type WatchOptions } from "./watch.ts";
import { newRights, ON_CHIP, watchChip } from "./version-card.ts";
import { readManifestText } from "./discover.ts";
import { watch as fsWatch } from "node:fs";

// `on` and `watch` (M105 spec 03, decisions 9 to 11). Two layers: TrickReactions against a fake host (the
// folding, one rule at a time), and the whole TricksService with a real bus and a real folder (the gates,
// the road a run takes, the switch-off, the card). The wire a program receives has its own contract test.

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-triggers-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const HOST = "lodge";
const MACHINE = HOST;
const sessionOf = (pane: string): string => encodeSessionId({ machine: MACHINE, paneId: pane, instance: "ab12" });
const scopeOf = (pane: string): string => `${MACHINE}:${pane}`;
const tick = (ms = 0): Promise<void> => Bun.sleep(ms);

/** Wait until `ready()` holds, polling every 20 ms, at most `ms` (a file event lands later on some systems, Windows among them). */
async function until(ready: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; waited < ms && !ready(); waited += 20) await tick(20);
}

const realFactory: WatchFactory = (dir, onEvent, onError) => {
  const handle = fsWatch(dir, { persistent: false, encoding: "utf8" }, (_type, name) => onEvent(name === "" || name === null ? null : name));
  handle.on("error", onError);
  return { close: () => handle.close() };
};

interface Counted {
  factory: WatchFactory;
  opened: string[];
  closed: string[];
}

/** A factory over the real `fs.watch` that remembers every folder it opened and closed. */
function countingFactory(): Counted {
  const opened: string[] = [];
  const closed: string[] = [];
  const factory: WatchFactory = (dir, onEvent, onError) => {
    opened.push(dir);
    const inner = realFactory(dir, onEvent, onError);
    const handle: FsWatchHandle = {
      close: () => {
        closed.push(dir);
        inner.close();
      },
    };
    return handle;
  };
  return { factory, opened, closed };
}

// A manifest's `watch` path starts with `/` or `~/` (web/src/lib/tricks/schema.ts), so the temp-folder path of a
// real file on Windows (`C:\...`) is refused with "A watched path starts with / or ~/." and the trick never
// watches. Tricks are closed on Windows behind the gate, so no Windows path form is defined yet; a test that
// writes a real file path into a manifest is POSIX only before the Windows gate for tricks opens. The watcher
// itself (bridge/tricks/watch.test.ts) runs on Windows.
const watchTest = test.skipIf(process.platform === "win32");

const FAST: WatchOptions = { debounceMs: 40, maxWaitMs: 160, pollMs: 60 };

// ── TrickReactions against a fake host ───────────────────────────────────────────────────────────────

interface FakeHost extends ReactionHost {
  verdict: Admit;
  started: { id: string; trigger: ReactTrigger }[];
  dues: string[];
  notes: { id: string; note: string | null }[];
  warnings: string[];
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    verdict: "now",
    started: [],
    dues: [],
    notes: [],
    warnings: [],
    admit: () => host.verdict,
    start: (id, trigger) => void host.started.push({ id, trigger }),
    due: (id) => void host.dues.push(id),
    note: (id, note) => void host.notes.push({ id, note }),
    warn: (line) => void host.warnings.push(line),
  };
  return host;
}

function newBus(): EventBus {
  return new EventBus({ machine: () => MACHINE });
}

const target = (id: string, events: TrickEvent[], watch: string[] = [], key = "k1"): ReactionTarget => ({ id, key, events, watch });

describe("an event reaches only the tricks that list its type", () => {
  test("two tricks, three types: each run names the event, the session scope id and a count of 1", async () => {
    const bus = newBus();
    const host = fakeHost();
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"]), target("asks", ["ask.open"]), target("both", ["turn.end", "ask.open"])]);
    bus.publish({ type: "turn.end", session: sessionOf("w1:2") });
    await tick();
    expect(host.started).toEqual([
      { id: "ends", trigger: { kind: "event", event: "turn.end", session: scopeOf("w1:2"), count: 1 } },
      { id: "both", trigger: { kind: "event", event: "turn.end", session: scopeOf("w1:2"), count: 1 } },
    ]);
    bus.publish({ type: "session.status", session: sessionOf("w1:2"), data: { state: "working" } });
    await tick();
    expect(host.started.length).toBe(2);
    reactions.close();
  });

  test("an id the codec does not read names no session, so it runs nothing", async () => {
    const bus = newBus();
    const host = fakeHost();
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"])]);
    bus.publish({ type: "turn.end", session: "not-a-session-id" });
    await tick();
    expect(host.started).toEqual([]);
    reactions.close();
  });
});

describe("coalescing", () => {
  test("events of one turn are one request: the newest is named, the count is how many", async () => {
    const bus = newBus();
    const host = fakeHost();
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"])]);
    for (const pane of ["a:1", "b:2", "c:3"]) bus.publish({ type: "turn.end", session: sessionOf(pane) });
    await tick();
    expect(host.started).toEqual([{ id: "ends", trigger: { kind: "event", event: "turn.end", session: scopeOf("c:3"), count: 3 } }]);
    reactions.close();
  });

  test("while the trick runs, three events are ONE waiting run: newest named, count 3, and it is taken once", async () => {
    const bus = newBus();
    const host = fakeHost();
    host.verdict = "wait";
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"])]);
    for (const pane of ["a:1", "b:2", "c:3"]) {
      bus.publish({ type: "turn.end", session: sessionOf(pane) });
      await tick();
    }
    expect(host.started).toEqual([]);
    expect(reactions.counts().waiting).toBe(1);
    expect(reactions.takeWaiting("ends")).toEqual({ kind: "event", event: "turn.end", session: scopeOf("c:3"), count: 3 });
    expect(reactions.takeWaiting("ends")).toBeNull();
    expect(reactions.counts().waiting).toBe(0);
    reactions.close();
  });

  test("events the bus dropped are added to the count of every trick that listens, and noted once in the log", async () => {
    const bus = newBus();
    const host = fakeHost();
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"]), target("asks", ["ask.open"])]);
    // The queue holds 256: 300 turn.end in one turn drop the 44 oldest, and the trick that listens to ask.open cannot know none was its own.
    for (let i = 0; i < 300; i += 1) bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick();
    expect(host.started).toEqual([{ id: "ends", trigger: { kind: "event", event: "turn.end", session: scopeOf("a:1"), count: 300 } }]);
    expect(host.warnings.length).toBe(1);
    expect(host.warnings[0]).toContain("44");
    // `asks` had no matching event: the 44 wait for its next one.
    bus.publish({ type: "ask.open", session: sessionOf("b:2") });
    await tick();
    expect(host.started.at(-1)).toEqual({ id: "asks", trigger: { kind: "event", event: "ask.open", session: scopeOf("b:2"), count: 45 } });
    reactions.close();
  });
});

describe("a request that is not admitted is dropped, never held", () => {
  test("a drop leaves nothing waiting and starts nothing", async () => {
    const bus = newBus();
    const host = fakeHost();
    host.verdict = "drop";
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"])]);
    bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick();
    expect(host.started).toEqual([]);
    expect(reactions.counts().waiting).toBe(0);
    // And the gate opening later does not bring the old event back.
    host.verdict = "now";
    await tick();
    expect(host.started).toEqual([]);
    reactions.close();
  });
});

describe("the interest, the subscription and the waiting request end with the trick", () => {
  test("one subscription for the whole runner, only while some trick lists `on`", () => {
    const bus = newBus();
    const reactions = new TrickReactions(fakeHost(), { bus });
    expect(bus.listeners().subscriptions).toBe(0);
    reactions.sync([target("a", ["turn.end"]), target("b", ["ask.open"]), target("w", [], ["/tmp/none-of-these"])]);
    expect(bus.listeners().subscriptions).toBe(1);
    reactions.sync([target("a", ["turn.end"])]);
    expect(bus.listeners().subscriptions).toBe(1);
    reactions.sync([]);
    expect(bus.listeners().subscriptions).toBe(0);
    reactions.close();
  });

  test("switch-off: the trick's interest goes, a waiting request is dropped, and a later event reaches nobody", async () => {
    const bus = newBus();
    const host = fakeHost();
    host.verdict = "wait";
    const reactions = new TrickReactions(host, { bus });
    reactions.sync([target("ends", ["turn.end"])]);
    bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick();
    expect(reactions.counts().waiting).toBe(1);
    reactions.sync([]);
    expect(reactions.counts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
    expect(reactions.takeWaiting("ends")).toBeNull();
    host.verdict = "now";
    bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick();
    expect(host.started).toEqual([]);
    reactions.close();
  });

  test("close frees the subscription and a later sync opens what is needed again", () => {
    const bus = newBus();
    const reactions = new TrickReactions(fakeHost(), { bus });
    reactions.sync([target("a", ["turn.end"])]);
    reactions.close();
    expect(bus.listeners().subscriptions).toBe(0);
    reactions.sync([target("a", ["turn.end"])]);
    expect(bus.listeners().subscriptions).toBe(1);
    reactions.close();
    expect(bus.listeners().subscriptions).toBe(0);
  });

  test("without a bus, `on` reaches nobody and nothing breaks", () => {
    const reactions = new TrickReactions(fakeHost());
    reactions.sync([target("a", ["turn.end"])]);
    expect(reactions.counts().subscribed).toBe(false);
    reactions.close();
  });
});

describe("the watch of a trick, in the runner", () => {
  test("a change of the key (a new version, a new config) closes the watch and opens it again; the same key leaves it alone", async () => {
    const dir = await tempDir();
    const file = join(dir, "w.md");
    await writeFile(file, "a");
    const counted = countingFactory();
    const reactions = new TrickReactions(fakeHost(), { watch: { ...FAST, factory: counted.factory } });
    reactions.sync([target("w", [], [file], "v1")]);
    reactions.sync([target("w", [], [file], "v1")]);
    expect(counted.opened).toEqual([dir]);
    reactions.sync([target("w", [], [file], "v2")]);
    expect(counted.opened).toEqual([dir, dir]);
    expect(counted.closed).toEqual([dir]);
    reactions.sync([]);
    expect(counted.closed).toEqual([dir, dir]);
    expect(reactions.counts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
    reactions.close();
  });

  test("a file change that waits, then the run ends: the waiting file request is absorbed, an event request stays", async () => {
    const dir = await tempDir();
    const file = join(dir, "w.md");
    await writeFile(file, "a");
    const bus = newBus();
    const host = fakeHost();
    host.verdict = "wait";
    const reactions = new TrickReactions(host, { bus, watch: { ...FAST } });
    reactions.sync([target("w", ["turn.end"], [file])]);
    // A new size: NTFS often keeps the modified time of a same-size rewrite this quick (149 of 200 in the VM),
    // and the watch's stat check would see no change.
    await writeFile(file, "bb");
    bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await until(() => reactions.counts().waiting === 2);
    expect(reactions.counts().waiting).toBe(2);
    reactions.ended("w");
    expect(reactions.counts().waiting).toBe(1);
    expect(reactions.takeWaiting("w")).toEqual({ kind: "event", event: "turn.end", session: scopeOf("a:1"), count: 1 });
    reactions.close();
  });

  test("one waiting run: a file request and an event request are taken as the newest, with both counts", async () => {
    const dir = await tempDir();
    const file = join(dir, "w.md");
    await writeFile(file, "a");
    const bus = newBus();
    const host = fakeHost();
    host.verdict = "wait";
    const reactions = new TrickReactions(host, { bus, watch: { ...FAST } });
    reactions.sync([target("w", ["turn.end"], [file])]);
    bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick();
    await writeFile(file, "b");
    await tick(200);
    expect(reactions.takeWaiting("w")).toEqual({ kind: "watch", path: file, count: 2 });
    reactions.close();
  });
});

// ── The whole service, a real bus and a real folder ──────────────────────────────────────────────────

interface Rig {
  root: string;
  configDir: string;
  stateDir: string;
  clock: { t: number };
  warnings: string[];
  service: TricksService;
  specs: RunSpec[];
  bus: EventBus;
  set: { active: boolean };
}

const T0 = Date.parse("2026-11-08T09:00:00Z");
const exited = (stdout: string, code = 0): RunOutcome => ({ kind: "exited", code, stdout, stderr: "", ms: 5 });
const belt = (label: string): string => JSON.stringify({ v: 1, asOf: "2026-11-08T09:00:00Z", parts: [{ at: "belt", id: "belt", mark: { label, intent: "x" } }] });
const OK = exited(belt("ok"));
const FAIL = exited("", 1);

type Scripted = RunOutcome | { later: () => Promise<RunOutcome> };

async function rig(outcomes: Scripted[] | null, extra: Partial<TricksServiceDeps> = {}): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const clock = { t: T0 };
  const warnings: string[] = [];
  const specs: RunSpec[] = [];
  const set = { active: true };
  const bus = newBus();
  let i = 0;
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    memberId: HOST,
    world: (memberId) => ({
      machine: "desk",
      sessions: [{ id: `${memberId}:w6X:3`, memberId, sessionId: `${memberId}:w6X:3`, paneId: "w6X:3", host: "desk", name: "composer", agent: "claude", status: "working" }],
      spaces: [{ name: "collie", folder: "/work/collie" }],
    }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: (line) => warnings.push(line),
    revBase: 1000,
    active: () => set.active,
    bus,
    watchOptions: FAST,
    // Tricks as a whole switched on (feature-switch.ts); the test of the big switch passes its own.
    feature: { on: () => true },
    ...extra,
  };
  if (outcomes !== null) {
    deps.run = async (spec: RunSpec): Promise<RunOutcome> => {
      specs.push(spec);
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (next === undefined) throw new Error("no outcome scripted");
      return "later" in next ? await next.later() : next;
    };
  }
  return { root, configDir, stateDir, clock, warnings, service: new TricksService(deps), specs, bus, set };
}

async function makeTrick(configDir: string, id: string, manifest: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(configDir, TRICKS_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), manifest);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o755 });
  return dir;
}

async function switchOn(stateDir: string, ...ids: string[]): Promise<void> {
  let switches: Switches = { on: new Map() };
  for (const id of ids) {
    const dir = join(dirname(stateDir), "config", TRICKS_DIR, id);
    const code = await trickCodeHash(dir);
    switches = withSwitch(switches, id, true, "2026-11-08T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, id));
  }
  await writeSwitches(stateDir, switches);
}

async function tickAt(r: Rig, t: number, watch = true): Promise<void> {
  r.clock.t = t;
  if (watch) r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

function factsOf(spec: RunSpec | undefined): TrickFacts {
  const parsed = parseFacts(JSON.parse(spec?.stdin ?? "null"));
  if (parsed.facts === undefined) throw new Error(`facts did not parse: ${JSON.stringify(parsed.refusals)}`);
  return parsed.facts;
}

const kinds = (r: Rig): string[] => r.specs.map((spec) => factsOf(spec).trigger.kind);

const ON_MANIFEST = (events = '["turn.end"]'): string => `id = "react"\nname = "React"\nrun = "./react.sh"\nplaces = ["belt"]\non = ${events}\n`;
const watchManifest = (...paths: string[]): string => `id = "react"\nname = "React"\nrun = "./react.sh"\nplaces = ["belt"]\nwatch = [${paths.map((p) => JSON.stringify(p)).join(", ")}]\n`;

/** The trick `react` on, after its start run. */
async function onRig(outcomes: Scripted[] | null, manifest: string = ON_MANIFEST(), extra: Partial<TricksServiceDeps> = {}, files: Record<string, string> = {}): Promise<Rig> {
  const r = await rig(outcomes, extra);
  await makeTrick(r.configDir, "react", manifest, files);
  await switchOn(r.stateDir, "react");
  await tickAt(r, T0);
  return r;
}

describe("the wire: what a program receives in `trigger`", () => {
  test("event: exactly kind, event, session and count; session is the facts scope id of the event's session", async () => {
    const r = await onRig([OK]);
    r.bus.publish({ type: "turn.end", session: sessionOf("w6X:3") });
    await tick(50);
    expect(kinds(r)).toEqual(["start", "event"]);
    const raw: { trigger: Record<string, string | number> } = JSON.parse(r.specs[1]?.stdin ?? "null");
    expect(Object.keys(raw.trigger).toSorted()).toEqual(["count", "event", "kind", "session"]);
    expect(raw.trigger).toEqual({ kind: "event", event: "turn.end", session: "lodge:w6X:3", count: 1 });
    // The facts' own session list uses the same id, so a program can join the two.
    expect(factsOf(r.specs[1]).sessions[0]?.id).toBe("lodge:w6X:3");
    r.service.stop();
  });

  watchTest("watch: exactly kind, path and count; path is the path as the manifest wrote it", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const r = await onRig([OK], watchManifest(file));
    await writeFile(file, "ab");
    await tick(300);
    expect(kinds(r)).toEqual(["start", "watch"]);
    const raw: { trigger: Record<string, string | number> } = JSON.parse(r.specs[1]?.stdin ?? "null");
    expect(Object.keys(raw.trigger).toSorted()).toEqual(["count", "kind", "path"]);
    expect(raw.trigger).toEqual({ kind: "watch", path: file, count: 1 });
    r.service.stop();
  });

  test("the facts schema reads both shapes, and refuses an event with no count or no session", () => {
    const base = { contract: 1, trick: { id: "react", dir: "/x", state: "/y" }, memberId: HOST, host: "desk", sessions: [], spaces: [] };
    expect(parseFacts({ ...base, trigger: { kind: "event", event: "ask.open", session: "lodge:w1:2", count: 4 } }).facts?.trigger).toEqual({ kind: "event", event: "ask.open", session: "lodge:w1:2", count: 4 });
    expect(parseFacts({ ...base, trigger: { kind: "watch", path: "~/a.md", count: 2 } }).facts?.trigger).toEqual({ kind: "watch", path: "~/a.md", count: 2 });
    expect(parseFacts({ ...base, trigger: { kind: "event", event: "ask.open", session: "lodge:w1:2" } }).facts).toBeUndefined();
    expect(parseFacts({ ...base, trigger: { kind: "event", event: "ask.open", count: 1 } }).facts).toBeUndefined();
    expect(parseFacts({ ...base, trigger: { kind: "watch", path: "~/a.md" } }).facts).toBeUndefined();
    expect(parseFacts({ ...base, trigger: { kind: "event", event: "ask.open", session: "lodge:w1:2", count: 1, extra: 1 } }).facts).toBeUndefined();
  });
});

describe("`on` runs a trick through the road a timer run takes", () => {
  test("an event reaches only the tricks that list its type", async () => {
    const r = await rig([OK]);
    await makeTrick(r.configDir, "react", ON_MANIFEST('["turn.end"]'));
    await makeTrick(r.configDir, "other", ON_MANIFEST('["ask.open"]').replace('id = "react"', 'id = "other"'));
    await switchOn(r.stateDir, "react", "other");
    await tickAt(r, T0);
    expect(r.specs.length).toBe(2);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(3);
    expect(factsOf(r.specs[2]).trick.id).toBe("react");
    r.service.stop();
  });

  test("three events while it runs are one waiting run, with a count of 3 and the newest event named", async () => {
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(OK);
        }),
    };
    const r = await onRig([OK, slow, OK]);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(30);
    expect(r.specs.length).toBe(2);
    for (const pane of ["b:2", "c:3", "d:4"]) {
      r.bus.publish({ type: "turn.end", session: sessionOf(pane) });
      await tick(10);
    }
    expect(r.service.reactionCounts().waiting).toBe(1);
    expect(r.specs.length).toBe(2);
    // The run lasted longer than the floor, so its end starts the waiting run at once.
    r.clock.t = T0 + REACT_FLOOR_MS + 1;
    release();
    await tick(60);
    expect(kinds(r)).toEqual(["start", "event", "event"]);
    expect(factsOf(r.specs[2]).trigger).toEqual({ kind: "event", event: "turn.end", session: scopeOf("d:4"), count: 3 });
    expect(r.service.reactionCounts().waiting).toBe(0);
    expect(r.service.runsHeld()).toBe(0);
    r.service.stop();
  });

  test("a tap waiting behind the running run goes before the waiting event run", async () => {
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(exited(belt("drawn")));
        }),
    };
    const drawn = exited(belt("drawn"));
    const r = await onRig([drawn, slow, drawn, drawn]);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(30);
    const rev = (await r.service.reply(undefined)).parts.find((p) => p.part === "belt")?.rev ?? 0;
    const tap = r.service.tap(HOST, "react", { rid: "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", node: "belt", intent: "x", rev });
    await tick(20);
    r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
    await tick(20);
    r.clock.t = T0 + REACT_FLOOR_MS + 1;
    release();
    expect((await tap).status).toBe(200);
    await tick(60);
    expect(kinds(r)).toEqual(["start", "event", "tap", "event"]);
    r.service.stop();
  });

  test("a failed event run backs the trick off: events in the backoff are dropped, and run again once it ends", async () => {
    const r = await onRig([OK, FAIL, OK, OK]);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(kinds(r)).toEqual(["start", "event"]);
    // Failed: one minute of backoff. Events inside it are dropped, not held.
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(2);
    expect(r.service.reactionCounts().waiting).toBe(0);
    r.clock.t = T0 + 61_000;
    r.service.noteWatched();
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(3);
    r.service.stop();
  });

  test("security read 2, item 2: a waiting event survives a run end where admit says no, and runs once admit says yes", async () => {
    let release: () => void = () => {};
    const slowFail: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(FAIL);
        }),
    };
    const r = await onRig([OK, slowFail, OK]);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(30);
    expect(kinds(r)).toEqual(["start", "event"]);
    // Admitted to wait behind the running run.
    r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
    await tick(20);
    expect(r.service.reactionCounts().waiting).toBe(1);
    // The run fails past the floor: the pump after it meets the backoff, so admit says no. The request stays.
    r.clock.t = T0 + REACT_FLOOR_MS + 1;
    release();
    await tick(60);
    expect(r.specs.length).toBe(2);
    expect(r.service.reactionCounts()).toMatchObject({ waiting: 1, timers: 0 });
    // The backoff ends; the next event is admitted, and it and the waiting one are ONE run, naming the newest.
    r.clock.t = T0 + 61_000 + REACT_FLOOR_MS;
    r.bus.publish({ type: "turn.end", session: sessionOf("c:3") });
    await tick(60);
    expect(kinds(r)).toEqual(["start", "event", "event"]);
    expect(factsOf(r.specs[2]).trigger).toEqual({ kind: "event", event: "turn.end", session: scopeOf("c:3"), count: 2 });
    expect(r.service.reactionCounts().waiting).toBe(0);
    await tick(60);
    expect(r.specs.length).toBe(3);
    r.service.stop();
  });

  test("security read 2, item 2: a request that outlived a backoff also runs after a tap, once", async () => {
    let release: () => void = () => {};
    const slowFail: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(FAIL);
        }),
    };
    const r = await onRig([OK, slowFail, exited(belt("drawn")), OK]);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(30);
    r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
    await tick(20);
    r.clock.t = T0 + REACT_FLOOR_MS + 1;
    release();
    await tick(60);
    expect(r.service.reactionCounts().waiting).toBe(1);
    // A tap clears the backoff and runs; at its end the waiting event runs, as it was.
    r.clock.t = T0 + 61_000 + REACT_FLOOR_MS;
    const rev = (await r.service.reply(undefined)).parts.find((p) => p.part === "belt")?.rev ?? 0;
    const tap = await r.service.tap(HOST, "react", { rid: "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", node: "belt", intent: "x", rev });
    expect(tap.status).toBe(200);
    await tick(60);
    expect(kinds(r)).toEqual(["start", "event", "tap", "event"]);
    expect(factsOf(r.specs[3]).trigger).toEqual({ kind: "event", event: "turn.end", session: scopeOf("b:2"), count: 1 });
    expect(r.service.reactionCounts().waiting).toBe(0);
    r.service.stop();
  });

  test("a stopped trick takes no event, however long it waits", async () => {
    const r = await onRig([OK, FAIL]);
    const waits = [0, 61_000, 361_000, 2_161_000];
    let at = T0;
    for (const wait of waits) {
      at += wait + 1000;
      r.clock.t = at;
      r.service.noteWatched();
      r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
      await tick(50);
    }
    // Start plus four failed event runs: the ladder is 1, 5, 30 minutes, then stop.
    expect(r.specs.length).toBe(5);
    expect((await r.service.reply(undefined)).tricks[0]?.state).toBe("stopped");
    r.clock.t = at + 86_400_000;
    r.service.noteWatched();
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(5);
    r.service.stop();
  });

  test("with no phone looking for five minutes, an event still runs, and a timer run still does not", async () => {
    const r = await onRig([OK], `${ON_MANIFEST()}every = "30s"\n`);
    expect(r.specs.length).toBe(1);
    // Six minutes on, nobody has looked since T0: the timer is due and does not run.
    r.clock.t = T0 + 6 * 60_000;
    await r.service.tick();
    expect(r.specs.length).toBe(1);
    // An event runs all the same.
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(kinds(r)).toEqual(["start", "event"]);
    r.service.stop();
  });

  describe("the floor between two event or watch runs", () => {
    /** A timer the test fires by hand: it records the delay and the callback. */
    function fakeTimers(): FloorTimers & { open: Map<number, { fn: () => void; ms: number }>; fire(): void; delays: number[] } {
      const open = new Map<number, { fn: () => void; ms: number }>();
      const delays: number[] = [];
      let next = 1;
      return {
        open,
        delays,
        set: (fn, ms) => {
          const handle = next;
          next += 1;
          delays.push(ms);
          open.set(handle, { fn, ms });
          return handle;
        },
        clear: (handle) => void open.delete(handle),
        fire: () => {
          for (const [handle, one] of open) {
            open.delete(handle);
            one.fn();
          }
        },
      };
    }

    test("a second event 3 s after the first run's start waits until 10 s, then runs once with the folded count", async () => {
      const timers = fakeTimers();
      const r = await onRig([OK, OK, OK], ON_MANIFEST(), { reactionTimers: timers });
      r.clock.t = T0 + 20_000;
      r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
      await tick(50);
      expect(kinds(r)).toEqual(["start", "event"]);
      // 3 s after the start of that run: inside the floor, so two events are ONE waiting run.
      r.clock.t = T0 + 23_000;
      r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
      await tick(20);
      r.bus.publish({ type: "turn.end", session: sessionOf("c:3") });
      await tick(20);
      expect(r.specs.length).toBe(2);
      expect(r.service.reactionCounts()).toMatchObject({ waiting: 1, timers: 1 });
      expect(timers.delays).toEqual([7000]);
      // The floor ends at 10 s after the start: the timer starts the one waiting run.
      r.clock.t = T0 + 30_000;
      timers.fire();
      await tick(60);
      expect(kinds(r)).toEqual(["start", "event", "event"]);
      expect(factsOf(r.specs[2]).trigger).toEqual({ kind: "event", event: "turn.end", session: scopeOf("c:3"), count: 2 });
      expect(r.service.reactionCounts()).toMatchObject({ waiting: 0, timers: 0 });
      r.service.stop();
    });

    test("the floor timer is cleared when the trick is switched off, and when the runner stops", async () => {
      const timers = fakeTimers();
      const r = await onRig([OK, OK], ON_MANIFEST(), { reactionTimers: timers });
      r.clock.t = T0 + 20_000;
      r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
      await tick(50);
      r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
      await tick(20);
      expect(r.service.reactionCounts()).toMatchObject({ waiting: 1, timers: 1 });
      await r.service.setSwitch(HOST, "react", false);
      expect(r.service.reactionCounts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
      expect(timers.open.size).toBe(0);
      r.service.stop();

      const second = await onRig([OK, OK], ON_MANIFEST(), { reactionTimers: timers });
      second.clock.t = T0 + 20_000;
      second.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
      await tick(50);
      second.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
      await tick(20);
      expect(timers.open.size).toBe(1);
      second.service.stop();
      expect(timers.open.size).toBe(0);
      expect(second.service.reactionCounts().timers).toBe(0);
    });

    test("a tap inside the floor runs at once, and does not move the floor", async () => {
      const timers = fakeTimers();
      const drawn = exited(belt("drawn"));
      const r = await onRig([drawn, drawn, drawn, drawn], ON_MANIFEST(), { reactionTimers: timers });
      r.clock.t = T0 + 20_000;
      r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
      await tick(50);
      r.clock.t = T0 + 23_000;
      const rev = (await r.service.reply(undefined)).parts.find((p) => p.part === "belt")?.rev ?? 0;
      const answer = await r.service.tap(HOST, "react", { rid: "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", node: "belt", intent: "x", rev });
      expect(answer.status).toBe(200);
      expect(kinds(r)).toEqual(["start", "event", "tap"]);
      // The floor is still counted from the event run's start, not from the tap.
      r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
      await tick(20);
      expect(r.specs.length).toBe(3);
      expect(timers.delays).toEqual([7000]);
      r.clock.t = T0 + 30_000;
      timers.fire();
      await tick(60);
      expect(kinds(r)).toEqual(["start", "event", "tap", "event"]);
      r.service.stop();
    });

    test("a run that ends inside the floor does not start the waiting run: the timer does", async () => {
      const timers = fakeTimers();
      let release: () => void = () => {};
      const slow: Scripted = {
        later: () =>
          new Promise((resolve) => {
            release = () => resolve(OK);
          }),
      };
      const r = await onRig([OK, slow, OK], ON_MANIFEST(), { reactionTimers: timers });
      r.clock.t = T0 + 20_000;
      r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
      await tick(30);
      r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
      await tick(20);
      r.clock.t = T0 + 24_000;
      release();
      await tick(60);
      expect(r.specs.length).toBe(2);
      expect(r.service.reactionCounts()).toMatchObject({ waiting: 1, timers: 1 });
      r.clock.t = T0 + 30_000;
      timers.fire();
      await tick(60);
      expect(kinds(r)).toEqual(["start", "event", "event"]);
      r.service.stop();
    });
  });

  test("a trick that has not had its start run takes no event", async () => {
    const r = await rig([OK]);
    await makeTrick(r.configDir, "react", ON_MANIFEST());
    await switchOn(r.stateDir, "react");
    r.service.noteWatched();
    await r.service.refresh(true);
    expect(r.service.reactionCounts().subscribed).toBe(true);
    // The scan that approved the copy asks for the start run at once, so it is the only run: the event
    // that arrives before that run has ended is dropped, never held.
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(kinds(r)).toEqual(["start"]);
    await r.service.tick();
    expect(kinds(r)).toEqual(["start"]);
    r.service.stop();
  });

  test("a machine that does not schedule tricks (a peer) closes the subscription and runs nothing", async () => {
    const r = await onRig([OK]);
    expect(r.bus.listeners().subscriptions).toBe(1);
    r.set.active = false;
    await r.service.refresh(true);
    expect(r.bus.listeners().subscriptions).toBe(0);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(1);
    r.service.stop();
  });

  test("a gated bridge (Windows) opens nothing and runs nothing", async () => {
    const r = await rig([OK], { platform: "win32" });
    await makeTrick(r.configDir, "react", ON_MANIFEST());
    await switchOn(r.stateDir, "react");
    await tickAt(r, T0);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(0);
    expect(r.service.reactionCounts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
    expect(r.bus.listeners().subscriptions).toBe(0);
  });

  test("an agent view with no program takes no event", async () => {
    const r = await rig([OK]);
    await makeTrick(r.configDir, "react", 'id = "react"\nname = "React"\nplaces = ["agent-view"]\ncontract = 2\nrules = "rules.md"\non = ["turn.end"]\n', { "rules.md": "Say hello.\n" });
    await switchOn(r.stateDir, "react");
    await tickAt(r, T0);
    expect(r.bus.listeners().subscriptions).toBe(0);
  });
});

describe("switch-off and stop end it all", () => {
  test("switching a trick off drops its waiting request, frees the subscription, and starts no waiting run", async () => {
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(OK);
        }),
    };
    const r = await onRig([OK, slow, OK]);
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(30);
    r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
    await tick(20);
    expect(r.service.reactionCounts()).toMatchObject({ subscribed: true, waiting: 1 });
    const off = await r.service.setSwitch(HOST, "react", false);
    expect(off.status).toBe(200);
    expect(r.service.reactionCounts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
    expect(r.bus.listeners().subscriptions).toBe(0);
    release();
    await tick(60);
    expect(r.specs.length).toBe(2);
    r.service.stop();
  });

  watchTest("tricks switched off as a whole: the subscription and the watch close, an event or a file change runs nothing, and on opens them again", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const counted = countingFactory();
    const feature = { value: true, on(): boolean { return this.value; } };
    const r = await onRig([OK], ON_MANIFEST().replace("on = ", `watch = [${JSON.stringify(file)}]\non = `), { watchOptions: { ...FAST, factory: counted.factory }, feature });
    expect(r.bus.listeners().subscriptions).toBe(1);
    expect(counted.opened).toEqual([dir]);
    feature.value = false;
    await r.service.refresh(true);
    expect(r.bus.listeners().subscriptions).toBe(0);
    expect(counted.closed).toEqual([dir]);
    expect(r.service.reactionCounts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await writeFile(file, "ab");
    await tick(300);
    expect(kinds(r)).toEqual(["start"]);
    // On again: the trick's own switch was kept, so it reacts again.
    feature.value = true;
    await tickAt(r, T0 + 60_000);
    await tick(50);
    expect(r.bus.listeners().subscriptions).toBe(1);
    expect(kinds(r)).toEqual(["start", "start"]);
    r.bus.publish({ type: "turn.end", session: sessionOf("b:2") });
    await tick(80);
    expect(kinds(r).at(-1)).toBe("event");
    r.service.stop();
  });

  watchTest("stop frees the service's own bus subscription and its file watches", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const counted = countingFactory();
    const r = await onRig([OK], ON_MANIFEST().replace("on = ", `watch = [${JSON.stringify(file)}]\non = `), { watchOptions: { ...FAST, factory: counted.factory } });
    expect(r.bus.listeners().subscriptions).toBe(1);
    expect(counted.opened).toEqual([dir]);
    r.service.stop();
    expect(r.bus.listeners().subscriptions).toBe(0);
    expect(counted.closed).toEqual([dir]);
    expect(r.service.reactionCounts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
  });
});

describe("`watch` runs a trick, and never loops on its own writes", () => {
  watchTest("an editor's save (a temp file renamed over the file) is one run", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "first");
    const r = await onRig([OK], watchManifest(file));
    await writeFile(join(dir, ".todo.md.swp"), "second");
    await rename(join(dir, ".todo.md.swp"), file);
    await tick(300);
    expect(kinds(r)).toEqual(["start", "watch"]);
    r.service.stop();
  });

  watchTest("five quick writes are one run", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "0");
    const r = await onRig([OK], watchManifest(file));
    for (const text of ["1", "22", "333", "4444", "55555"]) {
      await writeFile(file, text);
      await tick(4);
    }
    await tick(300);
    expect(kinds(r)).toEqual(["start", "watch"]);
    r.service.stop();
  });

  watchTest("a trick that writes the file it watches runs once for an outside change, not again for its own write", async () => {
    const dir = await tempDir();
    const file = join(dir, "state.json");
    await writeFile(file, "{}");
    let runs = 0;
    // Every run, the start run too, rewrites the file it watches, as a trick keeping its state in it would.
    const own = await rig(null, {
      run: async () => {
        runs += 1;
        await writeFile(file, `{"run":${String(runs)}}`);
        return OK;
      },
    });
    await makeTrick(own.configDir, "react", watchManifest(file));
    await switchOn(own.stateDir, "react");
    await tickAt(own, T0);
    await tick(250);
    // The start run's own write is absorbed.
    expect(runs).toBe(1);
    await writeFile(file, '{"outside":true}');
    await tick(400);
    // One run for the outside change; the write that run made did not start another.
    expect(runs).toBe(2);
    await tick(400);
    expect(runs).toBe(2);
    own.service.stop();
  });

  watchTest("a file's change while the trick runs does not queue a second run after it", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    let release: () => void = () => {};
    const slow: Scripted = {
      later: () =>
        new Promise((resolve) => {
          release = () => resolve(OK);
        }),
    };
    const r = await onRig([OK, slow, OK], watchManifest(file));
    await writeFile(file, "b");
    await tick(100);
    expect(r.specs.length).toBe(2);
    // A write during the run, after its debounce fired: it waits as one request, and the run's end absorbs it.
    await writeFile(file, "c");
    await tick(150);
    expect(r.service.reactionCounts().waiting).toBe(1);
    release();
    await tick(200);
    expect(r.specs.length).toBe(2);
    expect(r.service.reactionCounts().waiting).toBe(0);
    r.service.stop();
  });

  watchTest("when fs.watch cannot open (ENOSPC) the files are polled, the trick's row says so, and a changed time runs it", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const enospc: WatchFactory = () => {
      throw new Error("ENOSPC: System limit for number of file watchers reached");
    };
    const r = await onRig([OK], watchManifest(file), { watchOptions: { ...FAST, factory: enospc } });
    // A note of its own, not a refusal: the wire carries the interval, and the errno stays in the log.
    const row = (await r.service.reply(undefined)).tricks[0];
    expect(row?.refusals).toBeUndefined();
    expect(row?.watchPollSeconds).toBe(5);
    expect(JSON.stringify(row)).not.toContain("ENOSPC");
    expect(r.warnings.some((line) => line.includes("react") && line.includes("ENOSPC") && line.includes("5 seconds"))).toBe(true);
    expect(r.service.reactionCounts()).toMatchObject({ watchers: 1, handles: 0, timers: 1 });
    await writeFile(file, "ab");
    await tick(220);
    expect(kinds(r)).toEqual(["start", "watch"]);
    // Switched off: the poll and the note go.
    await r.service.setSwitch(HOST, "react", false);
    expect(r.service.reactionCounts().timers).toBe(0);
    expect((await r.service.reply(undefined)).tricks[0]?.watchPollSeconds).toBeUndefined();
    r.service.stop();
  });

  watchTest("switching off closes the watch and its timers; a restart (a config change) sets it up again", async () => {
    const dir = await tempDir();
    const file = join(dir, "todo.md");
    await writeFile(file, "a");
    const counted = countingFactory();
    const r = await rig([OK], { watchOptions: { ...FAST, factory: counted.factory } });
    const trick = await makeTrick(r.configDir, "react", watchManifest(file), { "config.toml": "a = 1\n" });
    await switchOn(r.stateDir, "react");
    await tickAt(r, T0);
    expect(counted.opened).toEqual([dir]);
    // A config change restarts the trick: the watch is set up again, once.
    await writeFile(join(trick, "config.toml"), "a = 2\n");
    await tickAt(r, T0 + 3000);
    expect(counted.opened).toEqual([dir, dir]);
    expect(counted.closed).toEqual([dir]);
    await writeFile(file, "ab");
    await tick(10);
    expect(r.service.reactionCounts().timers).toBe(1);
    await r.service.setSwitch(HOST, "react", false);
    expect(counted.closed).toEqual([dir, dir]);
    expect(r.service.reactionCounts()).toEqual({ subscribed: false, watchers: 0, handles: 0, timers: 0, waiting: 0 });
    await tick(150);
    expect(r.specs.length).toBe(2);
    r.service.stop();
  });
});

describe("`on` and `watch` are rights", () => {
  const V1 = 'id = "react"\nname = "React"\nrun = "./react.sh"\nplaces = ["belt"]\n';

  test("the manifest of this bridge reads both, and `serve` still waits", () => {
    const text = `${V1}on = ["turn.end", "turn.end"]\nwatch = ["~/a.md", "/etc/hosts"]\nmode = "serve"\n`;
    const read = readManifestText(text, "react");
    expect(read.manifest?.on).toEqual(["turn.end"]);
    expect(read.manifest?.watch).toEqual(["~/a.md", "/etc/hosts"]);
    expect(read.manifest?.mode).toBe("once");
    expect(read.refusals.map((refusal) => refusal.path)).toEqual(["/mode"]);
    expect(readManifestText(`${V1}watch = ["relative.md"]\n`, "react").refusals[0]?.reason).toBe("A watched path starts with / or ~/.");
    expect(readManifestText(`${V1}watch = [${Array.from({ length: 9 }, (_, i) => `"/a${String(i)}"`).join(", ")}]\n`, "react").manifest).toBeUndefined();
  });

  test("the powers move for an added event, a changed event list, an added path and a changed path; absent hashes as before", () => {
    const base = readManifestText(V1, "react").manifest;
    const withOn = readManifestText(`${V1}on = ["turn.end"]\n`, "react").manifest;
    const otherOn = readManifestText(`${V1}on = ["turn.end", "ask.open"]\n`, "react").manifest;
    const sameOnOtherOrder = readManifestText(`${V1}on = ["ask.open", "turn.end"]\n`, "react").manifest;
    const withWatch = readManifestText(`${V1}watch = ["/etc/hosts"]\n`, "react").manifest;
    const otherWatch = readManifestText(`${V1}watch = ["/etc/passwd"]\n`, "react").manifest;
    if (base === undefined || withOn === undefined || otherOn === undefined || sameOnOtherOrder === undefined || withWatch === undefined || otherWatch === undefined) throw new Error("manifest did not read");
    const powers = [base, withOn, otherOn, withWatch, otherWatch].map((manifest) => powersOf(manifest));
    expect(new Set(powers).size).toBe(5);
    expect(powersOf(sameOnOtherOrder)).toBe(powersOf(otherOn));
    // A trick that lists neither has the powers it always had: this value is what the build before `on` stored.
    expect(powersOf(base)).toBe(powersHash({ env: [], inputs: [], places: ["belt"] }));
  });

  test("the card words: exactly the two sentences, the paths joined by a comma and a space", () => {
    expect(ON_CHIP).toBe("runs when a session changes state");
    expect(watchChip(["~/notes/todo.md", "/etc/hosts"])).toBe("runs when these files change: ~/notes/todo.md, /etc/hosts");
    const base = readManifestText(V1, "react").manifest;
    const both = readManifestText(`${V1}on = ["turn.end", "ask.open"]\nwatch = ["~/a.md", "/etc/hosts"]\n`, "react").manifest;
    expect(newRights(base, both)).toEqual(["runs when a session changes state", "runs when these files change: ~/a.md, /etc/hosts"]);
    // A version that names one more event or path shows the right again; one that changes nothing shows nothing.
    const more = readManifestText(`${V1}on = ["turn.end", "ask.open", "session.status"]\nwatch = ["~/a.md", "/etc/hosts", "/tmp/x"]\n`, "react").manifest;
    expect(newRights(both, more)).toEqual(["runs when a session changes state", "runs when these files change: /tmp/x"]);
    expect(newRights(both, both)).toEqual([]);
  });

  test("a version that adds `on` waits for a new yes, and the version that runs takes no event meanwhile", async () => {
    const r = await rig([OK]);
    const dir = await makeTrick(r.configDir, "react", V1, { "react.sh": "#!/bin/sh\necho 1\n" });
    await switchOn(r.stateDir, "react");
    await tickAt(r, T0);
    expect(r.specs.length).toBe(1);
    await writeFile(join(dir, "trick.toml"), `${V1}on = ["turn.end"]\n`);
    await tickAt(r, T0 + 1000);
    await tickAt(r, T0 + PENDING_SETTLE_MS + 2000);
    const row = (await r.service.reply(undefined)).tricks[0];
    expect(row).toMatchObject({ on: true, changed: true, pending: { powersChanged: true } });
    expect(row?.events).toBeUndefined();
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(1);
    expect(r.bus.listeners().subscriptions).toBe(0);
    r.service.stop();
  });

  test("a trick approved by a build that did not read `on` as a right stops until it is switched on again, and runs on no event", async () => {
    const r = await rig([OK]);
    await makeTrick(r.configDir, "react", ON_MANIFEST());
    // The approval as the build before this one stored it: the same trick, read without `on`.
    const dir = join(r.configDir, TRICKS_DIR, "react");
    const code = await trickCodeHash(dir);
    const older = readManifestText(ON_MANIFEST(), "react").manifest;
    if (!code.ok || older === undefined) throw new Error("setup");
    const { on: _on, ...withoutOn } = older;
    await writeSwitches(r.stateDir, withSwitch({ on: new Map() }, "react", true, "2026-11-08T09:00:00Z", code.hash, powersOf(withoutOn)));
    await tickAt(r, T0);
    await tickAt(r, T0 + 1000);
    const row = (await r.service.reply(undefined)).tricks[0];
    expect(row).toMatchObject({ on: false, state: "stopped", error: RIGHTS_LINE, rightsMoved: true });
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(r.specs.length).toBe(0);
    expect(r.bus.listeners().subscriptions).toBe(0);
    r.service.stop();
  });

  test("the row carries the events and the paths as the manifest wrote them, while the trick is off too", async () => {
    const r = await rig([OK]);
    await makeTrick(r.configDir, "react", `${ON_MANIFEST('["turn.end", "ask.open"]')}watch = ["~/notes/todo.md"]\n`);
    r.service.noteWatched();
    await r.service.refresh(true);
    const row = (await r.service.reply(undefined)).tricks[0];
    expect(row).toMatchObject({ on: false, events: ["turn.end", "ask.open"], watch: ["~/notes/todo.md"] });
    expect(row?.error).not.toBe(PENDING_LINE);
    expect(await readFile(join(r.configDir, TRICKS_DIR, "react", "trick.toml"), "utf8")).toContain("watch");
    r.service.stop();
  });
});

// ── One scan at bridge start (the lead, 2026-11-17): reacting tricks and the local API stand with no phone ──

describe("the scan at bridge start", () => {
  test("a reacting trick on and no phone: one scan, its start run, the local API told, and an event runs it", async () => {
    const told: boolean[] = [];
    const r = await rig([OK], { onLocalApi: (wanted) => told.push(wanted) });
    await makeTrick(r.configDir, "react", ON_MANIFEST());
    await switchOn(r.stateDir, "react");
    // No noteWatched: no phone has looked since the bridge started.
    await r.service.boot();
    expect(kinds(r)).toEqual(["start"]);
    expect(told).toEqual([true]);
    r.clock.t = T0 + REACT_FLOOR_MS + 1;
    r.bus.publish({ type: "turn.end", session: sessionOf("a:1") });
    await tick(50);
    expect(kinds(r)).toEqual(["start", "event"]);
    r.service.stop();
  });

  test("review J, point 1: the start sweeps `.gone-*` leftovers of a crashed add, with no trick on", async () => {
    const r = await rig([OK]);
    const left = [join(r.stateDir, TRICKS_DIR, ".gone-legs-aaaaaaaaaaaa"), join(r.configDir, TRICKS_DIR, ".collie-approved", ".gone-legs-bbbbbbbbbbbb")];
    for (const path of left) {
      await mkdir(join(path, "deep"), { recursive: true });
      await writeFile(join(path, "deep", "x"), "x\n");
    }
    await r.service.boot();
    await r.service.swept;
    for (const path of left) expect(await Bun.file(join(path, "deep", "x")).exists()).toBe(false);
    r.service.stop();
  });

  test("no trick on: no scan, no run, and the local API not told by the boot", async () => {
    const told: boolean[] = [];
    const r = await rig([OK], { onLocalApi: (wanted) => told.push(wanted) });
    await makeTrick(r.configDir, "react", ON_MANIFEST());
    await r.service.boot();
    expect(r.specs).toHaveLength(0);
    expect(told).toEqual([]);
    r.service.stop();
  });

  test("a trick that only runs on its timer gets the scan but no start run: it still waits for a phone", async () => {
    const told: boolean[] = [];
    const r = await rig([OK], { onLocalApi: (wanted) => told.push(wanted) });
    await makeTrick(r.configDir, "timed", `id = "timed"\nname = "Timed"\nrun = "./t.sh"\nplaces = ["belt"]\nevery = "1m"\n`);
    await switchOn(r.stateDir, "timed");
    await r.service.boot();
    expect(r.specs).toHaveLength(0);
    expect(told).toEqual([true]);
    r.service.stop();
  });

  test("where tricks do not run (a crew peer, a deputy) or behind the Windows gate: nothing", async () => {
    for (const extra of [{ active: () => false }, { platform: "win32" as const }]) {
      const told: boolean[] = [];
      const r = await rig([OK], { ...extra, onLocalApi: (wanted) => told.push(wanted) });
      await makeTrick(r.configDir, "react", ON_MANIFEST());
      await switchOn(r.stateDir, "react");
      await r.service.boot();
      expect(r.specs).toHaveLength(0);
      expect(told).toEqual([]);
      r.service.stop();
    }
  });
});
