import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../json.ts";
import { askInput, askRig, ONE, posted, TWO, uuid, type AskRig } from "./ask-rig.ts";
import { ASK_CHECK_LIFT_MAX_MS, AskCheckBook, askCheckWait } from "./check.ts";
import type { HillLeadForward } from "./crew.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { ASK_KEEP_MEMBER, HillService } from "./service.ts";
import { HillStore } from "./store.ts";

// The check at the end of a turn (.adr/0177): the bridge's decision (`askCheck`), the keep, and the lift of a
// pane while its check runs. The hook verb that asks for the decision is tested in cli/ask-check.test.ts.

const PANE = { session: "main", paneId: "%1" };
const PANE_TWO = { session: "main", paneId: "%2" };

interface CheckRig extends AskRig {
  book: AskCheckBook;
  flags: { on: boolean };
}

function rig(): CheckRig {
  let book!: AskCheckBook;
  const flags = { on: true };
  const r = askRig(memoryHillReceipts(), (clock) => {
    book = new AskCheckBook(clock);
    return { checks: book, hillSwitch: { on: () => flags.on } };
  });
  return Object.assign(r, { book, flags });
}

/** A new operator turn in the pane: a prompt edge at the rig's clock, then the clock moves on. */
function prompt(r: CheckRig, where = PANE): void {
  r.book.edge(where.session, where.paneId, "prompt", r.clock);
  r.clock += 1000;
}

function check(r: CheckRig, sender = ONE, where = PANE) {
  return r.hill.askCheck(sender, where);
}

function fields(n: number, over: JsonObject = {}): JsonObject {
  return {
    requestId: uuid(n),
    title: `Ship the fix on Edge first, round ${String(n)}?`,
    summary: "Green.",
    options: [
      { intent: "edge", label: "Ship it on Edge first", detail: "Testers." },
      { intent: "stable", label: "Ship it on Stable now", detail: "Everyone." },
    ],
    ask: { words: false, files: [] },
    ...over,
  };
}

/** Two asks posted before the turn in which the check runs. */
function twoOld(r: CheckRig): string[] {
  const ids = [posted(r.hill.post(ONE, askInput(1))).id, posted(r.hill.post(ONE, askInput(2))).id];
  r.clock += 1000;
  return ids;
}

describe("the bridge's decision", () => {
  test("lists the open asks, oldest first, once in a turn", () => {
    const r = rig();
    const ids = twoOld(r);
    prompt(r);
    const first = check(r);
    expect(first).toEqual({ kind: "check", asks: ids.map((id, n) => ({ id, title: `Ship the fix on Edge first, round ${String(n + 1)}?`, at: 1000 })) });
    expect(check(r)).toEqual({ kind: "none", why: "checked" });
  });

  test("two hook processes at the same moment: one check, the other none", async () => {
    const r = rig();
    twoOld(r);
    prompt(r);
    const both = await Promise.all([Promise.resolve().then(() => check(r)), Promise.resolve().then(() => check(r))]);
    expect(both.map((answer) => answer.kind).toSorted()).toEqual(["check", "none"]);
  });

  test("no open asks: none, and no model step", () => {
    const r = rig();
    prompt(r);
    expect(check(r)).toEqual({ kind: "none", why: "no_asks" });
  });

  test("no turn known (no prompt edge since the bridge started): none", () => {
    const r = rig();
    twoOld(r);
    expect(check(r)).toEqual({ kind: "none", why: "no_turn" });
  });

  test("the Hill switched off: none; on again: a check", () => {
    const r = rig();
    twoOld(r);
    prompt(r);
    r.flags.on = false;
    expect(check(r)).toEqual({ kind: "none", why: "off" });
    r.flags.on = true;
    expect(check(r).kind).toBe("check");
  });

  test("an ask posted in this turn is not listed; with only such asks, none", () => {
    const r = rig();
    const old = posted(r.hill.post(ONE, askInput(1))).id;
    r.clock += 1000;
    prompt(r);
    posted(r.hill.post(ONE, askInput(2)));
    const answer = check(r);
    expect(answer.kind === "check" ? answer.asks.map((ask) => ask.id) : []).toEqual([old]);

    const fresh = rig();
    prompt(fresh);
    posted(fresh.hill.post(ONE, askInput(1)));
    expect(check(fresh)).toEqual({ kind: "none", why: "touched" });
  });

  test("an ask kept or replaced in this turn counts as confirmed", async () => {
    const r = rig();
    const [a, b] = twoOld(r);
    prompt(r);
    expect(r.hill.askKeep(ONE, [a!]).ok).toBe(true);
    const replaced = await r.hill.askPost(ONE, fields(3, { supersedes: b! }));
    if (!replaced.ok) throw new Error(replaced.error);
    expect(replaced.decision.ask?.confirmedAt).toBe(r.clock);
    expect(check(r)).toEqual({ kind: "none", why: "touched" });
  });

  test("only the session's own asks, and only for the pane's own turn", () => {
    const r = rig();
    posted(r.hill.post(TWO, askInput(1)));
    r.clock += 1000;
    prompt(r);
    expect(check(r)).toEqual({ kind: "none", why: "no_asks" });
    expect(check(r, TWO, PANE_TWO)).toEqual({ kind: "none", why: "no_turn" });
  });

  test("a crew member answers none: its asks are on the lead", () => {
    const forward: HillLeadForward = {
      post: async () => ({ ok: false, code: null, error: "x" }),
      one: async () => ({ ok: false, missing: true, error: "x" }),
      list: async () => ({ ok: true, decisions: [] }),
      state: async () => ({ ok: false, error: "x" }),
    };
    const book = new AskCheckBook(() => 5000);
    book.edge(PANE.session, PANE.paneId, "prompt", 1000);
    const member = new HillService({ store: new HillStore(null, () => 5000), receipts: memoryHillReceipts(), place: () => null, send: async () => "typed", crewMode: () => "peer", walkyOn: () => true, memberId: "m_bbbbbbbbbb", machine: "member", forward, checks: book });
    expect(member.askCheck(ONE, PANE)).toEqual({ kind: "none", why: "off" });
    expect(member.askKeep(ONE, ["ak_aaaaaaaaaaaa"])).toEqual({ ok: false, error: ASK_KEEP_MEMBER });
  });

  test("a bridge without the book, and an error inside, answer none", () => {
    const plain = askRig();
    expect(plain.hill.askCheck(ONE, PANE)).toEqual({ kind: "none", why: "off" });
    const r = rig();
    twoOld(r);
    prompt(r);
    r.book.decide = () => {
      throw new Error("boom");
    };
    expect(check(r)).toEqual({ kind: "none", why: "error" });
  });

  test("a restart forgives: a new book knows no turn, then checks at the next prompt", () => {
    const r = rig();
    twoOld(r);
    prompt(r);
    expect(check(r).kind).toBe("check");
    // A restarted bridge: the same store, a new book.
    const book = new AskCheckBook(() => r.clock);
    const again = new HillService({ store: r.store, receipts: memoryHillReceipts(), place: () => null, send: async () => "typed", crewMode: () => "solo", walkyOn: () => true, memberId: "m_aaaaaaaaaa", machine: "desk", now: () => r.clock, checks: book });
    expect(again.askCheck(ONE, PANE)).toEqual({ kind: "none", why: "no_turn" });
    book.edge(PANE.session, PANE.paneId, "prompt", r.clock);
    r.clock += 1000;
    expect(again.askCheck(ONE, PANE).kind).toBe("check");
  });
});

describe("the brake", () => {
  test("ignored checks come 1, 2, 4, 8, 8 turns apart", () => {
    const r = rig();
    twoOld(r);
    const checkedTurns: number[] = [];
    for (let turn = 1; turn <= 30; turn += 1) {
      prompt(r);
      if (check(r).kind === "check") checkedTurns.push(turn);
    }
    const gaps = checkedTurns.slice(1).map((turn, n) => turn - checkedTurns[n]!);
    expect(checkedTurns[0]).toBe(1);
    expect(gaps).toEqual([2, 4, 8, 8]);
    expect([0, 1, 2, 3, 4, 9].map(askCheckWait)).toEqual([1, 2, 4, 8, 8, 8]);
  });

  test("a check followed by a keep is not ignored: the next turn checks again", () => {
    const r = rig();
    const [a, b] = twoOld(r);
    for (let turn = 1; turn <= 4; turn += 1) {
      prompt(r);
      expect(check(r).kind).toBe("check");
      r.clock += 10;
      expect(r.hill.askKeep(ONE, [a!, b!]).ok).toBe(true);
      r.clock += 1000;
    }
  });

  test("any ask verb resets it: a cancel, and a post", async () => {
    const r = rig();
    const [a] = twoOld(r);
    prompt(r);
    expect(check(r).kind).toBe("check");
    prompt(r);
    expect(check(r)).toEqual({ kind: "none", why: "backoff" });
    expect((await r.hill.askCancel(ONE, a!, { answered: false, because: null })).ok).toBe(true);
    prompt(r);
    expect(check(r).kind).toBe("check");
    prompt(r);
    expect(check(r)).toEqual({ kind: "none", why: "backoff" });
    expect((await r.hill.askPost(ONE, fields(9))).ok).toBe(true);
    r.clock += 1000;
    prompt(r);
    expect(check(r).kind).toBe("check");
  });
});

describe("keep", () => {
  test("sets confirmedAt on each of several ids, and saves it", () => {
    const r = rig();
    const [a, b] = twoOld(r);
    r.clock = 7000;
    const kept = r.hill.askKeep(ONE, [a!, b!, a!]);
    expect(kept.ok && kept.decisions.map((decision) => [decision.id, decision.ask?.confirmedAt])).toEqual([
      [a, 7000],
      [b, 7000],
    ]);
    expect(r.store.get(a!)?.ask?.confirmedAt).toBe(7000);
  });

  test("refuses, whole, a foreign, a closed or an unknown id, and names it", async () => {
    const r = rig();
    const [a] = twoOld(r);
    const theirs = posted(r.hill.post(TWO, askInput(5))).id;
    expect(r.hill.askKeep(ONE, [a!, theirs])).toEqual({ ok: false, error: `${theirs} is not an ask of this session` });
    expect(r.store.get(a!)?.ask?.confirmedAt).toBeUndefined();
    expect(r.hill.askKeep(ONE, ["ak_zzzzzzzzzzzz"])).toEqual({ ok: false, error: "ak_zzzzzzzzzzzz is not an ask of this session" });
    await r.hill.askCancel(ONE, a!, { answered: true, because: null });
    expect(r.hill.askKeep(ONE, [a!])).toEqual({ ok: false, error: `${a!} is withdrawn, only an open ask can be kept` });
    const plain = posted(r.hill.post(ONE, { ...askInput(6), ask: undefined }));
    expect(r.hill.askKeep(ONE, [plain.id]).ok).toBe(false);
  });
});

describe("the pane's state during a check", () => {
  test("lifts the pane from the answer until the check's own stop, when the first stop came first", () => {
    const r = rig();
    twoOld(r);
    prompt(r);
    // The stop that runs the check: the emitter's edge reaches the bridge before the check asks.
    r.book.edge(PANE.session, PANE.paneId, "stop", r.clock);
    r.clock += 200;
    expect(check(r).kind).toBe("check");
    expect(r.book.lifting(PANE.session, PANE.paneId)).toBe(true);
    r.clock += 4000;
    r.book.edge(PANE.session, PANE.paneId, "stop", r.clock);
    expect(r.book.lifting(PANE.session, PANE.paneId)).toBe(false);
  });

  test("when the check asks first, the stop that ran it does not end the lift; the check's own does", () => {
    const r = rig();
    twoOld(r);
    prompt(r);
    expect(check(r).kind).toBe("check");
    r.clock += 100;
    r.book.edge(PANE.session, PANE.paneId, "stop", r.clock);
    expect(r.book.lifting(PANE.session, PANE.paneId)).toBe(true);
    r.clock += 5000;
    r.book.edge(PANE.session, PANE.paneId, "stop", r.clock);
    expect(r.book.lifting(PANE.session, PANE.paneId)).toBe(false);
  });

  test("a new prompt, an end edge or the time cap end it; a none lifts nothing", () => {
    const r = rig();
    twoOld(r);
    prompt(r);
    check(r);
    prompt(r);
    expect(r.book.lifting(PANE.session, PANE.paneId)).toBe(false);

    const none = rig();
    prompt(none);
    expect(check(none).kind).toBe("none");
    expect(none.book.lifting(PANE.session, PANE.paneId)).toBe(false);

    const capped = rig();
    twoOld(capped);
    prompt(capped);
    check(capped);
    capped.clock += ASK_CHECK_LIFT_MAX_MS;
    expect(capped.book.lifting(PANE.session, PANE.paneId)).toBe(false);

    const ended = rig();
    twoOld(ended);
    prompt(ended);
    check(ended);
    ended.book.edge(PANE.session, PANE.paneId, "end", ended.clock);
    expect(ended.book.lifting(PANE.session, PANE.paneId)).toBe(false);
    expect(ended.book.turn(PANE.session, PANE.paneId)).toBeNull();
  });
});
