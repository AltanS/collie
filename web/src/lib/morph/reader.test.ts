import type { JsonValue } from "@/lib/json";
import type { TranscriptEntry } from "@/lib/types";

import { morphStateOf, nodeAtControl, tapTextOf, textAnswerAfter, withMorphHint } from "./reader";
import { parseMorphView, type MorphView } from "./wire";

const HINT = "(answer with collie morph show)";

function entry(role: TranscriptEntry["role"], ts: string, text: string): TranscriptEntry {
  return { uuid: `${role}-${ts}`, ts, role, parts: [{ kind: "text", text }] };
}

function screenOf(raw: JsonValue): MorphView {
  const parsed = parseMorphView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return { rev: 1, at: "2026-11-10T10:00:00.000Z", view: parsed.view };
}

describe("withMorphHint", () => {
  it("appends the hint after one space, on one line", () => {
    expect(withMorphHint({ text: "Show me the plan", hint: HINT, attachments: 0 })).toBe(`Show me the plan ${HINT}`);
  });

  it("adds no hint to a slash command, a shell line or a file mention", () => {
    expect(withMorphHint({ text: "/compact", hint: HINT, attachments: 0 })).toBe("/compact");
    expect(withMorphHint({ text: "!ls", hint: HINT, attachments: 0 })).toBe("!ls");
    expect(withMorphHint({ text: "@notes.md", hint: HINT, attachments: 0 })).toBe("@notes.md");
  });

  it("adds no hint to a send with attachments, and none when there is no hint", () => {
    expect(withMorphHint({ text: "look at this", hint: HINT, attachments: 1 })).toBe("look at this");
    expect(withMorphHint({ text: "plain", hint: undefined, attachments: 0 })).toBe("plain");
    expect(withMorphHint({ text: "plain", hint: "  ", attachments: 0 })).toBe("plain");
  });
});

describe("textAnswerAfter", () => {
  const at = "2026-11-10T10:00:00.000Z";

  it("is the reply to a request made after the screen was drawn", () => {
    const entries = [
      entry("user", "2026-11-10T09:59:00.000Z", "draw the plan"),
      entry("assistant", "2026-11-10T10:00:05.000Z", "Drew it."),
      entry("user", "2026-11-10T10:01:00.000Z", "what is step two?"),
      entry("assistant", "2026-11-10T10:01:10.000Z", "Step two is the test run."),
    ];
    expect(textAnswerAfter(entries, at)).toEqual({ text: "Step two is the test run.", ts: "2026-11-10T10:01:10.000Z" });
  });

  it("ignores the reply that ends the turn in which the screen was drawn", () => {
    const entries = [entry("user", "2026-11-10T09:59:00.000Z", "draw the plan"), entry("assistant", "2026-11-10T10:00:05.000Z", "Drew it.")];
    expect(textAnswerAfter(entries, at)).toBeNull();
  });

  it("is null while the newest request has no reply yet", () => {
    const entries = [
      entry("user", "2026-11-10T10:01:00.000Z", "one"),
      entry("assistant", "2026-11-10T10:01:10.000Z", "answer one"),
      entry("user", "2026-11-10T10:02:00.000Z", "two"),
    ];
    expect(textAnswerAfter(entries, at)).toBeNull();
  });
});

describe("morphStateOf", () => {
  const view = screenOf([{ kind: "para", text: "Hi" }]);
  const answer = { text: "words", ts: "2026-11-10T10:01:10.000Z" };

  it("names the four states", () => {
    expect(morphStateOf({ view: undefined, working: false, answer: null })).toBe("empty");
    expect(morphStateOf({ view, working: true, answer })).toBe("working");
    expect(morphStateOf({ view, working: false, answer })).toBe("text");
    expect(morphStateOf({ view, working: false, answer: null })).toBe("view");
  });
});

describe("tapTextOf", () => {
  const view = screenOf([
    { kind: "bar", kids: [{ kind: "button", attrs: { label: "Approve", intent: "approve", value: "Approve the plan" } }, { kind: "button", attrs: { label: "Skip", intent: "skip" } }] },
  ]).view;

  it("is the button's value when it has one, else its label", () => {
    expect(tapTextOf({ view, control: "v/0/0" })).toBe("Approve the plan");
    expect(tapTextOf({ view, control: "v/0/1" })).toBe("Skip");
  });

  it("is null for a control that names no button", () => {
    expect(tapTextOf({ view, control: "v/0" })).toBeNull();
    expect(tapTextOf({ view, control: "v/9/0" })).toBeNull();
    expect(nodeAtControl(view, "x/0")).toBeUndefined();
  });
});
