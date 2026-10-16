import { describe, expect, it } from "vitest";

import {
  alwaysAllowOffered,
  answerable,
  answered,
  ASKS_SHOWN,
  asksAt,
  blockOf,
  decidedOf,
  EMPTY_DRAFT,
  effectKey,
  formFields,
  formReady,
  formValues,
  freshCard,
  MAX_ASK_OPTIONS,
  MAX_CHOICE_OPTIONS,
  MAX_FORM_FIELDS,
  optionTone,
  parseAsk,
  pickedAfter,
  polled,
  pressed,
  secondaryLabel,
  sent,
  shownAsks,
  tapped,
  textLimit,
  textReady,
  visibleOptions,
} from "./ask";
import { t } from "./i18n";
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

describe("which asks show as cards", () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => ask({ id: `a${i}` }));

  it.each([
    [0, false, 0, 0],
    [1, false, 1, 0],
    [5, false, 5, 0],
    [6, false, 5, 1],
    [50, false, 5, 45],
    [6, true, 6, 0],
    [50, true, 50, 0],
  ])("%i open, expanded %s: draws %i, folds %i", (n, expanded, drawn, hidden) => {
    const got = shownAsks(list(n), expanded);
    expect(got.shown).toHaveLength(drawn);
    expect(got.hidden).toBe(hidden);
  });

  it("keeps the first five, oldest first", () => {
    expect(ASKS_SHOWN).toBe(5);
    expect(shownAsks(list(8), false).shown.map((a) => a.id)).toEqual(["a0", "a1", "a2", "a3", "a4"]);
  });
});

describe("Always allow needs a scope it can state", () => {
  const always = option("always", "allow-always");
  const withTool = { name: "bash", summary: "ls" };

  it.each([
    ["a tool with a name", { tool: withTool }, true],
    ["no tool", {}, false],
    ["a tool with a blank name", { tool: { name: "  ", summary: "ls" } }, false],
    ["text the bridge cut or changed", { tool: withTool, cleaned: true as const }, false],
  ])("%s: offered %s", (_name, over, offered) => {
    const a = ask({ ...over, options: [option("yes"), always, option("no", "deny")] });
    expect(alwaysAllowOffered(a)).toBe(offered);
    expect(visibleOptions(a).map((o) => o.id)).toEqual(offered ? ["yes", "always", "no"] : ["yes", "no"]);
  });

  it("filters before it caps at six", () => {
    const a = ask({ options: [always, ...Array.from({ length: 7 }, (_, i) => option(`o${i}`))] });
    expect(visibleOptions(a).map((o) => o.id)).toEqual(["o0", "o1", "o2", "o3", "o4", "o5"]);
  });

  it("arms on the first press and posts on the second, on the same option", () => {
    const start = freshCard(ask({ tool: withTool }));
    const first = pressed(start, always);
    expect(first).toMatchObject({ post: false, state: { armed: "always" } });
    const second = pressed(first.state, always);
    expect(second).toMatchObject({ post: true, state: { armed: null } });
  });

  it("a press on another option disarms it, and an ordinary option posts at once", () => {
    const armed = pressed(freshCard(ask({ tool: withTool })), always).state;
    expect(pressed(armed, option("no", "deny"))).toMatchObject({ post: true, state: { armed: null } });
    expect(pressed(freshCard(ask()), option("yes"))).toMatchObject({ post: true, state: { armed: null } });
  });

  it("a newer revision from the poll disarms it", () => {
    const armed = pressed(freshCard(ask({ tool: withTool })), always).state;
    expect(polled(armed, ask({ revision: 2, tool: withTool })).armed).toBeNull();
  });
});

describe("the words on a button come from the effect", () => {
  it.each([
    ["allow", "Allow"],
    ["allow-always", "Always allow"],
    ["deny", "Deny"],
    ["cancel", "Cancel"],
  ] as const)("%s says %s", (effect, words) => {
    expect(t(effectKey(effect))).toBe(words);
  });

  it("the program's label is the second line, unless it only repeats the main words", () => {
    expect(secondaryLabel("Run it", "Allow")).toBe("Run it");
    expect(secondaryLabel("allow", "Allow")).toBeUndefined();
    expect(secondaryLabel(" ALWAYS ALLOW ", "Always allow")).toBeUndefined();
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

  it("too late keeps who decided first when the answer said, and nothing when it did not", () => {
    const decided = { by: "timeout" as const, at: "2026-10-15T09:30:00.000Z" };
    expect(answered(tapped(first, "yes", "r"), { outcome: "too-late", decided })).toMatchObject({ phase: "late", decided });
    expect(answered(tapped(first, "yes", "r"), { outcome: "too-late" }).decided).toBeNull();
    expect(first.decided).toBeNull();
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

  it("maybe-applied closes every button and leaves the card as it was", () => {
    const s = answered(tapped(first, "yes", "req-4"), { outcome: "maybe-applied" });
    expect(s.phase).toBe("maybe");
    expect(s.ask).toBe(first.ask);
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

  it("reads cleaned only when it is exactly true", () => {
    expect(parseAsk({ ...good, cleaned: true })?.cleaned).toBe(true);
    expect(parseAsk({ ...good, cleaned: false })).not.toHaveProperty("cleaned");
    expect(parseAsk({ ...good, cleaned: "yes" })).not.toHaveProperty("cleaned");
    expect(parseAsk(good)).not.toHaveProperty("cleaned");
  });

  it("drops a tool block it cannot read, and keeps the ask", () => {
    expect(parseAsk({ ...good, tool: { name: 3 } })?.tool).toBeUndefined();
  });

  it("reads expiresAt when it is a time, and treats anything else as none", () => {
    expect(parseAsk({ ...good, expiresAt: "2026-10-15T10:04:00.000Z" })?.expiresAt).toBe("2026-10-15T10:04:00.000Z");
    expect(parseAsk({ ...good, expiresAt: "soon" })).not.toHaveProperty("expiresAt");
    expect(parseAsk({ ...good, expiresAt: 1760000000 })).not.toHaveProperty("expiresAt");
    expect(parseAsk(good)).not.toHaveProperty("expiresAt");
  });
});

describe("who decided a too-late answer", () => {
  it("reads the three words with a time, and nothing else", () => {
    for (const by of ["phone", "program", "timeout"]) {
      expect(decidedOf({ by, at: "2026-10-15T09:30:00.000Z" })).toEqual({ by, at: "2026-10-15T09:30:00.000Z" });
    }
    expect(decidedOf({ by: "stopped", at: "2026-10-15T09:30:00.000Z" })).toBeUndefined();
    expect(decidedOf({ by: "program", at: "later" })).toBeUndefined();
    expect(decidedOf({ by: "program" })).toBeUndefined();
    expect(decidedOf(undefined)).toBeUndefined();
  });
});

describe("more kinds of ask", () => {
  const plain = (id: string): AskOption => ({ id, label: `Pick ${id}` });
  const choice = (over: Partial<Ask> = {}) => ask({ kind: "choice", options: ["a", "b", "c"].map(plain), ...over });
  const text = (over: Partial<Ask> = {}) => ask({ kind: "text", options: [], ...over });
  const form = (over: Partial<Ask> = {}) =>
    ask({
      kind: "form",
      options: [],
      fields: [
        { id: "summary", label: "Summary", kind: "text", required: true, maxLength: 10 },
        { id: "queue", label: "Queue", kind: "choice", options: ["a", "b"].map(plain) },
        { id: "urgent", label: "Urgent", kind: "toggle", required: true },
      ],
      ...over,
    });

  const lines = (typed: Record<string, string>) => ({ lines: typed, flags: {} });

  it("answerable: each kind needs what it is answered with", () => {
    expect(answerable(choice())).toBe(true);
    expect(answerable(choice({ options: [] }))).toBe(false);
    expect(answerable(text())).toBe(true);
    expect(answerable(form())).toBe(true);
    expect(answerable(form({ fields: [] }))).toBe(false);
    expect(answerable(form({ fields: undefined }))).toBe(false);
    expect(answerable(form({ fields: [{ id: "q", label: "Q", kind: "choice", options: [] }] }))).toBe(false);
    expect(answerable(ask({ kind: "dial" }))).toBe(false);
  });

  it("a choice draws its first eight options, with no effect to withhold; a permission still draws six", () => {
    const many = Array.from({ length: 10 }, (_, i) => plain(`o${i}`));
    expect(visibleOptions(choice({ options: many }))).toHaveLength(MAX_CHOICE_OPTIONS);
    expect(visibleOptions(ask({ options: Array.from({ length: 10 }, (_, i) => option(`o${i}`)) }))).toHaveLength(MAX_ASK_OPTIONS);
  });

  it("a permission option with no effect is not drawn", () => {
    expect(visibleOptions(ask({ options: [plain("x"), option("y")] })).map((o) => o.id)).toEqual(["y"]);
  });

  it("a form draws its first six fields", () => {
    const fields = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, label: "F", kind: "toggle" as const }));
    expect(formFields(form({ fields }))).toHaveLength(MAX_FORM_FIELDS);
  });

  it("textLimit reads 500 when the program names none; textReady wants a non-blank line within the limit", () => {
    expect(textLimit({})).toBe(500);
    expect(textLimit({ maxLength: 12 })).toBe(12);
    expect(textReady("", {})).toBe(false);
    expect(textReady("   ", {})).toBe(false);
    expect(textReady("ok", { maxLength: 2 })).toBe(true);
    expect(textReady("ooo", { maxLength: 2 })).toBe(false);
    expect(textReady("  ok  ", { maxLength: 2 })).toBe(true); // the line is sent trimmed
    expect(textReady("🙂🙂", { maxLength: 2 })).toBe(true); // characters, not code units
  });

  it("pickedAfter: a single choice replaces, a multiple one flips the id", () => {
    expect(pickedAfter(["a"], "b", false)).toEqual(["b"]);
    expect(pickedAfter(["a"], "b", true)).toEqual(["a", "b"]);
    expect(pickedAfter(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("formReady: a required text field needs a line, a toggle always has a value, a text over its limit blocks", () => {
    expect(formReady(form(), EMPTY_DRAFT)).toBe(false);
    expect(formReady(form(), lines({ summary: "   " }))).toBe(false);
    expect(formReady(form(), lines({ summary: "ok" }))).toBe(true);
    expect(formReady(form(), lines({ summary: "x".repeat(11) }))).toBe(false);
    expect(formReady(form({ fields: [{ id: "queue", label: "Q", kind: "choice", required: true, options: [plain("a")] }] }), EMPTY_DRAFT)).toBe(false);
    expect(formReady(form({ fields: [{ id: "queue", label: "Q", kind: "choice", required: true, options: [plain("a")] }] }), lines({ queue: "a" }))).toBe(true);
  });

  it("formValues: filled fields only, text trimmed, every toggle as a boolean", () => {
    expect(formValues(form(), { lines: { summary: "  hi  ", queue: "b" }, flags: { urgent: true } })).toEqual({ summary: "hi", queue: "b", urgent: true });
    expect(formValues(form(), lines({ summary: "hi", queue: "" }))).toEqual({ summary: "hi", urgent: false });
  });

  it("sent keeps the whole answer for Try again, and an option id only when the answer is one option", () => {
    const first = freshCard(choice());
    const one = sent(first, { optionIds: ["a"] }, "r1");
    expect(one).toMatchObject({ phase: "sending", requestId: "r1", answer: { optionIds: ["a"] }, optionId: null });
    expect(tapped(freshCard(ask()), "yes", "r2")).toMatchObject({ optionId: "yes", answer: { optionId: "yes" } });
    expect(answered(one, { outcome: "unknown" })).toMatchObject({ phase: "unknown", answer: { optionIds: ["a"] }, requestId: "r1" });
    expect(answered(one, { outcome: "stale" })).toMatchObject({ phase: "stale", answer: null, requestId: null });
  });

  it("parseAsk reads a choice, a text ask and a form, and drops one with a broken field", () => {
    const good = { id: "a", kind: "choice", toolCallId: "t", revision: 1, title: "Q", itemId: "i", options: [{ id: "x", label: "X" }], multiple: true };
    expect(parseAsk(good)).toEqual(good);
    const line = { id: "a", kind: "text", toolCallId: "t", revision: 1, title: "Q", itemId: "i", options: [], placeholder: "hint", maxLength: 30 };
    expect(parseAsk(line)).toEqual(line);
    const fields = [
      { id: "s", label: "S", kind: "text", required: true, maxLength: 5 },
      { id: "q", label: "Q", kind: "choice", options: [{ id: "x", label: "X" }] },
      { id: "u", label: "U", kind: "toggle" },
    ];
    const whole = { id: "a", kind: "form", toolCallId: "t", revision: 1, title: "Q", itemId: "i", options: [], fields };
    expect(parseAsk(whole)).toEqual(whole);
    expect(parseAsk({ ...whole, fields: [{ id: "s", label: "S", kind: "dial" }] })).toBeUndefined();
    expect(parseAsk({ ...whole, fields: [{ id: "q", label: "Q", kind: "choice", options: [{ id: "x" }] }] })).toBeUndefined();
    expect(parseAsk({ ...good, options: [{ id: "x", label: "X", effect: "sudo" }] })).toBeUndefined();
  });
});
