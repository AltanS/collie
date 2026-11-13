import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { rememberUnknownSend, SEND_AGAIN_WINDOW_MS, __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M100 spec 06, item 2: after a send that ended `unknown`, a second tap on the same text on the same
// pane inside the window asks "Send it again?" in the Send slot (the Really send? slot), and the next tap sends.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  sessionStorage.clear();
  __forgetSendAgainMemory();
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
  render(<RouterProvider router={router} />);
}

interface Posted {
  id: string;
  text: string;
}

const UNKNOWN = { body: { receipt: { outcome: "unknown", reason: "no_evidence", keys: [] }, offers: ["keys"] } };
const SENT = { body: { receipt: { outcome: "sent", keys: [] }, offers: [] } };
const DRAFT_REFUSED = { body: { receipt: { outcome: "refused", reason: "draft_present", keys: [] }, offers: ["append", "replace", "cancel"] } };

function bridge(answers: { body: object }[]) {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose id and text Posted names.
      sends.push((await request.json()) as Posted);
      const next = answers.shift();
      return next === undefined ? new HttpResponse("down", { status: 500 }) : HttpResponse.json(next.body);
    }),
  );
  return sends;
}

/** Tap Send once the last send has settled (the button is disabled while one is in flight). */
async function tapSend(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: "Send" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

const box = () => screen.getByPlaceholderText(/type a reply/i);

describe("Send it again? after a send that ended unknown", () => {
  it("asks on the second tap with the same text, sends nothing, and the confirming tap sends under a new id", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    // The unknown answer keeps the draft; the next tap waits for a yes.
    await tapSend(user);
    const again = await screen.findByRole("button", { name: "Send it again?" });
    expect(sends).toHaveLength(1);
    // The question takes the Send slot itself: no second Send button and no row of its own.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Really send?" })).toBeNull();
    expect(box()).toHaveValue("run the tests");
    await user.click(again);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "run the tests" });
    expect(sends[1]!.id).not.toBe(sends[0]!.id);
  });

  it("asks again when the confirmed send ends unknown too", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, UNKNOWN]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    await user.click(await screen.findByRole("button", { name: "Send it again?" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    await tapSend(user);
    expect(await screen.findByRole("button", { name: "Send it again?" })).toBeInTheDocument();
    expect(sends).toHaveLength(2);
  });

  it("sends at once when the text changed since", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await user.type(box(), " again");
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull();
  });

  it("sends at once after the window, and on a pane that never had an unknown send", async () => {
    const user = userEvent.setup();
    const sends = bridge([SENT, SENT]);
    // An unknown send on this pane, older than the window; and one for another pane, just now.
    rememberUnknownSend(undefined, "w1:p1", "late words", Date.now() - SEND_AGAIN_WINDOW_MS - 1_000);
    rememberUnknownSend(undefined, "w1:p2", "other pane", Date.now());
    renderComposer();
    await user.type(box(), "late words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await user.type(box(), "other pane");
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
  });

  it("never asks after an answer that is known: a refusal is a send that did not go", async () => {
    const user = userEvent.setup();
    const sends = bridge([DRAFT_REFUSED, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull();
  });

  it("a known answer to the same text ends an earlier unknown one", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, DRAFT_REFUSED, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    await user.click(await screen.findByRole("button", { name: "Send it again?" }));
    await waitFor(() => expect(sends).toHaveLength(2)); // known: refused
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(3));
  });
});
