import { describe, expect, it, beforeEach, vi } from "vitest";

// The multi-select choreography engine: the entry guard + the Submit macro (walk the pointer DOWN
// onto "Submit", re-reading each step, then Enter) and the one-keystroke intents (toggle / escape /
// confirm / cancel). The api layer is mocked so the mid-flight pane states can be sequenced precisely;
// the detector is the real thing, driven by synthetic plain-text buffers in the verified layout.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

// A harness that declares its submit keys as data (opencode's `question` tool shape). It re-uses
// Claude's grammar for the screens and adds the declared plans on top, so the guard re-derives
// through a real detector and the declared fields ride every derivation, exactly as an adapter that
// emits them would. Every other agent resolves through the real registry.
const keysHarness = vi.hoisted(() => {
  const agent = "keys-harness";
  const declare = (m: import("./blocks").MultiSelectModel): import("./blocks").MultiSelectModel =>
    m.phase === "checkbox"
      ? { ...m, advanceKeys: ["Tab"] }
      : {
          ...m,
          submit: "keys",
          submitKeys: ["Enter"],
          cancelKeys: ["Escape"],
          backKeys: ["Left"],
          answers: [{ question: "Toppings", answer: "Cheese, Olives" }],
        };
  return { agent, declare };
});
vi.mock("./harness/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("./harness/registry")>();
  return {
    ...real,
    adapterFor: (agent: string | undefined) => {
      if (agent !== keysHarness.agent) return real.adapterFor(agent);
      const claude = real.adapterFor("claude")!;
      return {
        ...claude,
        agent: keysHarness.agent,
        buildBlocks: (lines: import("./blocks").StyledLine[]) => {
          const blocks = claude.buildBlocks(lines);
          for (const b of blocks) if (b.kind === "multi-select") b.multi = keysHarness.declare(b.multi);
          return blocks;
        },
      };
    },
  };
});

import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MultiSelectModel } from "./blocks";
import { detectMultiSelect } from "./harness/claude/multi-select";
import { detectCheckbox } from "./harness/muse/checkbox";
import {
  multiSelectEquals,
  multiSelectIdentity,
  submitMultiSelectIntent,
  type MultiSelectIntent,
} from "./multi-select-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

type Pointer = "opt1" | "opt2" | "opt3" | "opt4" | "free" | "submit" | "chat" | "none";

// A synthetic checkbox screen in the verified layout: stepper, question, four checkbox rows, the
// free-text row, a navigable Submit row, a rule, the "Chat about this" escape, and the select footer.
// `pointer` places the ❯; `checked` marks rows.
function checkboxBuffer(
  opts: { pointer?: Pointer; checked?: number[]; question?: string; stepper?: string } = {},
): string {
  const pointer = opts.pointer ?? "opt1";
  const checked = new Set(opts.checked ?? []);
  const labels = ["Cheese", "Mushrooms", "Olives", "Peppers"];
  const optRows = labels.map((label, i) => {
    const n = i + 1;
    const box = checked.has(n) ? "[✔]" : "[ ]";
    const ptr = pointer === `opt${n}` ? "❯ " : "  ";
    return `${ptr}${n}. ${box} ${label}`;
  });
  // The ❯ replaces the FIRST leading space (column alignment is preserved), so the pointer normalises
  // cleanly out of the signature — the un-pointed row is 5 spaces, the pointed one ❯ + 4.
  const submitRow = (pointer === "submit" ? "❯    " : "     ") + "Submit";
  const chatRow = (pointer === "chat" ? "❯ " : "  ") + "6. Chat about this";
  // The free-text "Type something" row can also carry the pointer (Claude lets the ❯ rest on it);
  // pointerAt reads it as `field`, so the Submit walk must nudge past it, never Enter, and no digit
  // goes out until the pointer has left it.
  const freeRow = (pointer === "free" ? "❯ " : "  ") + "5. [ ] Type something";
  return [
    opts.stepper ?? "←  ☐ Toppings  ✔ Submit  →",
    "",
    opts.question ?? "Which pizza toppings do you want?",
    "",
    ...optRows,
    freeRow,
    submitRow,
    "─".repeat(80),
    chatRow,
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

function reviewBuffer(opts: { incomplete?: boolean } = {}): string {
  return [
    "←  ☐ Toppings  ✔ Submit  →",
    "",
    "Review your answers",
    ...(opts.incomplete ? ["", "⚠ You have not answered all questions"] : []),
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n");
}

function model(text: string): MultiSelectModel {
  const m = detectMultiSelect(splitLines(parseAnsi(text)));
  if (!m) throw new Error("synthetic buffer did not detect a multi-select dialog");
  return m;
}

function paneWith(text: string, revision = 5) {
  return { paneId: "w1:p1", text, truncated: false, revision };
}

// Serve a SCRIPT of pane states: each fetch consumes one entry; the last repeats forever.
function script(...texts: string[]) {
  const queue = [...texts];
  mockFetchPane.mockImplementation(async () =>
    paneWith(queue.length > 1 ? queue.shift()! : queue[0]!),
  );
}

const noSleep = async () => {};
const base = {
  paneId: "w1:p1",
  requestedLines: 600,
  detectedRevision: 5,
  // The guard re-derives through the pane's ADAPTER (lib/dialog-guard.ts), so every call names the
  // agent whose grammar produced the fixture — an agent with no adapter fails the guard closed.
  agent: "claude",
  sleep: noSleep,
};
const keysSent = () => mockSendKeys.mock.calls.map((c) => c[1]);

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockReset();
  mockSendReply.mockResolvedValue({ ok: true });
});

// The answer field of a multi-select question (ADR 0113, grammar/ASK_FIELD_NOTES.md § Multi-select),
// in the 2.1.299 layout of the claude--v2299-ask-field-multi-* captures: three options, the field as
// row 4, `Submit`, a rule, `5. Chat about this`. `wrap` adds a continuation line under the field.
type FieldPointer = "opt1" | "opt3" | "field" | "submit" | "chat";
function fieldBuffer(pointer: FieldPointer, text: string, checked: boolean, wrap?: string): string {
  const mark = (p: FieldPointer) => (p === pointer ? "❯ " : "  ");
  return [
    "←  ☒ Toppings  ✔ Submit  →",
    "",
    "Which toppings?",
    "",
    `${mark("opt1")}1. [✔] Cheese`,
    "         Melted cheese",
    "  2. [ ] Olives",
    "         Sliced olives",
    `${mark("opt3")}3. [ ] Basil`,
    "         Fresh basil leaves",
    `${mark("field")}4. ${checked ? "[✔]" : "[ ]"} ${text === "" ? "Type something" : text}`,
    ...(wrap === undefined ? [] : [`     ${wrap}`]),
    (pointer === "submit" ? "❯    " : "     ") + "Submit",
    "─".repeat(80),
    `${mark("chat")}5. Chat about this`,
    "",
    pointer === "field"
      ? "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel"
      : "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
}

function typeAnswer(tapped: string, text = "Kiwi") {
  return submitMultiSelectIntent({ ...base, multi: model(tapped), intent: { kind: "type", text } });
}

const CLEAR = ["ctrl+u", "ctrl+k"];

describe("submitMultiSelectIntent — type an answer into the field", () => {
  // The park ends on the option row above the field: from `Submit` an option's digit does nothing
  // (ASK_FIELD_NOTES.md § Multi-select), so a park there would leave every checkbox tap dead.
  it("an empty field: never its digit (it toggles), a Down walk, type, no Enter (ticked), park Up on the option above", async () => {
    const tapped = fieldBuffer("opt3", "", true);
    script(
      tapped, // entry guard
      tapped, // the walk's first read
      fieldBuffer("field", "", true), // the walk lands
      fieldBuffer("field", "", true), // the reach proof
      fieldBuffer("field", "Kiwi", true), // typing into it kept it ticked
      fieldBuffer("opt3", "Kiwi", true), // the park lands on the option above the field
    );
    expect(await typeAnswer(tapped)).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Up"]]);
    expect(keysSent()).not.toContainEqual(["4"]);
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "Kiwi", false, undefined]]);
    // The park's Up is bound to the read that proved the text.
    expect(mockSendKeys.mock.calls[1]![3]).toBe(model(fieldBuffer("field", "Kiwi", true)).regionSignature);
  });

  it("replaces a filled field from Submit: an Up walk, a clear, the text, then the park Up", async () => {
    const tapped = fieldBuffer("submit", "Mushroom", false);
    script(
      tapped, // entry guard
      tapped, // the walk's first read
      fieldBuffer("field", "Mushroom", false), // the walk lands
      fieldBuffer("field", "Mushroom", false), // the reach proof
      fieldBuffer("field", "", false), // one clear round emptied (and unticked) it
      fieldBuffer("field", "Kiwi", true), // typing into the empty field ticked it
      fieldBuffer("opt3", "Kiwi", true),
    );
    expect(await typeAnswer(tapped)).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], CLEAR, ["Up"]]);
    expect(keysSent()).not.toContainEqual(["4"]);
    expect(keysSent()).not.toContainEqual(["Down"]);
  });

  it("a wrapped field: the park spends one Up per caret line, within its bound, and never Enter", async () => {
    const tapped = fieldBuffer("field", "", true);
    const typed = fieldBuffer("field", "Mushroom and", true, "pineapple");
    const proof = model(typed);
    expect(proof.phase === "checkbox" && proof.field?.lines).toBe(2);
    const text = proof.phase === "checkbox" ? (proof.field?.text ?? "") : "";
    // The first Up moves the caret up a visual line and repaints nothing, so the park's poll reads the
    // same screen until it gives up; the second Up leaves the field for the option above it.
    const caretMoveReads = Array.from({ length: 8 }, () => typed);
    script(tapped, tapped, typed, ...caretMoveReads, fieldBuffer("opt3", "Mushroom and", true, "pineapple"));
    expect(await typeAnswer(tapped, text)).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Up"]]);
  });

  it("a park that never reaches the option row still reports sent, after its bound of Ups and no Enter", async () => {
    const tapped = fieldBuffer("field", "", true);
    script(tapped, tapped, fieldBuffer("field", "Kiwi", true));
    expect(await typeAnswer(tapped)).toEqual({ status: "sent" });
    // One line of text: the bound is its lines plus three.
    expect(keysSent()).toEqual([["Up"], ["Up"], ["Up"], ["Up"]]);
  });

  it("a typed field that reads unticked: exactly ONE Enter, bound, then the tick verified", async () => {
    const tapped = fieldBuffer("submit", "Mushroom", false);
    script(
      tapped,
      tapped,
      fieldBuffer("field", "Mushroom", false),
      fieldBuffer("field", "Mushroom", false),
      fieldBuffer("field", "", false),
      fieldBuffer("field", "Kiwi", false), // typed, but unticked
      fieldBuffer("field", "Kiwi", true), // the Enter ticked it
      fieldBuffer("opt3", "Kiwi", true),
    );
    expect(await typeAnswer(tapped)).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], CLEAR, ["Enter"], ["Up"]]);
    expect(mockSendKeys.mock.calls[2]![3]).toBe(model(fieldBuffer("field", "Kiwi", false)).regionSignature);
  });

  it("the tick never comes: an error, and no second Enter", async () => {
    const tapped = fieldBuffer("field", "", false);
    script(tapped, tapped, fieldBuffer("field", "Kiwi", false));
    const res = await typeAnswer(tapped);
    expect(res.status).toBe("error");
    expect(keysSent()).toEqual([["Enter"]]);
  });

  it("the field no longer holds what the person saw: refused, nothing typed, no Enter", async () => {
    const tapped = fieldBuffer("submit", "Mushroom", false);
    script(fieldBuffer("submit", "Mushrooms", false));
    expect(await typeAnswer(tapped)).toEqual({ status: "changed", why: "entry" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockSendReply).not.toHaveBeenCalled();
  });

  it("a park that sees the field change refuses", async () => {
    const tapped = fieldBuffer("field", "", true);
    script(tapped, tapped, fieldBuffer("field", "Kiwi", true), fieldBuffer("opt3", "Kiwis", true));
    expect(await typeAnswer(tapped)).toEqual({ status: "changed", why: "park: drift" });
    expect(keysSent()).toEqual([["Up"]]);
  });

  it("a dialog with no field refuses before any read", async () => {
    const res = await submitMultiSelectIntent({ ...base, multi: model(reviewBuffer()), intent: { kind: "type", text: "Kiwi" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
  });
});

describe("submitMultiSelectIntent — the other intents and the field", () => {
  it("toggle, escape and nav never type into a focused field: one Up, and no key while it keeps focus", async () => {
    const screen = fieldBuffer("field", "Kiwi", true);
    const focused = model(screen);
    // A standalone multiSelect has no step to navigate to, so its nav is refused before any key.
    const intents: [MultiSelectIntent, string[][]][] = [
      [{ kind: "toggle", n: 1 }, [["Up"]]],
      [{ kind: "escape" }, [["Up"]]],
      [{ kind: "nav", keys: ["Left"] }, []],
    ];
    for (const [intent, keys] of intents) {
      mockSendKeys.mockClear();
      script(screen);
      expect(await submitMultiSelectIntent({ ...base, multi: focused, intent })).toEqual({ status: "changed" });
      expect(keysSent(), intent.kind).toEqual(keys);
    }
  });

  it("toggle takes the field's own digit when it holds text and is not focused", async () => {
    const screen = fieldBuffer("opt1", "Mushroom", false);
    script(screen);
    const res = await submitMultiSelectIntent({ ...base, multi: model(screen), intent: { kind: "toggle", n: 4 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["4"]]);
  });

  it("the advance walk's bound grows with the field's wrapped lines", async () => {
    const one = fieldBuffer("opt1", "Mushroom", true);
    const two = fieldBuffer("opt1", "Mushroom and", true, "pineapple");
    const wrapped = model(two);
    expect(wrapped.phase === "checkbox" && wrapped.field?.lines).toBe(2);
    mockFetchPane.mockResolvedValue(paneWith(one));
    await submitMultiSelectIntent({ ...base, multi: model(one), intent: { kind: "advance" } });
    const short = keysSent().length;
    mockSendKeys.mockClear();
    mockFetchPane.mockResolvedValue(paneWith(two));
    await submitMultiSelectIntent({ ...base, multi: model(two), intent: { kind: "advance" } });
    expect(keysSent().length).toBe(short + 1);
    expect(keysSent()).not.toContainEqual(["Enter"]);
  });
});

describe("multiSelectEquals / multiSelectIdentity", () => {
  it("equals: full state incl. checked; unequal across question / checked; ignores pointer", () => {
    const a = model(checkboxBuffer({ pointer: "opt1", checked: [] }));
    // Pointer moved but everything else identical → still the same visible state (pointer is transient).
    expect(multiSelectEquals(a, model(checkboxBuffer({ pointer: "chat", checked: [] })))).toBe(true);
    // A checkbox flip IS a visible-state change the entry guard must catch.
    expect(multiSelectEquals(a, model(checkboxBuffer({ checked: [2] })))).toBe(false);
    // A different question is a different dialog.
    expect(multiSelectEquals(a, model(checkboxBuffer({ question: "Something else?" })))).toBe(false);
  });

  it("identity: pointer-independent but checked-DEPENDENT (an external mid-walk flip is drift)", () => {
    const a = model(checkboxBuffer({ pointer: "opt1", checked: [] }));
    // The macro's own pointer move (it only ever sends Down/Up — never a toggle) is NOT drift.
    expect(multiSelectIdentity(a, model(checkboxBuffer({ pointer: "submit", checked: [] })))).toBe(true);
    // But a box that flipped underfoot (a second device toggled it) IS — we must not walk on and
    // ship a set the user never saw.
    expect(multiSelectIdentity(a, model(checkboxBuffer({ pointer: "submit", checked: [3] })))).toBe(false);
    // A different question / different labels is a different dialog (the identity re-derivation guard).
    expect(multiSelectIdentity(a, model(checkboxBuffer({ question: "Another question?" })))).toBe(false);
  });
});

describe("toggle / escape — one guarded keystroke", () => {
  it("toggle sends the option's digit alone", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt1" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 3 } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], undefined, m.regionSignature],
    ]);
  });

  it("escape sends the 'Chat about this' digit", async () => {
    const m = model(checkboxBuffer({}));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "escape" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["6"], undefined, m.regionSignature],
    ]);
  });

  it("returns changed when the bound key write reports prompt_changed", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValueOnce(paneWith(checkboxBuffer({ pointer: "opt1" })));
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitMultiSelectIntent({
      ...base,
      multi: m,
      intent: { kind: "toggle", n: 3 },
    });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["3"], undefined, m.regionSignature],
    ]);
  });

  it("toggle rejects an out-of-range digit against the model, sending nothing (no stray keystroke)", async () => {
    const m = model(checkboxBuffer({})); // options 1..4
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    // n=7 is not a real option row — the renderer must never inject a digit the model doesn't back.
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 7 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    // The escape digit (6) is NOT a toggle target either — a toggle must match an OPTION, not the escape.
    const res2 = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 6 } });
    expect(res2).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("toggle rejects at the entry guard when the dialog changed underfoot (no keys)", async () => {
    const m = model(checkboxBuffer({ checked: [] }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ checked: [1] }))); // a box flipped
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("toggle rejects when the fresh revision differs (frozen mirror, advanced pane)", async () => {
    const m = model(checkboxBuffer({}));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({}), 9));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

describe("review — confirm / cancel", () => {
  it("confirm sends digit 1; cancel sends digit 2", async () => {
    const m = model(reviewBuffer({ incomplete: true }));
    mockFetchPane.mockResolvedValue(paneWith(reviewBuffer({ incomplete: true })));
    expect(await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "confirm" } })).toEqual({
      status: "sent",
    });
    expect(await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "cancel" } })).toEqual({
      status: "sent",
    });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["1"], undefined, m.regionSignature],
      ["w1:p1", ["2"], undefined, m.regionSignature],
    ]);
  });
});

describe("submit macro — walk the pointer down onto Submit, then Enter", () => {
  it("walks Down until a fresh read shows the pointer on Submit, then Enters", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt1" }), // read: an option row → Down
      checkboxBuffer({ pointer: "opt2" }), // read: still an option row → Down
      checkboxBuffer({ pointer: "submit" }), // read: on Submit → Enter (stops here, no overshoot)
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.regionSignature],
      ["w1:p1", ["Down"], undefined],
      ["w1:p1", ["Enter"], undefined],
    ]);
  });

  it("returns changed when the first bound macro write reports prompt_changed", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt1" }), // first pointer read leads to Down
    );
    mockSendKeys.mockResolvedValueOnce({
      ok: false,
      error: "Prompt changed before keys were sent",
      code: "prompt_changed",
    });
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.regionSignature],
    ]);
  });

  it("re-sends Down when a key is swallowed (the re-read still shows an option row)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt2" }), // read: option → Down
      checkboxBuffer({ pointer: "opt2" }), // read: STILL option (Down swallowed) → Down again
      checkboxBuffer({ pointer: "submit" }), // read: Submit → Enter
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Down"], ["Enter"]]);
  });

  it("Ups onto Submit when the pointer starts on the bottom Chat row (Submit is one row above)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "chat" }), // read: on the bottom row → Up
      checkboxBuffer({ pointer: "submit" }), // read: Submit → Enter
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Enter"]]);
  });

  it("NEVER Enters when the pointer never reaches Submit within the bounded walk", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // Every read shows an option row — the pointer never converges on Submit, so the bounded walk
    // exhausts and refreshes rather than blind-sending an Enter at an unverified row.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt2" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true); // only ever nudged downward
  });

  it("NEVER Enters when the pointer sits on the free-text row — nudges past it, never activates", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    // The ❯ parked on "5. [ ] Type something" (the answer field) reads as the `field` pointer, a
    // non-Submit row, so the walk only ever nudges Down — it must never mistake it for Submit and
    // blind-Enter.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "free" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true);
  });

  it("NEVER Enters when NO row carries the pointer (pointer null throughout)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // A redraw with the ❯ absent → pointer null → still not Submit, so the walk nudges Down and never
    // blind-Enters at an unverified row.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "none" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true);
  });

  it("aborts (no Enter) when a different dialog drifts in mid-walk", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard: same dialog
      checkboxBuffer({ pointer: "opt1" }), // read: option → Down
      // A DIFFERENT dialog (new question), even with the pointer on Submit — the per-read identity
      // check must reject it so NO Enter follows.
      checkboxBuffer({ pointer: "submit", question: "A different question?" }),
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Down"]]); // drift detected on the read, before any further key
    expect(keysSent()).not.toContainEqual(["Enter"]);
  });

  it("rejects at the entry guard (no keys at all) when the dialog already changed", async () => {
    const m = model(checkboxBuffer({ checked: [] }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ question: "Different?" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// With the ❯ on "Type something" the field has the keyboard: a digit is typed into it (measured on
// Claude Code 2.1.283), and Left/Right move its cursor. The model says `pointer: "field"`, and every
// digit or step key first moves the pointer off with ONE Up, reads that back, and then goes through
// its own entry guard against the read that showed the pointer off the field.
describe("the pointer on the free-text field — leave it before any digit", () => {
  const WIZARD_STEP = "←  ☐ Toppings  ☐ Size  ✔ Submit  →";

  it("the commit comparison tells a focused field from an unfocused one; identity does not", () => {
    const off = model(checkboxBuffer({ pointer: "opt1" }));
    const on = model(checkboxBuffer({ pointer: "free" }));
    expect(on.phase === "checkbox" && on.pointer).toBe("field");
    expect(multiSelectEquals(off, on)).toBe(false);
    expect(multiSelectEquals(on, model(checkboxBuffer({ pointer: "free" })))).toBe(true);
    // The macros' own arrows move the pointer onto and off the field: that is not drift.
    expect(multiSelectIdentity(off, on)).toBe(true);
  });

  it("toggle: one Up, a read showing the pointer off the field, then the digit bound to that read", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    const left = model(checkboxBuffer({ pointer: "opt4" }));
    script(
      checkboxBuffer({ pointer: "free" }), // offField's entry guard
      checkboxBuffer({ pointer: "opt4" }), // read after the Up: off the field
      checkboxBuffer({ pointer: "opt4" }), // the digit's own entry guard
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 3 } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Up"], undefined, m.regionSignature],
      ["w1:p1", ["3"], undefined, left.regionSignature],
    ]);
  });

  it("toggle: a redraw that has not caught up costs a read, never a second Up", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    script(
      checkboxBuffer({ pointer: "free" }), // entry guard
      checkboxBuffer({ pointer: "free" }), // first read: not redrawn yet
      checkboxBuffer({ pointer: "none" }), // a torn frame: no pointer at all
      checkboxBuffer({ pointer: "opt4" }), // off the field
      checkboxBuffer({ pointer: "opt4" }), // the digit's entry guard
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 1 } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["1"]]);
  });

  it("toggle: NO digit while the pointer stays on the field", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "free" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Up"]]);
  });

  it("toggle: NO digit when the pointer is back on the field by the digit's own guard", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    script(
      checkboxBuffer({ pointer: "free" }), // entry guard
      checkboxBuffer({ pointer: "opt4" }), // off the field
      checkboxBuffer({ pointer: "free" }), // someone moved it back in the gap
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Up"]]);
  });

  it("toggle: a box that flipped while leaving the field stops before the digit", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    script(
      checkboxBuffer({ pointer: "free" }), // entry guard
      checkboxBuffer({ pointer: "opt4", checked: [1] }), // off the field, but another device ticked 1
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Up"]]);
  });

  it("toggle: a tap on a screen with the field unfocused never commits on one where it has focus", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "free" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("escape: leaves the field before the 'Chat about this' digit", async () => {
    const m = model(checkboxBuffer({ pointer: "free" }));
    script(checkboxBuffer({ pointer: "free" }), checkboxBuffer({ pointer: "opt4" }), checkboxBuffer({ pointer: "opt4" }));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "escape" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["6"]]);
  });

  it("a step key of a wizard step: leaves the field before Right", async () => {
    const m = model(checkboxBuffer({ pointer: "free", stepper: WIZARD_STEP }));
    expect(m.phase === "checkbox" && m.steps).not.toBeNull();
    script(
      checkboxBuffer({ pointer: "free", stepper: WIZARD_STEP }),
      checkboxBuffer({ pointer: "opt4", stepper: WIZARD_STEP }),
      checkboxBuffer({ pointer: "opt4", stepper: WIZARD_STEP }),
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "nav", keys: ["Right"] } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Right"]]);
  });

  it("Submit from the field: arrows only, Down onto Submit, then Enter", async () => {
    const m = model(checkboxBuffer({ pointer: "free", checked: [1, 2, 3, 4] }));
    script(
      checkboxBuffer({ pointer: "free", checked: [1, 2, 3, 4] }), // entry guard
      checkboxBuffer({ pointer: "free", checked: [1, 2, 3, 4] }), // read: the field → Down
      checkboxBuffer({ pointer: "submit", checked: [1, 2, 3, 4] }), // read: Submit → Enter
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Down"], undefined, m.regionSignature],
      ["w1:p1", ["Enter"], undefined],
    ]);
  });
});

describe("per-pane serialization — overlapping actions can't both fire", () => {
  it("a second Submit while one is in-flight on the same pane is rejected, and only ONE Enters", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // Park the FIRST macro's entry read so it stays in-flight while we fire the second on the same pane.
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    mockFetchPane.mockImplementation(async () => {
      if (call++ === 0) await firstRead; // hold the first entry read open
      return paneWith(checkboxBuffer({ pointer: "submit" }));
    });

    const first = submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    // The second tap lands while the first is parked mid-flight → rejected before any read/send.
    const second = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "advance" } });
    expect(second).toEqual({ status: "changed" });

    releaseFirst();
    expect(await first).toEqual({ status: "sent" });
    // Exactly ONE Enter ever reached the terminal — the second macro never ran (no auto-confirm past
    // the review screen).
    expect(keysSent().filter((k) => k[0] === "Enter")).toHaveLength(1);
  });

  it("releases the lock after completion — a later action on the same pane proceeds normally", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt1" })));
    expect(
      await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 2 } }),
    ).toEqual({ status: "sent" });
    // The lock cleared, so the next action on the same pane is NOT blocked by a stale entry.
    expect(
      await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "toggle", n: 3 } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["2"], ["3"]]);
  });
});

// The `signature` normalises ☒/☑ → ☐ across the whole chip line, because the current question's chip
// flips on the first tick. That also erases WHICH step you are on — so the comparators have to carry
// the steps themselves, or a tap meant for one question lands on another.
describe("multiSelectEquals / multiSelectIdentity — wizard step identity", () => {
  const step = (
    chips: { label: string; answered: boolean; current: boolean }[],
  ): MultiSelectModel => ({
    phase: "checkbox",
    question: "Which changes should I keep?",
    options: [
      { n: 1, label: "Formatting", checked: false },
      { n: 2, label: "Renames", checked: false },
    ],
    escape: { n: 3, label: "Chat about this" },
    pointer: "option",
    pointerRow: null,
    steps: chips,
    advanceLabel: "Next",
    toggle: "digit",
    // Deliberately IDENTICAL: this is what the normalisation leaves behind for two steps of one
    // wizard whose questions and options happen to read the same.
    signature: "same",
    regionSignature: "region",
  });

  const q1 = step([
    { label: "Backend", answered: false, current: true },
    { label: "Frontend", answered: false, current: false },
  ]);
  const q2 = step([
    { label: "Backend", answered: true, current: false },
    { label: "Frontend", answered: false, current: true },
  ]);

  it("does not treat two steps of one wizard as the same screen", () => {
    expect(multiSelectEquals(q1, q2)).toBe(false);
    expect(multiSelectIdentity(q1, q2)).toBe(false);
  });

  it("still treats the same step as itself", () => {
    expect(multiSelectEquals(q1, step(q1.phase === "checkbox" ? q1.steps! : []))).toBe(true);
    expect(multiSelectIdentity(q1, step(q1.phase === "checkbox" ? q1.steps! : []))).toBe(true);
  });

  it("separates a Next step from the Submit step even if everything else matches", () => {
    // SAFETY: `q1` IS a MultiSelectModel and only `advanceLabel` — a declared string field — is
    // overridden, so the spread result carries every other field unchanged. The assertion exists
    // because a spread of a discriminated union widens the discriminant.
    const onSubmit = { ...q1, advanceLabel: "Submit" } as MultiSelectModel;
    expect(multiSelectEquals(q1, onSubmit)).toBe(false);
  });
});

// Pointer-mode choreography (Muse): a digit merely MOVES the pointer, Enter toggles (checkbox) or
// submits (review), and review swallows digits entirely — so toggle is digit-jump + verified Enter
// and review submit/cancel is a verified pointer walk + a freshly-bound Enter. The buffers below are
// synthetic plain-text screens in the verified Muse layout; the detector is the real thing.

type MusePointer = number | "submit" | "none";

function museCheckboxBuffer(
  opts: { pointer?: MusePointer; checked?: number[]; question?: string } = {},
): string {
  const pointer = opts.pointer ?? 1;
  const checked = new Set(opts.checked ?? []);
  const labels = ["Cheese", "Pepperoni", "Mushrooms"];
  const optRows = labels.map((label, i) => {
    const n = i + 1;
    const box = checked.has(n) ? "[x]" : "[ ]";
    const ptr = pointer === n ? "› " : "  ";
    return `  ${ptr}${n}. ${box} ${label}`;
  });
  const submitRow = `  ${pointer === "submit" ? "› " : "  "}4. Submit answer (${checked.size} checked)`;
  return [
    "◇ Request user input Toppings — running (3s)",
    "",
    opts.question ?? "Which pizza toppings do you want?",
    "",
    ...optRows,
    submitRow,
    "",
    "  Enter to toggle · Submit row to continue · ↑/↓ to move · Tab for an optional note · Esc to",
    "  interrupt",
    "",
    "── Voice input (⌥ + v to start) ──",
    "❯",
    "─".repeat(80),
    "  muse-spark-1.3 · max · /tmp/x · YOLO",
  ].join("\n");
}

function museReviewBuffer(opts: { pointer?: "submit" | "cancel" | "none" } = {}): string {
  const pointer = opts.pointer ?? "submit";
  const submitRow = `  ${pointer === "submit" ? "> " : "  "}Submit answers`;
  const cancelRow = `  ${pointer === "cancel" ? "> " : "  "}Interrupt turn`;
  return [
    "◇ Request user input Toppings — running (3s)",
    "",
    "  Review answers before submit · Enter to edit or submit · ↑/↓ to move · Esc to go back",
    "    Toppings: Cheese",
    submitRow,
    cancelRow,
    "",
    "── Voice input (⌥ + v to start) ──",
    "❯",
    "─".repeat(80),
    "  muse-spark-1.3 · max · /tmp/x · YOLO",
  ].join("\n");
}

function museIdleBuffer(): string {
  return [
    "  Muse Code 1.3.0",
    "",
    "── Voice input (⌥ + v to start) ──",
    "❯",
    "─".repeat(80),
    "  muse-spark-1.3 · max · /tmp/x · YOLO",
  ].join("\n");
}

function museModel(text: string): MultiSelectModel {
  const m = detectCheckbox(splitLines(parseAnsi(text)));
  if (!m) throw new Error("synthetic Muse buffer did not detect a multi-select dialog");
  return m;
}

const museBase = { ...base, agent: "muse" };
// SAFETY: sendKeys(paneId, keys, scope, expectedPrompt?) — the 4th mock call arg is the region
// binding when the write carried one, undefined when unbound. The cast names that contract; the
// tests assert bound regions where the recipe requires them, so an undefined fails loudly.
const regionsSent = () => mockSendKeys.mock.calls.map((c) => c[3] as string | undefined);

describe("pointer mode — toggle macro (digit-jump + verified Enter)", () => {
  it("jumps the pointer with the digit, then Enters on the verified row", async () => {
    const s1 = museCheckboxBuffer({ pointer: 1 });
    const s2 = museCheckboxBuffer({ pointer: 2 });
    const m = museModel(s1);
    script(s1, s1, s2);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "toggle", n: 2 } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["2"], ["Enter"]]);
  });

  it("Enters immediately when the pointer already sits on the tapped row", async () => {
    const s2 = museCheckboxBuffer({ pointer: 2 });
    const m = museModel(s2);
    script(s2, s2);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "toggle", n: 2 } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Enter"]]);
  });

  it("aborts when a box flips mid-macro — the jump went out, the Enter never does", async () => {
    const s1 = museCheckboxBuffer({ pointer: 1 });
    const flipped = museCheckboxBuffer({ pointer: 2, checked: [3] });
    const m = museModel(s1);
    script(s1, s1, flipped);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "toggle", n: 2 } }),
    ).toEqual({ status: "changed" });
    // The digit already moved the pointer (harmless, verified-or-retried), but the flip reads as
    // drift before any Enter — we never toggle a set the user didn't see.
    expect(keysSent()).toEqual([["2"]]);
  });

  it("aborts when the dialog vanishes mid-macro", async () => {
    const s1 = museCheckboxBuffer({ pointer: 1 });
    const m = museModel(s1);
    script(s1, s1, museIdleBuffer(), museIdleBuffer(), museIdleBuffer(), museIdleBuffer());
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "toggle", n: 2 } }),
    ).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["2"]]);
  });
});

describe("pointer mode — review macro (walk + freshly-bound Enter)", () => {
  it("confirm walks Up from cancel, then submits with the fresh region bound", async () => {
    const cancel = museReviewBuffer({ pointer: "cancel" });
    const submit = museReviewBuffer({ pointer: "submit" });
    const m = museModel(cancel);
    script(cancel, cancel, submit);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "confirm" } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Enter"]]);
    // The irreversible Enter carries the just-read region (prompt-feedback pattern): a terminal
    // pointer move in the final gap 409s at the bridge instead of submitting the wrong row.
    const regions = regionsSent();
    expect(regions[1]).toContain("Review answers before submit");
    expect(regions[1]).toContain("> Submit answers");
  });

  it("confirm Enters immediately (bound) when already on Submit", async () => {
    const submit = museReviewBuffer({ pointer: "submit" });
    const m = museModel(submit);
    script(submit, submit);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "confirm" } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Enter"]]);
    expect(regionsSent()[0]).toContain("> Submit answers");
  });

  it("cancel walks Down from submit, then interrupts with the fresh region bound", async () => {
    const submit = museReviewBuffer({ pointer: "submit" });
    const cancel = museReviewBuffer({ pointer: "cancel" });
    const m = museModel(submit);
    script(submit, submit, cancel);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "cancel" } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Enter"]]);
    expect(regionsSent()[1]).toContain("> Interrupt turn");
  });

  it("aborts when the review is gone mid-walk — the nudge went out, the Enter never does", async () => {
    const submit = museReviewBuffer({ pointer: "submit" });
    const m = museModel(submit);
    script(submit, submit, museCheckboxBuffer({ pointer: 1 }));
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "cancel" } }),
    ).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Down"]]);
  });
});

describe("advance macro on a pointer-mode checkbox (unchanged recipe)", () => {
  it("walks Down to the Submit row and Enters", async () => {
    const r1 = museCheckboxBuffer({ pointer: 1 });
    const r2 = museCheckboxBuffer({ pointer: 2 });
    const r3 = museCheckboxBuffer({ pointer: 3 });
    const sub = museCheckboxBuffer({ pointer: "submit" });
    const m = museModel(r1);
    script(r1, r1, r2, r3, sub);
    expect(
      await submitMultiSelectIntent({ ...museBase, multi: m, intent: { kind: "advance" } }),
    ).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Down"], ["Down"], ["Enter"]]);
  });
});

describe("comparators — choreography is identity, pointer position is transient", () => {
  it("a mode change is a different dialog; a pointer move is not", () => {
    const a = museModel(museCheckboxBuffer({ pointer: 1 }));
    // SAFETY: `a` IS a MultiSelectModel and only declared fields are overridden, so the spreads
    // carry every other field unchanged (the discriminant widens, hence the casts).
    const digitMode = { ...a, toggle: "digit" } as MultiSelectModel;
    expect(multiSelectEquals(a, digitMode)).toBe(false);
    expect(multiSelectIdentity(a, digitMode)).toBe(false);
    const moved = museModel(museCheckboxBuffer({ pointer: 2 }));
    expect(multiSelectEquals(a, moved)).toBe(true);
    expect(multiSelectIdentity(a, moved)).toBe(true);
  });

  it("review: a mode change differs; submit-vs-cancel pointer does not", () => {
    const a = museModel(museReviewBuffer({ pointer: "submit" }));
    // SAFETY: `a` IS a MultiSelectModel and only a declared field is overridden, so the spread
    // carries every other field unchanged (the discriminant widens, hence the cast).
    const digitMode = { ...a, submit: "digit" } as MultiSelectModel;
    expect(multiSelectEquals(a, digitMode)).toBe(false);
    expect(multiSelectIdentity(a, digitMode)).toBe(false);
    const moved = museModel(museReviewBuffer({ pointer: "cancel" }));
    expect(multiSelectEquals(a, moved)).toBe(true);
    expect(multiSelectIdentity(a, moved)).toBe(true);
  });
});

// KEYS mode: a harness that declares its plans on the model (opencode's lone multi-select list has
// no advance row, and its `Confirm` tab has no action rows). Every plan is ONE guarded write bound to
// the entry region; no pointer walk runs and no Down/Up is ever sent.
describe("keys mode — declared plans, one guarded write each", () => {
  const keysBase = { ...base, agent: keysHarness.agent };
  const keysModel = (text: string) => keysHarness.declare(model(text));

  it("advance sends advanceKeys once, bound to the entry region, and never walks the pointer", async () => {
    const m = keysModel(checkboxBuffer({ pointer: "opt1" }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt1" })));
    const res = await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["Tab"], undefined, m.regionSignature]]);
    expect(keysSent().flat()).not.toContain("Down");
    expect(keysSent().flat()).not.toContain("Up");
    // One fresh read for the entry guard, none for a walk.
    expect(mockFetchPane).toHaveBeenCalledTimes(1);
  });

  it("confirm, cancel and back send their declared plans, each bound to the entry region", async () => {
    const m = keysModel(reviewBuffer());
    mockFetchPane.mockResolvedValue(paneWith(reviewBuffer()));
    for (const kind of ["confirm", "cancel", "back"] as const) {
      expect(await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind } })).toEqual({
        status: "sent",
      });
    }
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["Enter"], undefined, m.regionSignature],
      ["w1:p1", ["Escape"], undefined, m.regionSignature],
      ["w1:p1", ["Left"], undefined, m.regionSignature],
    ]);
  });

  it("back refuses when the review declares no backKeys, sending nothing", async () => {
    const declared = keysModel(reviewBuffer());
    if (declared.phase !== "review") throw new Error("fixture is not a review screen");
    const { backKeys: _dropped, ...m } = declared;
    mockFetchPane.mockResolvedValue(paneWith(reviewBuffer()));
    const res = await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind: "back" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockFetchPane).not.toHaveBeenCalled();
  });

  it("back refuses on the checkbox phase, sending nothing", async () => {
    const m = keysModel(checkboxBuffer({}));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    const res = await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind: "back" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("advance refuses a drifted checkbox at the entry guard, before any key", async () => {
    const m = keysModel(checkboxBuffer({ checked: [] }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ checked: [2] }))); // a box flipped
    const res = await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("confirm, cancel and back refuse a drifted review at the entry guard, before any key", async () => {
    const m = keysModel(reviewBuffer());
    // The review now warns about an unanswered question: a different screen than the one tapped.
    mockFetchPane.mockResolvedValue(paneWith(reviewBuffer({ incomplete: true })));
    for (const kind of ["confirm", "cancel", "back"] as const) {
      expect(await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind } })).toEqual({
        status: "changed",
      });
    }
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("refuses when the fresh screen carries different plans than the tapped model", async () => {
    // The tapped model declares Tab; the adapter now derives Tab too, but the tap carried Right.
    // SAFETY: the spread base IS a checkbox MultiSelectModel and only the declared optional
    // `advanceKeys` is overridden; the cast only restores the discriminant the spread widened.
    const m = { ...keysModel(checkboxBuffer({})), advanceKeys: ["Right"] } as MultiSelectModel;
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    const res = await submitMultiSelectIntent({ ...keysBase, multi: m, intent: { kind: "advance" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// Every declared plan and the echoed answers are part of the screen's identity: a plan that changed
// would send a key the button did not advertise, and a changed answer is a different review.
describe("comparators — declared plans and answers", () => {
  const checkbox = keysHarness.declare(model(checkboxBuffer({})));
  const review = keysHarness.declare(model(reviewBuffer()));
  // SAFETY: each spread base IS a MultiSelectModel of the phase the overridden field belongs to, and
  // only declared fields are overridden; the casts restore the discriminant the spread widened.
  const variants: [string, MultiSelectModel, MultiSelectModel][] = [
    ["advanceKeys differ", checkbox, { ...checkbox, advanceKeys: ["Right"] } as MultiSelectModel],
    ["advanceKeys absent", checkbox, { ...checkbox, advanceKeys: undefined } as MultiSelectModel],
    ["submitKeys differ", review, { ...review, submitKeys: ["1"] } as MultiSelectModel],
    ["cancelKeys differ", review, { ...review, cancelKeys: ["2"] } as MultiSelectModel],
    ["backKeys differ", review, { ...review, backKeys: ["Tab"] } as MultiSelectModel],
    ["backKeys absent", review, { ...review, backKeys: undefined } as MultiSelectModel],
    [
      "an answer differs",
      review,
      { ...review, answers: [{ question: "Toppings", answer: "Cheese" }] } as MultiSelectModel,
    ],
    [
      "a question differs",
      review,
      { ...review, answers: [{ question: "Crust", answer: "Cheese, Olives" }] } as MultiSelectModel,
    ],
    ["answers absent", review, { ...review, answers: undefined } as MultiSelectModel],
    [
      "keys mode vs digit mode",
      review,
      {
        ...review,
        submit: "digit",
        submitKeys: undefined,
        cancelKeys: undefined,
      } as MultiSelectModel,
    ],
  ];

  for (const [label, a, b] of variants) {
    it(`${label}: breaks both equality and identity`, () => {
      expect(multiSelectEquals(a, b)).toBe(false);
      expect(multiSelectIdentity(a, b)).toBe(false);
    });
  }

  it("the same declared screen still equals itself", () => {
    expect(multiSelectEquals(checkbox, keysHarness.declare(model(checkboxBuffer({}))))).toBe(true);
    expect(multiSelectIdentity(review, keysHarness.declare(model(reviewBuffer())))).toBe(true);
    expect(multiSelectEquals(review, keysHarness.declare(model(reviewBuffer())))).toBe(true);
  });
});
