import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ChatApprovalCard, isSessionProposal, SessionTrickCards, useSessionProposalWaiting } from "@/components/session-trick-card";
import { TrickCardsWaiting } from "@/components/trick-cards";
import { HILL_IDLE, type HillAnswerState } from "@/hooks/use-hill-answer";
import { postHillAnswer } from "@/lib/api";
import { APPROVE_HOLD_MS } from "@/lib/arm";
import { closeInSession, forgetSessionLater } from "@/lib/hill/session-later";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { collieCard, hillDecision } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

// Every way a hold ends early is tested on the control itself (hold-to-approve.test.tsx); here the card.

// PACKAGE I: a trick proposal shows in the chat view of the session that proposed it, as ONE card in the chat's
// own look and the chat's own scroll (2026-11-17): the facts open, the code in a fold, no Hill first line, no
// Back and Next. "Not now" there closes it in that session only (Settings, Tricks keeps it). Its yes is a hold of
// three seconds, and reading the code is offered, not required (ADR 0156).

const SELF = "lodge/%3#abcd";
const HASH = "a".repeat(64);

/** A proposal from the session at SELF: the facts the bridge writes, and its code. */
function proposalCard(over: Partial<HillDecision> = {}): HillDecision {
  return collieCard("proposal", "legs", {
    replyTo: SELF,
    summary: "A session on lodge proposes it. It has 1 file. It reaches the network.",
    view: [
      { kind: "para", text: "It runs as you: it can read and change any file you can." },
      { kind: "bar", attrs: { label: "It asks for" }, kids: [{ kind: "chip", text: "the belt" }, { kind: "chip", text: "GITHUB_TOKEN" }] },
      { kind: "line", text: "It reaches the network.", attrs: { role: "note" } },
      { kind: "para", text: "Asks you for: Repository" },
      { kind: "diff", attrs: { file: "program.ts" }, text: '@@ -0,0 +1,1 @@\n+console.log("legs")' },
    ],
    ...over,
  });
}

/** A proposal on three cards: the facts, then two cards of code. */
function groupCard(): HillDecision {
  return collieCard("proposal", "legs", {
    replyTo: SELF,
    summary: "A session on lodge proposes it. It has 2 files. It shows on 3 cards.",
    group: {
      digest: "d".repeat(64),
      decline: "later",
      parts: [
        { view: [{ kind: "para", text: "It runs as you: it can read and change any file you can." }, { kind: "line", text: "2 files, on cards 2 to 3.", attrs: { role: "note" } }], sha256: "1".repeat(64) },
        { view: [{ kind: "diff", attrs: { file: "program.ts" }, text: '@@ -0,0 +1,1 @@\n+console.log("two")' }], sha256: "2".repeat(64) },
        { view: [{ kind: "diff", attrs: { file: "lib/legs.ts" }, text: '@@ -0,0 +1,1 @@\n+console.log("three")' }], sha256: "3".repeat(64) },
      ],
    },
  });
}

/** A new version, proposed by the session: the version card's words, a proposal's intents. */
function versionCard(): HillDecision {
  return proposalCard({
    title: "Use the new version of legs?",
    summary: "A session on lodge proposes it. 1 file changed. It now also asks for GITHUB_TOKEN.",
    view: [
      { kind: "para", text: "It runs as you: it can read and change any file you can." },
      { kind: "bar", attrs: { label: "New rights" }, kids: [{ kind: "chip", text: "GITHUB_TOKEN" }] },
      { kind: "diff", attrs: { file: "program.ts" }, text: '@@ -1,1 +1,1 @@\n-console.log("old")\n+console.log("new")' },
    ],
    options: [
      { intent: "on", label: "Use the new version" },
      { intent: "later", label: "Keep the old version" },
    ],
  });
}

async function holds(open: HillDecision[], rev = 1) {
  server.use(http.get("/api/hill", () => HttpResponse.json({ v: 1, rev, open, closed: [] })));
  await act(async () => {
    syncHill(rev, "tricks");
    await __settleHill();
  });
}

function renderChat(self: string) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ hillOff: true, trickCards: true }),
        element: withHeaderHost(<Outlet />),
        children: [
          {
            index: true,
            element: (
              <>
                {/* The chat's own scroller: the card flows in it, like a message. */}
                <div data-testid="chat" style={{ overflowY: "auto" }}>
                  <SessionTrickCards self={self} />
                </div>
                <div data-testid="settings">
                  <TrickCardsWaiting />
                </div>
              </>
            ),
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
}

/** A finger down on `button` for three seconds, then lifted: the hold that approves. */
async function hold(button: HTMLElement) {
  vi.useFakeTimers();
  try {
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, pointerType: "touch" });
    await act(async () => {
      vi.advanceTimersByTime(APPROVE_HOLD_MS);
    });
    fireEvent.pointerUp(button, { button: 0, pointerId: 1, pointerType: "touch" });
  } finally {
    vi.useRealTimers();
  }
}

function recordAnswers(): unknown[] {
  const answers: unknown[] = [];
  server.use(
    http.post("/api/hill/answer", async ({ request }) => {
      answers.push(await request.json());
      return HttpResponse.json({});
    }),
  );
  return answers;
}

beforeEach(() => {
  __resetHill();
  forgetSessionLater();
});
afterEach(() => {
  __resetHill();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const chat = () => screen.getByTestId("chat");
const card = () => chat().querySelector<HTMLElement>('[data-slot="chat-approval"]');
const toggle = () => chat().querySelector<HTMLButtonElement>('[data-slot="chat-approval-code-toggle"]')!;
const yes = (name: RegExp = /Hold to switch on/u) => within(chat()).getByRole("button", { name });

describe("a trick proposal in its session's chat view", () => {
  it("draws ONE card in the chat's look: title, summary, the honest line, rights, warnings and fields, no Hill first line, no Back and Next, no Dismiss", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    expect(chat().querySelectorAll('[data-slot="chat-approval"]')).toHaveLength(1);
    const slot = card()!;
    expect(slot).toHaveTextContent("A session on lodge proposes it.");
    expect(slot).toHaveTextContent("It runs as you: it can read and change any file you can.");
    expect(slot).toHaveTextContent("the belt");
    expect(slot).toHaveTextContent("GITHUB_TOKEN");
    expect(slot).toHaveTextContent("It reaches the network.");
    expect(slot).toHaveTextContent("Asks you for: Repository");
    // Not the Hill's card: no first line, no pager, no Dismiss, no recommendation, and no scroll box of its own.
    expect(slot.querySelector('[data-slot="decision-meta"]')).toBeNull();
    expect(slot.querySelector('[data-slot="decision-group-nav"]')).toBeNull();
    expect(chat().querySelector('[data-slot="decision-dismiss"]')).toBeNull();
    expect(chat().querySelector('[data-slot="decision-recommended-mark"]')).toBeNull();
    expect(chat().querySelector("[data-scroll-root]")).toBeNull();
    expect(chat().querySelector('[data-slot="session-trick-card"]')?.className ?? "").not.toMatch(/overflow|max-h/u);
    // The code waits behind its fold; nothing is focused.
    expect(slot).not.toHaveTextContent('console.log("legs")');
    expect(toggle()).toHaveTextContent("Read the code");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).not.toBe(yes());
    expect(screen.getByRole("button", { name: /Not now/u })).toBeInTheDocument();
  });

  it("the code opens in place with one tap, and the chat is told to bring the fold's row to the top", async () => {
    const asked: HTMLElement[] = [];
    await holds([proposalCard()]);
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => ({ hillOff: true, trickCards: true }), element: withHeaderHost(<div data-testid="chat"><SessionTrickCards self={SELF} onReadCode={(row) => asked.push(row)} /></div>) }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(card()).toHaveTextContent('console.log("legs")');
    expect(asked).toEqual([toggle()]);
  });

  it("Hold to switch on is ready at the draw with the fold never opened; a tap is no yes; a hold sends once with the hash", async () => {
    const answers = recordAnswers();
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(yes()).toBeEnabled();
    expect(yes()).toHaveAccessibleDescription("Hold to confirm. With a keyboard, press it twice.");
    expect(card()).not.toHaveTextContent("read it to its end");
    // A tap, by a finger, is no yes.
    await userEvent.click(yes());
    expect(answers).toEqual([]);
    await hold(yes());
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: HASH, opened: [1] } });
    expect(answers[0]).toEqual(expect.objectContaining({ group: { digest: HASH, opened: [1] } }));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("opening and closing the fold leaves the yes as it was", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await userEvent.click(toggle());
    expect(yes()).toBeEnabled();
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(yes()).toBeEnabled();
  });

  it("a changed card (other code, a new hash) is a new card: the fold closes and the next yes carries the new hash", async () => {
    const answers = recordAnswers();
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await userEvent.click(toggle());
    const changed = proposalCard();
    if (changed.from.ref !== undefined) changed.from = { ...changed.from, ref: { ...changed.from.ref, hash: "b".repeat(64) } };
    await holds([changed], 2);
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-expanded", "false"));
    await hold(yes());
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: "b".repeat(64) } });
  });

  it("a group of cards is one card: the facts open, the code cards stacked in the fold, the yes a hold with the group's digest", async () => {
    const answers = recordAnswers();
    await holds([groupCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    expect(chat().querySelectorAll('[data-slot="chat-approval"]')).toHaveLength(1);
    expect(card()).toHaveTextContent("2 files, on cards 2 to 3.");
    expect(chat().querySelector('[data-slot="decision-group-nav"]')).toBeNull();
    expect(yes()).toBeEnabled();
    await userEvent.click(toggle());
    const sections = [...chat().querySelectorAll('[data-slot="chat-approval-section"]')];
    expect(sections.map((s) => s.getAttribute("data-card"))).toEqual(["2", "3"]);
    expect(sections[0]).toHaveTextContent("Card 2");
    expect(sections[0]).toHaveTextContent('console.log("two")');
    expect(sections[1]).toHaveTextContent('console.log("three")');
    await hold(yes());
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: "d".repeat(64) } });
  });

  it("a new version shows what changed and the new rights, and Hold to use", async () => {
    await holds([versionCard()]);
    renderChat(SELF);
    await screen.findByText("Use the new version of legs?", { selector: "[data-testid=chat] *" });
    expect(card()).toHaveTextContent("It now also asks for GITHUB_TOKEN.");
    expect(chat().querySelector('[data-slot="chat-approval-facts"]')).toHaveTextContent("GITHUB_TOKEN");
    expect(yes(/Hold to use/u)).toBeEnabled();
    await userEvent.click(toggle());
    expect(card()).toHaveTextContent('console.log("new")');
    expect(within(chat()).getByRole("button", { name: /Keep the old version/u })).toBeEnabled();
  });

  it("a card the phone cannot show whole offers no yes, only the decline and why", async () => {
    // A node this phone does not know (a newer bridge's) is drawn as a placeholder: not every right is on screen.
    // SAFETY: the node kind is unknown on purpose, as a newer bridge would send it; the renderer draws its placeholder.
    const decision = proposalCard({ view: [{ kind: "para", text: "It runs as you." }, { kind: "hologram", text: "a right" } as never, { kind: "diff", attrs: { file: "a.ts" }, text: "+1" }] });
    const onSend = vi.fn();
    const onLater = vi.fn();
    render(
      <div data-testid="chat">
        <ChatApprovalCard decision={decision} answer={HILL_IDLE} onSend={onSend} onLater={onLater} />
      </div>,
    );
    expect(card()).toHaveTextContent("This phone cannot show all of this card, so the trick cannot be switched on here.");
    expect(screen.queryByRole("button", { name: /Hold to switch on/u })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Not now/u }));
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("a proposal whose card holds no code offers no yes", async () => {
    const decision = proposalCard({ view: [{ kind: "para", text: "It runs as you." }, { kind: "line", text: "trick.toml changed +x", attrs: { role: "note" } }] });
    const onSend = vi.fn();
    render(
      <div data-testid="chat">
        <ChatApprovalCard decision={decision} answer={HILL_IDLE} onSend={onSend} onLater={vi.fn()} />
      </div>,
    );
    expect(card()).toHaveTextContent("This phone cannot show all of this card, so the trick cannot be switched on here.");
    expect(within(chat()).queryByRole("button", { name: /Hold to switch on/u })).toBeNull();
    expect(chat().querySelector('[data-slot="chat-approval-code-toggle"]')).toBeNull();
  });

  it("a yes that got no answer offers no Try again: the hold sends it again, with the hash", async () => {
    const onSend = vi.fn();
    const decision = proposalCard();
    const failed: HillAnswerState = { phase: "failed", intent: "on", text: null };
    const draw = (answer: HillAnswerState) => (
      <div data-testid="chat" style={{ overflowY: "auto" }}>
        <ChatApprovalCard decision={decision} answer={answer} onSend={onSend} onLater={vi.fn()} />
      </div>
    );
    const { rerender } = render(draw(HILL_IDLE));
    await hold(yes());
    expect(onSend).toHaveBeenCalledTimes(1);
    const children = [...card()!.querySelectorAll("*")];
    rerender(draw(failed));
    const button = chat().querySelector<HTMLButtonElement>('[data-slot="chat-approval-option"][data-intent="on"]')!;
    // Said in the yes's own label, no new row: the same elements, in the same order.
    expect(button).toHaveAttribute("data-not-sent");
    expect(button).toHaveAccessibleName("Not sent. Hold again");
    expect(chat().querySelector('[data-slot="decision-retry"]')).toBeNull();
    expect([...card()!.querySelectorAll("*")]).toEqual(children);
    await hold(button);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith("on", null, { digest: HASH, opened: [1] });
  });

  it("a waiting proposal sets the jump-to-latest dot of its own session only, and Not now clears it", async () => {
    function Probe({ self }: { self: string }) {
      return <span data-testid={`dot-${self}`}>{String(useSessionProposalWaiting(self))}</span>;
    }
    const waiting = proposalCard();
    await holds([waiting]);
    render(
      <>
        <Probe self={SELF} />
        <Probe self="lodge/%3#ffff" />
      </>,
    );
    expect(screen.getByTestId(`dot-${SELF}`)).toHaveTextContent("true");
    expect(screen.getByTestId("dot-lodge/%3#ffff")).toHaveTextContent("false");
    act(() => closeInSession(waiting.id));
    expect(screen.getByTestId(`dot-${SELF}`)).toHaveTextContent("false");
  });

  it("shows nothing in another session, and never an agent's own Decision", async () => {
    await holds([proposalCard(), hillDecision({ title: "An agent asks", replyTo: SELF })]);
    renderChat("lodge/%9#ffff");
    expect(await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=settings] *" })).toBeInTheDocument();
    expect(chat()).toBeEmptyDOMElement();
    expect(isSessionProposal(hillDecision({ replyTo: SELF }), SELF)).toBe(false);
    expect(isSessionProposal(collieCard("version", "legs", { replyTo: SELF }), SELF)).toBe(false);
  });

  it("compares the FULL address: a new session in the same pane, with another instance token, never shows an old card (security read, point 3)", async () => {
    expect(isSessionProposal(proposalCard(), SELF)).toBe(true);
    expect(isSessionProposal(proposalCard(), "lodge/%3#ffff")).toBe(false);
    // The pane address alone, with no token, is not the session either.
    expect(isSessionProposal(proposalCard(), "lodge/%3")).toBe(false);
    await holds([proposalCard()]);
    renderChat("lodge/%3#ffff");
    expect(await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=settings] *" })).toBeInTheDocument();
    expect(chat()).toBeEmptyDOMElement();
  });

  it("Not now closes the card in the session, sends nothing, and Settings, Tricks keeps it waiting for a yes", async () => {
    const answers = recordAnswers();
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await userEvent.click(screen.getByRole("button", { name: /Not now/u }));
    expect(chat()).toBeEmptyDOMElement();
    expect(answers).toEqual([]);
    expect(screen.getByRole("heading", { name: "Waiting for your yes" })).toBeInTheDocument();
    expect(screen.getByTestId("settings")).toHaveTextContent("Switch on the trick legs?");
  });

  it("a crew member's pane: the member's own snapshot carries no hill, so the chat shows no card, and a refused yes would say why (security read, point 6)", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    // The chat of a member's pane reads that member's snapshot: no `hillRev`, so the store is emptied.
    act(() => syncHill(undefined, "tricks"));
    await waitFor(() => expect(chat()).toBeEmptyDOMElement());
    // A yes that still reached a member-scoped answer route is refused with the bridge's sentence, never silently.
    server.use(http.post("/api/hill/answer", () => new HttpResponse("the hill reads this machine only for now; ask the machine itself", { status: 400 })));
    const receipt = await postHillAnswer({ rid: "7c2a7a3e-6a42-4f5e-9d2b-3a0a6e7a1b11", node: "hill/dc_test0000001", intent: "on", value: { text: null } });
    expect(receipt.code).toBe("rejected");
    expect(receipt.reason).toBe("the hill reads this machine only for now; ask the machine itself");
  });
});
