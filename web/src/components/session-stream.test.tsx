import { act, render, screen } from "@testing-library/react";
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
    asked: 0,
    answered: 0,
    tried: false,
    ...over,
  };
}

function renderStream(
  feed: ChatFeed,
  showToolCalls = true,
  working = false,
  starting = false,
  onSendQueuedNow?: (keys: readonly string[]) => Promise<boolean>,
) {
  const listRef = createRef<ChatMessageListHandle>();
  return render(
    <SessionStream
      feed={feed}
      address="w1:p1"
      working={working}
      starting={starting}
      showToolCalls={showToolCalls}
      showCompactions={false}
      fontSize={14}
      listRef={listRef}
      onSendQueuedNow={onSendQueuedNow}
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
    expect(screen.getByText("Send a message to start.")).toBeInTheDocument();
  });

  // 1.17.0: a NEW pane has nothing to read, and that is expected (lib/chat-gate.ts). It says how to
  // begin, never the readings that are only true of a pane that should have a log by now.
  it("on a new pane, says how to begin instead of reporting a missing session or log", () => {
    for (const status of [
      { kind: "empty" },
      { kind: "unavailable", reason: "no-session" },
      { kind: "unavailable", reason: "no-log" },
    ] as const) {
      const r = renderStream(feedOf({ status }), true, false, true);
      expect(screen.getByText("Send a message to start.")).toBeInTheDocument();
      expect(screen.queryByText(/no agent session|No transcript file/)).toBeNull();
      r.unmount();
    }
  });

  it("on a new pane that is working, shows the running turn and not the line that says how to begin", () => {
    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-log" } }), true, true, true);
    expect(screen.getByText("Still working…")).toBeInTheDocument();
    expect(screen.queryByText("Send a message to start.")).toBeNull();
  });

  it("a pane that is not new still says its log is missing", () => {
    renderStream(feedOf({ status: { kind: "unavailable", reason: "no-log" } }));
    expect(screen.getByText("No transcript file was found for this pane's session yet.")).toBeInTheDocument();
    expect(screen.queryByText("Send a message to start.")).toBeNull();
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
        working={false}
        showToolCalls
        showCompactions={false}
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
        working={false}
        showToolCalls
        showCompactions={false}
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
        working={false}
        showToolCalls
        showCompactions={false}
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
  // ── the tail row: a turn in flight ────────────────────────────────────────
  // The mirror shows the agent's own spinner; this body draws the record, and a record gains nothing
  // while a compaction runs. Without this row a compacting session looked exactly like a finished one.
  it("says a turn is still running while the agent is working", () => {
    renderStream(feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] }), true, true);
    expect(screen.getByText("Still working…")).toBeInTheDocument();
  });

  it("says nothing while the agent is idle", () => {
    renderStream(feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] }), true, false);
    expect(screen.queryByText("Still working…")).not.toBeInTheDocument();
  });

  it("says nothing over a journal it cannot read, busy or not", () => {
    // Busy in the chrome is true; promising a turn this body will never draw is not.
    renderStream(
      feedOf({ status: { kind: "unavailable", reason: "no-session" }, entries: [] }),
      true,
      true,
    );
    expect(screen.queryByText("Still working…")).not.toBeInTheDocument();
  });

  it("stands at the END of the thread, where the answer will arrive", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")] }),
      true,
      true,
    );
    const blocks = [...container.querySelectorAll("[data-block], [data-slot='stream-live']")];
    expect(blocks.at(-1)?.getAttribute("data-slot")).toBe("stream-live");
  });
});

// ── what you typed that has not started yet (M41/12) ─────────────────────────
//
// The other half of the same blindness: a compaction runs, you queue a message, and nothing on the
// phone says the message exists. It is state and not a turn, so it is a row of its own.
describe("SessionStream — the queue", () => {
  it("shows what you typed that has not been started", () => {
    renderStream(
      feedOf({
        status: { kind: "live" },
        entries: [entry("a", BASE, "hi")],
        queued: ["and the tests too"],
      }),
      true,
      true,
    );
    expect(screen.getByText("Waiting to send")).toBeInTheDocument();
    expect(screen.getByText("and the tests too")).toBeInTheDocument();
  });

  it("shows every waiting message, oldest first", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [], queued: ["first", "second"] }),
      true,
      true,
    );
    const texts = [...container.querySelectorAll("[data-slot='stream-queued'] p")].map((p) => p.textContent);
    expect(texts).toEqual(["Waiting to send", "first", "second"]);
  });

  it("draws it even when the pane does not read as working", () => {
    // The reported gap is exactly the moment those two disagree. A queued message is a fact on its own.
    renderStream(feedOf({ status: { kind: "live" }, entries: [], queued: ["mine"] }), true, false);
    expect(screen.getByText("mine")).toBeInTheDocument();
  });

  it("says nothing when nothing is waiting", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], queued: [] }),
      true,
      true,
    );
    expect(container.querySelector("[data-slot='stream-queued']")).toBeNull();
  });

  it("says nothing over a journal it cannot read", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "unavailable", reason: "no-session" }, queued: ["mine"] }),
      true,
      true,
    );
    expect(container.querySelector("[data-slot='stream-queued']")).toBeNull();
  });

  it("stands under the working mark, at the end of the thread", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [entry("a", BASE, "hi")], queued: ["mine"] }),
      true,
      true,
    );
    const rows = [
      ...container.querySelectorAll("[data-block], [data-slot='stream-live'], [data-slot='stream-queued']"),
    ].map((el) => el.getAttribute("data-slot"));
    expect(rows.slice(-2)).toEqual(["stream-live", "stream-queued"]);
  });

  it("shows two identical queued messages as two", () => {
    const { container } = renderStream(
      feedOf({ status: { kind: "live" }, entries: [], queued: ["same", "same"] }),
      true,
      true,
    );
    const texts = [...container.querySelectorAll("[data-slot='stream-queued'] p")].map((p) => p.textContent);
    expect(texts).toEqual(["Waiting to send", "same", "same"]);
  });
});

// ── "Send now" on the waiting card ───────────────────────────────────────────
//
// The keys are DATA from the bridge (`ChatWindow.sendQueuedNow`), so these cases name no harness. The
// pane view hands `onSendQueuedNow` over only where this device may write; leaving it out is how
// every "nothing may act" state loses the button.
describe("SessionStream — Send now", () => {
  const live = (over: Partial<ChatWindow> = {}) =>
    feedOf({ status: { kind: "live" }, entries: [], queued: ["first", "second"], sendQueuedNow: ["ctrl+Enter"], ...over });

  it("shows one button on the group, beside the label, when the bridge declared keys and the device can write", () => {
    const { container } = renderStream(live(), true, true, false, vi.fn(async () => true));
    const buttons = container.querySelectorAll("[data-slot='stream-send-now']");
    expect(buttons).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send now, the waiting messages" })).toHaveTextContent("Send now");
    // In the head row with the label, not among the message paragraphs.
    expect(buttons[0]!.parentElement).toBe(container.querySelector("[data-slot='stream-queued'] > div"));
  });

  it("is absent when the bridge declared no keys", () => {
    const { container } = renderStream(live({ sendQueuedNow: [] }), true, true, false, vi.fn(async () => true));
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("is absent when the device cannot act, because the handler is withheld", () => {
    const { container } = renderStream(live(), true, true);
    expect(container.querySelector("[data-slot='stream-queued']")).not.toBeNull();
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("is absent when nothing is waiting, however many keys are declared", () => {
    const { container } = renderStream(live({ queued: [] }), true, true, false, vi.fn(async () => true));
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("is absent on a window that is not live", () => {
    const { container } = renderStream(
      live({ status: { kind: "unavailable", reason: "no-log" } }),
      true,
      true,
      false,
      vi.fn(async () => true),
    );
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("a tap hands the declared keys over once, shows pending, and a second tap sends nothing", async () => {
    let finish: (sent: boolean) => void = () => {};
    const send = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    renderStream(live({ sendQueuedNow: ["ctrl+Enter"] }), true, true, false, send);
    const button = screen.getByRole("button", { name: "Send now, the waiting messages" });
    await userEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(["ctrl+Enter"]);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(send).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it("drops the pending face at once when nothing was sent", async () => {
    const send = vi.fn(async () => false);
    renderStream(live(), true, true, false, send);
    const button = screen.getByRole("button", { name: "Send now, the waiting messages" });
    await userEvent.click(button);
    await vi.waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("drops the pending face after five seconds and never sends again on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const send = vi.fn(async () => true);
      renderStream(live(), true, true, false, send);
      const button = screen.getByRole("button", { name: "Send now, the waiting messages" });
      await userEvent.click(button);
      expect(button).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(button).not.toBeDisabled();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names no harness: the component source holds no quoted harness name", async () => {
    // SAFETY: Vite's `?raw` import is a string module by contract; the dynamic import only types it as unknown.
    const source = (await import("./session-stream.tsx?raw")).default as string;
    for (const name of ["claude", "codex", "opencode", "grok", "hermes", "muse", "pi", "omp"]) {
      expect(source).not.toMatch(new RegExp(`["'\\u0060]${name}["'\\u0060]`, "i"));
    }
  });
});
