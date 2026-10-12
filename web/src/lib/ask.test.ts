import { describe, expect, it } from "vitest";

import {
  answerable,
  answered,
  asksAt,
  blockOf,
  freshCard,
  MAX_ASK_OPTIONS,
  optionTone,
  parseAsk,
  polled,
  tapped,
  visibleOptions,
} from "./ask";
import type { Ask, AskOption } from "./types";

// The ask card's rules (ADR 0100), as tables. Nothing here renders anything or sends anything.

function option(id: string, effect: AskOption["effect"] = "allow"): AskOption {
  return { id, label: `Option ${id}`, effect };
}

function ask(over: Partial<Ask> = {}): Ask {
  return {
    id: "ask-1",
    kind: "permission",
    toolCallId: "call-1",
    revision: 1,
    title: "Run a command?",
    itemId: "item-1",
    options: [option("yes"), option("no", "deny")],
    ...over,
  };
}

describe("which options show", () => {
  it("draws at most six, in the program's order", () => {
    const many = ask({ options: Array.from({ length: 9 }, (_, i) => option(`o${i}`)) });
    expect(MAX_ASK_OPTIONS).toBe(6);
    expect(visibleOptions(many).map((o) => o.id)).toEqual(["o0", "o1", "o2", "o3", "o4", "o5"]);
  });

  it("an ask of another kind, or with no option, is not answerable", () => {
    expect(answerable(ask())).toBe(true);
    expect(answerable(ask({ kind: "form" }))).toBe(false);
    expect(answerable(ask({ options: [] }))).toBe(false);
  });
});

describe("how heavy an option looks", () => {
  it.each([
    ["allow", "selected"],
    ["allow-always", "default"],
    ["deny", "default"],
    ["cancel", "default"],
  ] as const)("%s is %s", (effect, tone) => {
    expect(optionTone(effect)).toBe(tone);
  });
});

describe("the card's state", () => {
  const first = freshCard(ask());

  it("a tap turns the buttons off and keeps the request id", () => {
    const s = tapped(first, "yes", "req-1");
    expect(s).toMatchObject({ phase: "sending", optionId: "yes", requestId: "req-1" });
  });

  it("taken closes the card", () => {
    expect(answered(tapped(first, "yes", "r"), { outcome: "taken" }).phase).toBe("taken");
  });

  it("too late says already answered", () => {
    expect(answered(tapped(first, "yes", "r"), { outcome: "too-late" }).phase).toBe("late");
  });

  it("stale replaces the card with the returned ask and asks for a fresh tap", () => {
    const newer = ask({ revision: 2, title: "Run it as root?" });
    const s = answered(tapped(first, "yes", "r"), { outcome: "stale", ask: newer });
    expect(s).toMatchObject({ phase: "stale", requestId: null, optionId: null, older: false });
    expect(s.ask).toBe(newer);
  });

  it("stale with no ask keeps the card it has, and an old machine is told so", () => {
    const s = answered(tapped(first, "yes", "r"), { outcome: "stale", older: true });
    expect(s.ask).toBe(first.ask);
    expect(s.older).toBe(true);
  });

  it("unknown keeps the SAME request id and the choice, for Try again", () => {
    const s = answered(tapped(first, "yes", "req-9"), { outcome: "unknown" });
    expect(s).toMatchObject({ phase: "unknown", requestId: "req-9", optionId: "yes" });
  });

  it("refused keeps the bridge's words", () => {
    const s = answered(tapped(first, "yes", "r"), { outcome: "refused", detail: "This pane takes no answers." });
    expect(s).toMatchObject({ phase: "refused", detail: "This pane takes no answers." });
  });
});

describe("a poll that brings the ask again", () => {
  const first = freshCard(ask());

  it("takes a newer revision when the card is idle or stale", () => {
    const newer = ask({ revision: 3 });
    expect(polled(first, newer).ask).toBe(newer);
    const stale = answered(tapped(first, "yes", "r"), { outcome: "stale" });
    expect(polled(stale, newer).phase).toBe("idle");
  });

  it("never swaps the options under a tap in flight or a pending retry", () => {
    const newer = ask({ revision: 3 });
    const sending = tapped(first, "yes", "r");
    expect(polled(sending, newer)).toBe(sending);
    const unknown = answered(sending, { outcome: "unknown" });
    expect(polled(unknown, newer)).toBe(unknown);
  });

  it("ignores the same or an older revision", () => {
    expect(polled(first, ask({ revision: 1 }))).toBe(first);
    expect(polled(first, ask({ revision: 0 }))).toBe(first);
  });
});

describe("where a card sits", () => {
  const blocks = [[{ id: "u1:0" }], [{ id: "tool-7" }, { id: "tool-8" }], [{ id: "m9:0" }, { id: "m9:1" }]];

  it("under the block that shows its item, by the program's id or one part of it", () => {
    expect(blockOf(blocks, ask({ itemId: "tool-8" }))).toBe(1);
    expect(blockOf(blocks, ask({ itemId: "m9" }))).toBe(2);
    expect(blockOf(blocks, ask({ itemId: "u1" }))).toBe(0);
  });

  it("a part id is not a prefix match on a longer id", () => {
    expect(blockOf(blocks, ask({ itemId: "tool-" }))).toBeNull();
    expect(blockOf(blocks, ask({ itemId: "m" }))).toBeNull();
  });

  it("at the tail when the item is not shown", () => {
    const gone = ask({ id: "ask-gone", itemId: "nowhere" });
    expect(blockOf(blocks, gone)).toBeNull();
    const here = ask({ id: "ask-here", itemId: "tool-7" });
    expect(asksAt(blocks, [gone, here], null).map((a) => a.id)).toEqual(["ask-gone"]);
    expect(asksAt(blocks, [gone, here], 1).map((a) => a.id)).toEqual(["ask-here"]);
  });
});

describe("an ask out of a response body", () => {
  const good = {
    id: "a",
    kind: "permission",
    toolCallId: "c",
    revision: 2,
    title: "T",
    itemId: "i",
    options: [{ id: "yes", label: "Yes", effect: "allow" }],
    reason: "because",
    tool: { name: "bash", summary: "ls", output: "x" },
  };

  it("reads a whole shape", () => {
    expect(parseAsk(good)).toEqual(good);
  });

  it.each([
    ["a missing id", { ...good, id: undefined }],
    ["a revision that is not a number", { ...good, revision: "2" }],
    ["an option with an unknown effect", { ...good, options: [{ id: "x", label: "X", effect: "run" }] }],
    ["an option list that is not a list", { ...good, options: "yes" }],
  ])("drops the whole ask for %s", (_name, body) => {
    expect(parseAsk(body)).toBeUndefined();
  });

  it("drops a tool block it cannot read, and keeps the ask", () => {
    expect(parseAsk({ ...good, tool: { name: 3 } })?.tool).toBeUndefined();
  });
});
