import { describe, expect, test } from "bun:test";

import { ASK_REMIND_MATCH_MS, ASK_REMIND_OWN_KEEP_MS, AskRemindBook } from "./remind.ts";

// The book of the reminder that rides on the prompt (.adr/0178): a hand-out is paired with its prompt edge by
// the prompt's hash and by time, in either order; a stop confirms the newest turn's hand-out once; the
// bridge's own prompts answer once; the short form needs the same set as last time.

const A = "local/%1#aaaa";

function book(start = 1_000_000) {
  const clock = { now: start };
  return { book: new AskRemindBook(() => clock.now), clock };
}

describe("pairing a hand-out with its prompt", () => {
  test("the hand-out first, then the prompt edge: the stop confirms it once", () => {
    const { book: b } = book();
    b.handOut("main", "%1", { address: A, hash: "h1", at: 100, ids: ["ak_a"] });
    b.prompt("main", "%1", 105, "h1");
    expect(b.stop("main", "%1", 900)?.ids).toEqual(["ak_a"]);
    expect(b.stop("main", "%1", 950)).toBeNull();
  });

  test("the prompt edge first, then the hand-out: paired the same", () => {
    const { book: b } = book();
    b.prompt("main", "%1", 100, "h1");
    b.handOut("main", "%1", { address: A, hash: "h1", at: 104, ids: ["ak_a", "ak_b"] });
    expect(b.stop("main", "%1", 900)?.ids).toEqual(["ak_a", "ak_b"]);
  });

  test("another hash, too far apart in time, or no hash at all: never paired", () => {
    const { book: b } = book();
    b.handOut("main", "%1", { address: A, hash: "h1", at: 100, ids: ["ak_a"] });
    b.prompt("main", "%1", 105, "h2");
    expect(b.stop("main", "%1", 900)).toBeNull();
    b.handOut("main", "%1", { address: A, hash: "h3", at: 1000, ids: ["ak_a"] });
    b.prompt("main", "%1", 1000 + ASK_REMIND_MATCH_MS + 1, "h3");
    expect(b.stop("main", "%1", 90_000)).toBeNull();
    b.handOut("main", "%1", { address: A, hash: null, at: 100_000, ids: ["ak_a"] });
    b.prompt("main", "%1", 100_001, null);
    expect(b.stop("main", "%1", 100_500)).toBeNull();
  });

  test("a prompt with no hand-out (a hook fault, no hooks): its stop confirms nothing", () => {
    const { book: b } = book();
    b.prompt("main", "%1", 100, "h1");
    expect(b.stop("main", "%1", 500)).toBeNull();
  });

  test("Escape sends no stop: the next turn without a hand-out confirms nothing of the old one", () => {
    const { book: b } = book();
    b.handOut("main", "%1", { address: A, hash: "h1", at: 100, ids: ["ak_a"] });
    b.prompt("main", "%1", 100, "h1");
    // Escape: no stop. Then a new prompt with no hand-out.
    b.prompt("main", "%1", 5000, "h2");
    expect(b.stop("main", "%1", 6000)).toBeNull();
  });

  test("a hand-out newer than the known turn waits unpaired: the stop does not confirm the old turn", () => {
    const { book: b } = book();
    b.handOut("main", "%1", { address: A, hash: "h1", at: 100, ids: ["ak_a"] });
    b.prompt("main", "%1", 100, "h1");
    // The next prompt's hand-out came, its edge was lost.
    b.handOut("main", "%1", { address: A, hash: "h2", at: 60_000, ids: ["ak_a"] });
    expect(b.stop("main", "%1", 61_000)).toBeNull();
  });

  test("panes and sessions are apart; a start or an end resets the turn", () => {
    const { book: b } = book();
    b.handOut("main", "%1", { address: A, hash: "h1", at: 100, ids: ["ak_a"] });
    b.prompt("other", "%1", 100, "h1");
    expect(b.stop("other", "%1", 500)).toBeNull();
    b.prompt("main", "%1", 100, "h1");
    b.reset("main", "%1");
    expect(b.stop("main", "%1", 500)).toBeNull();
  });
});

describe("the bridge's own prompts", () => {
  test("a typed hash answers once, in its pane only, and not after the keep time", () => {
    const { book: b, clock } = book();
    b.typedOwn("main", "%1", "own1", 777);
    expect(b.takeOwn("main", "%2", "own1")).toBeNull();
    expect(b.takeOwn("main", "%1", "nope")).toBeNull();
    expect(b.takeOwn("main", "%1", "own1")).toEqual({ composedAt: 777 });
    expect(b.takeOwn("main", "%1", "own1")).toBeNull();
    b.typedOwn("main", "%1", "own2", 1);
    clock.now += ASK_REMIND_OWN_KEEP_MS + 1;
    expect(b.takeOwn("main", "%1", "own2")).toBeNull();
  });
});

describe("the short form", () => {
  test("the same set as last time is short; a new set, a cleared session, or the switch off is full", () => {
    const { book: b } = book();
    expect(b.form(A, ["ak_a", "ak_b"])).toBe("full");
    expect(b.form(A, ["ak_b", "ak_a"])).toBe("short");
    expect(b.form(A, ["ak_a"])).toBe("full");
    expect(b.form(A, ["ak_a"], false)).toBe("full");
    b.forget(A);
    expect(b.form(A, ["ak_a"])).toBe("full");
    b.shown("local/%2#bbbb", ["ak_c"]);
    expect(b.form("local/%2#bbbb", ["ak_c"])).toBe("short");
  });
});
