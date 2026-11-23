import { useEffect, useMemo } from "react";

import { useCrew } from "@/components/crew-provider";
import { useTick } from "@/hooks/use-tick";
import { groupAsks, openAsksOf, type AskDecision, type AskSession } from "@/lib/hill/asks";
import { deckOf, orderByClock } from "@/lib/hill/asks-board";
import { useHillOpen } from "@/lib/hill/store";
import { useOptionalRootData } from "@/lib/route-data";
import type { WalkyLivePanes } from "@/lib/walky-names";

// THE SESSIONS OF THE ASKS BOARD AND THE DECK THE ASK SCREEN WALKS (Asks build 2, 2026-11-23). The board and the ask
// screen read the same list, in the same order, so Next on an ask is the row below it on the board. The order is the
// cache clock's (`orderByClock`), held: the keys of the last drawn order live in this module, so a session keeps its
// row while a clock turns under it, and a session that is new to the list goes on top. The cache clock is read once a
// minute: a row never moves because a second went by.

/** The phone's live panes and the lead's member id, as a session's name and cache are read from them. */
export function useAsksLive(): WalkyLivePanes {
  const root = useOptionalRootData();
  const { lead } = useCrew();
  const agents = root?.agents;
  const shell = root?.shellPanes;
  return useMemo(() => ({ panes: [...(agents ?? []), ...(shell ?? [])], lead }), [agents, shell, lead]);
}

/** The keys of the sessions as the board last drew them, top first. */
let held: readonly string[] = [];

/** For a test: forget the order a page drew before. */
export function __resetAsksOrder(): void {
  held = [];
}

/** How often the clock is read: the cache's own unit is a minute. */
export const ASKS_CLOCK_MS = 60_000;

/** What the pages need of the open asks. */
export interface AsksDeck {
  /** The sessions that have an open ask, in board order, each one's asks in their order. */
  sessions: AskSession[];
  /** Every open ask in the order Previous and Next walk. */
  deck: AskDecision[];
  live: WalkyLivePanes;
  /** The clock the words were read at, ms. */
  now: number;
}

export function useAsksDeck(): AsksDeck {
  const open = useHillOpen();
  const live = useAsksLive();
  const now = useTick(true, ASKS_CLOCK_MS);
  const sessions = useMemo(() => orderByClock(groupAsks(openAsksOf(open)), live, now, held), [open, live, now]);
  useEffect(() => {
    held = sessions.map((session) => session.key);
  }, [sessions]);
  const deck = useMemo(() => deckOf(sessions), [sessions]);
  return { sessions, deck, live, now };
}
