import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Ask } from "../types.ts";
import { AskPush, type AskPushPane } from "./ask-push.ts";
import { AskGuardStore, decideAsks, GUARD_FILE, openCap, type GuardAsk, type GuardDecision, type GuardEntry } from "./guard.ts";

// The push guard for asks that travel as data (ADR 0100), ported from the durable-member spike's
// lead guard and its tests. The decisions are the spike's: 3 pushes per pane per minute, 10 per host,
// 5 shown per pane, and a re-raised question is shown, not pushed. Two things changed on the way in:
// the key is `(host, toolCallId)` (the spike keyed on pane and tool item), and the memory is a file
// in the state dir, so a bridge restart pushes nothing twice.

const H = "laptop";
const START = 1_000_000;

let n = 0;
function ask(over: Partial<GuardAsk> = {}): GuardAsk {
  n += 1;
  return { id: `ask-${String(n)}`, toolCallId: `call-${String(n)}`, ...over };
}

/** An ask in the phone's shape, as a pane carries it. */
function wireAsk(id: string, toolCallId: string): Ask {
  return { id, kind: "permission", toolCallId, revision: 1, title: "t", itemId: "i", options: [{ id: "allow", label: "Allow", effect: "allow" }] };
}

/** A guard with a fake clock and no file. */
function guard() {
  let now = START;
  const store = new AskGuardStore(null);
  const decide = (paneId: string, asks: readonly GuardAsk[], host = H): GuardDecision[] =>
    [...(store.observe(host, [{ paneId, asks }], now).get(paneId) ?? [])].map((v) => v.decision);
  return { store, decide, tick: (ms: number) => (now += ms), now: () => now };
}

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-guard-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("decisions", () => {
  test("a first ask on a quiet pane is pushed", () => {
    expect(guard().decide("p", [ask()])).toEqual(["push"]);
  });

  test("the same ask seen again on the next poll is shown, not pushed again", () => {
    const g = guard();
    const a = ask();
    expect(g.decide("p", [a])).toEqual(["push"]);
    expect(g.decide("p", [a])).toEqual(["show-quiet"]);
    expect(g.decide("p", [a])).toEqual(["show-quiet"]);
  });

  test("re-ask: the same tool call id under a new ask id is shown, not pushed, even after it closed", () => {
    const g = guard();
    const first = ask({ toolCallId: "call-x" });
    expect(g.decide("p", [first])).toEqual(["push"]);
    // The program restarted: for a while the pane shows no ask, then raises the same call again.
    expect(g.decide("p", [])).toEqual([]);
    const again = ask({ toolCallId: "call-x" });
    expect(again.id).not.toBe(first.id);
    expect(g.decide("p", [again])).toEqual(["show-quiet"]);
    expect(g.decide("p", [again])).toEqual(["show-quiet"]);
    // Another call is a new question.
    expect(g.decide("p", [again, ask({ toolCallId: "call-y" })])).toEqual(["show-quiet", "push"]);
  });

  test("re-ask: the key is (host, toolCallId), so the same call on another host is a new question", () => {
    const g = guard();
    expect(g.decide("p", [ask({ toolCallId: "same" })], "laptop")).toEqual(["push"]);
    expect(g.decide("p", [ask({ toolCallId: "same" })], "desktop")).toEqual(["push"]);
  });

  test("caps: 3 pushes per pane per minute, the fourth is quiet, and the window slides", () => {
    const g = guard();
    const open: GuardAsk[] = [];
    const next = (): GuardDecision => {
      // Each new ask arrives alone, so the open cap is not what this test is about.
      const a = ask();
      open.push(a);
      return g.decide("p", [a]).at(-1)!;
    };
    expect([next(), next(), next(), next()]).toEqual(["push", "push", "push", "show-quiet"]);
    g.tick(59_999);
    expect(next()).toBe("show-quiet");
    g.tick(2); // the first three pushes are now older than a minute
    expect([next(), next(), next(), next()]).toEqual(["push", "push", "push", "show-quiet"]);
  });

  test("caps: 10 pushes per host per minute across panes, and another host has its own budget", () => {
    const g = guard();
    const decisions: GuardDecision[] = [];
    for (const pane of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 3; i++) decisions.push(g.decide(pane, [ask()]).at(-1)!);
    }
    expect(decisions.filter((d) => d === "push")).toHaveLength(10);
    expect(decisions.slice(-2)).toEqual(["show-quiet", "show-quiet"]);
    expect(g.decide("a", [ask()], "other-host")).toEqual(["push"]);
    g.tick(60_001);
    expect(g.decide("e", [ask()])).toEqual(["push"]);
  });

  test("caps: 5 shown per pane, the rest dropped; a close frees a slot and the oldest dropped is promoted, quietly", () => {
    const g = guard();
    const asks = Array.from({ length: 8 }, () => ask());
    expect(g.decide("p", asks)).toEqual(["push", "push", "push", "show-quiet", "show-quiet", "drop", "drop", "drop"]);
    // Delivered again: nothing moves, nothing is pushed twice.
    expect(g.decide("p", asks)).toEqual(["show-quiet", "show-quiet", "show-quiet", "show-quiet", "show-quiet", "drop", "drop", "drop"]);
    // The first one is answered. The sixth takes its slot, shown but not pushed: it was decided as a
    // drop when it was first seen, and only that first decision may push.
    g.tick(120_000);
    expect(g.decide("p", asks.slice(1))).toEqual(["show-quiet", "show-quiet", "show-quiet", "show-quiet", "show-quiet", "drop", "drop"]);
    // A brand new ask, with a free slot and the window clear, is pushed.
    expect(g.decide("p", [...asks.slice(1, 4), ask()])).toEqual(["show-quiet", "show-quiet", "show-quiet", "push"]);
  });

  test("caps: a hostile burst of 50 asks on one pane gives 3 pushes, 2 quiet, 45 dropped", () => {
    const g = guard();
    const burst = Array.from({ length: 50 }, (_, i) => ask({ toolCallId: `burst-${String(i)}` }));
    const out = g.decide("p", burst);
    const count = (d: GuardDecision) => out.filter((x) => x === d).length;
    expect([count("push"), count("show-quiet"), count("drop")]).toEqual([3, 2, 45]);
    // The five shown are the five oldest.
    expect(out.slice(0, 5)).toEqual(["push", "push", "push", "show-quiet", "show-quiet"]);
    // Polled again and again: still 3 pushes in all.
    for (let i = 0; i < 5; i++) expect(g.decide("p", burst).filter((x) => x === "push")).toHaveLength(0);
  });

  test("an ask twice in one list is one question", () => {
    const a = ask();
    expect(guard().decide("p", [a, { ...a, id: "other-id" }])).toEqual(["push"]);
  });

  test("a key closed more than a day ago is forgotten; inside the day it is still known", () => {
    const g = guard();
    const a = ask({ toolCallId: "call-day" });
    expect(g.decide("p", [a])).toEqual(["push"]);
    g.decide("p", []); // closed now
    g.tick(23 * 60 * 60 * 1000);
    expect(g.decide("q", [])).toEqual([]);
    expect(g.store.remembered().map((e) => e.toolCallId)).toEqual(["call-day"]);
    g.tick(2 * 60 * 60 * 1000);
    g.decide("q", []);
    expect(g.store.remembered()).toEqual([]);
  });

  test("decideAsks is pure: it never changes the memory it is given", () => {
    const remembered: GuardEntry[] = [{ host: H, toolCallId: "c", paneId: "p", askId: "a", firstSeenAt: START, pushedAt: START }];
    const frozen = JSON.stringify(remembered);
    const result = decideAsks(remembered, H, [{ paneId: "p", asks: [] }], START + 1);
    expect(JSON.stringify(remembered)).toBe(frozen);
    expect(result.changed).toBe(true);
    expect(result.entries[0]?.closedAt).toBe(START + 1);
  });

  test("openCap lists the five oldest and counts the rest", () => {
    expect(openCap([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(openCap([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
  });
});

describe("the memory on disk", () => {
  test("restart: a bridge restart pushes nothing twice", () => {
    const dir = stateDir();
    const first = new AskGuardStore(dir);
    first.load();
    const a = ask({ toolCallId: "call-disk" });
    expect(first.observe(H, [{ paneId: "p", asks: [a] }], START).get("p")?.[0]?.decision).toBe("push");

    const second = new AskGuardStore(dir);
    second.load();
    expect(second.observe(H, [{ paneId: "p", asks: [a] }], START + 5_000).get("p")?.[0]?.decision).toBe("show-quiet");
    // And the program restarted too: the same call under a new ask id, after the bridge restart.
    const third = new AskGuardStore(dir);
    third.load();
    const reasked = { ...a, id: "ask-after-restart" };
    expect(third.observe(H, [{ paneId: "p", asks: [reasked] }], START + 10_000).get("p")?.[0]?.decision).toBe("show-quiet");
  });

  test("restart: the push rate holds across a bridge restart", () => {
    const dir = stateDir();
    const first = new AskGuardStore(dir);
    first.load();
    const three = [ask(), ask(), ask()];
    expect([...(first.observe(H, [{ paneId: "p", asks: three }], START).get("p") ?? [])].map((v) => v.decision)).toEqual(["push", "push", "push"]);
    const second = new AskGuardStore(dir);
    second.load();
    const fourth = ask();
    expect(second.observe(H, [{ paneId: "p", asks: [...three, fourth] }], START + 1_000).get("p")?.[3]).toMatchObject({ decision: "show-quiet", why: "pane rate" });
  });

  test("the file is owner-only, and nothing is written until a pane carries an ask", () => {
    const dir = stateDir();
    const store = new AskGuardStore(dir);
    store.load();
    store.observe(H, [], START);
    store.observe(H, [{ paneId: "p", asks: [] }], START);
    expect(existsSync(join(dir, GUARD_FILE))).toBe(false);
    store.observe(H, [{ paneId: "p", asks: [ask()] }], START);
    const file = join(dir, GUARD_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved: { entries: GuardEntry[] } = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.entries).toHaveLength(1);
    expect(Object.keys(saved.entries[0] ?? {}).toSorted()).toEqual(["askId", "firstSeenAt", "host", "paneId", "pushedAt", "toolCallId"]);
  });

  test("a broken file is an empty memory, and is not trusted", () => {
    const dir = stateDir();
    writeFileSync(join(dir, GUARD_FILE), "{not json");
    const store = new AskGuardStore(dir);
    store.load();
    expect(store.remembered()).toEqual([]);
  });

  test("a host that left closes its keys, which are forgotten a day later", () => {
    const store = new AskGuardStore(null);
    store.observe(H, [{ paneId: "p", asks: [ask()] }], START);
    store.forgetHost(H, START + 1);
    expect(store.remembered()[0]?.closedAt).toBe(START + 1);
    store.observe("other", [], START + 2 + 24 * 60 * 60 * 1000);
    expect(store.remembered()).toEqual([]);
  });
});

describe("the push path", () => {
  test("only a pane that carries asks holds its way into blocked", () => {
    expect(AskPush.holds({ asks: [] }, "blocked")).toBe(true);
    expect(AskPush.holds({ asks: [] }, "idle")).toBe(false);
    expect(AskPush.holds({ asks: [] }, "done")).toBe(false);
    expect(AskPush.holds({}, "blocked")).toBe(false);
    expect(AskPush.holds({ asks: undefined }, "blocked")).toBe(false);
  });

  test("a pane is raised once per observation with a push, and never for a re-ask", () => {
    let now = START;
    const push = new AskPush(new AskGuardStore(null), () => now);
    const raised: string[] = [];
    const raise = (pane: AskPushPane) => raised.push(pane.paneId);
    const a = wireAsk("a1", "c1");
    const b = wireAsk("b1", "c2");
    const panes: AskPushPane[] = [{ paneId: "p", asks: [a, b] }, { paneId: "shell" }];
    push.observe(H, panes, raise);
    expect(raised).toEqual(["p"]);
    now += 1_000;
    push.observe(H, panes.slice(0, 1), raise);
    expect(raised).toEqual(["p"]);
    // The program restarted: new ask ids for the same calls.
    now += 1_000;
    const reasked: AskPushPane[] = [{ paneId: "p", asks: [{ ...a, id: "a2" }, { ...b, id: "b2" }] }];
    push.observe(H, reasked, raise);
    expect(raised).toEqual(["p"]);
  });

  test("an ask from a link that cannot be keyed pushes nothing", () => {
    const push = new AskPush(new AskGuardStore(null), () => START);
    const raised: string[] = [];
    // What a broken or hostile member can put in `asks`: the merge keeps it whole, the type is a claim.
    const hostile: Ask[] = JSON.parse('[null, 7, {"id": "x"}, {"id": "y", "toolCallId": ""}, {"id": 3, "toolCallId": "c"}]');
    const panes: AskPushPane[] = [{ paneId: "p", asks: hostile }];
    push.observe(H, panes, (pane) => raised.push(pane.paneId));
    expect(raised).toEqual([]);
  });
});
