import { useCallback } from "react";

import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import type { TrickRef } from "@/components/trick-place-items";
import type { DashboardBar } from "@/hooks/use-dashboard-bar";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { useNav } from "@/hooks/use-nav";
import type { DashView } from "@/lib/dash-view";
import { hillPath, homePath, trickSessionPath } from "@/lib/nav";
import { parseTrickSessionId } from "@/lib/tricks/schema";
import type { AgentView } from "@/lib/types";

// THE DASHBOARD'S BAR ON A ROUTE OF ITS OWN (amended 2026-11-10, the owner on the phone: "the dashboard
// footer nav is missing, for tricks that use this area it should be displayed"). The Hill and a trick's
// Session are opened from the bar, so the bar stays under them: the same bar as on the Dashboard
// (`useDashboardBar`), with no tab selected and the route's own item drawn as the current one.
//
// THE TAPS, AND WHAT BACK DOES AFTER THEM (ADR 0067). The bar's items are siblings one level below the
// Dashboard, so a tap here never pushes a stack of bar taps for the edge swipe to walk back through.
//
// - A tab (Crew, Dashboard, Files) stores its view, as on the Dashboard, and goes UP to the Dashboard
//   (`nav.upTo`): a step back onto the Dashboard's entry when that is the entry behind, else a replace
//   onto it. Either way the Dashboard is not stacked on top of the route, and the swipe from it does not
//   land on the Hill.
// - The Hill item on the Hill, and a trick's item on its own Session, do nothing: they are where you are.
//   The tabs do nothing on a second tap on the Dashboard either.
// - The Hill item on a trick's Session, and a trick's item on the Hill or on another trick's Session, are
//   SIDEWAYS (`nav.side`): a replace that carries `from`, so the new route's Back still goes up to where
//   the first one came from.

/** Whose route the bar is drawn on. */
export type DashboardRouteBarAt = { kind: "hill" } | { kind: "trick"; trick: TrickRef | undefined };

/**
 * The bottom air of a route's scroller or foot over the bar. With the bar drawn the bar owns the safe
 * area, so the content keeps only its own air; with none the content clears the safe area itself. Set
 * by whether the bar is drawn at all (`DashboardBar.shown`), never by the keyboard's transient hide,
 * so the keyboard opening never moves the list (home.tsx keeps its stamp's air the same way).
 */
export function footAir(shown: boolean, air: "pb-3" | "pb-4"): string {
  if (shown) return air;
  return air === "pb-3" ? "pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]" : "pb-[calc(1rem_+_env(safe-area-inset-bottom))]";
}

export function DashboardRouteBar({ bar, at }: { bar: DashboardBar; at: DashboardRouteBarAt }) {
  const nav = useNav();
  const { setDashView } = useDashPrefs();
  // Gone while the on-screen keyboard is up, as the Back bar and the New button are (DESIGN.md §1, §12):
  // the Hill's note field raises it, and the bar would ride up over the keys and cost the screen the
  // row it needs to show what is being typed.
  const keyboard = useKeyboardOpen();
  const { scope } = bar;
  const onSelect = useCallback(
    (view: DashView) => {
      setDashView(view);
      nav.upTo(homePath(scope));
    },
    [setDashView, nav, scope],
  );
  const onOpenHill = useCallback(() => {
    if (at.kind === "hill") return;
    nav.side(hillPath(scope));
  }, [at.kind, nav, scope]);
  const here = at.kind === "trick" ? at.trick : undefined;
  const onOpenSession = useCallback(
    (pane: AgentView) => {
      const address = parseTrickSessionId(pane.paneId);
      if (here !== undefined && address?.host === here.host && address.trick === here.trick) return;
      nav.side(trickSessionPath(pane.paneId));
    },
    [here, nav],
  );
  if (!bar.shown || keyboard) return null;
  return (
    <DashboardTabBar
      view={null}
      onSelect={onSelect}
      crew={bar.crew}
      files={!bar.screenless}
      blockedCount={bar.blockedCount}
      readyUnseen={bar.readyUnseen}
      hill={bar.hill}
      hillNow={bar.hillNow}
      onOpenHill={onOpenHill}
      hillCurrent={at.kind === "hill"}
      currentTrick={here}
      tabbarParts={bar.tabbarParts}
      sessions={bar.sessions}
      onOpenSession={onOpenSession}
    />
  );
}
