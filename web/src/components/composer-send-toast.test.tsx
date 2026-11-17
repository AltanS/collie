import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";
import { SEND_SLOW_MS, SEND_TOAST_FADE_MS } from "./send-toast";

// The word for a send the pane has not echoed ("You sent: ..."): a toast that floats over the mirror, and one
// that shows only when the send is still not echoed SEND_SLOW_MS after the tap. A send the pane echoes sooner shows
// nothing, and a toast that did show fades out when the echo comes.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let setMirror: (text: string) => void = () => undefined;

function Harness() {
  const [text, setText] = useState("pane output");
  setMirror = setText;
  return (
    <Composer
      paneId="w1:p1"
      agent="claude"
      isShell={false}
      gone={false}
      readOnly={false}
      surface={{ revision: 1, turn: "idle", modal: "none", composer: "empty" }}
      text={text}
      terminalDraft={null}
      rawTerminalDraft={null}
      prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false }}
      display={{ open: false, onToggle: vi.fn() }}
      onSent={vi.fn()}
    />
  );
}

async function sendHello() {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  let posted = 0;
  server.use(
    http.post(/\/api\/send$/, () => {
      posted += 1;
      return HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] });
    }),
  );
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
  await user.type(screen.getByPlaceholderText(/type a reply/i), "hello there");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posted).toBe(1));
  // The bridge's answer has landed: the box let go of the text and the status says Sent.
  // SAFETY: the composer's field is a textarea.
  await waitFor(() => expect((screen.getByPlaceholderText(/type a reply/i) as HTMLTextAreaElement).value).toBe(""));
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the sent toast", () => {
  it("never shows for a send the pane echoes before SEND_SLOW_MS", async () => {
    await sendHello();
    expect(screen.queryByText("You sent:")).toBeNull();
    await advance(SEND_SLOW_MS / 4);
    // The echo: the mirror's text changes.
    await act(async () => setMirror("pane output\n> hello there"));
    await advance(SEND_SLOW_MS * 2);
    expect(screen.queryByText("You sent:")).toBeNull();
    expect(document.querySelector('[data-slot="send-toast"]')).toBeNull();
  });

  it("shows for a send still not echoed SEND_SLOW_MS after the tap, over the mirror and not in the footer", async () => {
    await sendHello();
    await advance(SEND_SLOW_MS - 600);
    expect(screen.queryByText("You sent:")).toBeNull();
    await advance(700);
    const label = await screen.findByText("You sent:");
    const toast = label.closest('[data-slot="send-toast"]');
    expect(toast).not.toBeNull();
    expect(toast).toHaveTextContent("hello there");
    // It is in the floating column (absolute, no space), never inside the composer's own flow of rows.
    expect(toast!.closest('[data-slot="floating-cards"]')).not.toBeNull();
    expect(toast!.closest('[data-slot="composer-box"]')).toBeNull();
  });

  it("fades out when the echo comes, and leaves the tree after the fade", async () => {
    await sendHello();
    await advance(SEND_SLOW_MS + 100);
    await screen.findByText("You sent:");
    await act(async () => setMirror("pane output\n> hello there"));
    const toast = document.querySelector('[data-slot="send-toast"]');
    expect(toast).not.toBeNull();
    expect(toast).not.toHaveAttribute("data-open");
    expect(toast).toHaveClass("opacity-0");
    await advance(SEND_TOAST_FADE_MS + 50);
    expect(document.querySelector('[data-slot="send-toast"]')).toBeNull();
  });
});
