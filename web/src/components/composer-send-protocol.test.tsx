import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M56 specs 05 and 06 on the composer: Send posts ONE request to `POST /api/send` and renders the
// answer; there is no phone-side guard and no old reply route any more. A retry after no answer reuses
// the id; every offer is a new request with a new id.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
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
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

interface Posted {
  id: string;
  pane: string;
  text: string;
  mode: string;
  rowsHash?: string;
}

/** One answer the fake bridge gives: a body, or a failure with this HTTP status. */
type Answer = { readonly body: object } | { readonly status: number };

/** Answers `/api/send` with each answer in turn, and records the old pane routes. */
function bridge(answers: Answer[]) {
  const sends: Posted[] = [];
  const paneCalls: string[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose fields Posted names.
      sends.push((await request.json()) as Posted);
      const next = answers.shift() ?? { status: 500 };
      return "status" in next ? new HttpResponse("down", { status: next.status }) : HttpResponse.json(next.body);
    }),
    http.all(/\/api\/pane\//, ({ request }) => {
      paneCalls.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ ok: true });
    }),
  );
  return { sends, paneCalls };
}

/** The receipt fields the composer reads. */
interface ReceiptStub {
  outcome: string;
  keys: string[];
  reason?: string;
}

function receipt(outcome: string, reason?: string): ReceiptStub {
  const out: ReceiptStub = { outcome, keys: [] };
  if (reason !== undefined) out.reason = reason;
  return out;
}

describe("Composer on the Send Protocol (M56 specs 05 and 06)", () => {
  it("posts one request, clears the draft on sent, and touches no old pane route", async () => {
    const user = userEvent.setup();
    const { sends, paneCalls } = bridge([{ body: { receipt: receipt("sent"), offers: [] } }]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ pane: "w1:p1", text: "hello there", mode: "send" });
    expect(sends[0]!.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(loadDraft(undefined, "w1:p1") ?? "").toBe(""));
    expect(paneCalls).toEqual([]);
  });

  it("a draft in the box offers Add, Replace and Cancel; Replace is a new request with a new id", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"] } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const strip = await screen.findByTestId("send-offers");
    expect(strip).toHaveTextContent("Add to it");
    expect(strip).toHaveTextContent("Replace");
    expect(strip).toHaveTextContent("Cancel");
    expect(loadDraft(undefined, "w1:p1")).toBe("new words"); // a refusal keeps the draft
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "new words", mode: "replace" });
    expect(sends[1]!.id).not.toBe(sends[0]!.id);
  });

  it("Add to it sends the text after one space, so it does not run into the draft", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"] } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "more words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Add to it" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: " more words", mode: "append" });
  });

  it("a screen Collie cannot read takes two taps: the second carries the rows hash", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("refused", "unconfirmed"), offers: ["commit", "keys"], rowsHash: "0abc12" } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "go ahead");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Type here" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "go ahead", mode: "send", rowsHash: "0abc12" });
  });

  it("typed but not submitted offers Submit and Discard, and keeps the draft", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("typed_not_submitted", "changed"), offers: ["submit", "discard", "keys"] } },
      { body: { receipt: receipt("discarded"), offers: [] } },
    ]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "half way");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "half way", mode: "discard" });
    // A discard emptied the pane's box; the phone's draft stays for the next try.
    expect(loadDraft(undefined, "w1:p1")).toBe("half way");
  });

  it("no answer keeps the request id, so the retry cannot send twice", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([{ status: 500 }, { body: { receipt: receipt("sent"), offers: [] } }]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "once only");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]!.id).toBe(sends[0]!.id);
  });

  it("a slash command goes as a command, and its commit stays a command (M56 spec 06)", async () => {
    const user = userEvent.setup();
    const { sends, paneCalls } = bridge([
      { body: { receipt: receipt("refused", "unconfirmed"), offers: ["commit", "keys"], rowsHash: "0abc12" } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "/compact");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Type here" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends.map((s) => s.mode)).toEqual(["command", "command"]);
    expect(paneCalls).toEqual([]);
  });

  it("a box out of reach sends nothing: the field is locked and says why", async () => {
    const { sends } = bridge([]);
    renderComposer({ surface: { revision: 1, turn: "unknown", modal: "unknown", composer: "unreachable" }, unreachableNote: "Sending is off on this machine" });
    expect(screen.getByPlaceholderText("Sending is off on this machine")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(sends).toEqual([]);
  });
});
