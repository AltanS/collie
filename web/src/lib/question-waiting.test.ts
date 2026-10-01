import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "./ansi";
import { splitLines, type Block } from "./blocks";
import { opencodeAdapter } from "./harness/opencode";
import type { PromptFamily } from "./harness/prompt-model";
import { waitingQuestionNote } from "./question-waiting";
import type { ChatEntry, ToolCall, TranscriptPart } from "./types";

type ToolResult = NonNullable<Extract<TranscriptPart, { kind: "tool" }>["result"]>;

// The join between a waiting question card and the dialog in the dock. It binds on exact counts and
// nothing else, because the screen never prints the call id (see the module header).

const NOTE = "Answer in the card below";

function entry(seq: number, parts: { id: string; call?: ToolCall; result?: ToolResult }[], over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    uuid: `u${seq}`,
    ts: "2026-10-01T08:00:00.000Z",
    role: "assistant",
    seq,
    parts: parts.map((p) => ({ kind: "tool", name: "question", summary: "Which?", ...p })),
    ...over,
  };
}

const ask: ToolCall = {
  kind: "question",
  name: "question",
  summary: "Which?",
  questions: [{ question: "Which?", multiple: false, options: [{ label: "A" }, { label: "B" }] }],
};
const run: ToolCall = { kind: "execute", command: "ls" };

const prompt = (family: PromptFamily): Block => ({
  kind: "prompt-select",
  prompt: { question: "Which?", options: [], family, coreSignature: "c", signature: "s" },
  lines: [],
});
const wizard: Block = {
  kind: "wizard",
  wizard: { phase: "question", steps: [], question: "Which?", options: [], signature: "s" },
  lines: [],
};
const multi: Block = {
  kind: "multi-select",
  multi: {
    phase: "checkbox",
    question: "Which?",
    options: [],
    escape: null,
    pointer: null,
    pointerRow: null,
    steps: null,
    advanceLabel: "Next",
    toggle: "digit",
    signature: "s",
    regionSignature: "r",
  },
  lines: [],
};
const menu: Block = {
  kind: "menu",
  menu: { title: "Select model", actions: [], nav: { upDown: true }, signature: "s" },
  lines: [],
};
const raw: Block = { kind: "raw", lines: [] };

const waiting = [entry(1, [{ id: "q1", call: ask }])];

describe("waitingQuestionNote", () => {
  it.each([
    ["a single-choice prompt", prompt("select")],
    ["a wizard", wizard],
    ["a multi-select", multi],
  ])("binds one waiting question to %s", (_name, block) => {
    expect(waitingQuestionNote(waiting, [raw, block, raw])).toEqual({ q1: { id: "q1", note: NOTE } });
  });

  it("keys the card by the part's own id, or by uuid and index when it has none", () => {
    const bare = [entry(1, [{ id: "", call: ask }])];
    expect(Object.keys(waitingQuestionNote(bare, [prompt("select")]))).toEqual(["u1:0"]);
  });

  it.each(["permission", "trust", "plan"] as const)("refuses a %s dialog", (family) => {
    expect(waitingQuestionNote(waiting, [prompt(family)])).toEqual({});
  });

  it("refuses a menu, a raw screen and an empty screen", () => {
    expect(waitingQuestionNote(waiting, [menu])).toEqual({});
    expect(waitingQuestionNote(waiting, [raw])).toEqual({});
    expect(waitingQuestionNote(waiting, [])).toEqual({});
  });

  it("refuses two question dialogs on the screen", () => {
    expect(waitingQuestionNote(waiting, [prompt("select"), wizard])).toEqual({});
  });

  it("refuses two running questions, in one turn or across two", () => {
    const two = [entry(1, [{ id: "q1", call: ask }, { id: "q2", call: ask }])];
    expect(waitingQuestionNote(two, [prompt("select")])).toEqual({});
    const across = [...waiting, entry(2, [{ id: "q2", call: ask }])];
    expect(waitingQuestionNote(across, [prompt("select")])).toEqual({});
  });

  it("refuses a completed question", () => {
    const done = [entry(1, [{ id: "q1", call: { ...ask, answers: [["A"]] }, result: { text: "ok" } }])];
    expect(waitingQuestionNote(done, [prompt("select")])).toEqual({});
  });

  it("counts only the question that is still waiting", () => {
    const mixed = [
      entry(1, [{ id: "q0", call: ask, result: { text: "ok" } }]),
      entry(2, [{ id: "r1", call: run }, { id: "q1", call: ask }]),
    ];
    expect(waitingQuestionNote(mixed, [prompt("select")])).toEqual({ q1: { id: "q1", note: NOTE } });
  });

  it("does not read a turn the agent rewound past", () => {
    const stale = [entry(1, [{ id: "q1", call: ask }], { abandoned: true })];
    expect(waitingQuestionNote(stale, [prompt("select")])).toEqual({});
  });
});

describe("waitingQuestionNote over a real opencode screen", () => {
  // The blocks the opencode adapter lifts from the captured dialogs (issue 329), not hand-built ones:
  // the join must bind the kinds the tab-bar dialogs really come out as.
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");
  const blocksOf = (name: string): Block[] =>
    opencodeAdapter.buildBlocks(splitLines(parseAnsi(readFileSync(join(PANES, `oc--question--${name}.txt`), "utf8"))));

  it.each([
    ["a multi-select question", "multi", "multi-select"],
    ["a multi-select step of a many-question call", "three--q2-multi", "multi-select"],
    ["a multi-select Confirm tab", "multi--confirm", "multi-select"],
    ["a single-select step of a many-question call", "two--q1", "wizard"],
    ["a many-question Confirm tab", "three--review", "wizard"],
  ] as const)("binds one waiting question to %s", (_name, fixture, kind) => {
    const blocks = blocksOf(fixture);
    expect(blocks.some((b) => b.kind === kind)).toBe(true);
    expect(waitingQuestionNote(waiting, blocks)).toEqual({ q1: { id: "q1", note: NOTE } });
  });

  it("binds nothing on a dialog the grammar leaves raw", () => {
    expect(waitingQuestionNote(waiting, blocksOf("tall14"))).toEqual({});
  });
});
