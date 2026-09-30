import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";

import { SessionStream } from "./session-stream";
import type { ChatFeed } from "@/hooks/use-chat-window";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";
import type { ChatEntry } from "@/lib/types";

// The pane view's second body. The load-bearing behaviours: the two empty answers are never drawn
// alike, a pane with nothing to read says nothing until it has actually asked, older turns come off
// `hasOlder` and nothing else, and a rewound turn is not part of the conversation.
//
// It takes a FEED rather than a paneId, so every case here is a plain render with no network: the
// fetching lives in `hooks/use-chat-window.ts` and the merge in `lib/chat-window.ts`.

beforeAll(() => {
  // jsdom doesn't implement scrollTo; ChatMessageList's auto-scroll calls it on mount.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const BASE = 1_000_000;

function entry(uuid: string, seq: number, text: string, over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    uuid,
    seq,
    ts: "2026-09-30T10:00:00.000Z",
    role: "assistant",
    parts: [{ kind: "text", text }],
    ...over,
  };
}

function feedOf(window: Partial<ChatWindow>, over: Partial<ChatFeed> = {}): ChatFeed {
  return {
    window: { ...EMPTY_CHAT_WINDOW, ...window },
    loadOlder: vi.fn(),
    loadingOlder: false,
    ...over,
  };
}

function renderStream(feed: ChatFeed, showToolCalls = true) {
  const listRef = createRef<ChatMessageListHandle>();
  return render(
    <SessionStream
      feed={feed}
      address="w1:p1"
      showToolCalls={showToolCalls}
      fontSize={14}
      listRef={listRef}
    />,
  );
}

describe("SessionStream", () => {
  it("draws the turns it holds, oldest first", () => {
    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [entry("a", BASE, "first"), entry("b", BASE + 1, "second")],
      }),
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("says nothing at all before the first answer has landed", () => {
    const { container } = renderStream(feedOf({}));
    expect(container.querySelectorAll("[data-block]")).toHaveLength(0);
    expect(screen.queryByText(/session/i)).toBeNull();
  });

  it("says a live session is empty only once the window has answered", () => {
    renderStream(feedOf({ status: { kind: "live" } }));
    expect(screen.getByText("Nothing has been said in this session yet.")).toBeInTheDocument();
  });

  // ADR 0073 point 7: a 404 means "update this member", never "this pane has nothing to show".
  it("tells a machine a release behind apart from a pane with no session", () => {
    const stale = renderStream(feedOf({ status: { kind: "stale" } }));
    expect(
      screen.getByText("This machine runs an older Collie. Update it to follow the conversation here."),
    ).toBeInTheDocument();
    stale.unmount();

    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-session" } }));
    expect(
      screen.getByText("This pane has no agent session, so there's no transcript to read."),
    ).toBeInTheDocument();
  });

  it("keeps the turns a stale answer arrived after — a version skew does not unsay them", () => {
    renderStream(feedOf({ status: { kind: "stale" }, entries: [entry("a", BASE, "said this")] }));
    expect(screen.getByText("said this")).toBeInTheDocument();
    expect(screen.getByText(/older Collie/)).toBeInTheDocument();
  });

  it("offers older turns only where the window says there are some", () => {
    const none = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: false }),
    );
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    expect(screen.getByText("Start of the conversation")).toBeInTheDocument();
    none.unmount();

    const loadOlder = vi.fn();
    renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: true }, { loadOlder }),
    );
    expect(screen.getByRole("button", { name: "Load older" })).toBeInTheDocument();
    expect(screen.queryByText("Start of the conversation")).toBeNull();
  });

  it("asks for the older page on a tap, and says so while it is in flight", async () => {
    const user = userEvent.setup();
    const loadOlder = vi.fn();
    const { rerender } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: true }, { loadOlder }),
    );
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(loadOlder).toHaveBeenCalledOnce();

    const listRef = createRef<ChatMessageListHandle>();
    rerender(
      <SessionStream
        feed={feedOf(
          { status: { kind: "live" }, entries: [entry("a", BASE, "hi")], hasOlder: true },
          { loadOlder, loadingOlder: true },
        )}
        address="w1:p1"
        showToolCalls
        fontSize={14}
        listRef={listRef}
      />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  // jsdom has no layout, so the scroller's two numbers are faked. What is under test is the
  // ARITHMETIC: the reader gets back exactly the height that went in above them.
  it("a page of older turns leaves the reader where they were, not at the top", async () => {
    const user = userEvent.setup();
    const loadOlder = vi.fn();
    const newer = [entry("b", BASE + 1, "newer")];
    const listRef = createRef<ChatMessageListHandle>();
    const draw = (entries: ChatEntry[], hasOlder: boolean) => (
      <SessionStream
        feed={feedOf({ status: { kind: "live" }, entries, hasOlder }, { loadOlder })}
        address="w1:p1"
        showToolCalls
        fontSize={14}
        listRef={listRef}
      />
    );
    const { rerender } = render(draw(newer, true));

    const el = listRef.current!.getScrollElement()!;
    let height = 1000;
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    top = 400;

    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(loadOlder).toHaveBeenCalledOnce();

    // The page lands: 600px of older turns went in ABOVE the viewport.
    height = 1600;
    rerender(draw([entry("a", BASE, "older"), ...newer], false));
    expect(el.scrollTop).toBe(1000);
  });

  it("a turn arriving at the TAIL while a page is in flight does not spend the anchor", async () => {
    const user = userEvent.setup();
    const loadOlder = vi.fn();
    const listRef = createRef<ChatMessageListHandle>();
    const draw = (entries: ChatEntry[], loadingOlder: boolean) => (
      <SessionStream
        feed={feedOf(
          { status: { kind: "live" }, entries, hasOlder: true },
          { loadOlder, loadingOlder },
        )}
        address="w1:p1"
        showToolCalls
        fontSize={14}
        listRef={listRef}
      />
    );
    const first = entry("a", BASE, "first");
    const { rerender } = render(draw([first], false));

    const el = listRef.current!.getScrollElement()!;
    let height = 1000;
    let top = 0;
    Object.defineProperty(el, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    top = 400;

    await user.click(screen.getByRole("button", { name: "Load older" }));
    height = 1400;
    rerender(draw([first, entry("z", BASE + 9, "a reply landed")], true));
    expect(el.scrollTop).toBe(400);

    // And the real page still gets its anchor when it arrives. The delta is measured from the tap,
    // so the 400px the tail grew by is in it: a hair low rather than a screen out.
    height = 2000;
    rerender(draw([entry("older", BASE - 1, "older"), first], false));
    expect(el.scrollTop).toBe(1400);
  });

  // The journal KEEPS a rewound turn so a `?before=` cursor can still resolve its uuid; hiding it is
  // the reader's job, here as on the History page (ADR 0073's addendum).
  it("hides a turn the agent rewound past", () => {
    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [entry("a", BASE, "kept"), entry("b", BASE + 1, "abandoned", { abandoned: true })],
      }),
    );
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.queryByText("abandoned")).toBeNull();
  });

  it("folds a lone step to one line while tool calls are off, and draws it while they are on", () => {
    const off = renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [
          entry("a", BASE, "", {
            // A FINISHED step: a run with anything still running stays open by design, and this
            // case is about the fold.
            parts: [
              {
                kind: "tool",
                id: "t1",
                name: "Read",
                summary: "/a.ts",
                call: { kind: "read", path: "/a.ts" },
                result: { text: "" },
              },
            ],
          }),
        ],
      }),
      false,
    );
    expect(screen.getByRole("button", { expanded: false })).toHaveTextContent("1 read");
    off.unmount();

    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [
          entry("a", BASE, "", {
            // A FINISHED step: a run with anything still running stays open by design, and this
            // case is about the fold.
            parts: [
              {
                kind: "tool",
                id: "t1",
                name: "Read",
                summary: "/a.ts",
                call: { kind: "read", path: "/a.ts" },
                result: { text: "" },
              },
            ],
          }),
        ],
      }),
      true,
    );
    expect(screen.getByText("Read")).toBeInTheDocument();
  });
});
