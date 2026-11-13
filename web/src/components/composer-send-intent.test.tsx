import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { __forgetSendIntentMemory, loadIntent } from "@/lib/send-intent";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// The request id of a send that got no answer survives a remount, a reload and a pane switch, so the
// next tap on the same text is the same request and the bridge answers from its receipt, not a second send.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  sessionStorage.clear();
  localStorage.clear();
  __forgetSendIntentMemory();
});
afterEach(() => cleanup());

function renderComposer() {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  return render(<RouterProvider router={router} />);
}

function field(): HTMLTextAreaElement {
  // SAFETY: the composer's field is a textarea.
  return screen.getByPlaceholderText(/type a reply/i) as HTMLTextAreaElement;
}

/** Answers `/api/send`: a dropped link (502) while `down`, the send answer after. Records each request's id and text. */
function bridge() {
  const seen: { id: string; text: string }[] = [];
  const state = { down: true };
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer posts a SendRequestBody.
      const body = (await request.json()) as { id: string; text: string };
      seen.push({ id: body.id, text: body.text });
      if (state.down) return new HttpResponse("down", { status: 502 });
      return HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] });
    }),
  );
  return { seen, state };
}

/** The ids the failed attempt used: a failed request may be tried more than once inside one tap, all under one id. */
function ids(seen: { id: string }[]): string[] {
  return [...new Set(seen.map((r) => r.id))];
}

describe("the request id of a send with no answer survives a remount", () => {
  it("keeps the id for the same text after the composer mounts again", async () => {
    const user = userEvent.setup();
    const { seen, state } = bridge();
    const first = renderComposer();
    await user.type(field(), "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Tap Send again/);
    const failed = ids(seen);
    expect(failed).toHaveLength(1);
    first.unmount();
    __forgetSendIntentMemory(); // a reload: only sessionStorage is left
    renderComposer();
    expect(field().value).toBe("hello there");
    state.down = false;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field().value).toBe(""));
    expect(ids(seen)).toEqual(failed);
  });

  it("mints a new id for a text edited since", async () => {
    const user = userEvent.setup();
    const { seen, state } = bridge();
    const first = renderComposer();
    await user.type(field(), "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Tap Send again/);
    const failed = ids(seen);
    first.unmount();
    renderComposer();
    await user.type(field(), " again");
    expect(loadIntent(undefined, "w1:p1")).toBeNull();
    state.down = false;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field().value).toBe(""));
    const last = seen[seen.length - 1];
    expect(last?.text).toBe("hello there again");
    expect(failed).not.toContain(last?.id);
  });

  it("an answer from the bridge clears it", async () => {
    const user = userEvent.setup();
    const { seen, state } = bridge();
    renderComposer();
    await user.type(field(), "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Tap Send again/);
    expect(loadIntent(undefined, "w1:p1")).not.toBeNull();
    const failed = ids(seen);
    state.down = false;
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field().value).toBe(""));
    expect(loadIntent(undefined, "w1:p1")).toBeNull();
    expect(sessionStorage.length).toBe(0);
    // The same words typed again are a new send now, with a new id.
    await user.type(field(), "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field().value).toBe(""));
    const last = seen[seen.length - 1];
    expect(last?.id).not.toBe(failed[0]);
  });
});
