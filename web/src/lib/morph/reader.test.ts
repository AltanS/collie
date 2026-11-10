import type { JsonValue } from "@/lib/json";
import type { TranscriptEntry } from "@/lib/types";

import {
  choiceControl,
  isUnanswered,
  latestRequestIn,
  morphRequestOf,
  morphStateOf,
  morphStatusOf,
  nodeAtControl,
  parentControl,
  pickedOption,
  picksAfter,
  pickTextOf,
  picksFor,
  requestAfter,
  stripMorphHint,
  tapTextOf,
  textAnswerAfter,
  withMorphHint,
  withPressed,
  type MorphRequest,
} from "./reader";
import { MORPH_DRAWING_MAX_MS, parseMorphView, type MorphView } from "./wire";

const HINT = "[rules: /bin/collie morph help --session local/w1:p1#ab12]";
const HEAD = "[morph] from operator:";

function entry(role: TranscriptEntry["role"], ts: string, text: string): TranscriptEntry {
  return { uuid: `${role}-${ts}`, ts, role, parts: [{ kind: "text", text }] };
}

function screenOf(raw: JsonValue): MorphView {
  const parsed = parseMorphView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return { rev: 1, at: "2026-11-10T10:00:00.000Z", view: parsed.view };
}

describe("withMorphHint", () => {
  it("puts the head in front and the hint behind, on one line", () => {
    expect(withMorphHint({ text: "Show me the plan", hint: HINT, head: HEAD, attachments: 0 })).toBe(`${HEAD} Show me the plan ${HINT}`);
  });

  it("sends the hint alone behind the text for a session whose bridge served no head", () => {
    expect(withMorphHint({ text: "Show me the plan", hint: HINT, attachments: 0 })).toBe(`Show me the plan ${HINT}`);
    expect(withMorphHint({ text: "Show me the plan", hint: HINT, head: "  ", attachments: 0 })).toBe(`Show me the plan ${HINT}`);
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
    // A text answer with no screen is still an answer.
    expect(morphStateOf({ view: undefined, working: false, answer })).toBe("text");
    expect(morphStateOf({ view, working: true, answer })).toBe("working");
    expect(morphStateOf({ view, working: false, answer })).toBe("text");
    expect(morphStateOf({ view, working: false, answer: null })).toBe("view");
  });
});

describe("tapTextOf", () => {
  const view = screenOf([
    { kind: "bar", kids: [{ kind: "button", attrs: { label: "Approve", intent: "approve", value: "Approve the plan" } }, { kind: "button", attrs: { label: "Skip", intent: "skip" } }, { kind: "button", attrs: { label: "Same", intent: "same", value: "Same" } }] },
    { kind: "group", attrs: { label: "Speed" }, kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Fast", intent: "pick" } }, { kind: "button", attrs: { label: "Slow", intent: "pick", value: "slowly" } }] }] },
    { kind: "group", kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Plain", intent: "pick" } }] }] },
  ]).view;

  it("says tapped with the label, and the value after a colon when it is more than the label", () => {
    expect(tapTextOf({ view, control: "v/0/0" })).toBe('tapped "Approve": Approve the plan');
    expect(tapTextOf({ view, control: "v/0/1" })).toBe('tapped "Skip"');
    expect(tapTextOf({ view, control: "v/0/2" })).toBe('tapped "Same"');
  });

  it("names the labelled group before the colon, and none for a group without a label", () => {
    expect(tapTextOf({ view, control: "v/1/0/0" })).toBe('tapped "Fast" in "Speed"');
    expect(tapTextOf({ view, control: "v/1/0/1" })).toBe('tapped "Slow" in "Speed": slowly');
    expect(tapTextOf({ view, control: "v/2/0/0" })).toBe('tapped "Plain"');
  });

  it("is null for a control that names no button", () => {
    expect(tapTextOf({ view, control: "v/0" })).toBeNull();
    expect(tapTextOf({ view, control: "v/9/0" })).toBeNull();
    expect(nodeAtControl(view, "x/0")).toBeUndefined();
  });
});

describe("withPressed", () => {
  const view = screenOf([
    { kind: "bar", kids: [{ kind: "button", attrs: { label: "A", intent: "pick" } }, { kind: "button", attrs: { label: "B", intent: "pick" } }] },
    { kind: "group", attrs: { label: "G" }, kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "C", intent: "pick" } }] }] },
  ]).view;
  const pressedAt = (v: typeof view, control: string): string | undefined => {
    const node = nodeAtControl(v, control);
    return node?.kind === "button" ? node.attrs.pressed : undefined;
  };

  it("marks the buttons at the given paths, in a group too, and leaves the view given alone", () => {
    const marked = withPressed(view, ["v/0/1", "v/1/0/0"]);
    expect(pressedAt(marked, "v/0/0")).toBeUndefined();
    expect(pressedAt(marked, "v/0/1")).toBe("true");
    expect(pressedAt(marked, "v/1/0/0")).toBe("true");
    expect(pressedAt(view, "v/0/1")).toBeUndefined();
  });

  it("is the same view for no path, and ignores a path that names no button", () => {
    expect(withPressed(view, [])).toBe(view);
    expect(withPressed(view, ["v/0", "v/7/0"])).toEqual(view);
  });

  it("names a button's parent: its siblings share it", () => {
    expect(parentControl("v/0/1")).toBe("v/0");
    expect(parentControl("v/1/0/0")).toBe("v/1/0");
  });
});

describe("stripMorphHint", () => {
  it("takes the head and the exact hint off", () => {
    expect(stripMorphHint(`${HEAD} Show me the plan ${HINT}`, { head: HEAD, hint: HINT })).toBe("Show me the plan");
  });

  it("takes a head and a rules tail off even when the wording changed since the send", () => {
    expect(stripMorphHint(`${HEAD} Show me the plan [rules: /other/bin/collie morph help --session local/w9:p9#zz99]`, { head: "[morph] from you:", hint: "[rules: x]" })).toBe("Show me the plan");
    expect(stripMorphHint(`${HEAD} tapped "Fast" in "Speed" ${HINT}`)).toBe('tapped "Fast" in "Speed"');
  });

  it("takes a head off alone, for a session that served none, and a tail alone", () => {
    expect(stripMorphHint(`Show me the plan ${HINT}`, { hint: HINT })).toBe("Show me the plan");
    expect(stripMorphHint(`${HEAD} Show me the plan`)).toBe("Show me the plan");
  });

  it("takes the one-bracket hint of an earlier build off too", () => {
    expect(stripMorphHint("Show me the plan [morph: read on Collie's Morph view. Answer with one screen: /bin/collie morph show <file.json>]")).toBe("Show me the plan");
  });

  it("leaves a text that carries neither, and a bracket that is not the hint, as it was", () => {
    expect(stripMorphHint("plain words")).toBe("plain words");
    expect(stripMorphHint("see [rules: no] here")).toBe("see [rules: no] here");
    expect(stripMorphHint("a [rules: be kind]")).toBe("a [rules: be kind]");
    expect(stripMorphHint("line one\n[rules: /bin/collie morph help]\nmore")).toBe("line one\n[rules: /bin/collie morph help]\nmore");
  });
});

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

describe("latestRequestIn and morphRequestOf", () => {
  const entries = [
    entry("user", iso(T0 - 60_000), `${HEAD} first ${HINT}`),
    entry("assistant", iso(T0 - 50_000), "Done."),
    entry("user", iso(T0), `${HEAD} second one ${HINT}`),
  ];

  it("is the latest person turn with its head and hint stripped", () => {
    expect(latestRequestIn(entries, { head: HEAD, hint: HINT })).toEqual({ text: "second one", at: T0 });
    expect(latestRequestIn([entry("assistant", iso(T0), "hello")], {})).toBeNull();
    expect(latestRequestIn([], {})).toBeNull();
  });

  it("skips a person turn that is only the hint, and an abandoned one", () => {
    const only = [entry("user", iso(T0 - 1000), "kept"), entry("user", iso(T0), `${HEAD} ${HINT}`), { ...entry("user", iso(T0 + 1000), "gone"), abandoned: true as const }];
    expect(latestRequestIn(only, { head: HEAD, hint: HINT })?.text).toBe("kept");
  });

  it("after a reload there is only the chat's turn; the composer's note wins while it is in flight or failed", () => {
    expect(morphRequestOf({ local: undefined, entries, wording: { head: HEAD, hint: HINT } })).toEqual({ text: "second one", at: T0, phase: "sent", reason: null });
    const sending: MorphRequest = { text: "typing now", phase: "sending", reason: null, at: T0 + 5000 };
    expect(morphRequestOf({ local: sending, entries, wording: {} })).toBe(sending);
    const failed: MorphRequest = { ...sending, phase: "failed", reason: "No link" };
    expect(morphRequestOf({ local: failed, entries, wording: {} })).toBe(failed);
  });

  it("once sent, a newer person turn that says something else (typed in the terminal) takes over", () => {
    const sent: MorphRequest = { text: "second one", phase: "sent", reason: null, at: T0 - 100 };
    expect(morphRequestOf({ local: sent, entries, wording: { head: HEAD, hint: HINT } })).toBe(sent);
    const typed = [...entries, entry("user", iso(T0 + 9000), "typed in the terminal")];
    expect(morphRequestOf({ local: sent, entries: typed, wording: {} })).toMatchObject({ text: "typed in the terminal", phase: "sent" });
  });
});

describe("morphStatusOf", () => {
  const request = (phase: MorphRequest["phase"], over: Partial<MorphRequest> = {}): MorphRequest => ({ text: "go", phase, reason: null, at: T0, ...over });
  const screen = (at: number): MorphView => ({ ...screenOf([{ kind: "para", text: "x" }]), at: iso(at) });
  const none: TranscriptEntry[] = [];
  const base = { view: undefined, drawing: undefined, working: false, entries: none, now: T0 + 1000 };

  it("is null with no request", () => {
    expect(morphStatusOf({ ...base, request: null })).toBeNull();
  });

  it("says Sending while the send is in flight, whatever else is true", () => {
    expect(morphStatusOf({ ...base, request: request("sending"), working: true })).toEqual({ kind: "sending" });
  });

  it("says Not sent, with the composer's words, for a send that failed", () => {
    expect(morphStatusOf({ ...base, request: request("failed", { reason: "The link is down" }) })).toEqual({ kind: "notSent", reason: "The link is down" });
    expect(morphStatusOf({ ...base, request: request("failed") })).toEqual({ kind: "notSent", reason: null });
  });

  it("says Sent once the bridge confirmed and the agent is not working yet", () => {
    expect(morphStatusOf({ ...base, request: request("sent") })).toEqual({ kind: "sent" });
  });

  it("says the agent is working once the pane's status is working", () => {
    expect(morphStatusOf({ ...base, request: request("sent"), working: true })).toEqual({ kind: "working" });
  });

  it("says Morphing, with the note, once the agent called start, newer than the request and the screen", () => {
    const drawing = { at: iso(T0 + 500), note: "Checking the tests" };
    expect(morphStatusOf({ ...base, request: request("sent"), drawing, working: true })).toEqual({ kind: "morphing", note: "Checking the tests" });
    expect(morphStatusOf({ ...base, request: request("sent"), drawing: { at: iso(T0 + 500) } })).toEqual({ kind: "morphing", note: null });
    // A start from before this request, or older than the screen, or ten minutes old, is not this request's.
    expect(morphStatusOf({ ...base, request: request("sent"), drawing: { at: iso(T0 - 5000) } })).toEqual({ kind: "sent" });
    expect(morphStatusOf({ ...base, request: request("sent"), drawing, now: T0 + 500 + MORPH_DRAWING_MAX_MS })).toEqual({ kind: "sent" });
  });

  it("says Answered with the screen's time once a screen newer than the request arrived", () => {
    expect(morphStatusOf({ ...base, request: request("sent"), view: screen(T0 + 2000), working: true })).toEqual({ kind: "answered", at: iso(T0 + 2000) });
    // An older screen is the old answer.
    expect(morphStatusOf({ ...base, request: request("sent"), view: screen(T0 - 2000) })).toEqual({ kind: "sent" });
  });

  it("says Answered when the turn ended with a text answer, and not while the agent still works", () => {
    const entries = [entry("user", iso(T0 + 100), "go"), entry("assistant", iso(T0 + 4000), "Here is the answer.")];
    expect(morphStatusOf({ ...base, request: request("sent"), entries })).toEqual({ kind: "answered", at: iso(T0 + 4000) });
    expect(morphStatusOf({ ...base, request: request("sent"), entries, working: true })).toEqual({ kind: "working" });
  });

  it("for a request read back from the chat, the same rules hold against its own time", () => {
    const entries = [entry("user", iso(T0), "go")];
    expect(morphStatusOf({ ...base, request: request("sent"), entries })).toEqual({ kind: "sent" });
    expect(morphStatusOf({ ...base, request: request("sent"), entries, view: screen(T0 + 3000) })).toEqual({ kind: "answered", at: iso(T0 + 3000) });
  });

  it("a request is unanswered unless it failed or was answered", () => {
    expect(isUnanswered(null)).toBe(false);
    expect(isUnanswered({ kind: "sending" })).toBe(true);
    expect(isUnanswered({ kind: "sent" })).toBe(true);
    expect(isUnanswered({ kind: "working" })).toBe(true);
    expect(isUnanswered({ kind: "morphing", note: null })).toBe(true);
    expect(isUnanswered({ kind: "notSent", reason: null })).toBe(false);
    expect(isUnanswered({ kind: "answered", at: iso(T0) })).toBe(false);
  });
});

describe("the operator's picks", () => {
  const here = { address: "local/w1:p1#ab12", rev: 3 };

  it("a tap the bridge confirmed marks that button", () => {
    const picks = picksAfter(null, { ...here, control: "v/0/1" });
    expect(picksFor(picks, here)).toEqual(["v/0/1"]);
  });

  it("a tap on a sibling in the same bar moves the mark", () => {
    const first = picksAfter(null, { ...here, control: "v/0/1" });
    const moved = picksAfter(first, { ...here, control: "v/0/2" });
    expect(picksFor(moved, here)).toEqual(["v/0/2"]);
  });

  it("a tap in another group keeps both marks", () => {
    const first = picksAfter(null, { ...here, control: "v/0/1" });
    const both = picksAfter(first, { ...here, control: "v/1/0/0" });
    expect(picksFor(both, here)).toEqual(["v/0/1", "v/1/0/0"]);
  });

  it("a new rev clears every mark, and another session has none", () => {
    const picks = picksAfter(picksAfter(null, { ...here, control: "v/0/1" }), { ...here, control: "v/1/0/0" });
    expect(picksFor(picks, { ...here, rev: 4 })).toEqual([]);
    expect(picksFor(picks, { address: "local/w2:p2#cd34", rev: 3 })).toEqual([]);
    expect(picksFor(picks, { ...here, rev: undefined })).toEqual([]);
    // A pick on the new screen starts again.
    expect(picksFor(picksAfter(picks, { ...here, rev: 4, control: "v/0/0" }), { ...here, rev: 4 })).toEqual(["v/0/0"]);
  });
});

describe("requestAfter", () => {
  it("stamps the start of a send, and keeps the time for its end", () => {
    const started = requestAfter(undefined, { text: "go", phase: "sending", reason: null }, 1000);
    expect(started).toEqual({ text: "go", phase: "sending", reason: null, at: 1000 });
    expect(requestAfter(started, { text: "go", phase: "sent", reason: null }, 5000)).toEqual({ text: "go", phase: "sent", reason: null, at: 1000 });
    expect(requestAfter(started, { text: "go", phase: "failed", reason: "No link" }, 5000)).toMatchObject({ phase: "failed", reason: "No link", at: 1000 });
  });

  it("a note about another text, a new start, or a failure with no start, is a new request", () => {
    const held = requestAfter(undefined, { text: "go", phase: "sent", reason: null }, 1000);
    expect(requestAfter(held, { text: "again", phase: "sending", reason: null }, 7000).at).toBe(7000);
    expect(requestAfter(held, { text: "go", phase: "sending", reason: null }, 8000).at).toBe(8000);
    expect(requestAfter(undefined, { text: "go", phase: "failed", reason: "Offline" }, 9000)).toMatchObject({ at: 9000, phase: "failed" });
  });
});

describe("the decision block's words", () => {
  const choice = { options: [{ label: "Cards", value: "Use cards." }, { label: "Table" }, { label: "Same", value: "Same" }] };

  it("sends picked with the value after a colon, the label alone without one or when they match", () => {
    expect(pickTextOf(choice, 0)).toBe('picked "Cards": Use cards.');
    expect(pickTextOf(choice, 1)).toBe('picked "Table"');
    expect(pickTextOf(choice, 2)).toBe('picked "Same"');
    expect(pickTextOf(choice, 3)).toBeNull();
  });

  it("files a pick beside the view's controls and reads it back", () => {
    expect(choiceControl(2)).toBe("choice/2");
    expect(pickedOption(["v/1/0", "choice/2"])).toBe(2);
    expect(pickedOption(["v/1/0"])).toBeNull();
    expect(parentControl(choiceControl(0))).toBe(parentControl(choiceControl(4)));
  });
});
