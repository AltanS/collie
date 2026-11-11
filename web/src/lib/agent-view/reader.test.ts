import type { JsonValue } from "@/lib/json";
import type { View } from "@/lib/tricks/schema";
import type { TranscriptEntry } from "@/lib/types";

import {
  blockControl,
  choiceControl,
  choicePrefix,
  isUnanswered,
  livePrefixes,
  latestRequestIn,
  optionControl,
  parentControl,
  pickedOption,
  pickReceiptOf,
  picksAfter,
  picksFor,
  pressedNode,
  renderedControl,
  requestAfter,
  requestNotes,
  screenBlocks,
  screenControl,
  sentWords,
  shownLinkText,
  shownTrickName,
  splitScreen,
  textAnswerAfter,
  viewRequestOf,
  viewStateOf,
  viewStatusOf,
  viewTurnText,
  withPressed,
  withTrueLinks,
  type ViewRequest,
} from "./reader";
import { parseAgentView, VIEW_DRAWING_MAX_MS, viewTapWords, type ViewScreen, type ViewSent } from "./wire";

const ADDRESS = "lodge/w1:p1#ab12";
const HEAD = `[view:plan ${ADDRESS}] from operator:`;
const TAIL = `[rules: /bin/collie trick view plan help --session ${ADDRESS}]`;

function entry(role: TranscriptEntry["role"], ts: string, text: string): TranscriptEntry {
  return { uuid: `${role}-${ts}`, ts, role, parts: [{ kind: "text", text }] };
}

function screenOf(raw: JsonValue): ViewScreen {
  const parsed = parseAgentView(raw);
  if (parsed.view === undefined) throw new Error(JSON.stringify(parsed.refusals));
  return { rev: 1, at: "2026-11-10T10:00:00.000Z", view: parsed.view };
}

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function sentLine(rid: string, at: number, line: string, kind: ViewSent["kind"] = "text"): ViewSent {
  return { rid, at: iso(at), kind, line };
}

describe("shownTrickName", () => {
  it("keeps a name of twelve characters or fewer whole", () => {
    expect(shownTrickName("plan")).toBe("plan");
    expect(shownTrickName("123456789012")).toBe("123456789012");
  });

  it("cuts a longer name to eleven characters and a cut mark", () => {
    expect(shownTrickName("1234567890123")).toBe("12345678901…");
    expect(shownTrickName("release-checklist")).toBe("release-che…");
  });

  it("counts characters, not code units, and drops the blanks around the name", () => {
    expect(shownTrickName("  plan  ")).toBe("plan");
    expect(shownTrickName("🐕".repeat(13))).toBe(`${"🐕".repeat(11)}…`);
  });
});

describe("shownLinkText and withTrueLinks", () => {
  it("shows the target when the words read as an address and differ from it", () => {
    expect(shownLinkText("https://good.example/docs", "https://evil.example/x")).toBe("https://evil.example/x");
    expect(shownLinkText("www.good.example", "https://evil.example/x")).toBe("https://evil.example/x");
    expect(shownLinkText("good.example/docs", "https://evil.example/x")).toBe("https://evil.example/x");
  });

  it("keeps words that are no address, and an address that is the target itself", () => {
    expect(shownLinkText("Read the docs", "https://good.example/docs")).toBe("Read the docs");
    expect(shownLinkText("https://good.example/docs", "https://good.example/docs")).toBe("https://good.example/docs");
    expect(shownLinkText(" https://good.example/docs ", "https://good.example/docs")).toBe(" https://good.example/docs ");
  });

  it("holds every link and linked run of a view, in a group too, and leaves the view given alone", () => {
    const view: View = [
      { kind: "para", kids: [{ kind: "link", text: "https://good.example", attrs: { href: "https://evil.example/x" } }, { kind: "run", text: "see www.a.example", attrs: { href: "https://evil.example/y" } }] },
      { kind: "group", kids: [{ kind: "para", kids: [{ kind: "link", text: "The docs", attrs: { href: "https://good.example/docs" } }, { kind: "run", text: "a.example", attrs: { href: "https://evil.example/z" } }] }] },
    ];
    const before = JSON.stringify(view);
    const fixed = withTrueLinks(view);
    const texts = JSON.stringify(fixed);
    expect(texts).toContain('"text":"https://evil.example/x"');
    expect(texts).toContain('"text":"see www.a.example"');
    expect(texts).toContain('"text":"The docs"');
    expect(texts).toContain('"text":"https://evil.example/z"');
    expect(texts).not.toContain('"text":"https://good.example"');
    expect(JSON.stringify(view)).toBe(before);
  });

  it("returns the same nodes for a view with no such link", () => {
    const view = screenOf([{ kind: "para", text: "Hi" }]).view;
    expect(withTrueLinks(view)).toEqual(view);
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

describe("viewStateOf", () => {
  const view = screenOf([{ kind: "para", text: "Hi" }]);

  it("names the five states from where the request stands", () => {
    expect(viewStateOf({ view: undefined, status: null })).toBe("empty");
    expect(viewStateOf({ view, status: null })).toBe("view");
    expect(viewStateOf({ view, status: { kind: "working" } })).toBe("working");
    expect(viewStateOf({ view, status: { kind: "sending" } })).toBe("working");
    expect(viewStateOf({ view, status: { kind: "drawing" } })).toBe("working");
    expect(viewStateOf({ view: undefined, status: { kind: "answered", at: view.at } })).toBe("answered");
    expect(viewStateOf({ view, status: { kind: "notSent", reason: null } })).toBe("notSent");
  });
});

describe("withPressed", () => {
  const view = screenOf([
    { kind: "bar", kids: [{ kind: "button", attrs: { label: "A", intent: "pick" } }, { kind: "button", attrs: { label: "B", intent: "pick" } }] },
    { kind: "group", attrs: { label: "G" }, kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "C", intent: "pick" } }] }] },
  ]).view;
  const pressedAt = (v: View, control: string): string | undefined => {
    const node = nodeAtPath(v, control);
    return node?.kind === "button" ? node.attrs.pressed : undefined;
  };

  /** The node at a renderer path, for the checks only. */
  function nodeAtPath(v: View, control: string) {
    const steps = control.split("/").slice(1).map(Number);
    let list: View = v;
    let node: View[number] | undefined;
    for (const step of steps) {
      node = list[step];
      // SAFETY: a node's `kids` is a list of view nodes by the schema; the screen came from parseAgentView.
      list = node !== undefined && "kids" in node && Array.isArray(node.kids) ? (node.kids as View) : [];
    }
    return node;
  }

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

describe("sentWords", () => {
  it("takes the head that names the trick and the session off, with or without the tail", () => {
    expect(sentWords(`${HEAD} Show me the plan ${TAIL}`)).toBe("Show me the plan");
    expect(sentWords(`${HEAD} Show me the plan`)).toBe("Show me the plan");
    expect(sentWords(`${HEAD} tapped "Fast" in "Speed" ${TAIL}`)).toBe('tapped "Fast" in "Speed"');
  });

  it("takes the head off when it names the trick alone, and a tail off alone", () => {
    expect(sentWords("[view:plan] from operator: Show me the plan")).toBe("Show me the plan");
    expect(sentWords(`Show me the plan ${TAIL}`)).toBe("Show me the plan");
  });

  it("takes the head off a session address with blanks in it", () => {
    expect(sentWords("[view:plan 'lodge/a b#ab12'] from operator: tapped \"Ship\"")).toBe('tapped "Ship"');
  });

  it("leaves a bracket that only looks like a head or a tail alone", () => {
    expect(sentWords("[view:plan] from someone: hi")).toBe("[view:plan] from someone: hi");
    expect(sentWords("say [view:plan x] from operator: later")).toBe("say [view:plan x] from operator: later");
    expect(sentWords("see [rules: no] here")).toBe("see [rules: no] here");
    expect(sentWords("line one\n[rules: /bin/collie trick view plan help]\nmore")).toBe("line one\n[rules: /bin/collie trick view plan help]\nmore");
  });
});

describe("viewTurnText", () => {
  const line = `${HEAD} Show me the plan ${TAIL}`;
  const lines = new Set([line, `${HEAD} tapped "Ship"`]);

  it("strips head and tail when the text is exactly a line the bridge sent", () => {
    expect(viewTurnText(line, lines)).toBe("Show me the plan");
    expect(viewTurnText(`${HEAD} tapped "Ship"`, lines)).toBe('tapped "Ship"');
  });

  it("strips a sent line that comes with blanks around it", () => {
    expect(viewTurnText(`\n${line}  `, lines)).toBe("Show me the plan");
  });

  it("leaves a look-alike line the bridge did not send whole", () => {
    const lookAlike = `${HEAD} Show me something else ${TAIL}`;
    expect(viewTurnText(lookAlike, lines)).toBe(lookAlike);
    expect(viewTurnText(`${HEAD} Show me the plan`, lines)).toBe(`${HEAD} Show me the plan`);
    expect(viewTurnText(line, new Set())).toBe(line);
  });

  it("leaves a plain text alone", () => {
    expect(viewTurnText("plain words", lines)).toBe("plain words");
  });
});

describe("latestRequestIn and viewRequestOf", () => {
  const first = `${HEAD} first ${TAIL}`;
  const second = `${HEAD} second one ${TAIL}`;
  const entries = [entry("user", iso(T0 - 60_000), first), entry("assistant", iso(T0 - 50_000), "Done."), entry("user", iso(T0), second)];
  const sent = [sentLine("r1", T0 - 59_000, first), sentLine("r2", T0 + 200, second)];
  const lines = new Set(sent.map((item) => item.line));

  it("is the latest person turn, drawn without head and tail when the bridge sent that line", () => {
    expect(latestRequestIn(entries, lines)).toEqual({ text: "second one", at: T0, line: second });
    expect(latestRequestIn([entry("assistant", iso(T0), "hello")], lines)).toBeNull();
    expect(latestRequestIn([], lines)).toBeNull();
  });

  it("keeps a look-alike turn the bridge did not send whole, with no line", () => {
    expect(latestRequestIn(entries, new Set([first]))).toEqual({ text: second, at: T0, line: null });
    expect(latestRequestIn([entry("user", iso(T0), "typed words")], lines)).toEqual({ text: "typed words", at: T0, line: null });
  });

  it("skips a person turn that is only the head, and an abandoned one", () => {
    const bare = `${HEAD}`;
    const only = [entry("user", iso(T0 - 1000), "kept"), entry("user", iso(T0), bare), { ...entry("user", iso(T0 + 1000), "gone"), abandoned: true as const }];
    expect(latestRequestIn(only, new Set([bare]))?.text).toBe("kept");
  });

  it("skips a slash command and a shell line, and keeps an @ turn", () => {
    expect(latestRequestIn([entry("user", iso(T0), "/model")], lines)).toBeNull();
    const compact = `${HEAD} /compact ${TAIL}`;
    expect(latestRequestIn([entry("user", iso(T0), compact)], new Set([compact]))).toBeNull();
    expect(latestRequestIn([entry("user", iso(T0), "!ls")], lines)).toBeNull();
    expect(latestRequestIn([entry("user", iso(T0), "@notes.md summarise it")], lines)?.text).toBe("@notes.md summarise it");
    const real = [entry("user", iso(T0 - 1000), "real prompt"), entry("assistant", iso(T0 - 500), "Done."), entry("user", iso(T0), "/model")];
    expect(latestRequestIn(real, lines)).toEqual({ text: "real prompt", at: T0 - 1000, line: null });
    const shell = [entry("user", iso(T0 - 1000), "real prompt"), entry("user", iso(T0), "!ls")];
    expect(latestRequestIn(shell, lines)?.text).toBe("real prompt");
  });

  it("a journal with only a slash command holds no request and no status", () => {
    const only = [entry("user", iso(T0), "/model")];
    const request = viewRequestOf({ local: undefined, entries: only, sent: [] });
    expect(request).toBeNull();
    expect(viewStatusOf({ request, view: undefined, drawing: undefined, working: false, entries: only, now: T0 + 1000 })).toBeNull();
  });

  it("a request sent from the phone is not replaced by a later slash command or shell line", () => {
    const held: ViewRequest = { text: "second one", phase: "sent", reason: null, at: T0 - 100, line: second };
    const typed = [...entries, entry("user", iso(T0 + 9000), "/model"), entry("user", iso(T0 + 9500), "!ls")];
    expect(viewRequestOf({ local: held, entries: typed, sent })).toBe(held);
  });

  it("after a reload the chat's turn and the bridge's line make the request; the composer's note wins while in flight or failed", () => {
    expect(viewRequestOf({ local: undefined, entries, sent })).toEqual({ text: "second one", at: T0, phase: "sent", reason: null, line: second });
    const sending: ViewRequest = { text: "typing now", phase: "sending", reason: null, at: T0 + 5000, line: null };
    expect(viewRequestOf({ local: sending, entries, sent })).toBe(sending);
    const failed: ViewRequest = { ...sending, phase: "failed", reason: "No link" };
    expect(viewRequestOf({ local: failed, entries, sent })).toBe(failed);
  });

  it("takes the last sent line when the chat has not shown it yet", () => {
    expect(viewRequestOf({ local: undefined, entries: [], sent })).toEqual({ text: "second one", at: T0 + 200, phase: "sent", reason: null, line: second });
    expect(viewRequestOf({ local: undefined, entries: [], sent: [] })).toBeNull();
  });

  it("a typed turn that looks like a view line but was not sent keeps its head in the request", () => {
    const request = viewRequestOf({ local: undefined, entries, sent: [] });
    expect(request).toEqual({ text: second, at: T0, phase: "sent", reason: null, line: null });
  });

  it("once sent, a newer person turn that says something else (typed in the terminal) takes over", () => {
    const held: ViewRequest = { text: "second one", phase: "sent", reason: null, at: T0 - 100, line: second };
    expect(viewRequestOf({ local: held, entries, sent })).toBe(held);
    const typed = [...entries, entry("user", iso(T0 + 9000), "typed in the terminal")];
    expect(viewRequestOf({ local: held, entries: typed, sent })).toMatchObject({ text: "typed in the terminal", phase: "sent", line: null });
  });

  it("a held request with no line takes the bridge's line once the chat or the list names it", () => {
    const held: ViewRequest = { text: "second one", phase: "sent", reason: null, at: T0 - 100, line: null };
    expect(viewRequestOf({ local: held, entries, sent })).toEqual({ ...held, line: second });
    expect(viewRequestOf({ local: held, entries: [], sent })).toEqual({ ...held, line: second });
    expect(viewRequestOf({ local: held, entries: [], sent: [] })).toBe(held);
  });
});

describe("viewStatusOf", () => {
  const request = (phase: ViewRequest["phase"], over: Partial<ViewRequest> = {}): ViewRequest => ({ text: "go", phase, reason: null, at: T0, line: null, ...over });
  const screen = (at: number): ViewScreen => ({ ...screenOf([{ kind: "para", text: "x" }]), at: iso(at) });
  const none: TranscriptEntry[] = [];
  const base = { view: undefined, drawing: undefined, working: false, entries: none, now: T0 + 1000 };

  it("is null with no request", () => {
    expect(viewStatusOf({ ...base, request: null })).toBeNull();
  });

  it("says Sending while the send is in flight, whatever else is true", () => {
    expect(viewStatusOf({ ...base, request: request("sending"), working: true })).toEqual({ kind: "sending" });
  });

  it("says Not sent, with the composer's words, for a send that failed", () => {
    expect(viewStatusOf({ ...base, request: request("failed", { reason: "The link is down" }) })).toEqual({ kind: "notSent", reason: "The link is down" });
    expect(viewStatusOf({ ...base, request: request("failed") })).toEqual({ kind: "notSent", reason: null });
  });

  it("says Sent once the bridge confirmed and the agent is not working yet", () => {
    expect(viewStatusOf({ ...base, request: request("sent") })).toEqual({ kind: "sent" });
  });

  it("says the agent is working once the pane's status is working", () => {
    expect(viewStatusOf({ ...base, request: request("sent"), working: true })).toEqual({ kind: "working" });
  });

  it("says Drawing once the agent called start for this request, until a show ends it", () => {
    const drawing = { at: iso(T0 + 500), note: "Checking the tests" };
    expect(viewStatusOf({ ...base, request: request("sent"), drawing, working: true })).toEqual({ kind: "drawing" });
    expect(viewStatusOf({ ...base, request: request("sent"), drawing: { at: iso(T0 + 500) } })).toEqual({ kind: "drawing" });
    // A set after the start keeps the run: the drawing outlives a block edit, and the turn still runs.
    expect(viewStatusOf({ ...base, request: request("sent"), drawing, view: screen(T0 + 900), working: true })).toEqual({ kind: "drawing" });
    // A start from before this request, or ten minutes old, is not this request's.
    expect(viewStatusOf({ ...base, request: request("sent"), drawing: { at: iso(T0 - 5000) } })).toEqual({ kind: "sent" });
    expect(viewStatusOf({ ...base, request: request("sent"), drawing, now: T0 + 500 + VIEW_DRAWING_MAX_MS })).toEqual({ kind: "sent" });
  });

  it("says Answered once the turn is over and a block is fresh; a fresh block while the turn runs is not yet the answer", () => {
    expect(viewStatusOf({ ...base, request: request("sent"), view: screen(T0 + 2000) })).toEqual({ kind: "answered", at: iso(T0 + 2000) });
    expect(viewStatusOf({ ...base, request: request("sent"), view: screen(T0 + 2000), working: true })).toEqual({ kind: "working" });
    // An older screen is never promoted to the answer.
    expect(viewStatusOf({ ...base, request: request("sent"), view: screen(T0 - 2000) })).toEqual({ kind: "sent" });
  });

  it("a fresh choice alone is an answer too", () => {
    const view: ViewScreen = { ...screen(T0 - 2000), choice: { options: [{ label: "Yes" }] }, choiceAt: iso(T0 + 3000) };
    expect(viewStatusOf({ ...base, request: request("sent"), view })).toEqual({ kind: "answered", at: iso(T0 + 3000) });
  });

  it("says Answered when the turn ended with a text answer, and not while the agent still works", () => {
    const entries = [entry("user", iso(T0 + 100), "go"), entry("assistant", iso(T0 + 4000), "Here is the answer.")];
    expect(viewStatusOf({ ...base, request: request("sent"), entries })).toEqual({ kind: "answered", at: iso(T0 + 4000) });
    expect(viewStatusOf({ ...base, request: request("sent"), entries, working: true })).toEqual({ kind: "working" });
  });

  it("for a request read back from the chat, the same rules hold against its own time", () => {
    const entries = [entry("user", iso(T0), "go")];
    expect(viewStatusOf({ ...base, request: request("sent"), entries })).toEqual({ kind: "sent" });
    expect(viewStatusOf({ ...base, request: request("sent"), entries, view: screen(T0 + 3000) })).toEqual({ kind: "answered", at: iso(T0 + 3000) });
  });

  it("a request is unanswered unless it failed or was answered", () => {
    expect(isUnanswered(null)).toBe(false);
    expect(isUnanswered({ kind: "sending" })).toBe(true);
    expect(isUnanswered({ kind: "sent" })).toBe(true);
    expect(isUnanswered({ kind: "working" })).toBe(true);
    expect(isUnanswered({ kind: "drawing" })).toBe(true);
    expect(isUnanswered({ kind: "notSent", reason: null })).toBe(false);
    expect(isUnanswered({ kind: "answered", at: iso(T0) })).toBe(false);
  });
});

describe("fresh and stale blocks", () => {
  const view: ViewScreen = {
    rev: 3,
    at: iso(T0 + 2000),
    view: [
      { kind: "para", text: "old" },
      { kind: "para", text: "new" },
      { kind: "spacer" },
    ],
    blocks: [
      { id: "old", at: iso(T0 - 1000) },
      { id: "new", at: iso(T0 + 2000) },
      { id: "tests", at: iso(T0 + 1000), pending: "Running the tests" },
    ],
    choice: { options: [{ label: "Yes" }] },
    choiceAt: iso(T0 - 1000),
  };

  it("a block is fresh from the request's time on, stale before; the choice by its own time", () => {
    const split = splitScreen(view, T0);
    expect(split.fresh.map((block) => block.id)).toEqual(["new", "tests"]);
    expect(split.stale.map((block) => block.id)).toEqual(["old"]);
    expect(split.isChoiceFresh).toBe(false);
    expect(split.isChoiceStale).toBe(true);
    expect(split.freshAt).toBe(iso(T0 + 2000));
    expect(split.fresh[1]?.pending).toBe("Running the tests");
  });

  it("with no request time nothing is stale", () => {
    const split = splitScreen(view, null);
    expect(split.stale).toEqual([]);
    expect(split.isChoiceFresh).toBe(true);
  });

  it("a keep moves a block back to fresh; nothing fresh has no time", () => {
    expect(splitScreen(view, T0 + 5000).freshAt).toBeNull();
    const kept: ViewScreen = { ...view, blocks: [{ id: "old", at: iso(T0 + 6000) }, ...(view.blocks ?? []).slice(1)] };
    expect(splitScreen(kept, T0 + 5000).fresh.map((block) => block.id)).toEqual(["old"]);
  });

  it("the notes of this request only, newest last, four at most", () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({ at: iso(T0 + i * 100), note: `Step ${String(i)}` }));
    expect(requestNotes({ at: iso(T0), notes: [{ at: iso(T0 - 100), note: "Older" }, ...notes] }, T0).map((note) => note.note)).toEqual(["Step 2", "Step 3", "Step 4", "Step 5"]);
    expect(requestNotes({ at: iso(T0 + 1), note: "Only one" }, T0)).toEqual([{ at: iso(T0 + 1), note: "Only one" }]);
    expect(requestNotes(undefined, T0)).toEqual([]);
  });
});

describe("controls, keyed by block", () => {
  const view: ViewScreen = {
    rev: 1,
    at: iso(T0),
    view: [
      { kind: "para", text: "Pick" },
      { kind: "group", attrs: { label: "Release" }, kids: [{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship", intent: "reply" } }] }] },
    ],
    blocks: [
      { id: "intro", at: iso(T0) },
      { id: "ship", at: iso(T0) },
    ],
    choice: { question: "Which way?", options: [{ label: "Cards" }, { label: "Table" }] },
    choiceAt: iso(T0),
  };
  const [, ship] = screenBlocks(view);

  it("a tap inside a block's own render is filed under the block, and read back to that render's path", () => {
    expect(ship?.prefix).toMatch(/^b:ship#[a-z0-9]+$/);
    const control = blockControl(ship!.prefix, "v/0/0/0");
    expect(control).toBe(`${ship!.prefix}/0/0`);
    expect(renderedControl(ship!.prefix, control)).toBe("v/0/0/0");
    expect(renderedControl("b:intro#x", control)).toBeNull();
  });

  it("the control the bridge reads is the renderer's path over the whole screen, and the words it builds come from the bridge's rule", () => {
    const control = screenControl(ship!, "v/0/0/0");
    expect(control).toBe("v/1/0/0");
    expect(viewTapWords(view, control)).toBe('tapped "Ship" in "Release"');
    expect(viewTapWords(view, screenControl(screenBlocks(view)[0]!, "v/0"))).toBeNull();
  });

  it("an option of the decision block is read by its index", () => {
    expect(optionControl(1)).toBe("choice/1");
    expect(viewTapWords(view, optionControl(0))).toBe('picked "Cards"');
    expect(viewTapWords(view, optionControl(1))).toBe('picked "Table"');
    expect(viewTapWords(view, optionControl(2))).toBeNull();
  });

  it("a block's node is marked by the picks filed under it alone", () => {
    const marked = pressedNode(ship!, [`${ship!.prefix}/0/0`, "b:intro#zz/0"]);
    expect(JSON.stringify(marked)).toContain('"pressed":"true"');
  });

  it("the live prefixes are the blocks' and the choice's; a change of content is a new prefix", () => {
    const live = livePrefixes(view);
    expect(live.has(ship!.prefix)).toBe(true);
    expect(live.has(choicePrefix(view.choice!))).toBe(true);
    expect(livePrefixes(undefined).size).toBe(0);
    const changed = screenBlocks({ ...view, view: [view.view[0]!, { kind: "para", text: "Shipped" }] })[1];
    expect(changed?.prefix).not.toBe(ship!.prefix);
  });
});

describe("the operator's picks", () => {
  const key = "plan\u0000lodge/w1:p1#ab12";
  const live = new Set(["b:a#1", "b:b#2"]);
  const here = { key, live };

  it("a tap the bridge confirmed marks that button", () => {
    const picks = picksAfter(null, { ...here, control: "b:a#1/1" });
    expect(picksFor(picks, here)).toEqual(["b:a#1/1"]);
  });

  it("a tap on a sibling in the same bar moves the mark", () => {
    const first = picksAfter(null, { ...here, control: "b:a#1/1" });
    const moved = picksAfter(first, { ...here, control: "b:a#1/2" });
    expect(picksFor(moved, here)).toEqual(["b:a#1/2"]);
  });

  it("a tap in another block keeps both marks", () => {
    const first = picksAfter(null, { ...here, control: "b:a#1/1" });
    const both = picksAfter(first, { ...here, control: "b:b#2/0/0" });
    expect(picksFor(both, here)).toEqual(["b:a#1/1", "b:b#2/0/0"]);
  });

  it("a mark stays while its block holds the same content, through another rev, and goes with the block", () => {
    const picks = picksAfter(picksAfter(null, { ...here, control: "b:a#1/1" }), { ...here, control: "b:b#2/0/0" });
    expect(picksFor(picks, { key, live: new Set(["b:a#1", "b:b#9"]) })).toEqual(["b:a#1/1"]);
    expect(picksFor(picks, { key, live: new Set() })).toEqual([]);
  });

  it("a pick belongs to one view: another trick or another session has none", () => {
    const picks = picksAfter(null, { ...here, control: "b:a#1/1" });
    expect(picksFor(picks, { key: "other\u0000lodge/w1:p1#ab12", live })).toEqual([]);
    expect(picksFor(picks, { key: "plan\u0000lodge/w2:p2#cd34", live })).toEqual([]);
    expect(picksFor(null, here)).toEqual([]);
  });
});

describe("requestAfter", () => {
  it("stamps the start of a send, and keeps the time for its end", () => {
    const started = requestAfter(undefined, { text: "go", phase: "sending", reason: null }, 1000);
    expect(started).toEqual({ text: "go", phase: "sending", reason: null, line: null, at: 1000 });
    expect(requestAfter(started, { text: "go", phase: "sent", reason: null }, 5000)).toEqual({ text: "go", phase: "sent", reason: null, line: null, at: 1000 });
    expect(requestAfter(started, { text: "go", phase: "failed", reason: "No link" }, 5000)).toMatchObject({ phase: "failed", reason: "No link", at: 1000 });
  });

  it("takes the line the bridge answered with at the end of the send", () => {
    const started = requestAfter(undefined, { text: "go", phase: "sending", reason: null }, 1000);
    const done = requestAfter(started, { text: "go", phase: "sent", reason: null, line: `${HEAD} go` }, 5000);
    expect(done).toEqual({ text: "go", phase: "sent", reason: null, line: `${HEAD} go`, at: 1000 });
  });

  it("a note about another text, a new start, or a failure with no start, is a new request", () => {
    const held = requestAfter(undefined, { text: "go", phase: "sent", reason: null }, 1000);
    expect(requestAfter(held, { text: "again", phase: "sending", reason: null }, 7000).at).toBe(7000);
    expect(requestAfter(held, { text: "go", phase: "sending", reason: null }, 8000).at).toBe(8000);
    expect(requestAfter(undefined, { text: "go", phase: "failed", reason: "Offline" }, 9000)).toMatchObject({ at: 9000, phase: "failed" });
  });
});

describe("the decision block's controls", () => {
  const choice = { options: [{ label: "Cards" }, { label: "Table" }, { label: "Same" }] };

  it("files a pick under the choice's own prefix and reads it back", () => {
    expect(choiceControl(choice, 2)).toBe(`${choicePrefix(choice)}/2`);
    expect(pickedOption(["b:a#1/0", choiceControl(choice, 2)])).toBe(2);
    expect(pickedOption(["b:a#1/0"])).toBeNull();
    expect(parentControl(choiceControl(choice, 0))).toBe(parentControl(choiceControl(choice, 4)));
  });
});

describe("the receipt of a pick or a tap", () => {
  const view: ViewScreen = {
    rev: 1,
    at: iso(T0),
    title: "Header",
    view: [{ kind: "para", text: "x" }],
    choice: { question: "Which header?", options: [{ label: "Compact", preview: 1 }, { label: "Tall" }] },
  };

  it("a pick names the question and the option's preview", () => {
    expect(pickReceiptOf('picked "Compact"', view)).toEqual({ kind: "pick", label: "Compact", context: "Which header?", preview: 1 });
    expect(pickReceiptOf('picked "Tall"', view)).toEqual({ kind: "pick", label: "Tall", context: "Which header?", preview: null });
  });

  it("a tap names its group, or the screen's title", () => {
    expect(pickReceiptOf('tapped "Ship" in "Release"', view)).toEqual({ kind: "tap", label: "Ship", context: "Release", preview: null });
    expect(pickReceiptOf('tapped "Wait"', view)).toEqual({ kind: "tap", label: "Wait", context: "Header", preview: null });
  });

  it("reads back a label with an escaped quote", () => {
    expect(pickReceiptOf(String.raw`tapped "Say \"hi\""`, view)).toMatchObject({ kind: "tap", label: 'Say "hi"' });
  });

  it("a typed request has none", () => {
    expect(pickReceiptOf("Compare the two plans", view)).toBeNull();
    expect(pickReceiptOf('picked "x" and more', view)).toBeNull();
  });
});
