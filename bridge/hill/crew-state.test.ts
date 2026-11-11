import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { hillStateRoute, hillTellRoute } from "../server.ts";
import { HILL_TELL_MAX, type HillDecision, type HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { hillCrewStatePath, HillCrewStateFile, parseHillCrewState, readHillCrewState, writeHillCrewState } from "./crew-state.ts";
import { HillCrewLead, HillHeldMedia, HillMemberForward, type HillLeadLink } from "./crew.ts";
import type { HillPushPort } from "./push.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HILL_STATE_ON_LEAD, HILL_TELL_DONE, HILL_TELL_HERE, HILL_TELL_MOVED, HillService, type HillAgentSender, type HillCrewMode, type HillPlace, type HillPostAnswer } from "./service.ts";
import { HillStore } from "./store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "hill-crew-state-"));
  roots.push(dir);
  return dir;
}

const MEMBER = "m_aaaaaaaaaa";

function sender(n: number): HillAgentSender {
  return { kind: "agent", address: `local/%${String(n)}#a${String(n).padStart(3, "0")}`, memberId: MEMBER, harness: "agent-x", label: `repo#s${String(n)}`, host: "lodge" };
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function input(n: number, over: Partial<HillPostInput> = {}): HillPostInput {
  return {
    requestId: uuid(n),
    title: "Ship the fix?",
    summary: "The leg is green.",
    options: [
      { intent: "yes", label: "Yes" },
      { intent: "no", label: "No, wait" },
    ],
    recommends: null,
    ...over,
  };
}

function posted(answer: HillPostAnswer): HillDecision {
  if (!answer.ok) throw new Error(`refused: ${answer.code ?? "-"} ${answer.error}`);
  return answer.decision;
}

interface Rig {
  readonly hill: HillService;
  readonly file: HillCrewStateFile;
  readonly stateDir: string;
  readonly sent: { to: string; body: string; by: string }[];
  readonly pushed: string[];
  readonly audit: AuditEntry[];
  live: HillPlace[];
  mode: HillCrewMode;
  clock: number;
}

function rig(): Rig {
  const stateDir = tempState();
  let n = 0;
  const sent: Rig["sent"] = [];
  const pushed: string[] = [];
  const audit: AuditEntry[] = [];
  const live: HillPlace[] = [];
  const mode: HillCrewMode = "solo";
  const state = { sent, pushed, audit, live, mode, clock: 10_000_000 };
  for (let i = 1; i <= 25; i += 1) state.live.push({ address: sender(i).address, label: `repo#s${String(i)}`, host: "lodge", unattended: false });
  const push: HillPushPort = {
    check: () => "send",
    send: (_key, decision) => void state.pushed.push(decision.id),
    clear: () => undefined,
  };
  const file = new HillCrewStateFile(stateDir, () => undefined, () => state.clock);
  const hill = new HillService({
    store: new HillStore(null, () => state.clock),
    receipts: memoryHillReceipts(),
    place: (address) => state.live.find((place) => place.address === address) ?? null,
    send: async (to, body, by) => {
      state.sent.push({ to, body, by });
      return "typed";
    },
    crewMode: () => state.mode,
    walkyOn: () => true,
    memberId: MEMBER,
    machine: "lodge",
    now: () => state.clock,
    mintId: () => {
      n += 1;
      return `dc_cs${String(n).padStart(10, "0")}`;
    },
    audit: (entry) => state.audit.push(entry),
    push,
    crewState: file,
  });
  return Object.assign(state, { hill, file, stateDir });
}

describe("the crew state file", () => {
  test("no file, and a file that does not read, are `here`; a write is 0600 and reads back", () => {
    const dir = tempState();
    expect(readHillCrewState(dir)).toEqual({ view: { state: "here", at: null, by: null, told: null }, problem: null });
    expect(parseHillCrewState('{"v":1,"state":"asleep","at":1,"by":"x"}').view.state).toBe("here");
    expect(parseHillCrewState("not json").problem).toContain("reads as here");
    writeHillCrewState(dir, { state: "away", by: "Pixel 9" }, 1234);
    expect(statSync(hillCrewStatePath(dir)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(hillCrewStatePath(dir), "utf8"))).toEqual({ v: 1, state: "away", at: 1234, by: "Pixel 9" });
    expect(readHillCrewState(dir).view).toEqual({ state: "away", at: 1234, by: "Pixel 9", told: null });
  });

  test("the bridge's reading follows the file with no restart, and a tell is marked once per change", () => {
    const dir = tempState();
    const file = new HillCrewStateFile(dir, () => undefined, () => 50);
    expect(file.read().state).toBe("here");
    writeHillCrewState(dir, { state: "quiet", by: "terminal" }, 40);
    expect(file.read()).toEqual({ state: "quiet", at: 40, by: "terminal", told: null });
    expect(file.markTold(39, 2)).toBe(false);
    expect(file.markTold(40, 2)).toBe(true);
    expect(file.read().told).toBe(2);
    expect(file.markTold(40, 3)).toBe(false);
  });
});

describe("the crew state on the Hill", () => {
  test("quiet and away push nothing for a new `now` Decision, and never refuse a post", () => {
    const r = rig();
    posted(r.hill.post(sender(1), input(1, { priority: "now" })));
    expect(r.pushed).toHaveLength(1);
    for (const state of ["quiet", "away"] as const) {
      r.hill.setCrewState(state, "Pixel 9", "Pixel 9");
      const answer = r.hill.post(sender(2), input(state === "quiet" ? 2 : 3, { priority: "now" }));
      expect(answer.ok).toBe(true);
    }
    expect(r.pushed).toHaveLength(1);
    expect(r.audit.filter((entry) => entry.action === "hill.push.skipped").map((entry) => entry.detail)).toEqual([
      { decisionId: "dc_cs0000000002", why: "the crew state is quiet" },
      { decisionId: "dc_cs0000000003", why: "the crew state is away" },
    ]);
  });

  test("a post's result carries the state only when it is not `here`", async () => {
    const r = rig();
    const fields = { requestId: uuid(1), title: "Ship?", summary: "Green.", options: [{ intent: "yes", label: "Yes" }] };
    const here = await r.hill.postFields(sender(1), fields);
    expect(here.ok && here.crewState).toBe(undefined);
    r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    const away = await r.hill.postFields(sender(2), { ...fields, requestId: uuid(2) });
    expect(away).toMatchObject({ ok: true, crewState: "away" });
  });

  test("the typed answer ends with `Crew state: away.` while the state is not `here`, and has no such line under `here`", async () => {
    const r = rig();
    const first = posted(r.hill.post(sender(1), input(1)));
    const second = posted(r.hill.post(sender(2), input(2)));
    await r.hill.answer({ rid: uuid(101), node: `hill/${first.id}`, intent: "yes", value: { text: null } }, first.id, "Pixel 9");
    r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    await r.hill.answer({ rid: uuid(102), node: `hill/${second.id}`, intent: "no", value: { text: "Later." } }, second.id, "Pixel 9");
    expect(r.sent.map((sent) => sent.body)).toEqual([`Answer to ${first.id} "Ship the fix?"\nOption: yes (Yes)`, `Answer to ${second.id} "Ship the fix?"\nOption: no (No, wait)\nLater.\nCrew state: away.`]);
  });

  test("setting it writes one `hill.state` audit line with the device and the value; a member refuses", () => {
    const r = rig();
    expect(r.hill.setCrewState("quiet", "Pixel 9", "Pixel 9")).toMatchObject({ ok: true, crewState: { state: "quiet", by: "Pixel 9", at: r.clock } });
    expect(r.audit).toContainEqual({ action: "hill.state", device: "Pixel 9", detail: { state: "quiet" } });
    r.mode = "peer";
    expect(r.hill.setCrewState("away", "Pixel 9", "Pixel 9")).toEqual({ ok: false, error: HILL_STATE_ON_LEAD, notLead: true });
    expect(r.hill.crewState().state).toBe("quiet");
  });

  test("a change of the state moves the revision, so every phone reads the list again", () => {
    const r = rig();
    posted(r.hill.post(sender(1), input(1)));
    const before = r.hill.rev();
    r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    expect(r.hill.rev()).toBe((before ?? 0) + 1);
    expect(r.hill.rev()).toBe((before ?? 0) + 1);
  });
});

describe("Tell all sessions now", () => {
  test("types one operator line into each live session with an open Decision or one posted in the last hour, once per change", async () => {
    const r = rig();
    posted(r.hill.post(sender(1), input(1)));
    const answered = posted(r.hill.post(sender(2), input(2)));
    const old = posted(r.hill.post(sender(3), input(3)));
    posted(r.hill.post(sender(4), input(4)));
    // Session 4 has gone; session 3 posted long ago and its Decision closed.
    r.live = r.live.filter((place) => place.address !== sender(4).address);
    r.clock += 10;
    await r.hill.answer({ rid: uuid(101), node: `hill/${answered.id}`, intent: "yes", value: { text: null } }, answered.id, "Pixel 9");
    r.clock += 2 * 60 * 60 * 1000;
    r.hill.withdraw(sender(3), old.id);
    posted(r.hill.post(sender(5), input(5)));
    r.sent.length = 0;
    const set = r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    if (!set.ok || set.crewState.at === null) throw new Error("not set");
    expect(r.hill.tellAll(set.crewState.at, "Pixel 9", "Pixel 9")).toEqual({ ok: true, told: 2 });
    await Promise.resolve();
    expect(r.sent).toEqual([
      { to: sender(5).address, body: "[hill] from operator: Crew state: away.", by: "Pixel 9" },
      { to: sender(1).address, body: "[hill] from operator: Crew state: away.", by: "Pixel 9" },
    ]);
    expect(r.audit).toContainEqual({ action: "hill.state.told", device: "Pixel 9", detail: { state: "away", count: 2 } });
    expect(r.hill.crewState().told).toBe(2);
    // A second tap, or a second phone, for the same change: refused, nothing typed.
    expect(r.hill.tellAll(set.crewState.at, "Pixel 9", "Pixel 9")).toEqual({ ok: false, error: HILL_TELL_DONE });
    expect(r.sent).toHaveLength(2);
  });

  test("reaches at most 20 sessions, newest first", async () => {
    const r = rig();
    for (let i = 1; i <= 25; i += 1) {
      r.clock += 1;
      posted(r.hill.post(sender(i), input(i)));
    }
    const set = r.hill.setCrewState("quiet", "Pixel 9", "Pixel 9");
    if (!set.ok || set.crewState.at === null) throw new Error("not set");
    expect(r.hill.tellAll(set.crewState.at, "Pixel 9", "Pixel 9")).toEqual({ ok: true, told: HILL_TELL_MAX });
    await Promise.resolve();
    expect(r.sent).toHaveLength(20);
    expect(r.sent[0]?.to).toBe(sender(25).address);
    expect(r.sent.every((sent) => sent.body === "[hill] from operator: Crew state: quiet.")).toBe(true);
  });

  test("refuses for `here`, and for a change the phone did not see", () => {
    const r = rig();
    posted(r.hill.post(sender(1), input(1)));
    expect(r.hill.tellAll(0, "Pixel 9")).toEqual({ ok: false, error: HILL_TELL_HERE });
    r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    expect(r.hill.tellAll(1, "Pixel 9")).toEqual({ ok: false, error: HILL_TELL_MOVED });
    expect(r.sent).toEqual([]);
  });
});

describe("the crew state routes", () => {
  test("GET answers the state; POST takes one known word and nothing else; a member answers 409", async () => {
    const r = rig();
    expect(await hillStateRoute(r.hill, null, { device: null, acceptEncoding: null }).json()).toEqual({ state: "here", at: null, by: null, told: null });
    for (const body of [{ state: "asleep" }, { state: "away", extra: 1 }, {}, "away"]) {
      expect(hillStateRoute(r.hill, { body }, { device: "Pixel 9", acceptEncoding: null }).status).toBe(400);
    }
    const ok = hillStateRoute(r.hill, { body: { state: "away" } }, { device: "Pixel 9", acceptEncoding: null });
    expect(await ok.json()).toEqual({ state: "away", at: r.clock, by: "Pixel 9", told: null });
    expect(r.audit).toContainEqual({ action: "hill.state", device: "Pixel 9", detail: { state: "away" } });
    r.mode = "peer";
    expect(hillStateRoute(r.hill, { body: { state: "here" } }, { device: "Pixel 9", acceptEncoding: null }).status).toBe(409);
  });

  test("the tell route takes `{ at }` and answers how many were told, or 409 with the words", async () => {
    const r = rig();
    posted(r.hill.post(sender(1), input(1)));
    r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    expect(hillTellRoute(r.hill, { at: "now" }, { device: "Pixel 9", acceptEncoding: null }).status).toBe(400);
    expect(await hillTellRoute(r.hill, { at: r.clock }, { device: "Pixel 9", acceptEncoding: null }).json()).toEqual({ told: 1 });
    const again = hillTellRoute(r.hill, { at: r.clock }, { device: "Pixel 9", acceptEncoding: null });
    expect(again.status).toBe(409);
    expect(await again.text()).toBe(HILL_TELL_DONE);
  });
});

describe("the crew state across a crew", () => {
  function link(answer: Awaited<ReturnType<HillLeadLink["call"]>>, older = false): HillLeadLink & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      call: async (route, payload) => {
        calls.push(`${route} ${payload}`);
        return answer;
      },
      leadName: () => "lodge",
      leadOlder: () => older,
      leadAtFloor: () => true,
    };
  }

  test("a member reads its lead's state over the op route; a lead too old to say is said plainly", async () => {
    const ok = link({ kind: "answer", status: 200, body: { ok: true, crewState: { state: "quiet", at: 5, by: "Pixel 9", told: null } } });
    expect(await new HillMemberForward(ok).state()).toEqual({ ok: true, crewState: { state: "quiet", at: 5, by: "Pixel 9", told: null } });
    expect(ok.calls).toEqual(['hill/op {"op":"state"}']);
    const old = new HillMemberForward(link({ kind: "answer", status: 400, body: { error: "a call is { op: status | withdraw | list, id?, as }" } }));
    expect(await old.state()).toEqual({ ok: false, error: "the lead (lodge) runs a Collie too old to say the crew state", older: true });
    expect(await new HillMemberForward(link({ kind: "answer", status: 200, body: {} }, true)).state()).toMatchObject({ ok: false, older: true });
  });

  test("the lead answers `state` for a signed member with no session named, and a forwarded post carries the state", () => {
    const r = rig();
    const lead = new HillCrewLead({ hill: r.hill, held: new HillHeldMedia() });
    expect(lead.op({ op: "state" }, "workshop")).toEqual({ status: 200, body: { ok: true, crewState: { state: "here", at: null, by: null, told: null } } });
    r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    r.live.push({ address: "workshop/%7#wwww", label: "repo#w", host: "workshop", unattended: false });
    const answer = lead.post({ from: { address: "workshop/%7#wwww", harness: "agent-x", label: "repo#w", host: "workshop" }, fields: { requestId: uuid(9), title: "Ship?", summary: "Green.", options: [{ intent: "yes", label: "Yes" }] } }, "workshop");
    expect(answer).toMatchObject({ status: 200, body: { ok: true, crewState: "away" } });
  });
});

test("a stray temp file is not read as the state", () => {
  const dir = tempState();
  mkdirSync(join(dir, "hill"), { recursive: true });
  writeFileSync(`${hillCrewStatePath(dir)}.99.tmp`, '{"v":1,"state":"away","at":1,"by":"x"}');
  expect(readHillCrewState(dir).view.state).toBe("here");
});
