import { createContext, useContext, useMemo, type ReactNode } from "react";

import { walkyLog, type WalkyLog, type WalkyRow } from "@/lib/walky";

// The pane's walky talky list (`PaneData.walky`), made available to the two places that draw an
// envelope header: the Chat card (components/chat-cards.tsx) and the mirror row
// (components/ansi-output.tsx). Both hold the same rule, and this context is how the rule gets its
// one input: a header on a screen is a CLAIM, and the list is the bridge's record of what it really
// delivered. `null` is "the list could not be read", which claims nothing either way (lib/walky.ts,
// `standingOf`).
//
// A context and not a prop, because the mirror sits several components below the pane view and the
// card is rendered by a tool-group renderer that has no business passing it along (the same reason
// `CardWaitingCtx` is one). A mount without a provider reads `null`: no card, no row style, no mark,
// which is exactly how every pane looked before this feature existed.

const WalkyLogCtx = createContext<WalkyLog | null>(null);

// ── HOW MANY TIMES THE LIST WAS READ ──────────────────────────────────────────
// A turn that printed a header the list lacks may only be marked "no log record on this machine" once
// the list has been read AGAIN since the turn first showed up: the bridge writes the log row a moment
// around the time the agent's screen shows the typed line, so one read can be a beat early. The list
// keeps its identity across a quiet poll (`readWalky` in lib/loaders.ts), so identity cannot count
// reads. The loader counts them instead (`PaneData.walkyReads`, bumped per answered read) and the pane
// route hands the number down here. A mount that passes none stays at 0 and never advances, so it
// never marks anything: with no way to tell "read again", it claims nothing.
const WalkyReadsCtx = createContext(0);

/**
 * Provides the pane's list. The index is built once per list identity, and the loader keeps that
 * identity across polls that brought nothing new (`readWalky` in lib/loaders.ts), so a quiet poll
 * re-draws no card.
 */
export function WalkyLogProvider({
  rows,
  reads = 0,
  children,
}: {
  rows: readonly WalkyRow[] | null | undefined;
  /** How many times the list has been read from the bridge so far (`PaneData.walkyReads`). */
  reads?: number;
  children: ReactNode;
}) {
  const log = useMemo(() => (rows === null || rows === undefined ? null : walkyLog(rows)), [rows]);
  return (
    <WalkyLogCtx.Provider value={log}>
      <WalkyReadsCtx.Provider value={reads}>{children}</WalkyReadsCtx.Provider>
    </WalkyLogCtx.Provider>
  );
}

/** How many times the pane's list has been read (see the note above). */
export function useWalkyReads(): number {
  return useContext(WalkyReadsCtx);
}

/** The pane's list as an index, or null where it was not read. */
export function useWalkyLog(): WalkyLog | null {
  return useContext(WalkyLogCtx);
}
