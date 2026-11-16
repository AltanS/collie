import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { hillTopic, type PushMessage } from "../push.ts";
import { HILL_SWITCHED_OFF_TEXT, hillAnswerRoute, hillSwitchRoute, withHill } from "../server.ts";
import type { SnapshotResponse } from "../types.ts";
import type { HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { HillPush, hillPushTag } from "./push.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { EXPIRED, HILL_OFF, HillService, type HillAgentSender, type HillPlace, type HillPostAnswer, type HillTrickSender } from "./service.ts";
import { HillStore, hillDir } from "./store.ts";
import { HILL_SWITCH_FILE, HillSwitch, hillSwitchPath, parseHillSwitch, readHillSwitch, renderHillSwitch, writeHillSwitch } from "./switch.ts";

// THE HILL'S SWITCH (switch.ts, service.ts "THE SWITCH"): the file, the reader behind its stat check,
// and every path that is off while it is off: a post, a trick's post, an answer, a push, the snapshot,
// and what keeps working (status, list, withdraw, the sweep). Then on again, with no restart.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hill-switch-"));
  roots.push(dir);
  return dir;
}

const POSTER: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "desk" };
const PLACES: HillPlace[] = [{ address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false }];
const TRICK: HillTrickSender = { kind: "trick", trickId: "nightly-leg", trickKey: "ship", label: "Nightly leg", memberId: "desk-hc" };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function input(n: number, over: Partial<HillPostInput> = {}): HillPostInput {
  return {
    requestId: uuid(n),
    title: "Ship the zoom fix in 1.28.1?",
    summary: "The pill moves out of Chat. The leg is green.",
    options: [
      { intent: "yes", label: "Yes, Edge first" },
      { intent: "no", label: "No, wait for 1.29.0" },
    ],
    ...over,
  };
}

function posted(answer: HillPostAnswer): string {
  if (!answer.ok) throw new Error(`refused: ${answer.code ?? "-"} ${answer.error}`);
  return answer.decision.id;
}

interface Rig {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly sw: HillSwitch;
  readonly dir: string;
  readonly pushes: PushMessage[];
  readonly audit: AuditEntry[];
  readonly sent: string[];
  readonly taps: string[];
  clock: number;
}

/** A hill with the real switch on a temp state folder, a push port that records, and a recording send and tap. */
function rig(): Rig {
  const dir = stateDir();
  let n = 0;
  const pushes: PushMessage[] = [];
  const audit: AuditEntry[] = [];
  const sent: string[] = [];
  const taps: string[] = [];
  const state = { pushes, audit, sent, taps, clock: 1000 };
  const store = new HillStore(null, () => state.clock);
  const sw = new HillSwitch(dir, null, () => undefined, () => state.clock);
  const hill = new HillService({
    store,
    receipts: memoryHillReceipts(),
    place: (address) => PLACES.find((p) => p.address === address || p.address.split("#")[0] === address) ?? null,
    send: async (to) => {
      state.sent.push(to);
      return "typed";
    },
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => state.clock,
    mintId: () => `dc_swit${String((n += 1)).padStart(8, "0")}`,
    audit: (entry) => state.audit.push(entry),
    tap: async (_host, trickId) => {
      state.taps.push(trickId);
      return true;
    },
    push: new HillPush({ ready: () => true, send: (message) => state.pushes.push(message), now: () => state.clock }),
    hillSwitch: sw,
  });
  // The Hill is off until switched on (2026-11-13): this rig is an instance whose person switched it on.
  sw.set(true);
  return Object.assign(state, { hill, store, sw, dir });
}

describe("the switch file", () => {
  test("no file is off; a version 1 file says on or off; anything else reads as off with a reason", () => {
    expect(parseHillSwitch(null)).toEqual({ on: false, problem: null });
    expect(parseHillSwitch(renderHillSwitch(false, "2026-11-10T09:41:00.000Z"))).toEqual({ on: false, problem: null });
    expect(parseHillSwitch(renderHillSwitch(true, "2026-11-10T09:41:00.000Z"))).toEqual({ on: true, problem: null });
    for (const bad of ["not json", "[]", '{"v":2,"on":false}', '{"v":1,"on":"no"}', '{"v":1}']) {
      expect(parseHillSwitch(bad)).toEqual({ on: false, problem: `${HILL_SWITCH_FILE} is not a version 1 switch file; the Hill reads as off` });
    }
  });

  test("a write goes to <stateDir>/hill/switch.json, 0600 in a 0700 folder, and reads back", () => {
    const dir = stateDir();
    writeHillSwitch(dir, false, Date.UTC(2026, 10, 10, 9, 41));
    expect(hillSwitchPath(dir)).toBe(join(hillDir(dir), "switch.json"));
    expect(JSON.parse(readFileSync(hillSwitchPath(dir), "utf8"))).toEqual({ v: 1, on: false, at: "2026-11-10T09:41:00.000Z" });
    expect(readHillSwitch(dir)).toEqual({ on: false, problem: null });
    if (process.platform !== "win32") {
      expect(statSync(hillSwitchPath(dir)).mode & 0o777).toBe(0o600);
      expect(statSync(hillDir(dir)).mode & 0o777).toBe(0o700);
    }
  });

  test("the bridge's reader follows a write by another process, with no restart, and warns once for a file that does not read", () => {
    const dir = stateDir();
    const warnings: string[] = [];
    const sw = new HillSwitch(dir, null, (line) => warnings.push(line));
    expect(sw.reading()).toBe("unset");
    expect(sw.on()).toBe(false);
    writeHillSwitch(dir, true);
    expect(sw.reading()).toBe("on");
    writeHillSwitch(dir, false);
    expect(sw.reading()).toBe("off");
    writeHillSwitch(dir, true);
    expect(sw.on()).toBe(true);
    mkdirSync(hillDir(dir), { recursive: true });
    writeFileSync(hillSwitchPath(dir), "{ torn");
    // A file that does not read is an explicit off, with one warning for the change.
    expect(sw.reading()).toBe("off");
    expect(sw.reading()).toBe("off");
    expect(warnings).toEqual([`${HILL_SWITCH_FILE} is not a version 1 switch file; the Hill reads as off`]);
  });

  test("three readings: no file is unset and reads as off; a written file is on or off; a removed file is unset again", () => {
    const dir = stateDir();
    const sw = new HillSwitch(dir, null, () => undefined);
    expect(sw.reading()).toBe("unset");
    expect(sw.on()).toBe(false);
    expect(sw.set(true)).toBe(true);
    expect(sw.reading()).toBe("on");
    expect(sw.set(false)).toBe(true);
    expect(sw.reading()).toBe("off");
    rmSync(hillSwitchPath(dir));
    expect(sw.reading()).toBe("unset");
  });

  test("set writes the value and answers true once the reading follows", () => {
    const dir = stateDir();
    const sw = new HillSwitch(dir, null, () => undefined);
    expect(sw.set(false)).toBe(true);
    expect(sw.on()).toBe(false);
    expect(readHillSwitch(dir).on).toBe(false);
  });
});

describe("the Hill is off by default", () => {
  test("with no switch file a post is refused hill_off in the words that name Settings, Experiments; switched on, it posts", () => {
    const r = rig();
    rmSync(hillSwitchPath(r.dir));
    expect(r.hill.isOn()).toBe(false);
    expect(r.hill.post(POSTER, input(1))).toEqual({ ok: false, code: "hill_off", error: HILL_OFF });
    expect(HILL_OFF).toBe("the Hill is off on this Collie; your person can switch it on in Settings, Experiments, on the phone, or with: collie hill on");
    expect(r.store.all()).toEqual([]);
    expect(r.hill.switchTo(true, "Pixel 9")).toBe(true);
    posted(r.hill.post(POSTER, input(1)));
  });

  test("a file that does not parse is off, and an explicit on is on", () => {
    const r = rig();
    writeFileSync(hillSwitchPath(r.dir), "{ torn");
    expect(r.hill.isOn()).toBe(false);
    writeFileSync(hillSwitchPath(r.dir), '{"v":1,"on":true}');
    expect(r.hill.isOn()).toBe(true);
  });

  test("the snapshot of an instance that never switched it says hillOff", () => {
    const r = rig();
    rmSync(hillSwitchPath(r.dir));
    expect(withHill({ bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: 5 }, r.hill)).toMatchObject({ hillOff: true });
  });
});

describe("with the Hill off", () => {
  test("an agent's post is refused hill_off with the way back on, and nothing is stored or pushed", () => {
    const r = rig();
    r.sw.set(false);
    const answer = r.hill.post(POSTER, input(1, { priority: "now" }));
    expect(answer).toEqual({ ok: false, code: "hill_off", error: HILL_OFF });
    expect(HILL_OFF).toContain("collie hill on");
    expect(r.store.all()).toEqual([]);
    expect(r.pushes).toEqual([]);
  });

  test("a repeat of a post the hill once took is refused too: off is checked first", () => {
    const r = rig();
    posted(r.hill.post(POSTER, input(1)));
    r.sw.set(false);
    expect(r.hill.post(POSTER, input(1))).toMatchObject({ ok: false, code: "hill_off" });
  });

  test("a trick's post is refused the same way", () => {
    const r = rig();
    r.sw.set(false);
    expect(r.hill.postDecision(TRICK, input(1), {})).toMatchObject({ ok: false, code: "hill_off" });
  });

  test("an answer is refused before anything: nothing is typed, no tap runs, no receipt, and the decision stays open", async () => {
    const r = rig();
    const agent = posted(r.hill.post(POSTER, input(1)));
    const trick = posted(r.hill.postDecision(TRICK, input(2), {}));
    r.sw.set(false);
    for (const id of [agent, trick]) {
      const outcome = await r.hill.answer({ rid: uuid(100), node: `hill/${id}`, intent: "yes", value: { text: null } }, id, "Pixel 9");
      expect(outcome).toEqual({ kind: "off" });
      expect(r.store.get(id)?.state).toBe("open");
    }
    expect(r.sent).toEqual([]);
    expect(r.taps).toEqual([]);
  });

  test("the answer route says so with a 409, which the phone reads as not accepted", async () => {
    const r = rig();
    const id = posted(r.hill.post(POSTER, input(1)));
    r.sw.set(false);
    const res = await hillAnswerRoute(r.hill, { rid: uuid(100), node: `hill/${id}`, intent: "yes", value: { text: null } }, { device: "Pixel 9", acceptEncoding: null });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(HILL_SWITCHED_OFF_TEXT);
  });

  test("status, list and withdraw keep working, so an agent can clean up", () => {
    const r = rig();
    const first = posted(r.hill.post(POSTER, input(1)));
    const second = posted(r.hill.post(POSTER, input(2)));
    r.sw.set(false);
    expect(r.hill.status(POSTER, first)).toMatchObject({ ok: true, decision: { id: first, state: "open" } });
    expect(r.hill.mineList(POSTER).map((d) => d.id)).toEqual([first, second]);
    expect(r.hill.withdraw(POSTER, second)).toMatchObject({ ok: true, decision: { state: "withdrawn" } });
  });

  test("the open decisions stay untouched, and the sweep still closes one past its expiry", () => {
    const r = rig();
    const lasting = posted(r.hill.post(POSTER, input(1)));
    const due = posted(r.hill.post(POSTER, input(2, { expiresAt: 5000 })));
    r.sw.set(false);
    r.clock = 6000;
    expect(r.hill.sweep(6000)).toBe(1);
    expect(r.store.get(due)).toMatchObject({ state: "expired", closedReason: EXPIRED });
    expect(r.store.get(lasting)).toMatchObject({ state: "open", closedAt: null, answer: null });
  });

  test("the move to off closes the notification of every open now decision once; a CLI switch is seen by the sweep", () => {
    const r = rig();
    const now = posted(r.hill.post(POSTER, input(1, { priority: "now" })));
    posted(r.hill.post(POSTER, input(2, { priority: "today" })));
    const before = r.pushes.length;
    // The CLI writes the file; the bridge sees it on its next look, here the slow timer's sweep.
    writeHillSwitch(r.dir, false);
    r.hill.sweep();
    expect(r.pushes.slice(before)).toEqual([{ type: "clear", tag: hillPushTag(now), topic: hillTopic(hillPushTag(now)) }]);
    expect(r.audit.at(-1)).toEqual({ action: "hill.push.cleared", detail: { why: "the Hill is off", count: 1 } });
    // Seen off again: nothing more is cleared.
    r.hill.sweep();
    expect(r.hill.isOn()).toBe(false);
    expect(r.pushes.slice(before)).toHaveLength(1);
    expect(r.store.get(now)?.state).toBe("open");
  });

  test("on again, with no restart: the kept decisions are served, a post is taken, an answer is typed", async () => {
    const r = rig();
    const kept = posted(r.hill.post(POSTER, input(1)));
    r.sw.set(false);
    expect(r.hill.post(POSTER, input(2))).toMatchObject({ ok: false, code: "hill_off" });
    r.sw.set(true);
    expect(r.hill.list().open.map((d) => d.id)).toEqual([kept]);
    const fresh = posted(r.hill.post(POSTER, input(2)));
    expect(r.hill.list().open.map((d) => d.id)).toEqual([kept, fresh]);
    const outcome = await r.hill.answer({ rid: uuid(100), node: `hill/${kept}`, intent: "yes", value: { text: null } }, kept, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok", state: "answered" } });
    expect(r.sent).toEqual(["local/%1#aaaa"]);
  });
});

describe("the phone's switch", () => {
  test("switchTo writes the file, answers the value now held, and writes one audit line", () => {
    const r = rig();
    expect(r.hill.switchTo(false, "Pixel 9")).toBe(false);
    expect(readHillSwitch(r.dir).on).toBe(false);
    expect(r.audit.at(-1)).toEqual({ action: "hill.switch", device: "Pixel 9", detail: { on: false } });
    expect(r.hill.switchTo(true, "Pixel 9")).toBe(true);
  });

  test("a hill with no switch cannot be moved: null, and nothing changes", () => {
    const store = new HillStore(null, () => 1000);
    const hill = new HillService({ store, receipts: memoryHillReceipts(), place: () => null, send: async () => "typed", crewMode: () => "solo", walkyOn: () => true, memberId: "m_aaaaaaaaaa", machine: "desk" });
    expect(hill.switchTo(false)).toBeNull();
    expect(hill.isOn()).toBe(true);
  });

  test("GET answers { on }; POST takes { on } alone and answers the value now held", async () => {
    const r = rig();
    const get = hillSwitchRoute(r.hill, null, { device: null, acceptEncoding: null });
    expect(await get.json()).toEqual({ on: true });
    const off = hillSwitchRoute(r.hill, { body: { on: false } }, { device: "Pixel 9", acceptEncoding: null });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ on: false });
    for (const body of [undefined, null, { on: "no" }, { on: false, extra: 1 }, []]) {
      expect(hillSwitchRoute(r.hill, { body }, { device: null, acceptEncoding: null }).status).toBe(400);
    }
    expect(hillSwitchRoute(undefined, null, { device: null, acceptEncoding: null }).status).toBe(404);
  });

  test("a switch that could not be written answers 503 and changes nothing", () => {
    const store = new HillStore(null, () => 1000);
    const hill = new HillService({ store, receipts: memoryHillReceipts(), place: () => null, send: async () => "typed", crewMode: () => "solo", walkyOn: () => true, memberId: "m_aaaaaaaaaa", machine: "desk", hillSwitch: { on: () => true, set: () => false } });
    expect(hillSwitchRoute(hill, { body: { on: false } }, { device: null, acceptEncoding: null }).status).toBe(503);
  });
});

describe("the snapshot", () => {
  const snapshot: SnapshotResponse = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: 5 };

  test("on: the hill's revision, also before the first Decision (decision 6), and no hillOff key; no hill: the same bytes", () => {
    const r = rig();
    // On with no decisions file yet: a revision all the same, so the phone shows the Hill in the bar.
    expect(withHill(snapshot, r.hill)).toEqual({ ...snapshot, hillRev: 0 });
    expect(JSON.stringify(withHill(snapshot, undefined))).toBe(JSON.stringify(snapshot));
    // Off with no decisions file: still no revision (the phone shows no Hill item), only hillOff.
    r.sw.set(false);
    expect(withHill(snapshot, r.hill)).toEqual({ ...snapshot, hillOff: true });
    r.sw.set(true);
    posted(r.hill.post(POSTER, input(1)));
    expect(withHill(snapshot, r.hill)).toEqual({ ...snapshot, hillRev: 1000 });
  });

  test("off: no revision, so the phone shows no Hill item, and hillOff: true; on again: the revision is back", () => {
    const r = rig();
    posted(r.hill.post(POSTER, input(1)));
    r.sw.set(false);
    expect(withHill(snapshot, r.hill)).toEqual({ ...snapshot, hillOff: true });
    r.sw.set(true);
    expect(withHill(snapshot, r.hill)).toEqual({ ...snapshot, hillRev: 1000 });
  });
});
