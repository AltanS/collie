import { act, render } from "@testing-library/react";
import { createRef } from "react";

import { CHAT_PENDING_DELAY_MS } from "./chat-pending";
import { SessionStream } from "./session-stream";
import type { ChatFeed } from "@/hooks/use-chat-window";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { __forgetChatSilhouetteMemory, recallSilhouette, rememberSilhouette, type Silhouette } from "@/lib/chat-silhouette";
import { recallScroll, rememberScroll } from "@/lib/scroll-memory";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import type { ChatEntry } from "@/lib/types";

// What Chat draws while a pane's first page is on its way: the pane's remembered silhouette, bottom-anchored and
// filling the screen, or a typical thread for a pane this device never drew. No text. The page replaces it.

const ADDRESS = "w1:p1";
const SCREEN = 600;

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom lays nothing out: the scroller reports the height of a phone's reading area.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(SCREEN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  __forgetChatSilhouetteMemory();
});

function feedOf(window: Partial<ChatWindow>, over: Partial<ChatFeed> = {}): ChatFeed {
  return { window: { ...EMPTY_CHAT_WINDOW, ...window }, loadOlder: vi.fn(), loadingOlder: false, asked: 0, answered: 0, tried: false, ...over };
}

function entry(uuid: string, seq: number, text: string, role: "user" | "assistant" = "assistant"): ChatEntry {
  return { uuid, seq, ts: "2026-09-30T10:00:00.000Z", role, parts: [{ kind: "text", text }] };
}

function streamOf(feed: ChatFeed, address = ADDRESS) {
  return (
    <SessionStream
      feed={feed}
      address={address}
      working={false}
      showToolCalls
      showCompactions={false}
      fontSize={14}
      listRef={createRef<ChatMessageListHandle>()}
      agent="muse"
    />
  );
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function drawnRows(container: HTMLElement): { kind: string; height: number; margin: number }[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-slot='chat-pending'] > [data-row]")).map((node) => ({
    kind: node.dataset.row ?? "",
    height: Number.parseFloat(node.querySelector<HTMLElement>(":scope > *")?.style.height ?? ""),
    margin: Number.parseFloat(node.style.marginTop),
  }));
}

function drawnHeight(container: HTMLElement): number {
  return drawnRows(container).reduce((sum, row) => sum + row.height + row.margin, 0);
}

describe("the loading view of Chat", () => {
  it("draws nothing inside the short wait, so a switch that is answered at once never shows it", () => {
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS - 10);
    expect(container.querySelector("[data-slot='chat-pending']")).toBeNull();
  });

  it("draws a typical thread that fills the screen for a pane never seen here, with no text", () => {
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    const view = container.querySelector("[data-slot='chat-pending']");
    expect(view).not.toBeNull();
    expect(view).toHaveAttribute("data-anchor", "bottom");
    expect(view).toHaveAttribute("aria-hidden", "true");
    expect(view?.textContent).toBe("");
    expect(drawnHeight(container)).toBeGreaterThanOrEqual(SCREEN);
    const kinds = drawnRows(container).map((row) => row.kind);
    expect(kinds).toContain("person");
    expect(kinds).toContain("agent");
    expect(kinds).toContain("tool");
    expect(kinds.at(-1)).toBe("agent");
  });

  it("draws the pane's remembered rows, newest last, at their heights, in the silhouettes of the real rows", () => {
    const remembered: Silhouette = {
      whole: false,
      rows: [
        { k: "person", h: 56, w: 3 },
        { k: "agent", h: 132, n: 6, w: 1 },
        { k: "tool", h: 44 },
        { k: "card", h: 120 },
        { k: "agent", h: 88, n: 4, w: 2 },
        { k: "person", h: 48, w: 1 },
        { k: "agent", h: 66, n: 3, w: 3 },
      ],
    };
    rememberSilhouette(ADDRESS, remembered);
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    const rows = drawnRows(container);
    expect(rows.map((row) => row.kind)).toEqual(remembered.rows.map((row) => row.k));
    expect(rows.map((row) => row.height)).toEqual(remembered.rows.map((row) => row.h));
    // The newest row is the last one, so it stands at the bottom of the list, where the page's newest row will.
    expect(rows.at(-1)?.kind).toBe("agent");
    // A person's message is a right-aligned block in the bubble surface; agent text is bars with a shorter last line.
    const person = container.querySelector("[data-row='person'] > div");
    expect(person).toHaveClass("ml-auto", "bg-status-working/8", "w-[85%]");
    const lastAgent = container.querySelectorAll("[data-row='agent']")[2]!;
    expect(lastAgent.querySelectorAll(".count-skeleton")).toHaveLength(3);
    expect(lastAgent.querySelectorAll(".count-skeleton")[2]).toHaveClass("w-5/6");
    expect(container.querySelector("[data-row='tool'] > div")).toHaveClass("bg-muted/40");
    expect(container.querySelector("[data-row='card'] > div")).toHaveClass("border-border");
    expect(drawnHeight(container)).toBeGreaterThanOrEqual(SCREEN);
    expect(container.querySelector("[data-slot='chat-pending']")?.textContent).toBe("");
  });

  it("fills the screen when the remembered rows fall short, with the typical thread above them", () => {
    const remembered: Silhouette = { whole: false, rows: [{ k: "person", h: 48, w: 2 }, { k: "tool", h: 44 }, { k: "agent", h: 44, n: 2, w: 2 }] };
    rememberSilhouette(ADDRESS, remembered);
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    const rows = drawnRows(container);
    expect(rows.at(-1)).toMatchObject({ kind: "agent", height: 44 });
    expect(drawnHeight(container)).toBeGreaterThanOrEqual(SCREEN);
  });

  it("draws a mix for a pane whose last screen was text alone, never bars of lines only", () => {
    rememberSilhouette(ADDRESS, { whole: false, rows: Array.from({ length: 8 }, () => ({ k: "agent" as const, h: 110, n: 5, w: 2 as const })) });
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    const kinds = drawnRows(container).map((row) => row.kind);
    expect(kinds).toContain("person");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("agent");
    expect(drawnHeight(container)).toBeGreaterThanOrEqual(SCREEN);
  });

  it("draws a whole short thread from the top and does not fill the screen, as the thread will arrive", () => {
    rememberSilhouette(ADDRESS, { whole: true, rows: [{ k: "person", h: 48, w: 1 }, { k: "agent", h: 44, n: 2, w: 2 }] });
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    expect(container.querySelector("[data-slot='chat-pending']")).toHaveAttribute("data-anchor", "top");
    expect(drawnRows(container)).toHaveLength(2);
  });

  it("is another pane's own: a silhouette of one pane is never drawn for another", () => {
    rememberSilhouette("w9:p9", { whole: false, rows: [{ k: "card", h: 400 }] });
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    expect(drawnRows(container).some((row) => row.kind === "card")).toBe(false);
  });

  it("is replaced by the page when it arrives, and nothing of the silhouette stays", () => {
    const { container, rerender } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    expect(container.querySelector("[data-slot='chat-pending']")).not.toBeNull();
    rerender(streamOf(feedOf({ status: { kind: "live" }, entries: [entry("u", 1, "a question", "user"), entry("a", 2, "an answer")] }, { tried: true })));
    expect(container.querySelector("[data-slot='chat-pending']")).toBeNull();
    expect(container.querySelectorAll("[data-block]")).toHaveLength(2);
  });

  it("leaves the reader's remembered place alone: where the silhouette is pinned is not a place in the thread", () => {
    rememberScroll(ADDRESS, 480);
    const { container } = render(streamOf(feedOf({})));
    wait(CHAT_PENDING_DELAY_MS + 10);
    const scroller = container.querySelector<HTMLElement>("[data-slot='session-stream']");
    scroller!.scrollTop = 900;
    act(() => {
      scroller!.dispatchEvent(new Event("scroll"));
    });
    expect(recallScroll(ADDRESS) ?? 0).toBe(0);
  });

  it("is not drawn once the first read has been tried, however empty its answer", () => {
    const { container } = render(streamOf(feedOf({}, { tried: true })));
    wait(CHAT_PENDING_DELAY_MS + 10);
    expect(container.querySelector("[data-slot='chat-pending']")).toBeNull();
  });
});

describe("recording the silhouette from the page Chat draws", () => {
  it("keeps the kinds and counts of the rows drawn, after the page has settled, and no word of them", () => {
    const secret = "the-private-words-of-this-thread";
    const feed = feedOf(
      { status: { kind: "live" }, entries: [entry("u", 1, `${secret} question`, "user"), entry("a", 2, `${secret} answer`)] },
      { tried: true },
    );
    const { unmount } = render(streamOf(feed));
    expect(recallSilhouette(ADDRESS)).toBeUndefined();
    wait(500);
    const silhouette = recallSilhouette(ADDRESS);
    expect(silhouette?.rows.map((row) => row.k)).toEqual(["person", "agent"]);
    expect(silhouette?.whole).toBe(true);
    const raw = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i)!) ?? "").join("\n");
    expect(raw).toContain('"rows"');
    expect(raw).not.toContain(secret);
    unmount();
  });

  it("is not recorded for a saved copy, and a page with older rows is not taken as a whole thread", () => {
    const saved = feedOf({ status: { kind: "live" }, savedAt: Date.now(), entries: [entry("a", 1, "an answer")] }, { tried: true });
    render(streamOf(saved, "w2:p2"));
    wait(500);
    expect(recallSilhouette("w2:p2")).toBeUndefined();
    const older = feedOf({ status: { kind: "live" }, hasOlder: true, entries: [entry("a", 1, "an answer")] }, { tried: true });
    render(streamOf(older, "w3:p3"));
    wait(500);
    expect(recallSilhouette("w3:p3")?.whole).toBe(false);
  });

  it("writes the last page at once when the pane is left, inside the wait", () => {
    const feed = feedOf({ status: { kind: "live" }, entries: [entry("a", 1, "an answer")] }, { tried: true });
    const { unmount } = render(streamOf(feed, "w4:p4"));
    expect(recallSilhouette("w4:p4")).toBeUndefined();
    unmount();
    expect(recallSilhouette("w4:p4")).toBeDefined();
  });
});
