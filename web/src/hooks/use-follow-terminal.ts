import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import { useFollowTerminalActive } from "@/lib/follow-terminal";
import { panePath } from "@/lib/nav";
import type { HomeData } from "@/lib/loaders";

// THE FOLLOW ITSELF — one effect, at the router's root, where the snapshot lives.
//
// It reads a fact the contract already puts on every snapshot (`MuxPane.focused`, "the pane the
// operator's own terminal is showing") and turns a CHANGE in it into a navigation. Three rules make
// it something an operator can leave switched on:
//
//  1. **It acts on a change, never on a state.** The first snapshot after the setting is turned on —
//     or after the app comes back — establishes a baseline and moves nothing. Otherwise enabling the
//     toggle would yank you off the pane you were reading, which is the opposite of following.
//  2. **It waits.** {@link SETTLE_MS} of the same answer before it moves. Focus in a terminal is
//     something a human sweeps through — `prefix n` three times is three focused panes in half a
//     second — and following each one would be a slideshow.
//  3. **Ambiguity is not a signal.** Two focused panes (two machines in a pack, two terminals on one
//     tmux server) mean two screens, and picking one would be picking at random. Nothing moves.
//
// The fourth rule lives in lib/follow-terminal.ts: anything the jump would ruin — a draft, an armed
// "Type into terminal", an open sheet — HOLDS the follow, and a held follow does not even keep a
// baseline, so releasing the hold does not fire a jump the operator has forgotten about.

/** How long one focused pane must stay focused before the phone follows it. */
const SETTLE_MS = 500;

/** The one pane the whole herd agrees the operator is looking at, or null. */
function focusedPaneId(data: HomeData): string | null {
  const focused = [...data.agents, ...data.shellPanes].filter((pane) => pane.focused);
  return focused.length === 1 ? (focused[0]?.paneId ?? null) : null;
}

/**
 * Follow the terminal's focus, while the operator has asked for it.
 *
 * `paneId` is the pane the phone is showing (undefined off the pane route), and it is compared
 * rather than trusted as the baseline: a follow that fired while you were already on the pane would
 * be a navigation to where you are.
 */
export function useFollowTerminal(data: HomeData, paneId: string | undefined): void {
  const active = useFollowTerminalActive();
  const navigate = useNavigate();
  /** The focus this hook has already accounted for. `null` = no baseline yet. */
  const seen = useRef<string | null>(null);
  const focused = focusedPaneId(data);
  const scope = data.scope;

  useEffect(() => {
    if (!active) {
      // Baseline dropped, so turning the setting back on (or releasing a hold) starts from what is
      // on screen THEN rather than from a focus change nobody was watching.
      seen.current = null;
      return;
    }
    if (focused === null) return;
    if (seen.current === null) {
      seen.current = focused;
      return;
    }
    if (focused === seen.current) return;
    const timer = setTimeout(() => {
      seen.current = focused;
      if (focused !== paneId) void navigate(panePath(focused, scope));
    }, SETTLE_MS);
    // A focus that moves again inside the window replaces the timer, so a sweep through four panes
    // navigates once, to the pane the operator stopped on.
    return () => clearTimeout(timer);
  }, [active, focused, paneId, navigate, scope]);
}
