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

/**
 * Provides the pane's list. The index is built once per list identity, and the loader keeps that
 * identity across polls that brought nothing new (`readWalky` in lib/loaders.ts), so a quiet poll
 * re-draws no card.
 */
export function WalkyLogProvider({ rows, children }: { rows: readonly WalkyRow[] | null | undefined; children: ReactNode }) {
  const log = useMemo(() => (rows === null || rows === undefined ? null : walkyLog(rows)), [rows]);
  return <WalkyLogCtx.Provider value={log}>{children}</WalkyLogCtx.Provider>;
}

/** The pane's list as an index, or null where it was not read. */
export function useWalkyLog(): WalkyLog | null {
  return useContext(WalkyLogCtx);
}
