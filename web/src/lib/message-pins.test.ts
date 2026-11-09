import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { apiErrorFields, fetchPanePins, pinItem } from "./api";
import type { ChatItem } from "./chat-items";
import { setLocale } from "./i18n";
import {
  blockOfPin,
  writingItemId,
  hostKeepsPins,
  isPinnable,
  itemCopyText,
  itemTitle,
  newestFirst,
  pinAsItem,
  pinFailure,
  pinnedByItem,
  pinTitle,
  rowOf,
} from "./message-pins";
import type { PinFull, PinRow } from "./types";

beforeEach(() => setLocale("en"));

const user: ChatItem = { id: "u1:0", kind: "user", text: "do the thing" };
const reply: ChatItem = { id: "a1:0", kind: "reply", text: "done" };
const tool: ChatItem = {
  id: "toolu_1",
  kind: "tool",
  status: "done",
  tool: { kind: "execute", command: "git status -sb", output: "## main" },
};

describe("hostKeepsPins", () => {
  it.each([
    [undefined, true],
    ["1.28.0", true],
    ["1.28.0-edge.1", true],
    ["1.28.1-dev", true],
    ["2.0.0", true],
    ["1.27.9", false],
    ["1.27.0", false],
    ["0.9.0", false],
    ["not a version", true],
  ])("reads %s as %s", (version, keeps) => {
    expect(hostKeepsPins(version)).toBe(keeps);
  });
});

describe("isPinnable", () => {
  it("pins a person's line, a reply, a thinking block, a notice and a tool card", () => {
    const items: ChatItem[] = [
      user,
      reply,
      { id: "t:0", kind: "thinking", text: "hm" },
      { id: "n:0", kind: "notice", text: "note", note: true },
      tool,
    ];
    expect(items.map(isPinnable)).toEqual([true, true, true, true, true]);
  });

  it("never pins a picture or the compaction marker", () => {
    expect(isPinnable({ id: "i:0", kind: "image", url: "/api/blobs/x" })).toBe(false);
    expect(isPinnable({ id: "c:0", kind: "compacted" })).toBe(false);
  });

  it("waits for a tool call that is still running, and takes one that ended, however it ended", () => {
    const call = { kind: "execute", command: "ls" } as const;
    expect(isPinnable({ id: "t:0", kind: "tool", status: "running", tool: call })).toBe(false);
    expect(isPinnable({ id: "t:0", kind: "tool", status: "done", tool: call })).toBe(true);
    expect(isPinnable({ id: "t:0", kind: "tool", status: "failed", tool: call })).toBe(true);
    expect(isPinnable({ id: "t:0", kind: "tool", status: "denied", tool: call })).toBe(true);
  });

  it("waits for a reply the program is still writing", () => {
    expect(isPinnable({ id: "a1:0", kind: "reply", text: "do", partial: true })).toBe(false);
    expect(isPinnable({ id: "a1:0", kind: "thinking", text: "hm", partial: true })).toBe(false);
    expect(isPinnable({ id: "a1:0", kind: "notice", text: "n", partial: true })).toBe(false);
  });
});

describe("writingItemId", () => {
  const blocks = (...items: ChatItem[]) => items.map((item) => [item]);

  it("names the last reply or thinking block while the agent works, and nothing once it is idle", () => {
    expect(writingItemId(blocks(user, reply), true)).toBe("a1:0");
    expect(writingItemId(blocks(user, { id: "a2:0", kind: "thinking", text: "hm" }), true)).toBe("a2:0");
    expect(writingItemId(blocks(user, reply), false)).toBeUndefined();
  });

  it("names nothing when the stream ends in a person's line, a tool call or nothing", () => {
    expect(writingItemId(blocks(reply, user), true)).toBeUndefined();
    expect(writingItemId(blocks(reply, tool), true)).toBeUndefined();
    expect(writingItemId([], true)).toBeUndefined();
  });
});

describe("what a block says about itself", () => {
  it("titles a tool without a name by the plain word, never 'Tool: '", () => {
    expect(itemTitle({ id: "t:0", kind: "tool", status: "done", tool: { kind: "other", name: "", summary: "" } })).toBe("Tool");
    expect(pinTitle({ kind: "tool" })).toBe("Tool");
    expect(pinTitle({ kind: "tool", tool: { name: "  " } })).toBe("Tool");
    expect(pinTitle({ kind: "tool", tool: { name: "Bash" } })).toBe("Tool: Bash");
  });

  it("titles a block by its kind in words and a tool card by its tool", () => {
    expect(itemTitle(user)).toBe("Your message");
    expect(itemTitle(reply)).toBe("Reply");
    expect(itemTitle(tool)).toBe("Tool: git");
    expect(itemTitle({ id: "o:0", kind: "tool", status: "done", tool: { kind: "other", name: "Skill", summary: "x" } })).toBe("Tool: Skill");
  });

  it("copies a text as it is and a tool card as its step line over what it printed", () => {
    expect(itemCopyText(user)).toBe("do the thing");
    expect(itemCopyText(tool)).toBe("git: git status -sb\n## main");
  });
});

describe("pins as the stream and the sheet hold them", () => {
  const row = (over: Partial<PinRow> & { id: string; itemId: string }): PinRow => ({
    kind: "reply",
    excerpt: "e",
    textLength: 1,
    anchor: "a",
    pinnedAt: 1,
    ...over,
  });

  it("maps item ids to pin ids, and a block on its way to its empty id", () => {
    const map = pinnedByItem([row({ id: "p1", itemId: "a1:0" })], new Set(["u1:0"]));
    expect([...map]).toEqual([
      ["u1:0", ""],
      ["a1:0", "p1"],
    ]);
  });

  it("orders newest first without touching the list it was given", () => {
    const rows = [row({ id: "p1", itemId: "a", pinnedAt: 1 }), row({ id: "p2", itemId: "b", pinnedAt: 3 }), row({ id: "p3", itemId: "c", pinnedAt: 2 })];
    expect(newestFirst(rows).map((r) => r.id)).toEqual(["p2", "p3", "p1"]);
    expect(rows[0]!.id).toBe("p1");
  });

  it("makes the list's row out of a whole pin: the first 400 characters and the length", () => {
    const pin: PinFull = { id: "p1", itemId: "a", kind: "reply", text: "y".repeat(500), anchor: "y", pinnedAt: 1 };
    const made = rowOf(pin);
    expect(made.excerpt).toHaveLength(400);
    expect(made.textLength).toBe(500);
    expect(made).not.toHaveProperty("text");
  });

  it("finds the block a pin leads back to by its id, else by the start of its text", () => {
    const blocks: ChatItem[][] = [[user], [{ id: "new:0", kind: "reply", text: "done and dusted" }]];
    expect(blockOfPin(blocks, { itemId: "u1:0", anchor: "x" })).toBe(0);
    expect(blockOfPin(blocks, { itemId: "gone:0", anchor: "done and" })).toBe(1);
    expect(blockOfPin(blocks, { itemId: "gone:0", anchor: "nothing like it" })).toBe(-1);
    expect(blockOfPin(blocks, { itemId: "gone:0", anchor: "" })).toBe(-1);
  });

  it("draws a pin as the block Chat draws, a thinking block and a notice as prose", () => {
    const base = { id: "p1", itemId: "a:0", anchor: "", pinnedAt: 1 };
    expect(pinAsItem({ ...base, kind: "user", text: "hi" })).toMatchObject({ kind: "user", text: "hi", id: "a:0" });
    expect(pinAsItem({ ...base, kind: "thinking", text: "hm" })).toMatchObject({ kind: "reply", text: "hm" });
    expect(pinAsItem({ ...base, kind: "notice", text: "n" })).toMatchObject({ kind: "reply", text: "n" });
    expect(pinAsItem({ ...base, kind: "tool", text: "out", tool: { name: "Bash", input: "ls" } })).toMatchObject({
      kind: "tool",
      tool: { kind: "other", name: "Bash", summary: "ls", output: "out" },
    });
  });
});

describe("pinFailure", () => {
  const refuseText = (status: number, text: string) => server.use(http.post(/\/api\/pane\/[^/]+\/pins$/, () => new HttpResponse(text, { status })));
  const refuse = (status: number, code: string) =>
    server.use(http.post(/\/api\/pane\/[^/]+\/pins$/, () => HttpResponse.json({ error: code, code, message: "english" }, { status })));
  const failed = () => pinItem(undefined, "w1:p1", "u1:0").catch(<TThrown,>(e: TThrown) => e);

  it.each([
    [404, "pin.item_not_found", "That block is no longer in this session's log."],
    [409, "pin.cap", "This session has 100 pins, unpin one first."],
    [409, "pin.no_session", "This pane has no session to keep pins for."],
    [409, "pin.not_pinnable", "That block cannot be pinned."],
    [409, "pin.not_settled", "That reply is still being written. Pin it when it is done."],
  ])("says the machine's own %s %s in words", async (status, code, sentence) => {
    refuse(status, code);
    expect(pinFailure(await failed())).toBe(sentence);
  });

  it("reads a 404 with no pin code as an older machine, and a 404 with one as that refusal", async () => {
    refuseText(404, "not found");
    const older = await failed();
    expect(apiErrorFields(older)?.code).toBeUndefined();
    expect(pinFailure(older)).toBe("That machine's Collie is older and cannot keep pins. Update it.");
    refuse(404, "pin.item_not_found");
    expect(pinFailure(await failed())).toBe("That block is no longer in this session's log.");
  });

  it("words a pin that is gone, and falls back to the catalogue for anything else", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/pins$/, () => HttpResponse.json({ error: "pin.not_found", code: "pin.not_found", message: "m" }, { status: 404 })));
    const gone = await fetchPanePins(undefined, "w1:p1").catch(<TThrown,>(e: TThrown) => e);
    expect(pinFailure(gone)).toBe("That pin is gone.");
    refuseText(500, "boom");
    expect(pinFailure(await failed())).not.toBe("");
  });
});
