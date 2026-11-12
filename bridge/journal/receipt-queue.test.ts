// The journal's proof of a queued send (ADR 0122) and of a door's send (ADR 0141 point 4), pure: sends
// and transcript entries in, cards and proofs out. The live window's wiring is in live.test.ts.

import { describe, expect, test } from "bun:test";
import { PROMPT_SKEW_MS, receiptQueue, settle, type ReceiptQueued } from "./receipt-queue.ts";
import type { TranscriptEntry } from "./types.ts";

const AT = Date.parse("2026-11-10T12:00:00Z");

function prompt(uuid: string, text: string, at: number): TranscriptEntry {
  return { uuid, ts: new Date(at).toISOString(), role: "user", parts: [{ kind: "text", text }] };
}

function door(requestId: string, text: string, at = AT): ReceiptQueued {
  return { requestId, text, at, state: "queued", door: true };
}

function screen(requestId: string, text: string, at = AT): ReceiptQueued {
  return { requestId, text, at, state: "queued" };
}

describe("the journal's proof of a door's send", () => {
  test("its own prompt lands it: the card goes and the proof says landed", () => {
    const got = receiptQueue([door("req-door-0001", "fix the tests")], [prompt("u1", "fix  the tests\n", AT + 500)], false, []);
    expect(got).toEqual({ cards: [], proofs: [{ requestId: "req-door-0001", how: "landed" }] });
  });

  test("a next prompt that holds the text without equalling it is merged or changed, and the card stays", () => {
    const got = receiptQueue([door("req-door-0002", "fix the tests")], [prompt("u1", "fix the tests and the lint", AT + 500)], false, []);
    expect(got.proofs).toEqual([{ requestId: "req-door-0002", how: "merged" }]);
    expect(got.cards).toEqual([{ requestId: "req-door-0002", state: "merged", text: "fix the tests" }]);
  });

  test("two door sends folded into one turn are both merged: the containing prompt is not claimed", () => {
    const got = settle([door("req-door-0003", "first", AT), door("req-door-0004", "second", AT + 100)], [prompt("u1", "first\nsecond", AT + 900)]);
    expect(got.proofs).toEqual([
      { requestId: "req-door-0003", how: "merged" },
      { requestId: "req-door-0004", how: "merged" },
    ]);
  });

  test("only the next prompt counts: a short text is never read into a later desk prompt", () => {
    const entries = [prompt("u1", "something else entirely", AT + 200), prompt("u2", "ok, now refactor the parser", AT + 60_000)];
    const got = settle([door("req-door-0005", "ok")], entries);
    expect(got.proofs).toEqual([]);
    expect(got.open.map((send) => send.requestId)).toEqual(["req-door-0005"]);
  });

  test("a prompt another send landed as its own is not this send's merge", () => {
    const got = settle([door("req-door-0012", "ok", AT), door("req-door-0013", "ok go", AT + 100)], [prompt("u1", "ok go", AT + 400)]);
    expect(got.proofs).toEqual([{ requestId: "req-door-0013", how: "landed" }]);
    expect(got.open.map((send) => send.requestId)).toEqual(["req-door-0012"]);
  });

  test("an equal prompt wins over a containing one, wherever it sits", () => {
    const entries = [prompt("u1", "deploy it now please", AT + 200), prompt("u2", "deploy it", AT + 5_000)];
    expect(settle([door("req-door-0006", "deploy it")], entries).proofs).toEqual([{ requestId: "req-door-0006", how: "landed" }]);
  });

  test("a prompt written earlier than the send less the skew proves nothing", () => {
    const entries = [prompt("u1", "fix the tests", AT - PROMPT_SKEW_MS - 1), prompt("u2", "fix the tests twice over", AT - PROMPT_SKEW_MS - 1)];
    const got = settle([door("req-door-0007", "fix the tests")], entries);
    expect(got.proofs).toEqual([]);
    expect(got.open).toHaveLength(1);
  });

  test("one prompt lands one send: two equal door sends and one prompt leave one card", () => {
    const got = receiptQueue([door("req-door-0008", "yes", AT), door("req-door-0009", "yes", AT + 100)], [prompt("u1", "yes", AT + 300)], false, []);
    expect(got.proofs).toEqual([{ requestId: "req-door-0008", how: "landed" }]);
    expect(got.cards).toEqual([{ requestId: "req-door-0009", state: "queued", text: "yes" }]);
  });

  test("a send already marked merged stays a merged card and is not proved again", () => {
    const got = receiptQueue([{ ...door("req-door-0010", "fix the tests"), merged: true }], [], false, []);
    expect(got).toEqual({ cards: [{ requestId: "req-door-0010", state: "merged", text: "fix the tests" }], proofs: [] });
  });

  test("a merged card is drawn even where the harness records its queue", () => {
    const got = receiptQueue([door("req-door-0011", "fix the tests")], [prompt("u1", "fix the tests and more", AT + 500)], true, []);
    expect(got.cards.map((card) => card.state)).toEqual(["merged"]);
  });
});

describe("a screen send keeps the exact rule alone", () => {
  test("its own prompt hides its card and proves nothing", () => {
    expect(receiptQueue([screen("req-scr-00001", "fix the tests")], [prompt("u1", "fix the tests", AT + 500)], false, [])).toEqual({ cards: [], proofs: [] });
  });

  test("a containing prompt leaves it queued, never merged", () => {
    const got = receiptQueue([screen("req-scr-00002", "fix the tests")], [prompt("u1", "fix the tests and the lint", AT + 500)], false, []);
    expect(got).toEqual({ cards: [{ requestId: "req-scr-00002", state: "queued", text: "fix the tests" }], proofs: [] });
  });
});

describe("a door's send the agent gave back (SPEC V26)", () => {
  const LEFT = AT + 3_000;
  const left = (requestId: string, text: string, at = AT): ReceiptQueued => ({ ...door(requestId, text, at), leftAt: LEFT });

  test("left the queue, journal read after that, no prompt: returned, and the card says so", () => {
    const got = receiptQueue([left("req-door-0020", "fix the tests")], [prompt("u0", "older", AT - 60_000)], false, [], LEFT + 1);
    expect(got.proofs).toEqual([{ requestId: "req-door-0020", how: "returned" }]);
    expect(got.cards).toEqual([{ requestId: "req-door-0020", state: "returned", text: "fix the tests" }]);
  });

  test("the agent's word alone, or a journal read before it, returns nothing", () => {
    expect(receiptQueue([door("req-door-0021", "fix the tests")], [], false, [], LEFT + 1).proofs).toEqual([]);
    expect(receiptQueue([left("req-door-0022", "fix the tests")], [], false, [], LEFT - 1).proofs).toEqual([]);
    expect(receiptQueue([left("req-door-0023", "fix the tests")], [], false, []).proofs).toEqual([]);
  });

  test("it ran: its own prompt lands it, a prompt that holds it merges it, an abandoned one keeps it from returning", () => {
    expect(settle([left("req-door-0024", "fix the tests")], [prompt("u1", "fix the tests", AT + 500)], LEFT + 1).proofs).toEqual([{ requestId: "req-door-0024", how: "landed" }]);
    expect(settle([left("req-door-0025", "fix the tests")], [prompt("u1", "fix the tests, then lint", AT + 500)], LEFT + 1).proofs).toEqual([{ requestId: "req-door-0025", how: "merged" }]);
    const abandoned: TranscriptEntry = { ...prompt("u1", "fix the tests", AT + 500), abandoned: true };
    expect(settle([left("req-door-0026", "fix the tests")], [abandoned], LEFT + 1).proofs).toEqual([]);
  });

  test("any later prompt that holds a short text keeps it from returning: an unconfirmed card is the safe end", () => {
    const got = settle([left("req-door-0027", "ok")], [prompt("u1", "first", AT + 500), prompt("u2", "looks ok to me", AT + 9_000)], LEFT + 1);
    expect(got.proofs).toEqual([]);
  });

  test("a screen send, a returned or merged card, are never returned again", () => {
    const sends: ReceiptQueued[] = [
      { ...screen("req-scr-00020", "typed"), leftAt: LEFT },
      { ...left("req-door-0028", "a"), state: "returned" },
      { ...left("req-door-0029", "b"), merged: true },
    ];
    expect(settle(sends, [], LEFT + 1).proofs).toEqual([]);
  });
});
