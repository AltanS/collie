import { describe, expect, it, beforeEach, vi } from "vitest";

// The multi-select choreography engine: the entry guard + the Submit macro (walk the pointer DOWN
// onto "Submit", re-reading each step, then Enter) and the one-keystroke intents (toggle / escape /
// confirm / cancel). The api layer is mocked so the mid-flight pane states can be sequenced precisely;
// the detector is the real thing, driven by synthetic plain-text buffers in the verified layout.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MultiSelectModel } from "./blocks";
import { detectMultiSelect } from "./harness/claude/multi-select";
import {
  multiSelectEquals,
  multiSelectIdentity,
  submitMultiSelectIntent,
} from "./multi-select-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

type Pointer = "opt1" | "opt2" | "opt3" | "opt4" | "free" | "submit" | "chat" | "none";

// A synthetic checkbox screen in the verified layout: stepper, question, four checkbox rows, the
// free-text row, a navigable Submit row, a rule, the "Chat about this" escape, and the select footer.
// `pointer` places the ❯; `checked` marks rows.
function checkboxBuffer(
  opts: { pointer?: Pointer; checked?: number[]; question?: string } = {},
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
  // pointerAt classifies it as a non-Submit row, so the Submit walk must nudge past it, never Enter.
  const freeRow = (pointer === "free" ? "❯ " : "  ") + "5. [ ] Type something";
  return [
    "←  ☐ Toppings  ✔ Submit  →",
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
const base = { paneId: "w1:p1", requestedLines: 600, detectedRevision: 5, sleep: noSleep };
const keysSent = () => mockSendKeys.mock.calls.map((c) => c[1]);

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
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
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["3"], undefined]]);
  });

  it("escape sends the 'Chat about this' digit", async () => {
    const m = model(checkboxBuffer({}));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({})));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "escape" } });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["6"], undefined]]);
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
    expect(keysSent()).toEqual([["1"], ["2"]]);
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
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Down"], ["Down"], ["Enter"]]);
  });

  it("re-sends Down when a key is swallowed (the re-read still shows an option row)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    script(
      checkboxBuffer({ pointer: "opt1" }), // entry guard
      checkboxBuffer({ pointer: "opt2" }), // read: option → Down
      checkboxBuffer({ pointer: "opt2" }), // read: STILL option (Down swallowed) → Down again
      checkboxBuffer({ pointer: "submit" }), // read: Submit → Enter
    );
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
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
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    expect(res).toEqual({ status: "sent" });
    expect(keysSent()).toEqual([["Up"], ["Enter"]]);
  });

  it("NEVER Enters when the pointer never reaches Submit within the bounded walk", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // Every read shows an option row — the pointer never converges on Submit, so the bounded walk
    // exhausts and refreshes rather than blind-sending an Enter at an unverified row.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "opt2" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true); // only ever nudged downward
  });

  it("NEVER Enters when the pointer sits on the free-text row — nudges past it, never activates", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // The ❯ parked on "5. [ ] Type something" (the composer row) reads as a non-Submit row, so the
    // walk only ever nudges Down — it must never mistake it for Submit and blind-Enter.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "free" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).not.toContainEqual(["Enter"]);
    expect(keysSent().every((k) => k[0] === "Down")).toBe(true);
  });

  it("NEVER Enters when NO row carries the pointer (pointer null throughout)", async () => {
    const m = model(checkboxBuffer({ pointer: "opt1" }));
    // A redraw with the ❯ absent → pointer null → still not Submit, so the walk nudges Down and never
    // blind-Enters at an unverified row.
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ pointer: "none" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
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
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    expect(res).toEqual({ status: "changed" });
    expect(keysSent()).toEqual([["Down"]]); // drift detected on the read, before any further key
    expect(keysSent()).not.toContainEqual(["Enter"]);
  });

  it("rejects at the entry guard (no keys at all) when the dialog already changed", async () => {
    const m = model(checkboxBuffer({ checked: [] }));
    mockFetchPane.mockResolvedValue(paneWith(checkboxBuffer({ question: "Different?" })));
    const res = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
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

    const first = submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
    // The second tap lands while the first is parked mid-flight → rejected before any read/send.
    const second = await submitMultiSelectIntent({ ...base, multi: m, intent: { kind: "submit" } });
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
