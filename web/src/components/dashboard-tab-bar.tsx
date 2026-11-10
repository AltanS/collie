import { useMemo } from "react";

import { Icon } from "@/components/icons/icon";
import { trickTabbarExtras, type TrickRef } from "@/components/trick-place-items";
import { TabBar, type TabBarItem, type TabBarLink } from "@/components/ui/tab-bar";
import { useLocale } from "@/hooks/use-locale";
import type { DashView } from "@/lib/dash-view";
import { t, tn } from "@/lib/i18n";
import type { WireTrickPart } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";
import type { TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";

// THE DASHBOARD'S BOTTOM BAR (ADR 0066, ADR 0085, both amended 2026-11-10). The route's footer, put
// together from `ui/tab-bar.tsx`: the views (Crew while a crew is configured, the Dashboard, Files on a
// machine with a screen), then the Hill, then the tricks' `tabbar` items.
//
// THE HILL IS A FOURTH FIXED ITEM, NOT A VIEW (M96, the owner's pick "A5"). The mountain, at the bar's
// right end under the thumb, and the bar's own red count of the open Decisions. A tap opens the Hill's
// route one level down, so on the Dashboard it is never drawn as the selected tab. It is there with
// nothing open too (no badge then), so the bar does not change shape when a Decision arrives.
//
// THE BAR STAYS ON THE HILL AND ON A TRICK'S SESSION (amended 2026-11-10, components/dashboard-route-bar.tsx).
// There no tab is selected (`view` null): on the Hill the Hill item is the current one (`hillCurrent`),
// and on a trick's Session that trick's own item when it has one (`currentTrick`). While a `now` Decision is open
// the mountain wears its snow cap in the warm accent, as A5 draws it (DESIGN.md §4, "The Hill's warm
// accent"); the word stays the bar's muted ink. Where the hill does not exist (the snapshot carries
// no `hillRev`: a bridge older than the hill, or a crew member's own scope) there is no Hill item.
//
// THE TRICKS' ITEMS FOLLOW IT (the `tabbar` place, components/trick-place-items.tsx). With one or more the
// bar is in its scrolling mode: the views and the Hill keep a fixed width and stay pinned, the items
// scroll after a thin divider. With none the bar is today's equal-width bar plus the Hill.

export interface DashboardTabBarProps {
  /** The selected tab, or null on a route of its own (the Hill, a trick's Session): no tab is selected there. */
  view: DashView | null;
  onSelect: (view: DashView) => void;
  /** Whether the Crew tab is drawn: a crew is configured. */
  crew: boolean;
  /** Whether the Files tab is drawn: the machine has a screen. */
  files: boolean;
  /** The Dashboard tab's red count, the panes blocked on you. */
  blockedCount: number;
  /** The Dashboard tab's quiet dot, finished panes nobody opened (drawn only when nothing is blocked). */
  readyUnseen: boolean;
  /** The open Decisions, or null where this view has no hill. */
  hill: number | null;
  /** Whether one of them is `now`: the mountain then wears its snow cap in the warm accent. */
  hillNow?: boolean;
  onOpenHill: () => void;
  /** The bar is drawn on the Hill's own route: the Hill item is the current one. */
  hillCurrent?: boolean;
  /** The bar is drawn on this trick's Session: its `tabbar` item, when it has one, is the current one. */
  currentTrick?: TrickRef;
  /** The held `tabbar` parts, in manifest order (`useTrickParts("tabbar")`). */
  tabbarParts: readonly WireTrickPart[];
  /** The trick sessions (`HomeData.trickSessions`), where a trick item's tap goes. */
  sessions: readonly AgentView[];
  onOpenSession: (pane: AgentView) => void;
  /** The tricks store the items read. Default: the app's. */
  store?: TricksStore;
}

export function DashboardTabBar({
  view,
  onSelect,
  crew,
  files,
  blockedCount,
  readyUnseen,
  hill,
  hillNow = false,
  onOpenHill,
  hillCurrent = false,
  currentTrick,
  tabbarParts,
  sessions,
  onOpenSession,
  store,
}: DashboardTabBarProps) {
  useLocale();
  const items: TabBarItem<DashView>[] = [
    // Crew leads, drawn only while a crew is configured (ADR 0085). Network is the Crew icon
    // the Settings card, the switcher sheet and the footer line wear.
    ...(crew ? [{ value: "crew" as const, label: t("crew.title"), icon: <Icon name="crew" className="size-5" /> }] : []),
    // The Dashboard tab carries the corner mark the Focus tab wore (ADR 0066 point 7), always:
    // it is information about the herd, not a nag, so it shows with the switch on or off.
    {
      value: "dashboard",
      label: t("home.tabs.dashboard"),
      icon: <Icon name="tab-dashboard" className="size-5" />,
      badge: blockedCount,
      dot: readyUnseen,
      badgeLabel: blockedCount > 0 ? tn("home.tabs.blocked", blockedCount) : t("home.tabs.unseen"),
    },
    // The Files tab (2026-10-06, ADR 0085): the stored value stays `changes`. ListTree is the
    // one Files icon: the pane belt's pill and the Files screen's Tree toggle wear it.
    ...(files ? [{ value: "changes" as const, label: t("files.title"), icon: <Icon name="files" className="size-5" /> }] : []),
  ];
  const links: TabBarLink[] =
    hill === null
      ? []
      : [
          {
            id: "hill",
            label: t("hill.title"),
            icon: <Icon name={hillNow ? "hill-now" : "hill"} className={cn("size-5", hillNow && "text-status-working")} />,
            badge: hill,
            badgeLabel: tn("home.tabs.hill", hill),
            current: hillCurrent,
            onSelect: onOpenHill,
          },
        ];
  const extras = useMemo(
    () => trickTabbarExtras({ parts: tabbarParts, sessions, onOpenSession, current: currentTrick, store }),
    [tabbarParts, sessions, onOpenSession, currentTrick, store],
  );
  return <TabBar<DashView> label={t("home.tabs.aria")} active={view} onSelect={onSelect} items={items} links={links} extras={extras} />;
}
