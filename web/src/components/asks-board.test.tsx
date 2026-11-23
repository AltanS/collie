import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { groupAsks } from "@/lib/hill/asks";
import { orderByClock } from "@/lib/hill/asks-board";
import { askAddress, askDecision, askPane } from "@/test/asks-fixtures";
import { HILL_T0 } from "@/test/hill-fixtures";

import { AsksBoard, questionLine } from "./asks-board";

const NOW = HILL_T0 + 60_000;
const LIVE = { lead: undefined, panes: [askPane("w1:p1", { label: "collie lead", cache: { warmMinutes: 38, now: NOW } }), askPane("w1:p2", { label: "m96-hill", cache: "cold" })] };

function board(asks: ReturnType<typeof askDecision>[], drafts = new Map<string, { intent: string | null; text: string }>()) {
  const onOpen = vi.fn();
  const sessions = orderByClock(groupAsks(asks), LIVE, NOW);
  const view = render(<AsksBoard sessions={sessions} live={LIVE} now={NOW} drafts={drafts} onOpen={onOpen} />);
  return { onOpen, view };
}

const LEAD_ASKS = [
  askDecision({ id: "dc_1", title: "Keep the route?", address: askAddress("w1:p1"), label: "lead", at: HILL_T0 }),
  askDecision({ id: "dc_2", title: "Drop   the\nflag?", address: askAddress("w1:p1"), at: HILL_T0 + 1, mark: "unchecked" }),
  askDecision({ id: "dc_3", title: "Ship it?", address: askAddress("w1:p1"), at: HILL_T0 + 2 }),
];

describe("the sessions of the board", () => {
  it("draws one card for each session in the order of the cache clock, with name, place, cache and count", () => {
    const cold = askDecision({ id: "dc_9", title: "A cold one?", address: askAddress("w1:p2"), label: "m96-hill", at: HILL_T0 });
    board([cold, ...LEAD_ASKS]);
    const cards = document.querySelectorAll('[data-slot="asks-session"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('[data-slot="asks-session-name"]')).toHaveTextContent("collie lead");
    expect(cards[0]?.querySelector('[data-slot="asks-session-cache"]')).toHaveTextContent("warm, 38 min left");
    expect(cards[0]?.querySelector('[data-slot="asks-session-place"]')).toHaveTextContent("lodge");
    expect(cards[0]?.querySelector('[data-slot="asks-session-count"]')).toHaveTextContent("3 questions · 1 not checked");
    expect(cards[1]?.querySelector('[data-slot="asks-session-cache"]')).toHaveTextContent("cold");
  });

  it("sinks an unchecked ask to the end of its card and mutes it", () => {
    board(LEAD_ASKS);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="asks-row"]')];
    expect(rows.map((row) => row.dataset.id)).toEqual(["dc_1", "dc_3", "dc_2"]);
    expect(rows[2]).toHaveAttribute("data-state", "unchecked");
    expect(rows[2]).toHaveClass("text-muted-foreground");
    expect(rows[2]).toHaveTextContent("Drop the flag?");
  });

  it("opens an ask from its row, and the first ask of the first session from Answer next", async () => {
    const { onOpen } = board(LEAD_ASKS);
    await userEvent.click(screen.getByRole("button", { name: /Ship it\?/u }));
    expect(onOpen).toHaveBeenLastCalledWith("dc_3");
    await userEvent.click(screen.getByRole("button", { name: "Answer next" }));
    expect(onOpen).toHaveBeenLastCalledWith("dc_1");
  });

  it("marks an answered row with the neutral badge and counts it, and keeps the badge's slot on every row", () => {
    board(LEAD_ASKS, new Map([["dc_1", { intent: "keep", text: "" }]]));
    const answered = document.querySelector('[data-slot="asks-row"][data-id="dc_1"]')!;
    expect(answered).toHaveAttribute("data-state", "answered");
    expect(answered.querySelector('[data-slot="badge"]')).not.toBeNull();
    expect(answered).toHaveTextContent("Answered");
    const other = document.querySelector('[data-slot="asks-row"][data-id="dc_3"]')!;
    expect(other.querySelector('[data-slot="badge"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="asks-session-count"]')).toHaveTextContent("1 of 3 answered · 1 not checked");
  });

  it("turns Answer next off when no ask is open", () => {
    board([]);
    expect(screen.getByRole("button", { name: "Answer next" })).toBeDisabled();
  });

  it("folds the whitespace of a question into one line", () => {
    expect(questionLine({ title: " a \n b " })).toBe("a b");
  });
});
