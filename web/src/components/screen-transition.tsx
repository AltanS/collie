import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";

import { cn } from "@/lib/utils";
import { homePath, panePath } from "@/lib/nav";

/**
 * The everyday move, animated: dashboard → pane slides in from the right, pane → dashboard slides
 * back in from the left. Nothing else on the router moves at all.
 *
 * IT IS NOT THE VIEW TRANSITIONS API, AND IT MAY NOT BECOME ONE. That path was removed in
 * `1d925922` and the reason has not changed: React Router persists an "applied view transitions"
 * map and replays a phantom same-location `document.startViewTransition` on every REVALIDATION, so
 * a poll every 1.5s crossfaded the whole page. `:root { view-transition-name: none }` in
 * `index.css` and the sessionStorage purge in `router.tsx` are the belt to that, and both stay.
 * This component reaches for none of it: it is one entrance animation on one wrapper, keyed on the
 * pathname, so a revalidation — which does not change the pathname — is invisible to it by
 * construction rather than by a suppression flag someone can get wrong.
 *
 * WHAT ANIMATES IS THE ARRIVING SCREEN, AND ONLY IT. There is no exit: the old screen is simply
 * gone the moment React commits the new route, because holding a leaving route mounted means
 * holding its loader data, its composer draft and its polling alive beside the arriving one. A
 * single 240ms slide in reads as a move without paying for two live screens.
 *
 * WHAT IT MUST NOT DO. The key here remounts the React subtree under `<Outlet/>` and NOTHING ELSE,
 * and it does so ONLY on a move that animates:
 * the header shell, the strip band and the router itself all sit above this wrapper in
 * `routes/root.tsx`, so the Collie mark keeps turning across the move and no loader re-runs (a key
 * is a reconciliation hint; loaders are the router's, and the router never sees it). It also styles
 * nothing and lays out nothing new — it takes exactly the flex-child classes the outlet region had
 * when it was `<Outlet/>` alone, so the pane's own scroller and the composer's sticky footer still
 * measure against the same column they always did. Nothing here clips either: the app's one
 * `h-[100dvh] overflow-hidden` column already does that, and an `overflow` of our own would be a
 * second scrollport in the middle of the route's.
 *
 * ONE CONSEQUENCE, STATED. A running transform makes this wrapper the containing block for any
 * `position: fixed` descendant, so a sheet (`ui/sheet.tsx`, `fixed inset-0`, rendered in tree)
 * would resolve against it rather than the viewport FOR THE 240ms. It is inherent to sliding
 * anything and not to the fill mode, and it is unreachable in practice: a sheet is opened by a tap
 * on a screen that has been standing still, and a navigation closes the route it lives in. The
 * `from`-only `enter` keyframe leaves no transform behind once the animation ends, so nothing
 * outlives the move.
 */

/** Which of the two everyday moves this navigation is, if it is one of them at all. */
export type ScreenMove = "forward" | "back" | "none";

/** `/` — the dashboard, with no scope on it. The scope rides in the query, which a pathname drops. */
const DASHBOARD = homePath();
/** `/pane/` — asked of the path helper rather than spelled, so a route rename moves both at once. */
const PANE_PREFIX = panePath("");

/** A pane's own screen: exactly one segment under `/pane/`, so `/pane/x/history` is not one. */
function isPane(pathname: string): boolean {
  if (!pathname.startsWith(PANE_PREFIX)) return false;
  const rest = pathname.slice(PANE_PREFIX.length);
  return rest.length > 0 && !rest.includes("/");
}

/**
 * The classification, pure and exported for its table test.
 *
 * Pathnames ONLY, which is what makes the quiet cases quiet: a poll revalidation and a scope change
 * (`?h=`/`?s=`) both leave the pathname where it was, so both fall out as `none` here rather than
 * needing a rule of their own. A first render (`prev === null`) is `none` too — the app opening on a
 * pane is not a move the operator made.
 */
export function classifyMove(prev: string | null, next: string): ScreenMove {
  if (prev === null || prev === next) return "none";
  if (prev === DASHBOARD && isPane(next)) return "forward";
  if (isPane(prev) && next === DASHBOARD) return "back";
  return "none";
}

/**
 * The entrance per move. 240ms is the app's "move" speed — the same number `ui/collapse.tsx` states
 * as `COLLAPSE_MS`, written as a literal here for the reason that file gives: the motion tokens
 * (`--dur-move`, `--ease-orbit`) do not exist yet, and a primitive is not the place to mint them.
 *
 * `fill-mode-forwards` holds the last frame, so the arriving screen cannot flash at its start
 * position between the animation ending and the class being irrelevant. `motion-reduce:animate-none`
 * is the whole opt-out: a reader who asked for less motion gets the new screen, immediately, in
 * place.
 */
const ENTER = {
  forward:
    "duration-[240ms] ease-out animate-in slide-in-from-right fill-mode-forwards motion-reduce:animate-none",
  back: "duration-[240ms] ease-out animate-in slide-in-from-left fill-mode-forwards motion-reduce:animate-none",
  none: "",
} satisfies Record<ScreenMove, string>;

/**
 * Wraps the outlet region. The classes are the ones that region carries in `routes/root.tsx`, and
 * a caller may add to them but should not need to.
 */
export function ScreenTransition({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { pathname, key } = useLocation();
  // The previous pathname, held as STATE and updated during render rather than through a ref or an
  // effect. A ref mutated in the render body is double-written under StrictMode's second pass, which
  // classifies every move as `none`; an effect runs after the commit, so the first frame of the new
  // screen would paint with the previous move's class. This is React's own "derive state from
  // props" shape: the setState during render is discarded along with this render's output, and the
  // immediate re-render sees the new value.
  //
  // KEYED ON THE LOCATION KEY AND NOT THE PATHNAME, so a navigation that lands on the pathname it
  // is already on re-classifies (to `none`, which is what it is) instead of leaving the last move's
  // class on an element nobody is remounting. A REVALIDATION is not a navigation and does not touch
  // this key, so the poll loop still never reaches the classifier at all.
  //
  // `mounts` is the remount counter and it is the whole reason this is one state object rather than
  // two: it may only move when `move` does, so the two can never be derived from different renders.
  const [seen, setSeen] = useState<{
    pathname: string;
    key: string;
    move: ScreenMove;
    mounts: number;
  }>(() => ({ pathname, key, move: "none", mounts: 0 }));
  if (seen.key !== key) {
    const move = classifyMove(seen.pathname, pathname);
    // A move that does not animate does not remount either. This is not an optimisation; it is the
    // difference between keying the outlet and breaking every screen that keeps state across a
    // navigation React Router would have reconciled: pane → pane through the pane strip, pane →
    // history and back, dashboard → settings. Only `forward` and `back` advance the counter, and
    // they are exactly the two that have an entrance to replay.
    setSeen({ pathname, key, move, mounts: seen.mounts + (move === "none" ? 0 : 1) });
  }

  return (
    // KEYED ON THE REMOUNT COUNTER, so the arriving screen is a new element on the two moves that
    // animate — React would otherwise reconcile the two routes into the same box and the animation,
    // having already played, would not replay — and the SAME element on every other navigation, a
    // revalidation and a scope change included.
    <div
      key={seen.mounts}
      data-slot="screen-transition"
      className={cn("flex min-h-0 flex-1 flex-col", ENTER[seen.move], className)}
    >
      {children}
    </div>
  );
}
