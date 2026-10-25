import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus, useStatus } from "@/lib/status";
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
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
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
  when?: string;
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
    expect(screen.getByText("The box already holds a draft. Add to it, replace it, or cancel.")).toBeInTheDocument();
    expect(loadDraft(undefined, "w1:p1")).toBe("new words"); // a refusal keeps the draft
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "new words", mode: "replace" });
    expect(sends[1]!.id).not.toBe(sends[0]!.id);
  });

  it("a draft refusal on a pane with a returned queued card points at that card, and keeps the offers (ADR 0122)", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"] } }]);
    renderComposer({ returnedDraft: true });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Your queued message is back in the agent as a draft. Use its card.")).toBeInTheDocument();
    expect(screen.queryByText("The box already holds a draft. Add to it, replace it, or cancel.")).toBeNull();
    expect(screen.getByTestId("send-offers")).toHaveTextContent("Replace");
  });

  it("a slash command onto a draft offers Replace and Cancel only, says so, and Replace sends it as a replace", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("refused", "draft_present"), offers: ["replace", "cancel"] } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "/model");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const strip = await screen.findByTestId("send-offers");
    expect(sends[0]).toMatchObject({ text: "/model", mode: "command" });
    expect(strip).not.toHaveTextContent("Add to it");
    expect(strip).toHaveTextContent("Replace");
    expect(strip).toHaveTextContent("Cancel");
    expect(screen.getByText("The box already holds a draft. Replace it, or cancel.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "/model", mode: "replace" });
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

// 2026-10-25: a box the bridge proved stale (its probe did not land, a second read showed the same rows) says so in
// the empty field's placeholder, in the smaller size, never in a row of its own.
describe("a stale screen in the placeholder", () => {
  const staleDraft = { revision: 1, turn: "idle", modal: "none", composer: "draft", staleFrame: true } as const;
  const HINT = "The screen may be stale. Send probes it first.";

  it("the empty field's placeholder is the stale hint, smaller than the reply words", () => {
    renderComposer({ surface: staleDraft });
    const field = screen.getByRole("textbox");
    expect(field).toHaveAttribute("placeholder", HINT);
    expect(field.className).toMatch(/placeholder:text-xs/);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("a Surface with no stale mark keeps the reply words", () => {
    renderComposer({ surface: { revision: 1, turn: "idle", modal: "none", composer: "draft" } });
    expect(screen.getByRole("textbox")).not.toHaveAttribute("placeholder", HINT);
    expect(screen.getByRole("textbox").className).not.toMatch(/placeholder:text-xs/);
  });
});

// M69 spec 03: while the turn runs on a pane whose bridge says `canSteer`, the Send button's long-press
// menu offers Steer above "Send as message", and the empty field's placeholder names both gestures.
// The hint is the placeholder, never a row of its own: a row opened and closed with every turn and moved
// the belt and the field (Altan, 2026-10-25), and a placeholder takes no height of its own.
describe("Steer or queue on the Send button (M69)", () => {
  const running = { revision: 1, turn: "running", modal: "none", composer: "empty" } as const;
  const HINT = "Hold Send to steer.";
  const STEER = "Steer: the agent takes it after its current step";

  /** The header status line, where a verified send leaves its words. */
  function StatusProbe() {
    return <div data-testid="status">{useStatus()?.text ?? ""}</div>;
  }
  /** The draft field. Its placeholder is the only place the hint is drawn. */
  const field = () => screen.getByRole("textbox");
  const status = () => screen.getByTestId("status").textContent ?? "";
  function renderSteer(overrides: Partial<ComponentProps<typeof Composer>>) {
    render(<StatusProbe />);
    return renderComposer(overrides);
  }

  async function openMenu(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(field(), text);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
  }

  it("offers the row while the turn runs on a pane that can steer, above Send as message", async () => {
    const user = userEvent.setup();
    renderSteer({ surface: running, canSteer: true });
    await openMenu(user, "look at the logs");
    const steer = await screen.findByRole("button", { name: STEER });
    const message = screen.getByRole("button", { name: "Send as message" });
    expect(steer.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the empty field's placeholder is the hint, smaller than the reply words, while the turn runs on a pane that can steer", () => {
    renderSteer({ surface: running, canSteer: true });
    expect(field()).toHaveAttribute("placeholder", HINT);
    expect(field().className).toMatch(/placeholder:text-xs/);
    // The hint is not text in the page: it is the placeholder or nothing.
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("draws no row for the hint: nothing in the composer carries the old slot, with or without the steer row", () => {
    renderSteer({ surface: running, canSteer: true });
    expect(document.querySelector('[data-slot="composer-steer-hint"]')).toBeNull();
    cleanup();
    renderSteer({ canSteer: true });
    expect(document.querySelector('[data-slot="composer-steer-hint"]')).toBeNull();
  });

  it("typing text leaves the placeholder attribute on the hint (the browser hides it, the DOM does not change)", async () => {
    const user = userEvent.setup();
    renderSteer({ surface: running, canSteer: true });
    await user.type(field(), "x");
    expect(field()).toHaveValue("x");
    expect(field()).toHaveAttribute("placeholder", HINT);
  });

  it("keeps the ordinary reply words on an idle pane, even one that can steer", async () => {
    const user = userEvent.setup();
    renderSteer({ canSteer: true });
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(field().className).not.toMatch(/placeholder:text-xs/);
    await openMenu(user, "hello");
    expect(await screen.findByRole("button", { name: "Send as message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: STEER })).toBeNull();
  });

  it("keeps the ordinary reply words while the turn runs on a pane that cannot steer (a Claude Code pane: Enter queues, canSteer is false)", async () => {
    const user = userEvent.setup();
    renderSteer({ surface: running });
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(field().className).not.toMatch(/placeholder:text-xs/);
    await openMenu(user, "hello");
    expect(await screen.findByRole("button", { name: "Send as message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: STEER })).toBeNull();
  });

  it("the facts keep priority over the hint: a read-only pane, a gone pane and a shell keep their own words", () => {
    renderSteer({ surface: running, canSteer: true, readOnly: true });
    expect(screen.getByPlaceholderText(/read-only/i)).not.toHaveAttribute("placeholder", HINT);
    expect(field().className).not.toMatch(/placeholder:text-xs/);
    cleanup();
    renderSteer({ surface: running, canSteer: true, isShell: true });
    expect(field()).not.toHaveAttribute("placeholder", HINT);
    expect(field().className).not.toMatch(/placeholder:text-xs/);
  });

  it("the row sends when: steer, says Steered, and clears the draft; the plain tap sends no when", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("steered"), offers: [] } },
      { body: { receipt: { ...receipt("sent"), queued: true }, offers: [] } },
    ]);
    renderSteer({ surface: running, canSteer: true });
    await openMenu(user, "use the other table");
    await user.click(await screen.findByRole("button", { name: STEER }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ pane: "w1:p1", text: "use the other table", mode: "send", when: "steer" });
    await waitFor(() => expect(status()).toBe("Steered: the agent takes it after its current step."));
    await waitFor(() => expect(loadDraft(undefined, "w1:p1") ?? "").toBe(""));

    await user.type(field(), "and then stop");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).not.toHaveProperty("when");
    expect(sends[1]!.id).not.toBe(sends[0]!.id);
  });

  it("a steer the harness queued reads Queued instead", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([{ body: { receipt: { ...receipt("sent"), queued: true }, offers: [] } }]);
    renderSteer({ surface: running, canSteer: true });
    await openMenu(user, "change course");
    await user.click(await screen.findByRole("button", { name: STEER }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(status()).toBe("Queued instead: the agent kept it for after the turn."));
    await waitFor(() => expect(loadDraft(undefined, "w1:p1") ?? "").toBe(""));
  });

  // Crew version skew (counsel on the Edge 5 candidate): a member that ignores `when` queues the text
  // and answers `sent` with `queued` through the pane's reply route. The phone asked to steer and got
  // queued: it says Queued instead, never Steered.
  it("a steer to a crew member that queued it (a receipt with no steered) reads Queued instead, never Steered", async () => {
    const user = userEvent.setup();
    const posted: Pick<Posted, "text" | "when">[] = [];
    markLive("w1:p1", Date.now(), { host: "laptop" });
    server.use(
      http.post(/\/api\/pane\/w1%3Ap1\/reply$/, async ({ request }) => {
        // SAFETY: the composer under test is the only poster; the test reads two fields it then checks.
        posted.push((await request.json()) as Pick<Posted, "text" | "when">);
        return HttpResponse.json({ ok: true, send: { receipt: { ...receipt("sent"), queued: true }, offers: [] } });
      }),
    );
    renderSteer({ surface: running, canSteer: true, scope: { host: "laptop" } });
    await openMenu(user, "change course");
    await user.click(await screen.findByRole("button", { name: STEER }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ text: "change course", when: "steer" });
    await waitFor(() => expect(status()).toBe("Queued instead: the agent kept it for after the turn."));
    expect(status()).not.toMatch(/Steered/u);
  });

  it("steer_unsupported says nothing was sent and keeps the draft", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("refused", "steer_unsupported"), offers: [] } }]);
    renderSteer({ surface: running, canSteer: true });
    await openMenu(user, "change course");
    await user.click(await screen.findByRole("button", { name: STEER }));
    expect(await screen.findByText(/Steer is not available on this pane\. Nothing was sent\./)).toBeInTheDocument();
    expect(loadDraft(undefined, "w1:p1")).toBe("change course");
  });

  it("steer_not_allowed says only a person at the phone can steer and keeps the draft", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("refused", "steer_not_allowed"), offers: [] } }]);
    renderSteer({ surface: running, canSteer: true });
    await openMenu(user, "change course");
    await user.click(await screen.findByRole("button", { name: STEER }));
    expect(await screen.findByText(/Only a person at the phone can steer\./)).toBeInTheDocument();
    expect(loadDraft(undefined, "w1:p1")).toBe("change course");
  });

  it("a destructive line keeps the steer across the Really send? confirm", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([{ body: { receipt: receipt("steered"), offers: [] } }]);
    renderSteer({ surface: running, canSteer: true });
    await openMenu(user, "rm -rf build");
    await user.click(await screen.findByRole("button", { name: STEER }));
    expect(sends).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "rm -rf build", when: "steer" });
  });
});
