import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService, type HillPlace } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { hillAnswerRoute, hillListRoute } from "../server.ts";
import type { HillDecision, HillReceipt } from "../../web/src/lib/hill/wire.ts";
import { parseJsonObject } from "../../web/src/lib/json.ts";
import { parseFacts, type Refusal, type TrickDecision, type TrickFacts, type TrickTapReply } from "../../web/src/lib/tricks/schema.ts";
import { decisionContentHash, IMAGES_LATER, scopeKeyAddress, TrickHill, TRICKS_MAP_FILE, trickRequestId, type TrickHillTrick } from "./hill.ts";
import { TRICKS_DIR } from "./paths.ts";
import { runProvider, type RunOutcome, type RunSpec } from "./run.ts";
import { HILL_NODE_TAP_REFUSED, TricksService, type TapAnswer } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";

// A TRICK POSTS INTO THE HILL AND GETS ITS TAP (M94, M96): the diff by key, the switch-off withdraw,
// the session mapping, the refusals, and one run of the real legs trick from post to tap.

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-trick-hill-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const HOST = "bluefin";
const LEGS: TrickHillTrick = { id: "legs", name: "Browser leg", host: HOST };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Two live agent sessions on this machine, as the hill's probe finds them. */
const PLACES: HillPlace[] = [
  { address: "local/w6X:3#aaaa", label: "m96-hill", host: "bluefin", unattended: false },
  { address: "local/w6X:4#bbbb", label: "composer", host: "bluefin", unattended: false },
];

interface Rig {
  readonly stateDir: string;
  readonly store: HillStore;
  readonly hill: HillService;
  readonly tricks: TrickHill;
  readonly sent: { to: string; body: string }[];
  live: HillPlace[];
  /** What the trick's tap callback is answered with, and every tap it got. */
  tapResult: boolean;
  readonly taps: { host: string; trickId: string; node: string; rid: string; decisionId: string }[];
  /** A fresh TrickHill and HillService over the same files: what a bridge restart reads. */
  restart(): Rig;
}

function place(live: () => HillPlace[]): (address: string) => HillPlace | null {
  return (address) => {
    const bare = address.split("#")[0];
    const hits = live().filter((candidate) => (address.includes("#") ? candidate.address === address : candidate.address.split("#")[0] === bare));
    return hits.length === 1 ? hits[0]! : null;
  };
}

function rig(stateDir = tempDir()): Rig {
  let n = 0;
  const store = new HillStore(join(stateDir, "hill"), () => 1000);
  const taps: Rig["taps"] = [];
  const sent: Rig["sent"] = [];
  const state = { live: [...PLACES], tapResult: true, taps, sent };
  const probe = place(() => state.live);
  const hill = new HillService({
    store,
    receipts: memoryHillReceipts(),
    place: probe,
    send: async (to, body) => {
      state.sent.push({ to, body });
      return "typed";
    },
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: null,
    machine: "bluefin.lan",
    now: () => 1000,
    mintId: () => `dc_trk${String((n += 1)).padStart(9, "0")}`,
    tap: async (host, trickId, tap, decisionId) => {
      state.taps.push({ host, trickId, node: tap.node, rid: tap.rid, decisionId });
      return state.tapResult;
    },
  });
  const tricks = new TrickHill({ stateDir, hill, addressOf: (scopeKey) => scopeKeyAddress(scopeKey, HOST, "local", probe) });
  return Object.assign(state, { stateDir, store, hill, tricks, restart: () => rig(stateDir) });
}

const decision = (key: string, over: Partial<TrickDecision> = {}): TrickDecision => ({
  key,
  title: `Leg red: ${key}. Rerun it?`,
  summary: "Case 8 failed, 10 passed.",
  options: [
    { intent: "rerun", label: "Rerun" },
    { intent: "skip", label: "Skip" },
  ],
  ...over,
});

function sync(r: Rig, decisions: TrickDecision[], refusedKeys: string[] = []): Refusal[] {
  return r.tricks.sync(LEGS, { decisions, refusedKeys });
}

const open = (r: Rig): HillDecision[] => r.store.all().filter((held) => held.state === "open");

async function answer(r: Rig, held: HillDecision, rid: number, intent: string, text: string | null = null): Promise<HillReceipt> {
  const outcome = await r.hill.answer({ rid: uuid(rid), node: `hill/${held.id}`, intent, value: { text } }, held.id, "Pixel 9");
  if (outcome.kind !== "receipt") throw new Error(outcome.kind);
  return outcome.receipt;
}

describe("the diff by key", () => {
  test("a new key posts once, stamped as the trick; a second run and a bridge restart post nothing again", () => {
    const r = rig();
    expect(sync(r, [decision("case-8")])).toEqual([]);
    const [posted] = open(r);
    expect(posted?.from).toEqual({ kind: "trick", address: null, trickId: "legs", trickKey: "case-8", memberId: null, harness: null, label: "Browser leg", host: HOST });
    expect(posted?.requestId).toBe(trickRequestId("legs", "case-8", decisionContentHash(decision("case-8")), 0, 0));
    expect(posted?.target).toBeNull();
    expect(sync(r, [decision("case-8")])).toEqual([]);
    const again = r.restart();
    expect(sync(again, [decision("case-8")])).toEqual([]);
    expect(again.store.all()).toHaveLength(1);
  });

  test("the map is <stateDir>/hill/tricks.json, owner only, and written only when something changed", () => {
    const r = rig();
    sync(r, []);
    expect(existsSync(join(r.stateDir, "hill", TRICKS_MAP_FILE))).toBe(false);
    sync(r, [decision("case-8")]);
    const path = join(r.stateDir, "hill", TRICKS_MAP_FILE);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const file = parseJsonObject(readFileSync(path, "utf8"));
    const held = open(r)[0]!;
    expect(file).toEqual({ v: 1, tricks: { legs: { gen: 0, keys: { "case-8": { decisionId: held.id, hash: decisionContentHash(decision("case-8")), state: "open", seq: 1 } } } } });
  });

  test("the same key with changed content posts the new one with supersedes", () => {
    const r = rig();
    sync(r, [decision("case-8")]);
    const first = open(r)[0]!;
    sync(r, [decision("case-8", { summary: "Case 8 failed again, 9 passed." })]);
    const [now] = open(r);
    expect(now?.supersedes).toBe(first.id);
    expect(now?.summary).toBe("Case 8 failed again, 9 passed.");
    expect(r.store.get(first.id)).toMatchObject({ state: "superseded", supersededBy: now?.id });
  });

  test("every field the person sees moves the hash; the key, the expiry and the images do not", () => {
    const base = decisionContentHash(decision("k"));
    const changes: Partial<TrickDecision>[] = [
      { title: "Other" },
      { summary: "Other" },
      { body: "More." },
      { options: [{ intent: "rerun", label: "Rerun now" }] },
      { options: [{ intent: "rerun", label: "Rerun" }, { intent: "skip", label: "Skip", confirm: "Skip it" }] },
      { recommends: { intent: "rerun", why: "Often a timeout." } },
      { text: "required" },
      { links: [{ label: "The log", href: "https://example.com/log" }] },
      { priority: "now" },
      { replyTo: "bluefin:w6X:3" },
      { about: "bluefin:w6X:3" },
    ];
    for (const change of changes) expect(decisionContentHash(decision("k", change)), JSON.stringify(change)).not.toBe(base);
    expect(decisionContentHash({ ...decision("k"), key: "other-key" })).toBe(base);
    expect(decisionContentHash(decision("k", { expiresAt: 9_999_999_999_999, media: [{ file: "a.png" }] }))).toBe(base);
    expect(decisionContentHash(decision("k", { priority: "today", text: "optional" }))).toBe(base);
  });

  test("a key the document no longer lists is withdrawn, by the trick", () => {
    const r = rig();
    sync(r, [decision("case-8"), decision("case-9")]);
    const nine = open(r).find((held) => held.from.trickKey === "case-9")!;
    sync(r, [decision("case-8")]);
    expect(r.store.get(nine.id)).toMatchObject({ state: "withdrawn", closedReason: "by the trick" });
    expect(open(r).map((held) => held.from.trickKey)).toEqual(["case-8"]);
    expect(r.tricks.entries("legs")).not.toHaveProperty("case-9");
  });

  test("a key the parser refused alone keeps its version on the hill", () => {
    const r = rig();
    sync(r, [decision("case-8")]);
    const held = open(r)[0]!;
    sync(r, [], ["case-8"]);
    expect(r.store.get(held.id)?.state).toBe("open");
  });

  test("an answered key stays closed while its content is unchanged; changed content asks again, with no supersedes", async () => {
    const r = rig();
    sync(r, [decision("case-8")]);
    const first = open(r)[0]!;
    await answer(r, first, 100, "rerun");
    sync(r, [decision("case-8")]);
    expect(open(r)).toEqual([]);
    expect(r.tricks.entries("legs")["case-8"]).toMatchObject({ decisionId: first.id, state: "answered" });
    sync(r, [decision("case-8", { summary: "Red again after the rerun." })]);
    const [asked] = open(r);
    expect(asked?.supersedes).toBeNull();
    expect(asked?.id).not.toBe(first.id);
  });

  test("a dismissed key dropped for a run and listed again asks again", async () => {
    const r = rig();
    sync(r, [decision("case-8")]);
    await answer(r, open(r)[0]!, 100, "dismiss");
    sync(r, [decision("case-8")]);
    expect(open(r)).toEqual([]);
    sync(r, []);
    sync(r, [decision("case-8")]);
    expect(open(r)).toHaveLength(1);
  });

  test("content that comes back (A, then B, then A) posts each time and never meets its own first post", () => {
    const r = rig();
    const a = decision("case-8");
    const b = decision("case-8", { summary: "B" });
    sync(r, [a]);
    sync(r, [b]);
    sync(r, [a]);
    expect(open(r)).toHaveLength(1);
    expect(open(r)[0]?.summary).toBe(a.summary);
    expect(r.store.all()).toHaveLength(3);
  });
});

describe("the sessions a decision names", () => {
  test("replyTo and about are facts scope keys, mapped to the session's walky address at post time", () => {
    const r = rig();
    expect(sync(r, [decision("case-8", { replyTo: "bluefin:w6X:3", about: "bluefin:w6X:4" })])).toEqual([]);
    expect(open(r)[0]).toMatchObject({ replyTo: "local/w6X:3#aaaa", about: "local/w6X:4#bbbb", target: { label: "m96-hill", host: "bluefin" } });
  });

  test("a name that maps to no live session refuses that one decision; the others post", () => {
    const r = rig();
    const refusals = sync(r, [decision("case-8", { replyTo: "bluefin:w6X:9" }), decision("case-9"), decision("case-10", { about: "minibuch:%1" })]);
    expect(refusals.map((refusal) => [refusal.code, refusal.path, refusal.decision])).toEqual([
      ["target", "/decisions/0/replyTo", "case-8"],
      ["target", "/decisions/2/about", "case-10"],
    ]);
    expect(open(r).map((held) => held.from.trickKey)).toEqual(["case-9"]);
  });

  test("scopeKeyAddress: only this machine's sessions, through the probe", () => {
    const probe = place(() => PLACES);
    expect(scopeKeyAddress("bluefin:w6X:3", "bluefin", "local", probe)).toBe("local/w6X:3#aaaa");
    expect(scopeKeyAddress("minibuch:w6X:3", "bluefin", "local", probe)).toBeNull();
    expect(scopeKeyAddress("bluefin:", "bluefin", "local", probe)).toBeNull();
    expect(scopeKeyAddress("bluefin:w6X:9", "bluefin", "local", probe)).toBeNull();
  });
});

describe("refusals and notes", () => {
  test("the hill's cap: past 20 open of one trick, the hill's refusal reaches the trick's refusals", () => {
    const r = rig();
    const many = Array.from({ length: 21 }, (_, i) => decision(`d${String(i)}`));
    const refusals = sync(r, many);
    expect(refusals.map((refusal) => [refusal.code, refusal.path, refusal.decision])).toEqual([["count", "/decisions/20", "d20"]]);
    expect(refusals[0]?.reason).toStartWith("The hill refused it: this session has 20 open decisions");
    expect(open(r)).toHaveLength(20);
  });

  test("a decision with images posts without them, with one note per run", () => {
    const r = rig();
    const refusals = sync(r, [decision("a", { media: [{ file: "a.png" }] }), decision("b", { media: [{ file: "b.png" }] })]);
    expect(refusals).toEqual([{ code: "later", path: "/decisions/0/media", reason: IMAGES_LATER, decision: "a" }]);
    expect(open(r)).toHaveLength(2);
  });
});

describe("switched off", () => {
  test("every open decision is withdrawn at once, the trick is off; answered ones stay; back on, the open ones post again", async () => {
    const r = rig();
    sync(r, [decision("a"), decision("b")]);
    const a = open(r).find((held) => held.from.trickKey === "a")!;
    await answer(r, a, 100, "skip");
    const b = open(r)[0]!;
    r.tricks.off(LEGS);
    expect(r.store.get(b.id)).toMatchObject({ state: "withdrawn", closedReason: "the trick is off" });
    expect(r.store.get(a.id)?.state).toBe("answered");
    sync(r, [decision("a"), decision("b")]);
    expect(open(r).map((held) => held.from.trickKey)).toEqual(["b"]);
    expect(open(r)[0]?.id).not.toBe(b.id);
  });

  test("prune: a trick the scan no longer finds is off", () => {
    const r = rig();
    sync(r, [decision("a")]);
    r.tricks.prune(new Set(["other"]), HOST);
    expect(open(r)).toEqual([]);
  });
});

describe("seen", () => {
  test("the content hash of the answered version, by decision id", () => {
    const r = rig();
    sync(r, [decision("a")]);
    const held = open(r)[0]!;
    expect(r.tricks.seenOf("legs", held.id)).toBe(decisionContentHash(decision("a")));
    expect(r.tricks.seenOf("legs", "dc_nonexistent1")).toBeUndefined();
  });
});

// ── The runner: the service with the hill wired in ─────────────────────────────────────────────

const T0 = Date.parse("2026-11-09T09:00:00Z");

async function switches(stateDir: string, on: boolean): Promise<void> {
  let next: Switches = { on: new Map<string, string>() };
  if (on) next = withSwitch(next, "legs", true, "2026-11-09T09:00:00Z");
  await writeSwitches(stateDir, next);
}

/** What the fake runner answers next. */
interface Scripted {
  outcome: RunOutcome;
}

interface ServiceRig extends Rig {
  readonly configDir: string;
  readonly service: TricksService;
  readonly clock: { t: number };
  readonly specs: RunSpec[];
  outcome: RunOutcome;
}

function makeLegs(configDir: string, manifest = 'id = "legs"\nname = "Browser leg"\nrun = "./legs.sh"\nplaces = ["belt"]\n'): void {
  const dir = join(configDir, TRICKS_DIR, "legs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "trick.toml"), manifest);
}

const exited = (doc: JsonObject): RunOutcome => ({ kind: "exited", code: 0, stdout: JSON.stringify(doc), stderr: "", ms: 5 });
const doc = (decisions: JsonObject[]): JsonObject => ({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: "10/12" } }], decisions });
const RED: JsonObject = { key: "case-8", title: "Leg red: case 8. Rerun it?", summary: "Case 8 failed.", options: [{ intent: "rerun", label: "Rerun" }, { intent: "skip", label: "Skip" }] };

async function serviceRig(): Promise<ServiceRig> {
  const root = tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  makeLegs(configDir);
  const base = rig(stateDir);
  const clock = { t: T0 };
  const specs: RunSpec[] = [];
  const state: Scripted = { outcome: exited(doc([RED])) };
  const out = Object.assign(base, state, { configDir, clock, specs });
  const service = new TricksService({
    configDir,
    stateDir,
    host: () => HOST,
    world: () => ({ sessions: [], spaces: [] }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: () => {},
    revBase: 1000,
    decisions: base.tricks,
    run: async (spec) => {
      specs.push(spec);
      return out.outcome;
    },
  });
  return Object.assign(out, { service });
}

async function runNow(r: ServiceRig): Promise<void> {
  r.clock.t += 60_000;
  r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

function factsOf(spec: RunSpec | undefined): TrickFacts {
  const parsed = parseFacts(JSON.parse(spec?.stdin ?? "null"));
  if (parsed.facts === undefined) throw new Error(`facts did not parse: ${JSON.stringify(parsed.refusals)}`);
  return parsed.facts;
}

describe("the runner posts", () => {
  test("after a successful run the decisions are on the hill; a failed or timed-out run changes nothing", async () => {
    const r = await serviceRig();
    await switches(r.stateDir, true);
    await runNow(r);
    expect(open(r).map((held) => held.from.trickKey)).toEqual(["case-8"]);
    r.outcome = { kind: "exited", code: 1, stdout: "", stderr: "boom", ms: 5 };
    await r.service.tap(HOST, "legs", { rid: uuid(1), node: "belt", intent: "rerun" });
    expect(open(r).map((held) => held.from.trickKey)).toEqual(["case-8"]);
    r.outcome = { kind: "timeout", stderr: "", ms: 30_000, limitMs: 30_000 };
    await r.service.tap(HOST, "legs", { rid: uuid(2), node: "belt", intent: "rerun" });
    expect(open(r)).toHaveLength(1);
  });

  test("a list refused as a whole changes nothing on the hill", async () => {
    const r = await serviceRig();
    await switches(r.stateDir, true);
    await runNow(r);
    r.outcome = exited(doc(Array.from({ length: 21 }, (_, i) => ({ ...RED, key: `d${String(i)}` }))));
    await r.service.tap(HOST, "legs", { rid: uuid(1), node: "belt", intent: "x" });
    expect(open(r).map((held) => held.from.trickKey)).toEqual(["case-8"]);
  });

  test("a refusal from the hill shows in the trick's refusals, the list the Settings row reads", async () => {
    const r = await serviceRig();
    await switches(r.stateDir, true);
    r.outcome = exited(doc([{ ...RED, replyTo: "bluefin:w6X:9" }]));
    await runNow(r);
    const info = (await r.service.reply(undefined)).tricks.find((trick) => trick.id === "legs");
    expect(info?.refusals?.map((refusal) => [refusal.code, refusal.path, refusal.decision])).toEqual([["target", "/decisions/0/replyTo", "case-8"]]);
  });

  test("switched off: every open decision of the trick is withdrawn at once", async () => {
    const r = await serviceRig();
    await switches(r.stateDir, true);
    await runNow(r);
    const held = open(r)[0]!;
    await r.service.setSwitch(HOST, "legs", false);
    expect(r.store.get(held.id)).toMatchObject({ state: "withdrawn", closedReason: "the trick is off" });
  });

  test("removed: the folder goes, and its open decisions with it", async () => {
    const r = await serviceRig();
    await switches(r.stateDir, true);
    await runNow(r);
    rmSync(join(r.configDir, TRICKS_DIR, "legs"), { recursive: true });
    await r.service.refresh(true);
    expect(open(r)).toEqual([]);
  });

  test("the hill's tap reaches the program with the answer's rid and seen; the phone's own tap on hill/ is refused", async () => {
    const r = await serviceRig();
    await switches(r.stateDir, true);
    await runNow(r);
    const held = open(r)[0]!;
    const ran = await r.service.tapFromHill(HOST, "legs", { rid: uuid(7), node: "hill/case-8", intent: "skip", value: { text: "flaky" } }, held.id);
    expect(ran).toBe(true);
    expect(factsOf(r.specs.at(-1)).trigger).toEqual({ kind: "tap", rid: uuid(7), node: "hill/case-8", intent: "skip", value: { text: "flaky" }, seen: r.tricks.seenOf("legs", held.id)! });
    const direct: TapAnswer = await r.service.tap(HOST, "legs", { rid: uuid(8), node: "hill/case-8", intent: "skip", value: { text: null } });
    expect(direct).toEqual({ status: 200, body: { rid: uuid(8), code: "rejected", message: HILL_NODE_TAP_REFUSED } satisfies TrickTapReply });
    r.outcome = { kind: "exited", code: 1, stdout: "", stderr: "", ms: 1 };
    expect(await r.service.tapFromHill(HOST, "legs", { rid: uuid(9), node: "hill/case-8", intent: "skip", value: { text: null } }, held.id)).toBe(false);
  });
});

// ── End to end: the real legs trick, from its run to its tap ───────────────────────────────────

const LEGS_DIR = join(import.meta.dir, "fixtures", "legs");

describe.skipIf(process.platform === "win32")("end to end with the legs trick", () => {
  test("run, see it in GET /api/hill, answer it, and the program's tap input carries the answer", async () => {
    const root = tempDir();
    const configDir = join(root, "config");
    const stateDir = join(root, "state");
    const tapLog = join(root, "facts.jsonl");
    mkdirSync(stateDir, { recursive: true });
    const dir = join(configDir, TRICKS_DIR, "legs");
    cpSync(LEGS_DIR, dir, { recursive: true });
    // The same trick, its stdin copied to a file outside its folder first, so the test reads what the program got.
    writeFileSync(join(dir, "record.sh"), '#!/bin/sh\nf=$(cat)\nprintf \'%s\\n\' "$f" >> "$LEGS_TAP_LOG"\nprintf \'%s\' "$f" | ./program.sh\n', { mode: 0o755 });
    writeFileSync(join(dir, "trick.toml"), readFileSync(join(LEGS_DIR, "trick.toml"), "utf8").replace('run = "./program.sh"', 'run = "./record.sh"').replace('every = "15s"\n', ""));
    await switches(stateDir, true);

    const base = rig(stateDir);
    const clock = { t: T0 };
    const service = new TricksService({
      configDir,
      stateDir,
      host: () => HOST,
      world: () => ({ sessions: [], spaces: [] }),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LEGS_LOG_DIR: join(LEGS_DIR, "fixtures", "red"), LEGS_RUNNING: "0", LEGS_NOW: "1794130860", LEGS_TAP_LOG: tapLog },
      now: () => clock.t,
      warn: () => {},
      revBase: 1000,
      decisions: base.tricks,
      run: (spec) => runProvider(spec),
    });
    // The hill's tap goes to this runner, as bridge/index.ts wires it.
    const hill = new HillService({
      store: base.store,
      receipts: memoryHillReceipts(),
      place: () => null,
      send: async () => "typed",
      crewMode: () => "solo",
      walkyOn: () => true,
      memberId: null,
      machine: "bluefin.lan",
      now: () => clock.t,
      tap: (host, trickId, tap, decisionId) => service.tapFromHill(host, trickId, tap, decisionId),
    });

    service.noteWatched();
    await service.refresh(true);
    await service.tick();

    const served: unknown = await hillListRoute(hill, null, null).json();
    const card = hill.list().open[0]!;
    expect(served).toMatchObject({ open: [{ id: card.id }] });
    expect(hill.list().open).toHaveLength(1);
    expect(card).toMatchObject({ title: "Leg red: case 8. Rerun it?", from: { kind: "trick", trickId: "legs", trickKey: "case-8", label: "Browser leg" }, target: null });

    const seen = base.tricks.seenOf("legs", card.id);
    expect(seen).toMatch(/^[0-9a-f]{16}$/);
    const res = await hillAnswerRoute(hill, { rid: uuid(42), node: `hill/${card.id}`, intent: "skip", value: { text: null } }, { device: "Pixel 9", acceptEncoding: null });
    expect(await res.json()).toMatchObject({ rid: uuid(42), code: "ok", state: "answered", delivery: "none", trick: "ran" });

    const facts = readFileSync(tapLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => parseFacts(JSON.parse(line)).facts);
    expect(facts.at(-1)?.trigger).toEqual({ kind: "tap", rid: uuid(42), node: "hill/case-8", intent: "skip", value: { text: null }, seen });
    // The program kept the skip in its own state folder, and its next document lists no decision.
    expect(readFileSync(join(stateDir, TRICKS_DIR, "legs", "skipped"), "utf8")).toStartWith("case-8 ");
    expect(hill.list().open).toEqual([]);
    expect(base.store.get(card.id)).toMatchObject({ state: "answered", answer: { intent: "skip", trick: "ran" } });
  });
});
