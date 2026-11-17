import { act, render } from "@testing-library/react";
import { createRef } from "react";

import { SessionStream } from "./session-stream";
import type { ChatFeed } from "@/hooks/use-chat-window";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import { __resetPending, addPending, handOverPending, pendingLines, setPendingState } from "@/lib/durable-pending";
import type { ChatEntry } from "@/lib/types";

// M104 spec 01, the thread's half of "one move at the tap": the person's line from a pane with a screen stands in the
// thread at the tap with the working row's room under it; the log's turn takes its place in one render; the room
// becomes "Still working" in the same box; when that row goes, its room stays in the list's one tail room; a line the
// bridge queued goes in the render its queue card arrives; and rows near the tail are drawn at their own height.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
const ADDRESS = "w1:p1";
const AT = Date.parse("2026-11-17T10:00:00.000Z");

// The component reads `Date.now()` with no seam (a pending line expires after `PENDING_KEEP_MS`), and every line
// here is stamped relative to `AT`. So the clock is pinned to `AT`: only `Date` is faked, never the timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
  __resetPending();
});
afterEach(() => vi.useRealTimers());

function entry(uuid: string, seq: number, text: string, over: Partial<ChatEntry> = {}): ChatEntry {
  return { uuid, seq, ts: "2026-11-17T09:59:00.000Z", role: "assistant", parts: [{ kind: "text", text }], ...over };
}
const user = (uuid: string, seq: number, text: string, ts = "2026-11-17T10:00:01.000Z") => entry(uuid, seq, text, { role: "user", ts });

function feedOf(window: Partial<ChatWindow>): ChatFeed {
  return { window: { ...EMPTY_CHAT_WINDOW, status: { kind: "live" }, ...window }, loadOlder: vi.fn(), loadingOlder: false, asked: 0, answered: 0, tried: false };
}

function stream(window: Partial<ChatWindow>, working = false) {
  const listRef = createRef<ChatMessageListHandle>();
  return <SessionStream feed={feedOf(window)} address={ADDRESS} working={working} showToolCalls showCompactions={false} fontSize={14} listRef={listRef} agent="claude" />;
}

const before = [entry("a1", 1, "an earlier answer")];
const seen = new Set(["a1"]);
const pendingRows = () => document.querySelectorAll("[data-slot='stream-pending']");
const userRows = () => Array.from(document.querySelectorAll("[data-block]")).filter((el) => el.textContent?.includes("carry on"));
const room = () => document.querySelector("[data-slot='stream-live-room']");
const live = () => document.querySelector("[data-slot='stream-live']");
const tailRoom = () => document.querySelector<HTMLElement>("[data-slot='session-stream']")?.style.getPropertyValue("--tail-room") ?? "";

function tap(text = "carry on") {
  act(() => addPending(ADDRESS, { requestId: "calm-1", text, at: AT, state: "sending", seen }));
}

describe("SessionStream — one move at the tap (M104)", () => {
  it("draws the line at the tap with the working row's room under it, unseen and unread", () => {
    const { rerender } = render(stream({ entries: before }));
    tap();
    rerender(stream({ entries: before }));
    expect(pendingRows()).toHaveLength(1);
    expect(room()).not.toBeNull();
    expect(room()).toHaveAttribute("aria-hidden");
    expect(room()).toHaveClass("invisible");
    // It never says "Still working" to a reader before the agent works.
    expect(live()).toBeNull();
  });

  it("hands the line over to the log's turn in one render: one row at every step, and the room stays", () => {
    const { rerender } = render(stream({ entries: before }));
    tap();
    rerender(stream({ entries: before }));
    expect(pendingRows().length + userRows().length).toBe(1);
    act(() => setPendingState(ADDRESS, "calm-1", "sent"));
    rerender(stream({ entries: [...before, user("u1", 2, "carry on")] }));
    expect(pendingRows()).toHaveLength(0);
    expect(userRows()).toHaveLength(1);
    expect(room()).not.toBeNull();
  });

  it("takes a NEW user turn with other words as the line's own (a chip's path, a paste): never two rows", () => {
    const { rerender } = render(stream({ entries: before }));
    tap("carry on [image #1]");
    rerender(stream({ entries: before }));
    rerender(stream({ entries: [...before, user("u1", 2, "carry on /tmp/shot.png")] }));
    expect(pendingRows()).toHaveLength(0);
    expect(userRows()).toHaveLength(1);
  });

  it("never takes an old turn, or one with no time, by the new-turn rule", () => {
    const old = user("u0", 0, "something else", "2026-11-17T09:00:00.000Z");
    const timeless = user("u9", 3, "and another", "");
    const { rerender } = render(stream({ entries: [old, ...before] }));
    act(() => addPending(ADDRESS, { requestId: "calm-1", text: "carry on", at: AT, state: "sending", seen: new Set(["a1"]) }));
    rerender(stream({ entries: [old, ...before, timeless] }));
    expect(pendingRows()).toHaveLength(1);
  });

  it("turns the room into Still working in the same box when the agent works", () => {
    const { rerender } = render(stream({ entries: before }));
    tap();
    rerender(stream({ entries: before }));
    const box = room();
    rerender(stream({ entries: before }, true));
    expect(live()).toBe(box);
    expect(live()).not.toHaveClass("invisible");
  });

  it("keeps the working row's room as tail room when it goes, until the next row arrives", () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(32);
    try {
      const turn = [...before, user("u1", 2, "carry on")];
      const { rerender } = render(stream({ entries: turn }, true));
      expect(live()).not.toBeNull();
      expect(tailRoom()).toBe("");
      const answered = [...turn, entry("a2", 3, "done")];
      rerender(stream({ entries: answered }, true));
      rerender(stream({ entries: answered }, false));
      expect(live()).toBeNull();
      expect(tailRoom()).toBe("32px");
      rerender(stream({ entries: [...answered, entry("a3", 4, "one more")] }, false));
      expect(tailRoom()).toBe("");
    } finally {
      height.mockRestore();
    }
  });

  it("drops a line the bridge queued in the render its queue card shows it", () => {
    const { rerender } = render(stream({ entries: before }, true));
    tap();
    act(() => handOverPending(ADDRESS, "calm-1"));
    rerender(stream({ entries: before }, true));
    expect(pendingRows()).toHaveLength(1);
    rerender(stream({ entries: before, queued: ["carry on"] }, true));
    expect(pendingRows()).toHaveLength(0);
    expect(document.querySelector("[data-slot='stream-queued']")).not.toBeNull();
    expect(pendingLines(ADDRESS)).toHaveLength(0);
  });

  it("does not draw a line from a pane with a screen where the thread cannot be read", () => {
    const { rerender } = render(stream({ status: { kind: "unavailable", reason: "no-log" } }));
    tap();
    rerender(stream({ status: { kind: "unavailable", reason: "no-log" } }));
    expect(pendingRows()).toHaveLength(0);
    expect(room()).toBeNull();
  });

  it("draws the rows near the tail at their own height: no content-visibility there, only far above", () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`e${String(i)}`, i, `answer ${String(i)}`, { role: i % 2 === 0 ? "assistant" : "user" }));
    render(stream({ entries: many }));
    const blocks = Array.from(document.querySelectorAll("[data-block]"));
    expect(blocks.length).toBeGreaterThan(8);
    const tail = blocks.slice(-8);
    for (const block of tail) expect(block.className).not.toContain("content-visibility");
    expect(blocks[0]!.className).toContain("[content-visibility:auto]");
    for (const block of blocks) expect(block.className).toContain("[contain-intrinsic-size:auto_64px]");
  });
});
