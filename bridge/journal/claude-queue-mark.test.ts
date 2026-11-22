// The queue as a take-back reads it (ADR 0122, the 2026-11-22 addendum): the Claude Code reducer's
// `queueMark`, the person's waiting words whole and the numbered moves of the queue, which the take-back
// route ties its proof to (bridge/surface/dequeue.ts). Row shapes as claude.test.ts builds them; the
// `popAll` with and without `content` as measured on 2026-11-22 (22 rows, 14 with content).

import { describe, expect, test } from "bun:test";
import type { JsonValue } from "../json.ts";
import { createClaudeReducer } from "./claude.ts";
import { QUEUE_MOVES_KEPT, type QueueMark } from "./reduce.ts";

const queueOp = (operation: string, content?: string): string =>
  JSON.stringify({ type: "queue-operation", operation, timestamp: "2026-11-22T10:00:00.000Z", sessionId: "s-1", content } satisfies Record<string, JsonValue | undefined>);

function markAfter(lines: readonly string[]): QueueMark {
  const reducer = createClaudeReducer();
  for (const line of lines) reducer.push(line);
  return reducer.queueMark!();
}

const NOTE = "<task-notification>\n<task-id>b1</task-id>\n</task-notification>";

describe("createClaudeReducer: the queue mark of a take-back", () => {
  test("a fresh reducer has met no queue: no moves, no texts", () => {
    expect(markAfter([])).toEqual({ moves: 0, texts: [], recent: [] });
  });

  test("the waiting words come whole, past the 200 characters the card shows", () => {
    const long = "word ".repeat(80).trim();
    const mark = markAfter([queueOp("enqueue", "first"), queueOp("enqueue", long)]);
    expect(mark.texts).toEqual(["first", long]);
    expect(mark.moves).toBe(2);
    expect(mark.recent.map((move) => move.kind)).toEqual(["words", "words"]);
  });

  test("plumbing holds a place but is no text, and its moves are plumbing", () => {
    const mark = markAfter([queueOp("enqueue", NOTE), queueOp("enqueue", "mine"), queueOp("dequeue")]);
    expect(mark.texts).toEqual(["mine"]);
    expect(mark.recent.map((move) => move.kind)).toEqual(["plumbing", "words", "plumbing"]);
  });

  test("a popAll is a `back` move with the words its row names, and empties the queue", () => {
    const mark = markAfter([queueOp("enqueue", "take me back"), queueOp("popAll", "take me back")]);
    expect(mark.texts).toEqual([]);
    expect(mark.recent.at(-1)).toEqual({ n: 2, kind: "back", words: "take me back" });
  });

  test("a popAll with no content is a `back` move that names no words", () => {
    expect(markAfter([queueOp("enqueue", "a"), queueOp("popAll")]).recent.at(-1)).toEqual({ n: 2, kind: "back", words: null });
  });

  test("a dequeue of the person's message is a `words` move: the queue went out", () => {
    const mark = markAfter([queueOp("enqueue", "go"), queueOp("dequeue")]);
    expect(mark.texts).toEqual([]);
    expect(mark.recent.map((move) => move.kind)).toEqual(["words", "words"]);
  });

  test("a remove with no content, and an operation the reducer does not know, break the tie as `words`", () => {
    expect(markAfter([queueOp("remove")]).recent.at(-1)?.kind).toBe("words");
    expect(markAfter([queueOp("shuffle", "x")]).recent.at(-1)?.kind).toBe("words");
  });

  test("a delivered message whose dequeue took another place moves the words too", () => {
    const user = JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-22T10:00:01.000Z", message: { role: "user", content: "second" } });
    const mark = markAfter([queueOp("enqueue", "first"), queueOp("enqueue", "second"), user]);
    expect(mark.texts).toEqual(["first"]);
    expect(mark.recent.at(-1)?.kind).toBe("words");
  });

  test("words that cannot come back whole make the texts null: a place with no words, a paste, a picture, a text too long", () => {
    expect(markAfter([queueOp("enqueue")]).texts).toBeNull();
    expect(markAfter([queueOp("enqueue", '<pasted_content id="1">\nbody\n</pasted_content>')]).texts).toBeNull();
    expect(markAfter([queueOp("enqueue", "look at [Image #1] here")]).texts).toBeNull();
    expect(markAfter([queueOp("enqueue", "x".repeat(3001))]).texts).toBeNull();
    expect(markAfter([queueOp("enqueue", "x".repeat(3000))]).texts).toEqual(["x".repeat(3000)]);
  });

  test("the mark keeps the newest moves only, numbered on", () => {
    const lines = Array.from({ length: QUEUE_MOVES_KEPT + 5 }, (_, i) => queueOp("enqueue", `m${String(i)}`));
    const mark = markAfter(lines);
    expect(mark.moves).toBe(QUEUE_MOVES_KEPT + 5);
    expect(mark.recent.length).toBe(QUEUE_MOVES_KEPT);
    expect(mark.recent[0]!.n).toBe(6);
  });

  test("the mark is a snapshot: a later row does not change what a caller holds", () => {
    const reducer = createClaudeReducer();
    reducer.push(queueOp("enqueue", "a"));
    const held = reducer.queueMark!();
    reducer.push(queueOp("popAll", "a"));
    expect(held.texts).toEqual(["a"]);
    expect(held.recent.length).toBe(1);
  });
});
