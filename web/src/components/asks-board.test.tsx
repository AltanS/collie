import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { AsksSend } from "@/hooks/use-asks-send";
import { groupAsks } from "@/lib/hill/asks";
import { orderByClock } from "@/lib/hill/asks-board";
import type { AskDraft } from "@/lib/hill/asks-drafts";
import { askAddress, askDecision, askPane } from "@/test/asks-fixtures";
import { HILL_T0 } from "@/test/hill-fixtures";

import { AsksBoard, questionLine } from "./asks-board";

const NOW = HILL_T0 + 60_000;
const LIVE = {
  lead: undefined,
  panes: [askPane("w1:p1", { label: "collie lead", cache: { warmMinutes: 38, now: NOW } }), askPane("w1:p2", { label: "m96-hill", cache: "cold" }), askPane("w1:p3", { label: "builder", status: "working" })],
};

function idleSend(): AsksSend {
  return { state: { phase: "idle" }, send: vi.fn(() => Promise.resolve(true)), reset: vi.fn() };
}

function board(asks: ReturnType<typeof askDecision>[], drafts = new Map<string, AskDraft>(), over: { sendRequest?: string | null; send?: AsksSend; onSendRequestDone?: () => void } = {}) {
  const onOpen = vi.fn();
  const send = over.send ?? idleSend();
  const sessions = orderByClock(groupAsks(asks), LIVE, NOW);
  const view = render(<AsksBoard sessions={sessions} live={LIVE} now={NOW} drafts={drafts} onOpen={onOpen} send={send} sendRequest={over.sendRequest ?? null} onSendRequestDone={over.onSendRequestDone} />);
  return { onOpen, send, view };
}

const LEAD_ASKS = [
  askDecision({ id: "ak_1", title: "Keep the route?", address: askAddress("w1:p1"), label: "lead", at: HILL_T0, recommend: "keep" }),
  askDecision({ id: "ak_2", title: "Drop   the\nflag?", address: askAddress("w1:p1"), at: HILL_T0 + 1, mark: "unchecked" }),
  askDecision({ id: "ak_3", title: "Ship it?", address: askAddress("w1:p1"), at: HILL_T0 + 2 }),
];
const COLD_ASK = askDecision({ id: "ak_9", title: "A cold one?", address: askAddress("w1:p2"), label: "m96-hill", at: HILL_T0 });
const WORKING_ASK = askDecision({ id: "ak_8", title: "A working one?", address: askAddress("w1:p3"), label: "builder", at: HILL_T0 });

const row = (id: string) => document.querySelector<HTMLElement>(`[data-slot="asks-row"][data-id="${id}"]`)!;

describe("the Next up card", () => {
  it("shows the first open ask with its session, its suggestion and Answer, the one filled button", async () => {
    const { onOpen } = board([COLD_ASK, ...LEAD_ASKS]);
    const card = document.querySelector('[data-slot="asks-next"]')!;
    expect(card).toHaveTextContent("Next up");
    expect(card.querySelector('[data-slot="asks-next-question"]')).toHaveTextContent("Keep the route?");
    expect(card.querySelector('[data-slot="asks-next-who"]')).toHaveTextContent("collie lead");
    expect(card.querySelector('[data-slot="asks-next-who"]')).toHaveTextContent("idle");
    expect(card.querySelector('[data-slot="asks-next-suggests"]')).toHaveTextContent("collie lead suggests: Keep both routes");
    expect(card.querySelector('[data-slot="asks-clock-words"]')).toHaveTextContent("38 min left");
    const answer = screen.getByRole("button", { name: "Answer" });
    expect(answer).not.toHaveTextContent("Enter");
    expect(answer).not.toHaveAttribute("title");
    // The only filled button: every other button is outline or ghost.
    const filled = [...document.querySelectorAll("button")].filter((button) => button.classList.contains("bg-primary"));
    expect(filled).toEqual([answer]);
    await userEvent.click(answer);
    expect(onOpen).toHaveBeenLastCalledWith("ak_1");
  });

  it("says the cache line with two sessions and a warm one, and none for a single session", () => {
    board([COLD_ASK, ...LEAD_ASKS]);
    expect(screen.getByText("Its cache runs out first. After that, an answer costs a full re-read.")).toBeInTheDocument();
    document.body.innerHTML = "";
    board(LEAD_ASKS);
    expect(document.querySelector('[data-slot="asks-next-line"]')).toBeNull();
  });

  it("says a working session waits for its turn end", () => {
    board([WORKING_ASK, COLD_ASK]);
    expect(screen.getByText("The session works. Your answer waits for its turn end.")).toBeInTheDocument();
  });

  it("moves to the next ask once the first has an answer, and offers Send when all have one", async () => {
    const { onOpen, view } = board(LEAD_ASKS, new Map([["ak_1", { intent: "keep", text: "" }]]));
    expect(document.querySelector('[data-slot="asks-next-question"]')).toHaveTextContent("Ship it?");
    view.unmount();
    const picked = new Map<string, AskDraft>([["ak_1", { intent: "keep", text: "" }], ["ak_3", { intent: "keep", text: "" }], ["ak_2", { intent: "keep", text: "" }]]);
    board(LEAD_ASKS, picked);
    const card = document.querySelector<HTMLElement>('[data-slot="asks-next"]')!;
    expect(card).toHaveAttribute("data-kind", "send");
    expect(card.querySelector('[data-slot="asks-next-question"]')).toHaveTextContent("3 of 3 answered");
    await userEvent.click(within(card).getByRole("button", { name: "Send 3" }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /Send to/u })).toBeInTheDocument();
  });

  it("draws no card when no ask is open", () => {
    board([]);
    expect(document.querySelector('[data-slot="asks-next"]')).toBeNull();
  });
});

describe("the sessions of the board", () => {
  it("draws one card for each session in cache order, with mark, name, place and clock, and no count line", () => {
    board([WORKING_ASK, COLD_ASK, ...LEAD_ASKS]);
    const cards = document.querySelectorAll('[data-slot="asks-session"]');
    expect(cards).toHaveLength(3);
    expect(cards[0]?.querySelector('[data-slot="asks-session-name"]')).toHaveTextContent("collie lead");
    expect(cards[0]?.querySelector('[data-slot="asks-session-place"]')).toHaveTextContent("lodge");
    expect(cards[0]?.querySelector('[data-slot="asks-session-place"]')).toHaveTextContent("idle");
    expect(cards[0]?.querySelector('[data-slot="asks-clock-words"]')).toHaveTextContent("38 min left");
    expect(cards[0]?.querySelector('[data-slot="asks-session-count"]')).toBeNull();
    expect(cards[1]?.querySelector('[data-slot="asks-session-place"]')).toHaveTextContent("working");
    expect(cards[2]?.querySelector('[data-slot="asks-clock-words"]')).toHaveTextContent("cold");
    expect(cards[2]).toHaveAttribute("data-clock", "cold");
    expect(cards[2]).toHaveClass("bg-transparent");
    expect(cards[0]).toHaveClass("bg-card");
  });

  it("says the section line with the open and answered counts", () => {
    board(LEAD_ASKS, new Map([["ak_1", { intent: "keep", text: "" }]]));
    expect(document.querySelector('[data-slot="asks-section"]')).toHaveTextContent("All open asks, by cache time left");
    expect(document.querySelector('[data-slot="asks-section-count"]')).toHaveTextContent("3 open · 1 answered");
  });

  it("keeps the mark's slot for a session with no status here, and names no state", () => {
    const gone = askDecision({ id: "ak_7", title: "Where did it go?", address: askAddress("w9:p9"), label: "far away", at: HILL_T0 });
    board([gone]);
    const head = document.querySelector('[data-slot="asks-session"]')!;
    expect(head.querySelector('[data-slot="asks-mark"]')).not.toBeNull();
    expect(head.querySelector('[data-slot="asks-session-name"]')).toHaveTextContent("far away");
    expect(head.querySelector('[data-slot="asks-session-place"]')).toHaveTextContent("");
    expect(head.querySelector('[data-slot="asks-clock"]')).toBeNull();
  });

  it("sinks an unchecked ask to the end of its card and mutes it", () => {
    board(LEAD_ASKS);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="asks-row"]')];
    expect(rows.map((r) => r.dataset.id)).toEqual(["ak_1", "ak_3", "ak_2"]);
    expect(rows[2]).toHaveAttribute("data-state", "unchecked");
    expect(rows[2]?.querySelector(".font-content")).toHaveClass("text-muted-foreground");
    expect(rows[2]).toHaveTextContent("Drop the flag?");
  });

  it("numbers the rows as plain muted numbers with no box, and the Next row's number in the foreground", () => {
    board(LEAD_ASKS);
    const numbers = [...document.querySelectorAll('[data-slot="asks-row-number"]')];
    expect(numbers.map((n) => n.textContent)).toEqual(["1", "2", "3"]);
    for (const n of numbers) expect(n.className).not.toMatch(/border|rounded/u);
    expect(numbers[0]).toHaveClass("text-foreground");
    expect(numbers[1]).toHaveClass("text-muted-foreground");
    expect(row("ak_1")).toHaveAttribute("data-state", "next");
    expect(row("ak_1")).toHaveTextContent("Next");
  });

  it("opens an ask from its row", async () => {
    const { onOpen } = board(LEAD_ASKS);
    await userEvent.click(screen.getByRole("button", { name: /Ship it\?/u }));
    expect(onOpen).toHaveBeenLastCalledWith("ak_3");
  });

  it("ends a row with Answered and the option, Next, or a chevron", () => {
    board(LEAD_ASKS, new Map([["ak_1", { intent: "keep", text: "" }]]));
    expect(row("ak_1")).toHaveAttribute("data-state", "answered");
    expect(row("ak_1")).toHaveTextContent("Answered: Keep both routes");
    expect(row("ak_3")).toHaveAttribute("data-state", "next");
    expect(row("ak_3")).toHaveTextContent("Next");
    expect(row("ak_2").querySelector("svg")).not.toBeNull();
    expect(row("ak_2")).not.toHaveTextContent("Next");
  });

  it("has no foot without a mark, and a foot with the count and Send when there is one", async () => {
    const { view } = board(LEAD_ASKS);
    expect(document.querySelector('[data-slot="asks-session-foot"]')).toBeNull();
    view.unmount();
    board(LEAD_ASKS, new Map([["ak_1", { intent: "keep", text: "" }]]));
    const foot = document.querySelector('[data-slot="asks-session-foot"]')!;
    expect(foot).toHaveTextContent("1 of 3 answered · 1 not checked");
    await userEvent.click(foot.querySelector("button")!);
    expect(screen.getByRole("dialog", { name: /Send to/u })).toBeInTheDocument();
  });

  it("sends the session's marks from the sheet the ask screen uses, and closes it after", async () => {
    const send = idleSend();
    board(LEAD_ASKS, new Map([["ak_1", { intent: "keep", text: "" }]]), { send });
    await userEvent.click(document.querySelector('[data-slot="asks-session-send"]')!);
    const sheet = screen.getByRole("dialog", { name: /Send to/u });
    await userEvent.click(sheet.querySelector('[data-slot="ask-send-go"]')!);
    expect(send.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(send.send).mock.calls[0]?.[0].map((answer) => answer.ask.id)).toEqual(["ak_1"]);
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(send.reset).toHaveBeenCalled();
  });

  it("opens the Send sheet a shortcut asked for, once, and drops the request", () => {
    const done = vi.fn();
    board(LEAD_ASKS, new Map([["ak_1", { intent: "keep", text: "" }]]), { sendRequest: askAddress("w1:p1"), onSendRequestDone: done });
    expect(screen.getByRole("dialog", { name: /Send to/u })).toBeInTheDocument();
    expect(done).toHaveBeenCalled();
  });

  it("drops a request for a session with no mark, and opens nothing", () => {
    const done = vi.fn();
    board(LEAD_ASKS, new Map(), { sendRequest: askAddress("w1:p1"), onSendRequestDone: done });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(done).toHaveBeenCalled();
  });

  it("folds the whitespace of a question into one line", () => {
    expect(questionLine({ title: " a \n b " })).toBe("a b");
  });
});
