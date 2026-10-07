import type { ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { DEAD_DEBOUNCE_MS, LIVE_CAP_MS, markDead, markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M46 spec 11 on the composer: with no live answer from the bridge for this pane (or a parent that
// drew the screen from the cache), Send and the other write paths are off and say why. Typing and the
// draft's own save carry on, and nothing is queued or sent when the bridge returns.
// (composer.test.tsx pins the pane live, so the real gating is tested here.)

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
});
afterEach(() => cleanup());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    dialogPresent: false,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

function watchNetwork() {
  const calls: string[] = [];
  server.use(
    http.all(/\/api\/pane\//, ({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ ok: true });
    }),
  );
  return calls;
}

const NOTE = "The draft stays on this phone and is never sent by itself.";

describe("Composer — no action from cached state (M46 spec 11)", () => {
  it("disables Send with 'Reconnect to send' when the pane is not live, and still saves the draft", async () => {
    const user = userEvent.setup();
    const calls = watchNetwork();
    renderComposer();

    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "hold this thought");

    const send = screen.getByRole("button", { name: "Reconnect to send" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", "Reconnect to send");
    expect(box).toHaveValue("hold this thought"); // typing works
    expect(loadDraft(undefined, "w1:p1")).toBe("hold this thought"); // and the draft saves

    await user.click(send);
    await user.type(box, "{Enter}");
    expect(calls).toEqual([]); // nothing sent, nothing queued
  });

  it("enables Send once a live read lands, and sends nothing by itself on the way", async () => {
    const user = userEvent.setup();
    const calls = watchNetwork();
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "later");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();

    act(() => markLive("w1:p1"));

    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(calls).toEqual([]); // reconnecting is not consent: no auto-send of the saved draft
  });

  it("disables Send again once a read fails, after the one-second debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderComposer();
      await user.type(screen.getByPlaceholderText(/type a reply/i), "x");
      act(() => markLive("w1:p1"));
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      act(() => markDead("w1:p1"));
      // One dropped poll does not flicker the button.
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      act(() => {
        vi.advanceTimersByTime(DEAD_DEBOUNCE_MS + 10);
      });
      expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Send on across a quiet stretch longer than the old 15 s window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderComposer();
      await user.type(screen.getByPlaceholderText(/type a reply/i), "x");
      act(() => markLive("w1:p1"));
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      act(() => {
        vi.advanceTimersByTime(LIVE_CAP_MS);
      });
      expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a stale parent screen as offline even while the pane is live", async () => {
    const user = userEvent.setup();
    const calls = watchNetwork();
    markLive("w1:p1");
    renderComposer({ stale: true });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "from the cache");
    const send = screen.getByRole("button", { name: "Reconnect to send" });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(calls).toEqual([]);
  });

  it("is per pane: a live answer for another pane does not open this one", async () => {
    const user = userEvent.setup();
    markLive("w1:p2");
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "x");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
  });

  it("says once, in the floating slot above the belt, that the draft stays on this phone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderComposer();
      // A cold mount waiting on its first read does not flash it.
      expect(screen.queryByText(NOTE)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1_600);
      });
      expect(screen.getByText(NOTE)).toBeInTheDocument();
      // An overlay, never a row of the composer: absolutely placed above the composer's top edge,
      // with no Collapse around it, so nothing in the flow moves when it comes or goes.
      const wrapper = screen.getByText(NOTE).closest('[data-slot="offline-draft-note"]')!;
      expect(wrapper.className).toMatch(/(?:^|\s)absolute(?=\s|$)/);
      expect(wrapper.className).toMatch(/(?:^|\s)bottom-full(?=\s|$)/);
      expect(wrapper.className).toMatch(/(?:^|\s)pointer-events-none(?=\s|$)/);
      expect(wrapper.closest('[data-slot="collapse"]')).toBeNull();
      // Live again: gone, and once per pane view, so the next outage does not repeat it.
      act(() => markLive("w1:p1"));
      expect(screen.queryByText(NOTE)).toBeNull();
      act(() => markDead("w1:p1"));
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
      expect(screen.queryByText(NOTE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("portals the note into the slot it is handed, the terminal-draft notice's slot", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const slot = document.createElement("div");
    document.body.append(slot);
    try {
      renderComposer({ draftNoticeSlot: slot });
      act(() => {
        vi.advanceTimersByTime(1_600);
      });
      expect(slot).toHaveTextContent(NOTE);
      // In the slot the wrapper is only the pass-through: the slot does the positioning.
      const wrapper = slot.querySelector('[data-slot="offline-draft-note"]')!;
      expect(wrapper.className).not.toMatch(/(?:^|\s)absolute(?=\s|$)/);
    } finally {
      slot.remove();
      vi.useRealTimers();
    }
  });

  it("the x dismisses the note for this pane view, and Send stays off", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const calls = watchNetwork();
      renderComposer();
      act(() => {
        vi.advanceTimersByTime(1_600);
      });
      expect(screen.getByText(NOTE)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Dismiss the offline draft note" }));
      expect(screen.queryByText(NOTE)).toBeNull();
      // Dismissing changes nothing about the gate.
      expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
      // Spent: still offline, it does not come back, nor after a live stretch and a second outage.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByText(NOTE)).toBeNull();
      act(() => markLive("w1:p1"));
      act(() => markDead("w1:p1"));
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while the terminal-draft notice holds the slot, then shows when it is dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderComposer({ terminalDraft: "typed on the host", rawTerminalDraft: "typed on the host" });
      act(() => {
        vi.advanceTimersByTime(1_600);
      });
      expect(screen.getByText(/draft in terminal/i)).toBeInTheDocument();
      // One notice in the slot: the terminal draft wins.
      expect(screen.queryByText(NOTE)).toBeNull();

      await user.click(screen.getByRole("button", { name: "Dismiss the terminal draft notice" }));
      expect(screen.queryByText(/draft in terminal/i)).toBeNull();
      expect(screen.getByText(NOTE)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the safety cap: a mark older than LIVE_CAP_MS is offline", async () => {
    const user = userEvent.setup();
    markLive("w1:p1", Date.now() - LIVE_CAP_MS - 1_000);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "x");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
  });
});
