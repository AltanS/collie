import { useCrew } from "@/components/crew-provider";
import type { DashView } from "@/lib/dash-view";
import { useHillCount, useHillOpen } from "@/lib/hill/store";
import { useMuxCapability } from "@/lib/mux-capability";
import { useRootData } from "@/lib/route-data";
import type { Scope } from "@/lib/scope";
import { countBlocked, hasReady } from "@/lib/triage";
import type { WireTrickPart } from "@/lib/tricks/schema";
import { useTrickParts } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";

// WHAT THE DASHBOARD'S BOTTOM BAR HOLDS (ADR 0066, ADR 0085, both amended 2026-11-10), read once for
// every route that draws it: the Dashboard (routes/home.tsx), the Hill (routes/hill.tsx) and a trick's
// Session (routes/trick-session.tsx). One reading, so the bar on the Hill is the bar on the Dashboard:
// the same tabs, the same Hill item and count, the same trick items, and the same rule for whether it is
// drawn at all.

const NO_TRICK_SESSIONS: readonly AgentView[] = [];

export interface DashboardBar {
  /**
   * Whether the bar is drawn. A bar with one tab and nothing else switches to nothing, so a solo machine
   * with no screen, no hill and no trick item draws none (durable-simple, 2026-10-13). The Hill alone is
   * reason enough for a bar: it is the hill's only way in.
   */
  shown: boolean;
  /** The view the Dashboard shows: the stored one, unless its tab is not drawn here. */
  view: DashView;
  /** Whether a crew is configured: the Crew tab is drawn. */
  crew: boolean;
  /** Whether the machine on screen has no screen (`paneGrid` false): no Files tab, the durable home. */
  screenless: boolean;
  /** The Dashboard tab's red count, the panes blocked on you. */
  blockedCount: number;
  /** The Dashboard tab's quiet dot: finished panes nobody opened, drawn only when nothing is blocked. */
  readyUnseen: boolean;
  /** The open Decisions, or null where the snapshot carries no `hillRev`: no Hill item there. */
  hill: number | null;
  /** Whether one open Decision is `now`: the Hill item's snow cap in the warm accent (the owner's pick A5). */
  hillNow: boolean;
  /** The tricks' `tabbar` parts, in manifest order. */
  tabbarParts: readonly WireTrickPart[];
  /** The trick sessions, where a trick item's tap goes. */
  sessions: readonly AgentView[];
  /** The scope the bar's routes are addressed to. */
  scope: Scope;
}

/** Whether the bar is drawn, from the four facts that decide it. Pure, for a test and for the reading below. */
export function dashboardBarShown(facts: { crew: boolean; screenless: boolean; hill: number | null; tabbarItems: number }): boolean {
  return facts.crew || !facts.screenless || facts.hill !== null || facts.tabbarItems > 0;
}

/**
 * The bar's reading. `storedView` is the device's stored choice (`useDashPrefs().prefs.dashView`): a
 * device that stored "crew" and then lost its crew sees the Dashboard, and the stored choice is left
 * alone, so the tab is back where it was when the crew returns (ADR 0085). A machine with no screen has
 * no Files tab (durable-simple, 2026-10-13), and a device that stored that tab sees the Dashboard there.
 * A route that selects no tab (the Hill, a trick's Session) passes nothing and reads no `view`.
 */
export function useDashboardBar(storedView: DashView = "dashboard"): DashboardBar {
  const data = useRootData();
  const { multi } = useCrew();
  // A machine with no screen (its multiplexer declared `paneGrid` false) runs a durable program (M53 spec
  // 12). Every multiplexer with a screen, and every bridge that has not answered, has a screen here.
  const screenless = !useMuxCapability("paneGrid", data.scope).capable;
  const view: DashView = (storedView === "crew" && !multi) || (storedView === "changes" && screenless) ? "dashboard" : storedView;
  const blockedCount = countBlocked(data.agents);
  const hillCount = useHillCount();
  const hill = data.hill === true ? hillCount : null;
  const hillOpenNow = useHillOpen().some((d) => d.priority === "now");
  const tabbarParts = useTrickParts("tabbar");
  return {
    shown: dashboardBarShown({ crew: multi, screenless, hill, tabbarItems: tabbarParts.length }),
    view,
    crew: multi,
    screenless,
    blockedCount,
    readyUnseen: blockedCount === 0 && hasReady(data.agents),
    hill,
    hillNow: hill !== null && hillOpenNow,
    tabbarParts,
    sessions: data.trickSessions ?? NO_TRICK_SESSIONS,
    scope: data.scope,
  };
}
