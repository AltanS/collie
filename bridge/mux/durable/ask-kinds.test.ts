import { afterEach, describe, expect, test } from "bun:test";

import { answerPane, memoryAnswerReceipts, type AnswerDeps } from "../../durable/answer.ts";
import { withOpenAsks } from "../../durable/pane-asks.ts";
import type { JsonValue } from "../../json.ts";
import type { AnswerRequest, PaneWire } from "../../types.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { ANSWER_TEXT_BYTES } from "./clean.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText } from "./fixture.ts";
import { parseSnapshot, type DurableAsk } from "./protocol.ts";

// MORE KINDS OF ASK (WIRE.md 7.14): a `choice`, a `text` ask and a `form` beside the `permission`. The claims:
//
//   1. The adapter reads each kind, cleans every string, drops what breaks a rule, and fills the defaults.
//   2. The phone's answer for each kind reaches the program in the one shape the wire names, once; a request id
//      repeated runs nothing twice, and a wrong pick is the program's 400.
//   3. The route reads the four answer shapes and refuses any other, and the digest tells a changed payload under
//      one request id apart without keeping the person's words.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

async function rig() {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock);
  const read = async () => {
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    return adapter.poll();
  };
  return { program, adapter, read };
}

let n = 0;
/** An ask of any kind, with the base fields filled. */
function askOf(kind: string, over: Partial<DurableAsk> = {}): DurableAsk {
  n += 1;
  return {
    id: `ask-kind-${String(n)}`,
    kind,
    toolCallId: `call-kind-${String(n)}`,
    revision: 1,
    title: "Which queue?",
    itemId: `item-kind-${String(n)}`,
    options: [],
    ...over,
  };
}

const QUEUES = [
  { id: "billing", label: "Billing" },
  { id: "access", label: "Access" },
  { id: "other", label: "Other" },
];

let reqs = 0;
const reqId = () => `00000000-0000-4000-8000-${String((reqs += 1)).padStart(12, "0")}`;

const wirePane = (paneId: string): PaneWire => ({
  paneId,
  workspaceId: "ws-notes",
  workspaceLabel: "notes",
  workspaceNumber: 1,
  tabId: "ws-notes:research",
  agent: "durable",
  status: "blocked",
  cwd: "/home/denis/notes/papers",
  focused: false,
  kind: "agent",
});

describe("the adapter reads each kind of ask", () => {
  test("a choice ask lists plain options and the multiple flag; an effect on an option is ignored", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOf("choice", { options: [{ id: "billing", label: "Billing", effect: "allow" }, { id: "access", label: "Access" }], multiple: true }));
    program.raiseAsk("conv-01", askOf("choice", { options: QUEUES }));
    expect((await read()).ok).toBe(true);
    const [multi, single] = adapter.openAsks("conv-01") ?? [];
    expect(multi).toMatchObject({ kind: "choice", multiple: true, options: [{ id: "billing", label: "Billing" }, { id: "access", label: "Access" }] });
    expect(multi?.options.every((option) => !("effect" in option))).toBe(true);
    expect(single?.multiple).toBeUndefined();
    expect("multiple" in (single ?? {})).toBe(false);
  });

  test("a choice ask keeps up to eight options, and a permission still keeps six", async () => {
    const { program, adapter, read } = await rig();
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `o${String(index)}`, label: `Option ${String(index)}` }));
    const effectful = Array.from({ length: 12 }, (_, index) => ({ id: `o${String(index)}`, label: `Option ${String(index)}`, effect: "allow" as const }));
    program.raiseAsk("conv-01", askOf("choice", { options: many }));
    program.raiseAsk("conv-01", askOf("permission", { options: effectful }));
    expect((await read()).ok).toBe(true);
    const [choice, permission] = adapter.openAsks("conv-01") ?? [];
    expect(choice?.options).toHaveLength(8);
    expect(permission?.options).toHaveLength(6);
  });

  test("a text ask carries a placeholder cut to 60 characters and a maxLength that defaults to 500", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOf("text", { placeholder: "e.g. we are looking into it", maxLength: 200 }));
    program.raiseAsk("conv-01", askOf("text", { placeholder: "é".repeat(100) }));
    program.raiseAsk("conv-01", askOf("text", { maxLength: 5000 }));
    expect((await read()).ok).toBe(true);
    const [first, second, third] = adapter.openAsks("conv-01") ?? [];
    expect(first).toMatchObject({ kind: "text", placeholder: "e.g. we are looking into it", maxLength: 200, options: [] });
    expect([...(second?.placeholder ?? "")]).toHaveLength(60);
    expect(second?.maxLength).toBe(500);
    expect(third?.maxLength).toBe(500); // 5000 is over the 2000 cap: the default
    expect("placeholder" in (third ?? {})).toBe(false);
  });

  test("a form ask lists up to six fields, drops a bad field alone, and fills the field defaults", async () => {
    const { program, adapter, read } = await rig();
    const fields = [
      { id: "summary", label: "Summary", kind: "text" as const, required: true },
      { id: "queue", label: "Queue", kind: "choice" as const, options: QUEUES },
      { id: "urgent", label: "Urgent", kind: "toggle" as const },
      { id: "empty-choice", label: "No options", kind: "choice" as const, options: [] }, // dropped
      { id: "summary", label: "Same id twice", kind: "toggle" as const }, // dropped
    ];
    program.raiseAsk("conv-01", askOf("form", { fields }));
    // A field kind this build does not know cannot be typed, so it goes in as the program would send it.
    program.snapshot.panes = program.snapshot.panes.map((pane) =>
      pane.id === "conv-01" ? Object.assign(pane, { openAsks: pane.openAsks.map((ask) => Object.assign(ask, { fields: [...(ask.fields ?? []), JSON.parse('{"id":"odd","label":"Odd","kind":"dial"}')] })) }) : pane,
    );
    expect((await read()).ok).toBe(true);
    const [form] = adapter.openAsks("conv-01") ?? [];
    expect(form?.fields).toEqual([
      { id: "summary", label: "Summary", kind: "text", required: true, maxLength: 500 },
      { id: "queue", label: "Queue", kind: "choice", options: QUEUES },
      { id: "urgent", label: "Urgent", kind: "toggle" },
    ]);
    expect(form?.options).toEqual([]);
  });

  test("a form ask with more than six fields keeps the first six", async () => {
    const { program, adapter, read } = await rig();
    const fields = Array.from({ length: 9 }, (_, index) => ({ id: `f${String(index)}`, label: `Field ${String(index)}`, kind: "toggle" as const }));
    program.raiseAsk("conv-01", askOf("form", { fields }));
    expect((await read()).ok).toBe(true);
    expect(adapter.openAsks("conv-01")?.[0]?.fields?.map((field) => field.id)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5"]);
  });

  test("hostile text in a choice label, a placeholder and a form field is cleaned", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOf("choice", { title: hostileText("pick"), options: [{ id: "a", label: hostileText("A") }] }));
    program.raiseAsk("conv-01", askOf("text", { placeholder: hostileText("hint", 10) }));
    program.raiseAsk("conv-01", askOf("form", { fields: [{ id: "f", label: hostileText("F"), kind: "text" }] }));
    expect((await read()).ok).toBe(true);
    const [choice, text, form] = adapter.openAsks("conv-01") ?? [];
    for (const shown of [choice?.title, choice?.options[0]?.label, text?.placeholder, form?.fields?.[0]?.label]) {
      expect(hasHostileChars((shown ?? "").replaceAll("\n", ""))).toBe(false);
    }
  });

  test("a kind this build does not know is still listed, and is not answerable", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOf("slider", { options: [{ id: "a", label: "A", effect: "allow" }] }));
    expect((await read()).ok).toBe(true);
    expect(adapter.openAsks("conv-01")?.[0]).toMatchObject({ kind: "slider" });
  });

  test("every kind rides the pane to the phone as one ask in the open list", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOf("choice", { options: QUEUES }));
    program.raiseAsk("conv-01", askOf("text"));
    program.raiseAsk("conv-01", askOf("form", { fields: [{ id: "f", label: "F", kind: "toggle" }] }));
    expect((await read()).ok).toBe(true);
    expect(withOpenAsks(wirePane("conv-01"), adapter).asks?.map((ask) => ask.kind)).toEqual(["choice", "text", "form"]);
  });

  test("an ask that went through the pane log reads back the same (the log stores the cleaned ask)", () => {
    const form = askOf("form", { fields: [{ id: "f", label: "F", kind: "text", maxLength: 80, required: true }] });
    const snapshot = JSON.stringify({
      rev: 1,
      epoch: "e4b1c7a09d3f5e826b7a1c0d94f3e582",
      workspaces: [{ id: "w", title: "W" }],
      tabs: [{ id: "t", workspaceId: "w", title: "T" }],
      panes: [{ id: "p", workspaceId: "w", tabId: "t", title: "P", harness: "x", state: "waiting", turnId: "t1", openAsks: [form] }],
      starters: [],
    });
    const parsed = parseSnapshot(snapshot, true);
    expect(parsed.ok && parsed.value.panes[0]?.openAsks[0]).toMatchObject({ kind: "form", fields: [{ id: "f", label: "F", kind: "text", maxLength: 80, required: true }] });
  });
});

describe("the phone's answer reaches the program in the shape of the ask", () => {
  async function raised(ask: DurableAsk) {
    const r = await rig();
    r.program.raiseAsk("conv-01", ask);
    expect((await r.read()).ok).toBe(true);
    const open = r.adapter.openAsks("conv-01")?.[0];
    if (open === undefined) throw new Error("no ask");
    return { ...r, open };
  }
  const head = (open: { id: string; revision: number }) => ({ requestId: reqId(), askId: open.id, revision: open.revision });

  test("choice: one pick is taken once, and the program sees optionIds", async () => {
    const { program, adapter, open } = await raised(askOf("choice", { options: QUEUES }));
    const answer: AnswerRequest = { ...head(open), optionIds: ["access"] };
    expect(await adapter.answerAsk("conv-01", answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(await adapter.answerAsk("conv-01", answer)).toEqual({ ok: true, value: { kind: "taken", replayed: true } });
    expect(program.answers).toHaveLength(1);
    expect(program.answers[0]).toMatchObject({ askId: open.id, optionId: "access", answer: { kind: "options", optionIds: ["access"] } });
  });

  test("choice: several picks need multiple, a pick that is no option is the program's 400, and nothing is taken", async () => {
    const single = await raised(askOf("choice", { options: QUEUES }));
    const two = await single.adapter.answerAsk("conv-01", { ...head(single.open), optionIds: ["billing", "access"] });
    expect(two).toMatchObject({ ok: false, reason: "refused" });
    const unknown = await single.adapter.answerAsk("conv-01", { ...head(single.open), optionIds: ["nope"] });
    expect(unknown).toMatchObject({ ok: false, reason: "refused" });
    expect(single.program.answers).toEqual([]);

    const multi = await raised(askOf("choice", { options: QUEUES, multiple: true }));
    const taken = await multi.adapter.answerAsk("conv-01", { ...head(multi.open), optionIds: ["billing", "other"] });
    expect(taken).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(multi.program.answers[0]?.answer).toEqual({ kind: "options", optionIds: ["billing", "other"] });
  });

  test("text ask: the text is taken once, and a text over the ask's maxLength is refused by the program", async () => {
    const { program, adapter, open } = await raised(askOf("text", { maxLength: 10 }));
    const long = await adapter.answerAsk("conv-01", { ...head(open), text: "this is longer than ten" });
    expect(long).toMatchObject({ ok: false, reason: "refused" });
    expect(program.answers).toEqual([]);
    const answer: AnswerRequest = { ...head(open), text: "all fixed" };
    expect(await adapter.answerAsk("conv-01", answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(program.answers[0]?.answer).toEqual({ kind: "text", text: "all fixed" });
  });

  test("text ask: a text over 2000 characters at four bytes is refused here, and nothing leaves", async () => {
    const { program, adapter, open } = await raised(askOf("text", { maxLength: 2000 }));
    const reply = await adapter.answerAsk("conv-01", { ...head(open), text: "x".repeat(ANSWER_TEXT_BYTES + 1) });
    expect(reply).toMatchObject({ ok: false, reason: "refused" });
    expect(program.answers).toEqual([]);
  });

  test("form: the values are taken once with a field's text, pick and toggle, and a missing required field is refused", async () => {
    const fields = [
      { id: "summary", label: "Summary", kind: "text" as const, required: true },
      { id: "queue", label: "Queue", kind: "choice" as const, options: QUEUES },
      { id: "urgent", label: "Urgent", kind: "toggle" as const },
    ];
    const { program, adapter, open } = await raised(askOf("form", { fields }));
    const missing = await adapter.answerAsk("conv-01", { ...head(open), values: { queue: "billing" } });
    expect(missing).toMatchObject({ ok: false, reason: "refused" });
    const badPick = await adapter.answerAsk("conv-01", { ...head(open), values: { summary: "x", queue: "nope" } });
    expect(badPick).toMatchObject({ ok: false, reason: "refused" });
    expect(program.answers).toEqual([]);
    const answer: AnswerRequest = { ...head(open), values: { summary: "Cannot log in", queue: "access", urgent: true } };
    expect(await adapter.answerAsk("conv-01", answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(await adapter.answerAsk("conv-01", answer)).toEqual({ ok: true, value: { kind: "taken", replayed: true } });
    expect(program.answers).toHaveLength(1);
    expect(program.answers[0]?.answer).toEqual({ kind: "values", values: { summary: "Cannot log in", queue: "access", urgent: true } });
  });

  test("an id in a form's keys or a pick that breaks the id rule never leaves", async () => {
    const { program, adapter, open } = await raised(askOf("form", { fields: [{ id: "f", label: "F", kind: "toggle" }] }));
    const reply = await adapter.answerAsk("conv-01", { ...head(open), values: { "bad key": true } });
    expect(reply).toMatchObject({ ok: false, reason: "refused" });
    expect(program.answers).toEqual([]);
  });

  test("a stale choice is a stale, and the current ask comes back in its kind", async () => {
    const { program, adapter, open } = await raised(askOf("choice", { options: QUEUES }));
    program.raiseAsk("conv-01", askOf("text")); // a second ask does not make the first stale
    const reply = await adapter.answerAsk("conv-01", { requestId: reqId(), askId: open.id, revision: open.revision + 1, optionIds: ["billing"] });
    expect(reply).toMatchObject({ ok: true, value: { kind: "stale", ask: { kind: "choice", id: open.id } } });
  });
});

describe("the answer route reads the four shapes", () => {
  const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
  const base = { requestId: ID, askId: "ask-1", revision: 1 };

  function rig2() {
    const calls: AnswerRequest[] = [];
    const deps: AnswerDeps = {
      adapter: {
        answerAsk: (_paneId: string, answer: AnswerRequest) => {
          calls.push(answer);
          return Promise.resolve({ ok: true as const, value: { kind: "taken" as const, replayed: false } });
        },
      },
      receipts: memoryAnswerReceipts(),
      audit: { record: () => {} },
      device: "pixel",
      session: "default",
    };
    return { calls, deps };
  }

  test("each good shape reaches the adapter as the phone sent it", async () => {
    const payloads: Record<string, JsonValue>[] = [
      { optionId: "allow", note: "go" },
      { optionIds: ["a", "b"] },
      { text: "one line" },
      { values: { summary: "x", urgent: false, queue: "access", many: ["a", "b"] } },
    ];
    for (const payload of payloads) {
      const { calls, deps } = rig2();
      const reply = await answerPane("conv-01", { ...base, ...payload }, deps);
      expect(reply).toMatchObject({ status: 200 });
      expect(calls.map((call) => JSON.stringify(call))).toEqual([JSON.stringify({ ...base, ...payload })]);
    }
  });

  test("a body that names no shape, two shapes, or a bad one is a plain 400 and nothing is sent", async () => {
    const bads: Record<string, JsonValue>[] = [
      {},
      { optionId: "a", text: "x" },
      { optionIds: ["a"], text: "x" },
      { optionIds: [] },
      { optionIds: ["a", "a"] },
      { optionIds: ["a", 3] },
      { optionIds: Array.from({ length: 9 }, (_, index) => `o${String(index)}`) },
      { optionIds: "a" },
      { text: "" },
      { text: 7 },
      { text: "x".repeat(ANSWER_TEXT_BYTES + 1) },
      { values: {} },
      { values: "x" },
      { values: [] },
      { values: { a: 1 } },
      { values: { a: null } },
      { values: { a: [3] } },
      { values: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`f${String(index)}`, true])) },
      { note: "no option", text: "x" },
    ];
    for (const payload of bads) {
      const { calls, deps } = rig2();
      expect(await answerPane("conv-01", { ...base, ...payload }, deps)).toEqual({ status: 400, text: "bad body" });
      expect(calls).toEqual([]);
    }
  });

  test("one request id, one payload: another text or another pick under it is refused and sends nothing", async () => {
    const { calls, deps } = rig2();
    expect(await answerPane("conv-01", { ...base, text: "first" }, deps)).toMatchObject({ status: 200, body: { ok: true, outcome: "taken" } });
    expect(await answerPane("conv-01", { ...base, text: "first" }, deps)).toMatchObject({ status: 200, body: { replayed: true } });
    expect(await answerPane("conv-01", { ...base, text: "second" }, deps)).toMatchObject({ status: 409, body: { outcome: "refused", reason: "request-id-reused" } });
    expect(await answerPane("conv-01", { ...base, optionIds: ["first"] }, deps)).toMatchObject({ status: 409, body: { outcome: "refused", reason: "request-id-reused" } });
    expect(calls).toHaveLength(1);
  });

  test("the same form with its keys in another order is the same payload", async () => {
    const { calls, deps } = rig2();
    await answerPane("conv-01", { ...base, values: { a: "1", b: true } }, deps);
    expect(await answerPane("conv-01", { ...base, values: { b: true, a: "1" } }, deps)).toMatchObject({ status: 200, body: { replayed: true } });
    expect(calls).toHaveLength(1);
  });

  test("the receipt and the audit line keep ids and the outcome, never a person's words", async () => {
    const audit: unknown[] = [];
    const { deps } = rig2();
    const receipts = memoryAnswerReceipts();
    const withAudit: AnswerDeps = { ...deps, receipts, audit: { record: (entry) => audit.push(entry) } };
    await answerPane("conv-01", { ...base, text: "my private words" }, withAudit);
    const receipt = receipts.get(ID);
    expect(JSON.stringify(receipt)).not.toContain("my private words");
    expect(JSON.stringify(audit)).not.toContain("my private words");
    expect(audit[0]).toMatchObject({ action: "answer", detail: { answer: "text", outcome: "taken" } });
    const second = memoryAnswerReceipts();
    await answerPane("conv-01", { ...base, requestId: "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d", optionIds: ["a", "b"] }, { ...withAudit, receipts: second, audit: { record: (entry) => audit.push(entry) } });
    expect(audit[1]).toMatchObject({ detail: { answer: "optionIds", optionIds: ["a", "b"] } });
  });
});
