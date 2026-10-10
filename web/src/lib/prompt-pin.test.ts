import { describe, expect, test } from "vitest";

import type { ChatItem } from "./chat-items";
import { pinAt, promptMap } from "./prompt-pin";

const user = (id: string, text: string): ChatItem[] => [{ id, kind: "user", text }];
const reply = (id: string): ChatItem[] => [{ id, kind: "reply", text: "done" }];
const tools = (id: string): ChatItem[] => [
  { id: `${id}a`, kind: "tool", tool: { kind: "read", path: "a.ts" }, status: "done" },
  { id: `${id}b`, kind: "tool", tool: { kind: "read", path: "b.ts" }, status: "done" },
];

const reported = { uuid: "p9", ts: "", text: "the newest prompt" };

describe("promptMap", () => {
  test("each block follows the prompt above it, and blocks before any prompt follow none", () => {
    const map = promptMap([reply("r0"), user("u1", "first"), tools("t1"), reply("r1"), user("u2", "second"), reply("r2")]);
    expect(map.runs).toEqual([
      { start: 1, text: "first" },
      { start: 4, text: "second" },
    ]);
    expect(map.owner).toEqual([-1, 0, 0, 0, 1, 1]);
  });

  test("consecutive user blocks are one prompt", () => {
    const map = promptMap([user("u1:0", "look at this"), user("u1:1", "and this"), reply("r1")]);
    expect(map.runs).toEqual([{ start: 0, text: "look at this\n\nand this" }]);
    expect(map.owner).toEqual([0, 0, 0]);
  });
});

describe("pinAt", () => {
  const map = promptMap([reply("r0"), user("u1", "first"), tools("t1"), reply("r1")]);

  test("a held prompt above the reader is pinned, with the block to jump to", () => {
    expect(pinAt(map, 3, null, false, false)).toEqual({ kind: "held", text: "first", start: 1 });
  });

  test("a prompt that is itself the top block is on screen and not pinned", () => {
    expect(pinAt(map, 1, null, false, false)).toBeNull();
  });

  test("at the stream's top edge a prompt that is not held still pins, standing in for 'Load older'", () => {
    expect(pinAt(map, -1, reported, false, true)).toEqual({ kind: "reported", text: "the newest prompt", truncated: false });
  });

  test("at the top edge a held prompt is on screen, so nothing covers the edge", () => {
    const held = promptMap([user("u1", "first"), reply("r1")]);
    expect(pinAt(held, -1, reported, true, true)).toBeNull();
  });

  test("turns before any held prompt pin the reported prompt when the client does not hold it", () => {
    expect(pinAt(map, 0, reported, false, true)).toEqual({ kind: "reported", text: "the newest prompt", truncated: false });
  });

  test("a held reported prompt means the turns above it answer an earlier one", () => {
    expect(pinAt(map, 0, reported, true, true)).toEqual({ kind: "earlier" });
  });

  test("no report and older turns to load: offer them", () => {
    expect(pinAt(map, 0, null, false, true)).toEqual({ kind: "earlier" });
  });

  test("at the start of the conversation a turn with no prompt above pins nothing", () => {
    expect(pinAt(map, 0, null, false, false)).toBeNull();
  });

  test("a capped report says so", () => {
    const capped = { ...reported, truncated: true };
    expect(pinAt(map, 0, capped, false, true)).toEqual({ kind: "reported", text: "the newest prompt", truncated: true });
  });
});
