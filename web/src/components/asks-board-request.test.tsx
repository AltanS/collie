import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { AsksSend } from "@/hooks/use-asks-send";
import { groupAsks } from "@/lib/hill/asks";
import { orderByClock } from "@/lib/hill/asks-board";
import type { AskDraft } from "@/lib/hill/asks-drafts";
import { askAddress, askDecision, askPane } from "@/test/asks-fixtures";
import { HILL_T0 } from "@/test/hill-fixtures";

import { AsksBoard } from "./asks-board";

// A shortcut's Send request meets a deck that has not loaded yet: the request waits, and is dropped only once the deck
// has loaded and has no session with a mark for it.

const NOW = HILL_T0 + 60_000;
const LIVE = { lead: undefined, panes: [askPane("w1:p1", { label: "collie lead", cache: { warmMinutes: 38, now: NOW } })] };
const ASKS = [askDecision({ id: "ak_1", title: "Keep the route?", address: askAddress("w1:p1"), label: "lead", at: HILL_T0 })];
const MARKED = new Map<string, AskDraft>([["ak_1", { intent: "keep", text: "" }]]);
const KEY = askAddress("w1:p1");

function idleSend(): AsksSend {
  return { state: { phase: "idle" }, send: vi.fn(() => Promise.resolve(true)), reset: vi.fn() };
}

function element(over: { asks: ReturnType<typeof askDecision>[]; loaded: boolean; done: () => void }) {
  const sessions = orderByClock(groupAsks(over.asks), LIVE, NOW);
  return <AsksBoard sessions={sessions} live={LIVE} now={NOW} drafts={MARKED} onOpen={vi.fn()} send={idleSend()} sendRequest={KEY} onSendRequestDone={over.done} loaded={over.loaded} />;
}

describe("a Send request that arrives before the deck has loaded", () => {
  it("waits while the deck is loading, then opens the sheet once the session is in", () => {
    const done = vi.fn();
    const view = render(element({ asks: [], loaded: false, done }));
    expect(done).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(element({ asks: ASKS, loaded: true, done }));
    expect(screen.getByRole("dialog", { name: /Send to/u })).toBeInTheDocument();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("waits through a partial deck that does not hold the session yet", () => {
    const done = vi.fn();
    const other = askDecision({ id: "ak_7", title: "Another?", address: askAddress("w9:p9"), label: "other", at: HILL_T0 });
    const view = render(element({ asks: [other], loaded: false, done }));
    expect(done).not.toHaveBeenCalled();
    view.rerender(element({ asks: [other, ...ASKS], loaded: true, done }));
    expect(screen.getByRole("dialog", { name: /Send to/u })).toBeInTheDocument();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("drops the request once the deck has loaded and the session is not in it", () => {
    const done = vi.fn();
    render(element({ asks: [], loaded: true, done }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
