import type { ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { LIVE_WINDOW_MS, markLive, resetLiveness } from "@/lib/liveness";
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

  it("disables Send again when the live answer ages out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderComposer();
      await user.type(screen.getByPlaceholderText(/type a reply/i), "x");
      act(() => markLive("w1:p1"));
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
      act(() => {
        vi.advanceTimersByTime(LIVE_WINDOW_MS + 100);
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

  it("uses the window: a mark older than LIVE_WINDOW_MS is offline", async () => {
    const user = userEvent.setup();
    markLive("w1:p1", Date.now() - LIVE_WINDOW_MS - 1_000);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "x");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
  });
});
