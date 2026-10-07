import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";

import { markInAppBack } from "@/lib/nav-entry";
import {
  canStepBack,
  historyIdx,
  isAncestor,
  pathOnly,
  readFrom,
  resolveTreeUp,
  resolveUp,
  resolveUpTo,
  resolveUpToExact,
  type NavExtras,
  type UpMove,
} from "@/lib/nav";
import { fromOutsideTree, navTrail, resolveCrumb } from "@/lib/nav-trail";

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
 *   `upExact(p)` as `upTo`, but the entry behind must match `p`'s query too: one folder up inside
 *                the Files view, where every level shares a pathname.
 *   `upTree(p)`  the Files tree's back arrow: a step back to whatever the entry came from (a pane,
 *                a diff, a file), else a replace onto the parent folder `p`.
 *   `crumb(t)`   a Files breadcrumb to an ancestor folder: a pop back to that entry when the stack
 *                holds it, else a replace with no `from`. Never a push, never a copy of the folder.
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
  upExact(parent: string): void;
  upTree(parent: string): void;
  crumb(target: string): void;
}

/**
 * Writes down every location the tab visits against its history index, for the breadcrumb's pop
 * (`lib/nav-trail.ts`). Mounted once, in the root layout: the stack is the tab's, not a screen's.
 * The router has updated `history.state` by the time the effect runs, so the index is the new one.
 */
export function useNavTrail(): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const idx = historyIdx();
    if (idx !== undefined) navTrail.record(idx, `${pathname}${search}`);
  }, [pathname, search]);
}

/**
 * How long a `popReplace` waits for its pop to land before it gives up. A pop is a browser history
 * move and lands within a frame or two; a second is far past that, and short enough that the next,
 * unrelated back the operator makes is never mistaken for it.
 */
export const POP_REPLACE_WAIT_MS = 1000;

export function useNav(): Nav {
  const navigate = useNavigate();
  const location = useLocation();
  const here = useRef(location);
  here.current = location;
  // The `popstate` listeners of moves still waiting for their pop. Removed on unmount.
  const waiting = useRef(new Set<() => void>());
  useEffect(() => {
    const pending = waiting.current;
    return () => {
      for (const stop of pending) stop();
    };
  }, []);

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
      upExact: (parent) => run(resolveUpToExact(readFrom(here.current.state), parent, canStepBack())),
      upTree: (parent) => run(resolveTreeUp(readFrom(here.current.state), parent, canStepBack())),
      crumb: (target) => {
        const move = resolveCrumb(navTrail.entries(), historyIdx(), href(), target);
        if (move.kind === "stay") return;
        if (move.kind === "pop") {
          // A pop onto an entry of the same screen, marked like the arrow's step back.
          markInAppBack(pathOnly(target));
          void navigate(-move.steps);
          return;
        }
        // The folder lands on an entry with a `from` only when that `from` is outside the tree (the
        // pane Files was opened from), so its arrow steps back there. A `from` inside the tree names
        // a place below the folder, and is dropped: the arrow then replaces onto the parent.
        const land = (to: string) => {
          const from = readFrom(window.history.state?.usr ?? here.current.state);
          void navigate(to, { replace: true, state: fromOutsideTree(from, to) ? { from } : undefined });
        };
        if (move.kind === "popReplace") {
          // Back to where the tree was entered, then that entry becomes the folder. The replace
          // waits for the pop to land, so it rewrites the entry the pop arrived on.
          //
          // The trail can remember entries the browser has dropped (Chrome keeps about fifty), and
          // then the pop never happens. A listener that waited for ever would fire on the operator's
          // NEXT, unrelated back and replace that entry with a stale folder. So the listener lives
          // for POP_REPLACE_WAIT_MS at most (and not past unmount), and it replaces only when the
          // entry it arrived on is the one the move meant: the index stamped on the history entry
          // is `idx - steps`. Where the router stamps no index there is nothing to compare, and the
          // landing goes ahead on the pop alone.
          markInAppBack(pathOnly(move.to));
          const from = historyIdx();
          const expected = from === undefined ? undefined : from - move.steps;
          const stop = () => {
            window.removeEventListener("popstate", onPop);
            clearTimeout(giveUp);
            waiting.current.delete(stop);
          };
          const onPop = () => {
            stop();
            setTimeout(() => {
              if (expected !== undefined && historyIdx() !== expected) return;
              land(move.to);
            }, 0);
          };
          const giveUp = setTimeout(stop, POP_REPLACE_WAIT_MS);
          waiting.current.add(stop);
          window.addEventListener("popstate", onPop);
          void navigate(-move.steps);
          return;
        }
        land(move.to);
      },
    };
  }, [navigate]);
}
