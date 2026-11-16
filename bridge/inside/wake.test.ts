// Wake and state from a part's events (M99 spec 04): a turn event is a state edge and a poke, a row
// is a poke, and no event ever gives an item.

import { describe, expect, test } from "bun:test";

import { applyWake, releasesHeld, wakeEdgeOf, type WakeSink } from "./wake.ts";
import type { WireEvent } from "./wire.ts";

const PART = "p".repeat(22);

function sink() {
  const calls: string[] = [];
  const s: WakeSink = {
    edge: (paneId, kind, at) => calls.push(`edge ${paneId} ${kind} ${at}`),
    poke: () => calls.push("poke"),
  };
  return { s, calls };
}

describe("wake from events", () => {
  test("turn.start folds the prompt edge (working) and pokes the read", () => {
    const { s, calls } = sink();
    expect(applyWake(s, "%1", { ok: true, part: PART, kind: "turn.start", turn: "t1", seq: null }, 5)).toBe(true);
    expect(calls).toEqual(["edge %1 prompt 5", "poke"]);
  });

  test("turn.end folds the stop edge (idle) and pokes the read", () => {
    const { s, calls } = sink();
    applyWake(s, "%1", { ok: true, part: PART, kind: "turn.end", turn: "t1", reason: null, seq: null }, 6);
    expect(calls).toEqual(["edge %1 stop 6", "poke"]);
  });

  test("a row only pokes: the session file gives the item, never the event", () => {
    const { s, calls } = sink();
    applyWake(s, "%1", { ok: true, part: PART, kind: "row", door: "assistant", row: "secret text the part must not carry" }, 7);
    expect(calls).toEqual(["poke"]);
    expect(calls.join(" ")).not.toContain("secret");
  });

  test("ask and command events wake nothing here", () => {
    const events: WireEvent[] = [
      { ok: true, part: PART, kind: "ask.open", ask: "a1", askKind: "permission", tool: "Bash", input: { command: "ls" } },
      { ok: true, part: PART, kind: "ask.close", ask: "a1", how: null },
      { ok: true, part: PART, kind: "sent", cmd: "c1" },
      { ok: true, part: PART, kind: "failed", cmd: "c1", reason: null, detail: null },
      { ok: true, part: PART, kind: "draft", cmd: "c1", text: "hello", caret: null },
    ];
    for (const event of events) {
      const { s, calls } = sink();
      expect(applyWake(s, "%1", event, 1)).toBe(false);
      expect(calls).toEqual([]);
      expect(wakeEdgeOf(event)).toBeNull();
    }
  });

  test("the sink has no door for an item: only a state edge and a poke", () => {
    const { s } = sink();
    expect(Object.keys(s).toSorted()).toEqual(["edge", "poke"]);
  });
});

describe("what releases a held send (spec 03 and spec 05)", () => {
  const draft = (present: boolean): WireEvent => ({ ok: true, part: PART, kind: "draft.state", present, seq: null });
  test("a turn end always; a draft that went only while the turn is known; a draft that came never", () => {
    expect(releasesHeld({ ok: true, part: PART, kind: "turn.end", turn: null, reason: null, seq: null }, null)).toBe(true);
    expect(releasesHeld(draft(false), "idle")).toBe(true);
    expect(releasesHeld(draft(false), "running")).toBe(true);
    expect(releasesHeld(draft(false), null)).toBe(false);
    expect(releasesHeld(draft(true), "idle")).toBe(false);
    expect(releasesHeld({ ok: true, part: PART, kind: "turn.start", turn: null, seq: null }, "running")).toBe(false);
  });

  test("a draft.state event wakes nothing and folds no edge", () => {
    const { s, calls } = sink();
    expect(applyWake(s, "w1:p1", draft(true), 1)).toBe(false);
    expect(calls).toEqual([]);
  });
});
