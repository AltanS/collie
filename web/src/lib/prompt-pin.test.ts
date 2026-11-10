import { describe, expect, test } from "vitest";

import type { ChatItem } from "./chat-items";
import { pinAt, promptMap } from "./prompt-pin";

const user = (id: string, text: string): ChatItem[] => [{ id, kind: "user", text }];
const walky = (id: string): ChatItem[] => [
  {
    id,
    kind: "user",
    text: "[walky-talky wt_abc123def456] from agent codex\nthe tests are green",
    walky: { id: "wt_abc123def456", kind: "agent", replyTo: null },
  },
];
const operatorWalky = (id: string): ChatItem[] => [
  {
    id,
    kind: "user",
    text: "[walky-talky wt_abc123def456] from operator the phone\nrun the tests again",
    walky: { id: "wt_abc123def456", kind: "operator", replyTo: null },
  },
];
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

describe("promptMap with walky talky turns", () => {
  test("a walky turn between two prompts closes the first run, and the blocks after it keep following it", () => {
    const map = promptMap([user("u1", "first"), reply("r1"), walky("w1"), tools("t1"), reply("r2"), user("u2", "second"), reply("r3")]);
    expect(map.runs).toEqual([
      { start: 0, text: "first" },
      { start: 5, text: "second" },
    ]);
    expect(map.owner).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  test("a walky turn right after a prompt does not join it", () => {
    const map = promptMap([user("u1", "first"), walky("w1"), reply("r1")]);
    expect(map.runs).toEqual([{ start: 0, text: "first" }]);
    expect(map.owner).toEqual([0, 0, 0]);
  });

  test("a walky turn as the last block is not a run, and the blocks before keep their owner", () => {
    const map = promptMap([user("u1", "first"), reply("r1"), walky("w1")]);
    expect(map.runs).toEqual([{ start: 0, text: "first" }]);
    expect(map.owner).toEqual([0, 0, 0]);
  });
});

describe("promptMap with an operator walky talky turn", () => {
  test("an operator walky turn is the person's own prompt and pins like one", () => {
    const map = promptMap([user("u1", "first"), reply("r1"), operatorWalky("w1"), tools("t1")]);
    expect(map.runs).toEqual([
      { start: 0, text: "first" },
      { start: 2, text: "[walky-talky wt_abc123def456] from operator the phone\nrun the tests again" },
    ]);
    expect(map.owner).toEqual([0, 0, 1, 1]);
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
    expect(pinAt(map, -1, reported, false, true)).toEqual({ kind: "reported", text: "the newest prompt", truncated: false, ts: "" });
  });

  test("at the top edge a held prompt is on screen, so nothing covers the edge", () => {
    const held = promptMap([user("u1", "first"), reply("r1")]);
    expect(pinAt(held, -1, reported, true, true)).toBeNull();
  });

  test("turns before any held prompt pin the reported prompt when the client does not hold it", () => {
    expect(pinAt(map, 0, reported, false, true)).toEqual({ kind: "reported", text: "the newest prompt", truncated: false, ts: "" });
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
    expect(pinAt(map, 0, capped, false, true)).toEqual({ kind: "reported", text: "the newest prompt", truncated: true, ts: "" });
  });

  test("a reported prompt that is a walky talky message pins as if none was reported", () => {
    const envelope = { uuid: "p8", ts: "", text: "[walky-talky wt_abc123def456] from agent codex\nthe tests are green" };
    for (const top of [-1, 0]) {
      expect(pinAt(map, top, envelope, false, true)).toEqual(pinAt(map, top, null, false, true));
      expect(pinAt(map, top, envelope, false, false)).toEqual(pinAt(map, top, null, false, false));
    }
    expect(pinAt(map, 0, envelope, false, true)).toEqual({ kind: "earlier" });
    expect(pinAt(map, 0, envelope, false, false)).toBeNull();
  });

  test("a reported prompt that is the operator's walky talky message still pins", () => {
    const operator = { uuid: "p7", ts: "", text: "[walky-talky wt_abc123def456] from operator the phone\nrun the tests again" };
    expect(pinAt(map, 0, operator, false, true)).toEqual({ kind: "reported", text: operator.text, truncated: false, ts: "" });
  });
});

describe("the prompt's time", () => {
  const stamped = (id: string, text: string, ts?: string): ChatItem[] => [{ id, kind: "user", text, ts }];

  test("a held run carries its first block's time", () => {
    const map = promptMap([stamped("u1", "first", "2026-09-30T10:07:00.000Z"), stamped("u2", "second", "2026-09-30T10:08:00.000Z"), reply("r1"), reply("r2")]);
    expect(map.runs[0]?.ts).toBe("2026-09-30T10:07:00.000Z");
    expect(pinAt(map, 3, null, false, false)).toEqual({ kind: "held", text: "first\n\nsecond", start: 0, ts: "2026-09-30T10:07:00.000Z" });
  });

  test("a held run with no time carries none", () => {
    const map = promptMap([user("u1", "first"), reply("r1"), reply("r2")]);
    expect(pinAt(map, 2, null, false, false)).toMatchObject({ kind: "held", ts: undefined });
  });

  test("a reported prompt carries the bridge's time", () => {
    const map = promptMap([reply("r0"), reply("r1")]);
    expect(pinAt(map, 0, { ...reported, ts: "2026-09-30T10:07:00.000Z" }, false, false)).toMatchObject({ kind: "reported", ts: "2026-09-30T10:07:00.000Z" });
  });

  test("the earlier pin carries no time", () => {
    const map = promptMap([reply("r0"), reply("r1")]);
    expect(pinAt(map, 0, null, false, true)).toEqual({ kind: "earlier" });
  });
});
