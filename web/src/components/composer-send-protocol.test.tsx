import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Turns the launch on or off for the composer `renderComposer` drew: a start begins after the person typed. */
let setStarting: (on: boolean) => void = () => undefined;

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
  function Harness() {
    const [starting, setStartingState] = useState(props.starting ?? false);
    setStarting = (on) => act(() => setStartingState(on));
    return <Composer {...props} starting={starting} />;
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
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
  override?: boolean;
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
    const sheet = await screen.findByTestId("send-offer-modal");
    expect(sheet).toHaveTextContent("Add to it");
    expect(sheet).toHaveTextContent("Replace");
    expect(sheet).toHaveTextContent("Cancel");
    expect(loadDraft(undefined, "w1:p1")).toBe("new words"); // a refusal keeps the draft
    await user.click(screen.getByRole("button", { name: /^Replace/ }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "new words", mode: "replace" });
    expect(sends[1]!.id).not.toBe(sends[0]!.id);
  });

  // The offer strip is the only control for a refused send; a near miss is a dead tap with no request
  // (field case 2026-11-20: the bridge saw the refusal and no Add or Replace request followed). The
  // offers are compact 32px bordered buttons, and the 44px floor is bought as a transparent reach
  // (`CAUTION_ACTION_TAP`: 30px padding box + 2 x 7px). They are as wide as their word, not blocks.
  it("the offers are compact buttons that keep the 44px reach, the dismiss included", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("typed_not_submitted", "changed"), offers: ["submit", "discard"] } }]);
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByTestId("send-offers");
    for (const name of ["Submit", "Discard"]) {
      const { className } = screen.getByRole("button", { name });
      expect(className).toContain("before:-inset-y-[7px]");
      expect(className).not.toMatch(/(?:^|\s)flex-1(?=\s|$)/);
    }
    const dismiss = screen.getByRole("button", { name: "Dismiss the send offers" }).className;
    expect(dismiss).toContain("before:-inset-[7px]");
    expect(dismiss).toMatch(/(?:^|\s)size-8(?=\s|$)/);
  });

  it("a draft refusal on a pane with a returned queued card points at that card, and keeps the offers (ADR 0122)", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"] } }]);
    renderComposer({ returnedDraft: true });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Your queued message is back in the agent as a draft. Use its card.")).toBeInTheDocument();
    expect(screen.queryByText("The box already holds a draft. Add to it, replace it, or cancel.")).toBeNull();
    // The modal carries the sentence, because the notice waits behind it.
    expect(screen.getByTestId("send-offer-modal")).toHaveTextContent("Use its card.");
    expect(screen.getByTestId("send-offer-modal")).toHaveTextContent("Replace");
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
    const sheet = await screen.findByTestId("send-offer-modal");
    expect(sends[0]).toMatchObject({ text: "/model", mode: "command" });
    expect(sheet).not.toHaveTextContent("Add to it");
    expect(sheet).toHaveTextContent("Replace");
    expect(sheet).toHaveTextContent("Cancel");
    await user.click(screen.getByRole("button", { name: /^Replace/ }));
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
    await user.click(await screen.findByRole("button", { name: /^Add to it/ }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: " more words", mode: "append" });
  });

  it("Add to it and Replace carry the offer's rows hash, and a box that changed shows the offer again over it (ADR 0166)", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"], rowsHash: "0abc12" } },
      // The person typed another draft at the desk: the same refusal again, over the draft now, with its hash.
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"], rowsHash: "0def34" } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    const field = screen.getByPlaceholderText(/type a reply/i);
    await user.type(field, "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: /^Replace/ }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "new words", mode: "replace", rowsHash: "0abc12" });
    // The offer is back, the same words as the first time (the modal's title; its notice waits behind it),
    // and the text stays in the field.
    expect(await screen.findByRole("dialog", { name: "The box already holds a draft" })).toBeInTheDocument();
    expect(field).toHaveValue("new words");
    await user.click(await screen.findByRole("button", { name: /^Add to it/ }));
    await waitFor(() => expect(sends).toHaveLength(3));
    expect(sends[2]).toMatchObject({ text: " new words", mode: "append", rowsHash: "0def34" });
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
    await user.click(await screen.findByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "go ahead", mode: "send", rowsHash: "0abc12" });
    // The commit is the person's tap through the stop, so it says override (M102 spec 01); the first tap and the other offers do not.
    expect(sends[0]).not.toHaveProperty("override");
    expect(sends[1]).toMatchObject({ override: true });
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
    await user.click(await screen.findByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends.map((s) => s.mode)).toEqual(["command", "command"]);
    expect(paneCalls).toEqual([]);
  });

  it("a box out of reach sends nothing: the field is locked and says why", async () => {
    const { sends } = bridge([]);
    renderComposer({ surface: { revision: 1, turn: "unknown", modal: "unknown", composer: "unreachable" }, unreachableNote: "Sending is off on this machine" });
    expect(screen.getByPlaceholderText("Sending is off on this machine")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
    expect(sends).toEqual([]);
  });
});

// The draft offers open as a modal (trial, 2026-11-20, send-offer-modal.tsx): Add to it, Replace and Cancel act on a
// draft the person may have typed at the desk, so they are a blocking choice in the app's modal (ui/modal.tsx,
// centred), with the draft the bridge read and one bordered button per choice. Every other offer set keeps the strip.
describe("the draft offers as a modal", () => {
  const DRAFT = { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"] } };
  const NOTICE = "The box already holds a draft. Add to it, replace it, or cancel.";
  const field = () => screen.getByPlaceholderText(/type a reply/i);

  async function refuse(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(field(), text);
    await user.click(screen.getByRole("button", { name: "Send" }));
    return screen.findByRole("dialog", { name: "The box already holds a draft" });
  }

  it("opens a centred modal with three buttons and their lines, and draws no strip and no notice", async () => {
    const user = userEvent.setup();
    bridge([DRAFT]);
    renderComposer();
    const dialog = await refuse(user, "new words");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-placement", "center");
    expect(screen.queryByTestId("send-offers")).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole("button", { name: /^Add to it/ })).toHaveTextContent("Your message goes after the draft. Both are sent as one message.");
    const replace = screen.getByRole("button", { name: /^Replace/ });
    expect(replace).toHaveTextContent("The draft is deleted. Only your message is sent.");
    // Replace wipes the desk's draft: it wears the destructive outline. Add to it the caution one.
    expect(replace.className).toContain("text-destructive");
    expect(replace.className).toContain("border-destructive/60");
    expect(screen.getByRole("button", { name: /^Add to it/ }).className).toContain("border-status-working/60");
    // No draft text in the answer: no quote and no label.
    expect(screen.queryByText("In the agent's box")).toBeNull();
    expect(dialog.querySelector('[data-slot="offer-draft"]')).toBeNull();
    expect(screen.getByRole("button", { name: /^Cancel/ })).toHaveTextContent("Nothing is sent. Your message stays here.");
  });

  it("a command onto a draft shows no Add row", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("refused", "draft_present"), offers: ["replace", "cancel"] } }]);
    renderComposer();
    await refuse(user, "/model");
    expect(screen.queryByRole("button", { name: /^Add to it/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Replace/ })).toBeInTheDocument();
    expect(screen.queryByText("The box already holds a draft. Replace it, or cancel.")).toBeNull();
  });

  it.each([
    ["Add to it", "append", " more words"],
    ["Replace", "replace", "more words"],
  ])("%s sends its offer as a new request and closes the modal", async (row, mode, text) => {
    const user = userEvent.setup();
    const { sends } = bridge([DRAFT, { body: { receipt: receipt("sent"), offers: [] } }]);
    renderComposer();
    await refuse(user, "more words");
    await user.click(screen.getByRole("button", { name: new RegExp(`^${row}`) }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text, mode });
  });

  it("Cancel closes the modal, sends nothing and keeps the text", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([DRAFT]);
    renderComposer();
    await refuse(user, "keep me");
    await user.click(screen.getByRole("button", { name: /^Cancel/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("send-offers")).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(sends).toHaveLength(1);
    expect(field()).toHaveValue("keep me");
  });

  it.each([
    ["the scrim", () => {
      const scrim = document.querySelector('[data-slot="send-offer-modal"]')?.previousElementSibling;
      if (!(scrim instanceof HTMLElement)) throw new Error("no scrim");
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
    }],
    ["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
  ])("a close without a choice (%s) drops the offer, hides the notice and sends nothing", async (_how, close) => {
    const user = userEvent.setup();
    const { sends } = bridge([DRAFT]);
    renderComposer();
    await refuse(user, "keep me");
    act(() => close());
    expect(screen.queryByRole("dialog")).toBeNull();
    // The strip's ✕ path: no strip comes back, and the notice stays hidden.
    expect(screen.queryByTestId("send-offers")).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(sends).toHaveLength(1);
    expect(field()).toHaveValue("keep me");
  });

  it("quotes the draft the bridge read, under its label, and draws the cut line only when it was cut", async () => {
    const user = userEvent.setup();
    bridge([
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"], rowsHash: "0aaa11", draftText: "fix the login\nthen the tests" } },
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"], rowsHash: "0bbb22", draftText: "a very long draft", draftCut: true } },
    ]);
    renderComposer();
    const dialog = await refuse(user, "words");
    const quote = dialog.querySelector('[data-slot="offer-draft"]');
    expect(quote).toHaveTextContent("In the agent's box");
    expect(quote?.querySelector("blockquote")?.textContent).toBe("fix the login\nthen the tests");
    expect(dialog.querySelector('[data-slot="offer-draft-cut"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Replace/ }));
    const again = await screen.findByRole("dialog", { name: "The box already holds a draft" });
    await waitFor(() => expect(again.querySelector('[data-slot="offer-draft-cut"]')).toHaveTextContent("…"));
    expect(again).toHaveTextContent("a very long draft");
  });

  // ADR 0166 in the modal: a tap over a draft that changed at the desk meets the same refusal again, with
  // the new draft's hash and text. The modal opens again over it and quotes the NEW draft, never the old one,
  // and the next tap carries the new hash.
  it.each([
    ["Replace", "replace", "Add to it", "append"],
    ["Add to it", "append", "Replace", "replace"],
  ])("after %s over a changed draft the modal opens again, and %s's next tap carries the new hash", async (first, firstMode, second, secondMode) => {
    const user = userEvent.setup();
    const { sends } = bridge([
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"], rowsHash: "0aaa11", draftText: "draft A at the desk" } },
      { body: { receipt: receipt("refused", "draft_present"), offers: ["append", "replace", "cancel"], rowsHash: "0bbb22", draftText: "draft B typed since" } },
      { body: { receipt: receipt("sent"), offers: [] } },
    ]);
    renderComposer();
    expect(await refuse(user, "words")).toHaveTextContent("draft A at the desk");
    await user.click(screen.getByRole("button", { name: new RegExp(`^${first}`) }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ mode: firstMode, rowsHash: "0aaa11" });
    const again = await screen.findByRole("dialog", { name: "The box already holds a draft" });
    await waitFor(() => expect(again).toHaveTextContent("draft B typed since"));
    expect(again).not.toHaveTextContent("draft A at the desk");
    expect(screen.queryByTestId("send-offers")).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(field()).toHaveValue("words");
    await user.click(screen.getByRole("button", { name: new RegExp(`^${second}`) }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(sends).toHaveLength(3));
    expect(sends[2]).toMatchObject({ mode: secondMode, rowsHash: "0bbb22" });
  });

  it("the buttons wait while a launch starts, as the strip's buttons do", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([DRAFT]);
    renderComposer();
    await refuse(user, "wait");
    setStarting(true);
    for (const row of [/^Add to it/, /^Replace/, /^Cancel/]) expect(screen.getByRole("button", { name: row })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /^Replace/ }));
    expect(sends).toHaveLength(1);
  });

  it("another offer set (Submit and Discard) keeps the strip and opens no modal", async () => {
    const user = userEvent.setup();
    bridge([{ body: { receipt: receipt("typed_not_submitted", "changed"), offers: ["submit", "discard", "keys"] } }]);
    renderComposer();
    await user.type(field(), "half way");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByTestId("send-offers")).toHaveTextContent("Submit");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("send-offer-modal")).toBeNull();
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
    // Centred in the field's line (#758), the same as the Steer hint below.
    expect(field.className).toMatch(/placeholder:leading-\[inherit\]/);
    expect(field.className).toMatch(/(^| )leading-\[1\.5em\]/);
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

  it("a launch still starting offers neither Send nor its steer menu, and keeps the draft", async () => {
    const user = userEvent.setup();
    const { sends } = bridge([]);
    renderSteer({ surface: running, canSteer: true });
    // The draft is typed before the start. While the launch starts the box is off (Altan, 2026-11-17), so a draft
    // can only be there already; it stays in the box and nothing offers a send.
    await user.type(field(), "wait for startup");
    field().focus();
    setStarting(true);
    // Held, not disabled: the box keeps its focus (and the soft keyboard), and takes no input.
    expect(field()).not.toBeDisabled();
    expect(field()).toHaveAttribute("readonly");
    expect(field()).toHaveAttribute("aria-disabled", "true");
    expect(field()).toHaveFocus();
    await user.keyboard("more{Enter}");
    expect(field()).toHaveAttribute("placeholder", "Starting…");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: STEER })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send as message" })).toBeNull();
    expect(field()).toHaveValue("wait for startup");
    expect(sends).toEqual([]);
  });

  it("the empty field's placeholder is the hint, smaller than the reply words, while the turn runs on a pane that can steer", () => {
    renderSteer({ surface: running, canSteer: true });
    expect(field()).toHaveAttribute("placeholder", HINT);
    expect(field().className).toMatch(/placeholder:text-xs/);
    // THE HINT IS CENTRED IN THE FIELD'S LINE (#758): the smaller words take the field's own line box, as a
    // length, instead of the 16px line `text-xs` brings, which stood them 3.5px above the box's centre. The
    // field states its line-height as a length so the placeholder can inherit it; layout is in
    // e2e/steer-placeholder.spec.ts.
    expect(field().className).toMatch(/placeholder:leading-\[inherit\]/);
    expect(field().className).toMatch(/(^| )leading-\[1\.5em\]/);
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
    // The ordinary words keep the field's own line, untouched by the repair.
    expect(field().className).not.toMatch(/leading-\[/);
    await openMenu(user, "hello");
    expect(await screen.findByRole("button", { name: "Send as message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: STEER })).toBeNull();
  });

  it("keeps the ordinary reply words while the turn runs on a pane that cannot steer (a Claude Code pane: Enter queues, canSteer is false)", async () => {
    const user = userEvent.setup();
    renderSteer({ surface: running });
    expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument();
    expect(field().className).not.toMatch(/placeholder:text-xs/);
    // The ordinary words keep the field's own line, untouched by the repair.
    expect(field().className).not.toMatch(/leading-\[/);
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
    expect(await screen.findByText(/Steer is not available on this pane, so nothing was sent\./)).toBeInTheDocument();
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
