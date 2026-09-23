import { useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import { markInAppBack } from "@/lib/nav-entry";
import { canStepBack, isAncestor, pathOnly, readFrom, resolveUp, resolveUpTo, type NavExtras, type UpMove } from "@/lib/nav";

/**
 * The three moves of ADR 0067, for components. Every navigation in the app goes through one of
 * these, so the history stack stays the level tree and the phone's edge swipe goes up one level.
 *
 *   `down(to)`   a push that records `from` (this pathname + search). Opening a level below.
 *   `side(to)`   a replace that carries this entry's `from` over. Switching within a level.
 *   `open(to)`   `down` from a dashboard or a space, `side` from a pane: opening a pane.
 *   `up(parent)` a step back when the entry behind is a legitimate parent, else a replace onto
 *                `parent`, the structural one. Back arrows, the Collie mark, closed-under-you exits.
 *   `upTo(p)`    as `up`, to one NAMED parent: the pane's space breadcrumb.
 *
 * The callbacks are stable: the location is read through a ref, so a hook that hands one of these
 * to a memoised child does not churn it on every navigation.
 */
export interface Nav {
  down(to: string, state?: NavExtras): void;
  side(to: string, state?: NavExtras): void;
  open(to: string, state?: NavExtras): void;
  up(parent: string): void;
  upTo(parent: string): void;
}

export function useNav(): Nav {
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef(location);
  here.current = location;

  return useMemo(() => {
    const href = () => `${here.current.pathname}${here.current.search}`;
    const run = (move: UpMove) => {
      if (move.kind === "back") {
        // The step back lands on the parent's own entry, whose `from` still names the level above
        // it. Marked, so the screen transition knows this POP was an arrow and not a swipe.
        markInAppBack(pathOnly(readFrom(here.current.state) ?? ""));
        void navigate(-1);
        return;
      }
      // The entry behind the child stays behind the parent. When it is a level above the parent too
      // (a pane opened from the dashboard, left through its space breadcrumb), the parent keeps it
      // as its `from`, so the parent's own up steps back onto it instead of stacking a second one.
      const from = readFrom(here.current.state);
      const keep = from !== undefined && isAncestor(from, pathOnly(move.to));
      void navigate(move.to, { replace: true, state: keep ? { from } : undefined });
    };
    const down = (to: string, state?: NavExtras) =>
      void navigate(to, { state: { ...state, from: href() } });
    const side = (to: string, state?: NavExtras) => {
      const from = readFrom(here.current.state);
      void navigate(to, { replace: true, state: from === undefined ? { ...state } : { ...state, from } });
    };
    return {
      down,
      side,
      open: (to, state) => (here.current.pathname.startsWith("/pane/") ? side(to, state) : down(to, state)),
      up: (parent) => run(resolveUp(here.current.pathname, readFrom(here.current.state), parent, canStepBack())),
      upTo: (parent) => run(resolveUpTo(readFrom(here.current.state), parent, canStepBack())),
    };
  }, [navigate]);
}
