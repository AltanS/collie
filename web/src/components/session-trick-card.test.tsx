import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ChatApprovalCard, isSessionProposal, SessionTrickCards } from "@/components/session-trick-card";
import { TrickCardsWaiting } from "@/components/trick-cards";
import { HILL_IDLE } from "@/hooks/use-hill-answer";
import { postHillAnswer } from "@/lib/api";
import { forgetSessionLater } from "@/lib/hill/session-later";
import { __resetHill, __settleHill, syncHill } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { withHeaderHost } from "@/test/header-host";
import { collieCard, hillDecision } from "@/test/hill-fixtures";
import { stubAllSeen } from "@/test/seen-end";
import { server } from "@/test/setup";

// The card standing still for a second is tested in session-trick-card.still.test.tsx; here every card has.
vi.mock("@/hooks/use-still", () => ({ STILL_MS: 1000, STILL_TICK_MS: 100, useStill: (el: HTMLElement | null) => el !== null }));

// PACKAGE I: a trick proposal shows in the chat view of the session that proposed it, as ONE card in the chat's
// own look and the chat's own scroll (2026-11-17): the facts open, the code in a fold, no Hill first line, no
// Back and Next. "Not now" there closes it in that session only (Settings, Tricks keeps it).

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

type Seen = (entries: readonly { isIntersecting: boolean }[]) => void;
interface Watch {
  callback: Seen;
  target: Element | null;
  root: Element | null;
}

/** An IntersectionObserver the test drives: every mark watched, and when it comes on screen. */
function stubWatch(): Watch[] {
  const seen: Watch[] = [];
  class FakeObserver {
    private readonly at: Watch;
    constructor(callback: Seen, options?: { root?: Element | null }) {
      this.at = { callback, target: null, root: options?.root ?? null };
      seen.push(this.at);
    }
    observe(target: Element): void {
      this.at.target = target;
    }
    disconnect(): void {
      this.at.target = null;
    }
    unobserve(): void {}
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  return seen;
}

/** Every mark watched now comes on screen. */
function showEveryEnd(seen: Watch[]) {
  act(() => {
    for (const one of seen.filter((o) => o.target !== null)) one.callback([{ isIntersecting: true }]);
  });
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
  stubAllSeen();
  __resetHill();
  forgetSessionLater();
});
afterEach(() => {
  __resetHill();
  vi.unstubAllGlobals();
});

const chat = () => screen.getByTestId("chat");
const card = () => chat().querySelector<HTMLElement>('[data-slot="chat-approval"]');
const toggle = () => chat().querySelector<HTMLButtonElement>('[data-slot="chat-approval-code-toggle"]')!;
const yes = (name: RegExp = /Switch it on/u) => within(chat()).getByRole("button", { name });
/** The fold opens, then settles (its marks are drawn only once it stopped moving). */
async function openCode() {
  await userEvent.click(toggle());
  await waitFor(() => expect(chat().querySelector('[data-slot="chat-approval-section"] [data-slot="chat-approval-end"]')).not.toBeNull());
}

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

  it("Switch it on stays off until the fold was OPENED and its end seen; a closed fold never counts, also for a short trick; then ONE tap sends once with the hash", async () => {
    const seen = stubWatch();
    const answers = recordAnswers();
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    expect(yes()).toBeDisabled();
    expect(card()).toHaveTextContent("Open the code and read it to its end first.");
    // Every mark the card watches says it is on screen: with the fold closed there is no mark of the code at all.
    showEveryEnd(seen);
    expect(yes()).toBeDisabled();
    await userEvent.click(yes());
    expect(answers).toEqual([]);
    // Opened, the end mark is watched in the chat's own scroller, not in a box of the card.
    await openCode();
    expect(yes()).toBeDisabled();
    expect(card()).toHaveTextContent("Scroll to the end of the code first.");
    const watching = seen.filter((o) => o.target !== null);
    expect(watching).toHaveLength(1);
    expect(watching[0]!.root).toBe(chat());
    showEveryEnd(seen);
    expect(yes()).toBeEnabled();
    await userEvent.click(yes());
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: HASH, opened: [1] } });
  });

  it("closing the fold again keeps the yes on", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await openCode();
    await waitFor(() => expect(yes()).toBeEnabled());
    await userEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(yes()).toBeEnabled();
  });

  it("a changed card (other code, a new hash) takes the yes off and closes the fold", async () => {
    await holds([proposalCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    await openCode();
    await waitFor(() => expect(yes()).toBeEnabled());
    const changed = proposalCard();
    if (changed.from.ref !== undefined) changed.from = { ...changed.from, ref: { ...changed.from.ref, hash: "b".repeat(64) } };
    await holds([changed], 2);
    await waitFor(() => expect(yes()).toBeDisabled());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("a group of cards is one card: the facts open, the code cards stacked in the fold, the yes after every end, with the digest and every card", async () => {
    const answers = recordAnswers();
    await holds([groupCard()]);
    renderChat(SELF);
    await screen.findByText("Switch on the trick legs?", { selector: "[data-testid=chat] *" });
    expect(chat().querySelectorAll('[data-slot="chat-approval"]')).toHaveLength(1);
    expect(card()).toHaveTextContent("2 files, on cards 2 to 3.");
    expect(chat().querySelector('[data-slot="decision-group-nav"]')).toBeNull();
    expect(yes()).toBeDisabled();
    await openCode();
    const sections = [...chat().querySelectorAll('[data-slot="chat-approval-section"]')];
    expect(sections.map((s) => s.getAttribute("data-card"))).toEqual(["2", "3"]);
    expect(sections[0]).toHaveTextContent("Card 2");
    expect(sections[0]).toHaveTextContent('console.log("two")');
    expect(sections[1]).toHaveTextContent('console.log("three")');
    await waitFor(() => expect(yes()).toBeEnabled());
    await userEvent.click(yes());
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({ intent: "on", group: { digest: "d".repeat(64), opened: [1, 2, 3] } });
  });

  it("a new version shows what changed and the new rights, and Use the new version", async () => {
    await holds([versionCard()]);
    renderChat(SELF);
    await screen.findByText("Use the new version of legs?", { selector: "[data-testid=chat] *" });
    expect(card()).toHaveTextContent("It now also asks for GITHUB_TOKEN.");
    expect(chat().querySelector('[data-slot="chat-approval-facts"]')).toHaveTextContent("GITHUB_TOKEN");
    expect(yes(/Use the new version/u)).toBeDisabled();
    await openCode();
    expect(card()).toHaveTextContent('console.log("new")');
    await waitFor(() => expect(yes(/Use the new version/u)).toBeEnabled());
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
    expect(screen.queryByRole("button", { name: /Switch it on/u })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Not now/u }));
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
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
