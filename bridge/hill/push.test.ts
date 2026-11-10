import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { PUSH_LINE_MAX, PUSH_TITLE_MAX } from "../mux/durable/clean.ts";
import { hillTopic, type PushMessage } from "../push.ts";
import type { HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { HILL_PUSH_RATE, HillPush, hillPushMessage, hillPushTag, isHillPushTag, pushLine } from "./push.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HillService, type HillAgentSender, type HillPlace, type HillPostAnswer, type HillTrickSender } from "./service.ts";
import { HillStore } from "./store.ts";

// A `now` DECISION RINGS THE PHONE ONCE (hill/push.ts): when it pushes, what the push carries, the slot a
// supersede keeps, the clear when it closes, the rate, and the gates.

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const POSTER: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "desk" };
const PLACES: HillPlace[] = [{ address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false }];
const HOUR = HILL_PUSH_RATE.windowMs;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const trick = (trickId: string): HillTrickSender => ({ kind: "trick", trickId, trickKey: "ship", label: "Nightly", memberId: "desk-hc" });

interface Rig {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly pushes: PushMessage[];
  readonly audit: AuditEntry[];
  ready: boolean;
  clock: number;
}

function rig(dir: string | null = null): Rig {
  let n = 0;
  const pushes: PushMessage[] = [];
  const audit: AuditEntry[] = [];
  const state = { pushes, audit, ready: true, clock: 1000 };
  const store = new HillStore(dir, () => state.clock);
  const hill = new HillService({
    store,
    receipts: memoryHillReceipts(),
    place: (address) => PLACES.find((p) => p.address === address) ?? null,
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => state.clock,
    mintId: () => `dc_push${String((n += 1)).padStart(8, "0")}`,
    audit: (entry) => state.audit.push(entry),
    push: new HillPush({ ready: () => state.ready, send: (message) => state.pushes.push(message), now: () => state.clock }),
  });
  return Object.assign(state, { hill, store });
}

function input(n: number, over: Partial<HillPostInput> = {}): HillPostInput {
  return {
    requestId: uuid(n),
    title: "Ship the zoom fix in 1.28.1?",
    summary: "The pill moves out of Chat. The leg is green.",
    body: "The **whole** story, which never leaves the bridge.",
    options: [
      { intent: "ship", label: "Ship it", detail: "Tags 1.28.1" },
      { intent: "hold", label: "Hold" },
    ],
    priority: "now",
    ...over,
  };
}

function posted(answer: HillPostAnswer): string {
  if (!answer.ok) throw new Error(answer.error);
  return answer.decision.id;
}

const renders = (r: Rig): PushMessage[] => r.pushes.filter((p) => p.type === undefined);
const clears = (r: Rig): PushMessage[] => r.pushes.filter((p) => p.type === "clear");

describe("when a decision pushes", () => {
  test("a fresh now post pushes once: the title and the summary, a slot keyed on its id, the tap to its card", () => {
    const r = rig();
    const id = posted(r.hill.post(POSTER, input(1)));
    const tag = hillPushTag(id);
    expect(r.pushes).toEqual([{ title: "Ship the zoom fix in 1.28.1?", body: "The pill moves out of Chat. The leg is green.", tag, target: "hill", decision: id, topic: hillTopic(tag) }]);
    // Never the body, an option, a label or a view; and no title code, the words are the poster's.
    const wire = JSON.stringify(r.pushes[0]);
    for (const absent of ["whole", "Ship it", "Tags 1.28.1", "titleCode"]) expect(wire).not.toContain(absent);
  });

  test("today and later never push", () => {
    const r = rig();
    posted(r.hill.post(POSTER, input(1, { priority: "today" })));
    posted(r.hill.post(POSTER, input(2, { priority: "later" })));
    posted(r.hill.post(POSTER, input(3, { priority: undefined })));
    expect(r.pushes).toEqual([]);
    expect(r.store.all().every((d) => d.pushTag === undefined)).toBe(true);
  });

  test("a fourth open now of one sender is shown as today and does not push", () => {
    const r = rig();
    for (let n = 1; n <= 4; n += 1) posted(r.hill.post(POSTER, input(n)));
    expect(renders(r)).toHaveLength(3);
    expect(r.store.all().at(-1)?.priority).toBe("today");
  });

  test("a repeated request id answers the stored decision and pushes nothing again", () => {
    const r = rig();
    const id = posted(r.hill.post(POSTER, input(1)));
    expect(posted(r.hill.post(POSTER, input(1)))).toBe(id);
    expect(renders(r)).toHaveLength(1);
  });

  test("the slot is stored with the decision, survives a restart, and is never served", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-hill-push-"));
    roots.push(dir);
    const r = rig(dir);
    const answer = r.hill.post(POSTER, input(1));
    if (!answer.ok) throw new Error(answer.error);
    expect(answer.decision.pushTag).toBeUndefined();
    expect(r.hill.list().open[0]?.pushTag).toBeUndefined();
    const reread = new HillStore(dir, () => 2000);
    expect(reread.get(answer.decision.id)?.pushTag).toBe(hillPushTag(answer.decision.id));
  });
});

describe("the slot across a supersede, and the clear at the close", () => {
  test("a now supersede of a pushed now keeps its slot: one notification, replaced; the old one is not cleared", () => {
    const r = rig();
    const first = posted(r.hill.post(POSTER, input(1)));
    const second = posted(r.hill.post(POSTER, input(2, { summary: "The pill moves. CI is green too.", supersedes: first })));
    expect(renders(r).map((p) => [p.tag, p.decision, p.body])).toEqual([
      [hillPushTag(first), first, "The pill moves out of Chat. The leg is green."],
      [hillPushTag(first), second, "The pill moves. CI is green too."],
    ]);
    expect(clears(r)).toEqual([]);
  });

  test("a today supersede of a pushed now clears the notification; a now supersede of a today pushes in a new slot", () => {
    const r = rig();
    const first = posted(r.hill.post(POSTER, input(1)));
    const second = posted(r.hill.post(POSTER, input(2, { priority: "today", supersedes: first })));
    expect(clears(r)).toEqual([{ type: "clear", tag: hillPushTag(first), topic: hillTopic(hillPushTag(first)) }]);
    const third = posted(r.hill.post(POSTER, input(3, { supersedes: second })));
    expect(renders(r).map((p) => p.tag)).toEqual([hillPushTag(first), hillPushTag(third)]);
  });

  test("a withdraw, an answer, an expiry and an ended target each clear the slot once; a decision with none clears nothing", async () => {
    const r = rig();
    const withdrawn = posted(r.hill.post(POSTER, input(1)));
    r.hill.withdraw(POSTER, withdrawn);
    const answered = posted(r.hill.post(POSTER, input(2)));
    await r.hill.answer({ rid: uuid(90), node: `hill/${answered}`, intent: "ship", value: { text: null } }, answered, "Pixel 9");
    const expiring = posted(r.hill.post(POSTER, input(3, { expiresAt: 5000 })));
    const quiet = posted(r.hill.post(POSTER, input(4, { priority: "today", expiresAt: 5000 })));
    r.hill.sweep(5000);
    expect(r.store.get(quiet)?.state).toBe("expired");
    expect(clears(r).map((p) => p.tag)).toEqual([hillPushTag(withdrawn), hillPushTag(answered), hillPushTag(expiring)]);
    // A second close of a closed decision is no close: nothing more.
    r.hill.withdraw(POSTER, withdrawn);
    r.hill.sweep(9000);
    expect(clears(r)).toHaveLength(3);
  });
});

describe("the rate and the gates", () => {
  test(`past ${String(HILL_PUSH_RATE.perSender)} an hour from one sender the decision posts and shows, the push is skipped with one audit line`, () => {
    const r = rig();
    const ids: string[] = [];
    for (let n = 1; n <= HILL_PUSH_RATE.perSender + 1; n += 1) {
      const id = posted(r.hill.post(POSTER, input(n)));
      ids.push(id);
      r.hill.withdraw(POSTER, id);
    }
    expect(renders(r)).toHaveLength(HILL_PUSH_RATE.perSender);
    const last = ids.at(-1)!;
    expect(r.store.get(last)?.priority).toBe("now");
    expect(r.store.get(last)?.pushTag).toBeUndefined();
    expect(r.audit.filter((e) => e.action === "hill.push.skipped")).toEqual([{ action: "hill.push.skipped", detail: { decisionId: last, why: "more than 3 an hour from this sender" } }]);
    r.clock += HOUR;
    posted(r.hill.post(POSTER, input(50)));
    expect(renders(r)).toHaveLength(HILL_PUSH_RATE.perSender + 1);
  });

  test(`past ${String(HILL_PUSH_RATE.perMember)} an hour from the agents of one crew member together the push is skipped (CREW_PROTOCOL §22)`, () => {
    const r = rig();
    // Three sessions of one member, posting through this lead, two `now` decisions each, then one more.
    const panes = ["laptop/%1#aaaa", "laptop/%2#bbbb", "laptop/%3#cccc", "laptop/%4#dddd"];
    let n = 0;
    for (const address of panes) {
      const sender: HillAgentSender = { kind: "agent", address, memberId: "laptop", harness: "agent-x", label: "repo", host: "laptop" };
      const own: HillPlace = { address, label: "repo", host: "laptop", unattended: false };
      for (let i = 0; i < (address === panes[3] ? 1 : 2); i += 1) posted(r.hill.postDecision(sender, input((n += 1)), { own, images: [] }));
    }
    expect(renders(r)).toHaveLength(HILL_PUSH_RATE.perMember);
    expect(r.audit.filter((e) => e.action === "hill.push.skipped").map((e) => e.detail?.why)).toEqual(["more than 6 an hour from this machine"]);
    // Another member, and this lead's own session, still ring.
    const mini: HillAgentSender = { kind: "agent", address: "mini/%1#aaaa", memberId: "mini", harness: "agent-x", label: "repo", host: "mini" };
    posted(r.hill.postDecision(mini, input(90), { own: { address: mini.address, label: "repo", host: "mini", unattended: false }, images: [] }));
    posted(r.hill.post(POSTER, input(91)));
    expect(renders(r)).toHaveLength(HILL_PUSH_RATE.perMember + 2);
  });

  test(`past ${String(HILL_PUSH_RATE.total)} an hour from every sender together the push is skipped`, () => {
    const r = rig();
    for (let n = 1; n <= HILL_PUSH_RATE.total + 1; n += 1) posted(r.hill.postDecision(trick(`t${String(n)}`), input(n)));
    expect(renders(r)).toHaveLength(HILL_PUSH_RATE.total);
    expect(r.audit.filter((e) => e.action === "hill.push.skipped").map((e) => e.detail?.why)).toEqual(["more than 10 an hour in total"]);
  });

  test("a gate that is shut (push off, the switch off, snoozed) sends nothing, records no slot and writes no line", () => {
    const r = rig();
    r.ready = false;
    const id = posted(r.hill.post(POSTER, input(1)));
    expect(r.pushes).toEqual([]);
    expect(r.store.get(id)?.pushTag).toBeUndefined();
    expect(r.audit.some((e) => e.action === "hill.push.skipped")).toBe(false);
    // Nothing goes later either: a push is decided at the post, never after it.
    r.ready = true;
    r.hill.sweep(2000);
    expect(r.pushes).toEqual([]);
  });

  test("a now supersede held by a gate keeps the old notification's slot until the question closes", () => {
    const r = rig();
    const first = posted(r.hill.post(POSTER, input(1)));
    r.ready = false;
    const second = posted(r.hill.post(POSTER, input(2, { supersedes: first })));
    expect(renders(r)).toHaveLength(1);
    expect(clears(r)).toEqual([]);
    r.hill.withdraw(POSTER, second);
    expect(clears(r).map((p) => p.tag)).toEqual([hillPushTag(first)]);
  });
});

describe("the message", () => {
  test("one line each, cut to an ask push's lengths with an ellipsis", () => {
    const long = "word ".repeat(80);
    const message = hillPushMessage({ id: "dc_aaaaaaaaaaaa", title: long, summary: `First line.\n\nSecond   line. ${long}` }, hillPushTag("dc_aaaaaaaaaaaa"));
    expect([...(message.title ?? "")].length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
    expect([...(message.body ?? "")].length).toBeLessThanOrEqual(PUSH_LINE_MAX);
    expect(message.body?.startsWith("First line. Second line. word")).toBe(true);
    expect(message.body?.endsWith("…")).toBe(true);
    expect(pushLine("short", 10)).toBe("short");
  });

  test("the slot's shape", () => {
    expect(isHillPushTag(hillPushTag("dc_aaaaaaaaaaaa"))).toBe(true);
    expect(isHillPushTag("collie:hill:../etc")).toBe(false);
    expect(isHillPushTag("collie:herd")).toBe(false);
  });
});
