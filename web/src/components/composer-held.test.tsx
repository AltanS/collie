import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus, useStatus } from "@/lib/status";
import type { HeldRow } from "@/lib/surface/send";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M56 spec 15 on the composer: the sends the bridge holds for a pane show as queued rows above the
// box, each with the control its state allows. The rows come from the snapshot (the `held` prop); the
// composer only draws them and calls the bridge.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function StatusProbe() {
  const status = useStatus();
  return <output data-testid="status">{status?.text ?? ""}</output>;
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "running", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <Composer {...props} />
          <StatusProbe />
        </>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return props;
}

const NOW = 1_700_000_000_000;
function row(requestId: string, state: HeldRow["state"], extra: Partial<HeldRow> = {}): HeldRow {
  return { requestId, mode: "send", text: `text of ${requestId}`, heldAt: NOW, expiresAt: NOW + 30 * 60_000, state, ...extra };
}

/** The DELETEs the fake bridge took, with its answer for each. */
function fakeDelete(answer: { status?: number; body: object }) {
  const calls: string[] = [];
  server.use(
    http.delete("/api/send/:id", ({ request, params }) => {
      calls.push(`${String(params.id)}${new URL(request.url).search}`);
      return HttpResponse.json(answer.body, { status: answer.status ?? 200 });
    }),
  );
  return calls;
}

interface Posted {
  id: string;
  text: string;
  mode: string;
  resendOf?: string;
  rowsHash?: string;
}
function fakeSend(body: (posted: Posted) => object) {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose fields Posted names.
      const posted = (await request.json()) as Posted;
      sends.push(posted);
      return HttpResponse.json(body(posted));
    }),
  );
  return sends;
}

describe("the held rows above the composer box", () => {
  it("draws one queued row per held entry, oldest first, with its text; a held one offers Cancel", async () => {
    renderComposer({ held: [row("req00001", "held"), row("req00002", "held", { text: "second\nline" })] });
    const found = document.querySelectorAll('[data-slot="held-row"]');
    expect(found).toHaveLength(2);
    expect(found[0]).toHaveTextContent("Queued. Sends when the turn ends.");
    expect(found[0]).toHaveTextContent("text of req00001");
    expect(found[1]).toHaveTextContent("second line");
    expect(screen.getAllByRole("button", { name: "Cancel the queued message" })).toHaveLength(2);
  });

  it("Cancel calls DELETE for that request on this pane and refreshes the snapshot", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "cancelled" } });
    const props = renderComposer({ scope: { session: "demo" }, held: [row("req00001", "held")] });
    await user.click(screen.getByRole("button", { name: "Cancel the queued message" }));
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1&session=demo"]));
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
  });

  it("a Cancel that came too late says so, and is not an error", async () => {
    const user = userEvent.setup();
    fakeDelete({ status: 409, body: { result: "refused", reason: "busy" } });
    renderComposer({ held: [row("req00001", "held")] });
    await user.click(screen.getByRole("button", { name: "Cancel the queued message" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("It is going out now. Cancel came too late."));
  });

  it("a request going out now says so and has no button", () => {
    renderComposer({ held: [row("req00001", "running")] });
    expect(screen.getByText("Sending now.")).toBeInTheDocument();
    // SAFETY: the query matches the row's own div, which is an HTMLElement.
    const held = document.querySelector('[data-slot="held-row"]') as HTMLElement;
    expect(within(held).queryAllByRole("button")).toHaveLength(0);
  });

  it("an expired one offers Resend and Dismiss; Resend posts a NEW request by the old id with an empty text, and never calls the cancel route", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "sent", keys: [] }, offers: [] }));
    const props = renderComposer({ held: [row("req00001", "ended", { outcome: "expired" })] });
    expect(screen.getByText("Not sent. The turn did not end within 30 minutes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss the message" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resend the message" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "", mode: "send", resendOf: "req00001" });
    expect(sends[0]!.id).not.toBe("req00001");
    expect(JSON.stringify(sends[0])).not.toContain("text of req00001");
    await waitFor(() => expect(props.onSent).toHaveBeenCalled());
    expect(calls).toEqual([]);
  });

  it("a Resend keeps the old row's mode", async () => {
    const user = userEvent.setup();
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "sent", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "expired", mode: "command", text: "/compact" })] });
    await user.click(screen.getByRole("button", { name: "Resend the message" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "", mode: "command", resendOf: "req00001" });
  });

  it("a Resend the bridge refuses keeps the row: the text is not dismissed", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "refused", reason: "not_free", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "refused", reason: "write_failed" })] });
    expect(screen.getByText("Not sent. Check the pane, then send again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resend the message" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Resend the message" })).toBeEnabled());
    expect(calls).toEqual([]);
  });

  it("Dismiss lets an ended row go with one DELETE and sends nothing", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend(() => ({}));
    renderComposer({ held: [row("req00001", "ended", { outcome: "unknown" })] });
    await user.click(screen.getByRole("button", { name: "Dismiss the message" }));
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
    expect(sends).toEqual([]);
  });

  it("a row that ended unknown says the text may have reached the agent, with Dismiss and no Resend", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    renderComposer({ held: [row("req00001", "ended", { outcome: "unknown" })] });
    expect(screen.getByText("The text may have reached the agent. Read the chat.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend the message" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss the message" }));
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
  });

  it("a row that ended typed_not_submitted offers Submit and Discard; Submit posts mode submit with the row's text, then dismisses", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "sent", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    expect(screen.getByText("Typed, not sent. The text is still in the box.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend the message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss the message" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Submit the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "text of req00001", mode: "submit" });
    expect(sends[0]!.resendOf).toBeUndefined();
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
  });

  it("Discard posts mode discard with the row's text, then dismisses", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "discarded", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    await user.click(screen.getByRole("button", { name: "Discard the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "text of req00001", mode: "discard" });
    await waitFor(() => expect(calls).toEqual(["req00001?pane=w1%3Ap1"]));
  });

  it("a Submit the bridge refuses keeps the row", async () => {
    const user = userEvent.setup();
    const calls = fakeDelete({ body: { result: "dismissed" } });
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "refused", reason: "not_free", keys: [] }, offers: [] }));
    renderComposer({ held: [row("req00001", "ended", { outcome: "typed_not_submitted" })] });
    await user.click(screen.getByRole("button", { name: "Submit the text in the box" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit the text in the box" })).toBeEnabled());
    expect(calls).toEqual([]);
  });

  it("a Cancel that finds the request already sent says it went out", async () => {
    const user = userEvent.setup();
    fakeDelete({ status: 409, body: { result: "refused", reason: "busy", receipt: { requestId: "req00001", outcome: "sent", keys: [] } } });
    renderComposer({ held: [row("req00001", "held")] });
    await user.click(screen.getByRole("button", { name: "Cancel the queued message" }));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("It already went out."));
  });

  it("a row whose pane closed offers Dismiss only", () => {
    renderComposer({ held: [row("req00001", "ended", { outcome: "refused", reason: "pane_gone" })] });
    expect(screen.getByText("Not sent. The pane closed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss the message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resend the message" })).toBeNull();
  });

  it("a crew member's pane shows its rows with no buttons: the cancel route does not cross a link", () => {
    renderComposer({ scope: { host: "badger" }, held: [row("req00001", "held"), row("req00002", "ended", { outcome: "expired" })] });
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /queued message|the message/ })).toBeNull();
  });

  it("a locked composer shows its rows with no buttons", () => {
    renderComposer({ readOnly: true, held: [row("req00001", "held")] });
    expect(document.querySelectorAll('[data-slot="held-row"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Cancel the queued message" })).toBeNull();
  });

  it("a send the bridge answers held clears the draft and says queued, with no refusal notice", async () => {
    const user = userEvent.setup();
    const sends = fakeSend((posted) => ({ receipt: { requestId: posted.id, outcome: "held", keys: [] }, offers: [], detail: "The agent is working." }));
    // The bridge decides held on its own read; the phone's surface is idle so its box is open to type in.
    renderComposer({ surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" } });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "after the turn");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(loadDraft(undefined, "w1:p1") ?? "").toBe(""));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Queued. Sends when the turn ends."));
    expect(document.querySelector('[data-slot="composer-refusal"]')).toBeNull();
    expect(screen.queryByTestId("send-offers")).toBeNull();
  });
});
