import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { DashboardRouteBar, footAir } from "@/components/dashboard-route-bar";
import { HillCrewStateBar } from "@/components/hill-crew-state";
import { HillHeader, HillOff, HillView, LiveDecisionCard } from "@/components/hill-view";
import { BandMain } from "@/components/ui/strip-host";
import { useDashboardBar } from "@/hooks/use-dashboard-bar";
import { useHillClear } from "@/hooks/use-hill-clear";
import { useHillCrewStateControl } from "@/hooks/use-hill-crew-state";
import { useHillSwitch } from "@/hooks/use-hill-switch";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useHillClosed, useHillClosedTotal, useHillKept, useHillOpen } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { homePath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { cn } from "@/lib/utils";

// THE HILL'S ROUTE (M96), `/hill`: one level below the Dashboard, the place Back goes up to (ADR 0067).
// The lists come from the hill's store, which the root loader keeps current from the snapshot's
// `hillRev` (lib/hill/store.ts), so this route has no loader of its own and a poll that moved the hill
// redraws it here. Each open Decision is a card wired to the bridge.
//
// The Dashboard's bottom bar stays under it, with the Hill item as the current one (amended 2026-11-10,
// components/dashboard-route-bar.tsx). The bar sits outside the scroller, so the list scrolls above it
// and its last card ends above the bar, as the Dashboard's list does.
//
// `/hill#<decision id>` is where a `now` Decision's notification lands (lib/push-decision.ts): the route
// scrolls that card into view once it is on the list. A closed one, or an unknown id, scrolls nothing.
//
// THE HILL SWITCHED OFF (the snapshot's `hillOff`, bridge/hill/switch.ts): the route stays, under the
// same header, and shows a calm off state with the switch's way back on (`HillOff`), not a redirect: a
// person who lands here from an old notification or a bookmark learns why the Hill is empty, and turns
// it on in one tap. The bar has no Hill item then, as on the Dashboard.
//
// THE CREW STATE (1.29.0) sits at the top of the list, above the cards: Here / Quiet / Away and its
// helper line (components/hill-crew-state.tsx). Only where the bridge serves one: a member's own Hill,
// which is not there (the Hill lives on the lead), and an older bridge show no control.

const AT_HILL = { kind: "hill" } as const;

export function HillRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const open = useHillOpen();
  // The marked cards this page shows: the second Clear sends their ids, so a card marked later stays (C-N5).
  const spoken = open.flatMap((d) => (d.spokeAfter === undefined ? [] : [d.id]));
  const closed = useHillClosed();
  const kept = useHillKept();
  const closedTotal = useHillClosedTotal();
  const clearing = useHillClear();
  const bar = useDashboardBar();
  const sw = useHillSwitch();
  const crew = useHillCrewStateControl();
  const off = !sw.on;
  useScrollToDecision(open);
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <HillHeader count={open.length} nowCount={open.filter((d) => d.priority === "now").length} onBack={() => nav.up(homePath(scope))} off={off} />
      <BandMain base={16} data-slot="hill-scroll" className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4", footAir(bar.shown, "pb-4"))}>
        {off ? (
          <HillOff canWrite={sw.canWrite} busy={sw.busy} onTurnOn={() => void sw.set(true)} />
        ) : (
          <>
            {crew.view !== null && (
              <HillCrewStateBar
                value={crew.value}
                saved={crew.view.state}
                told={crew.view.told}
                canWrite={crew.canWrite}
                busy={crew.busy}
                failed={crew.failed}
                telling={crew.telling}
                tellFailed={crew.tellFailed}
                onChange={(next) => void crew.set(next)}
                onTell={() => void crew.tell()}
              />
            )}
            <HillView open={open} closed={closed} closedTotal={closedTotal} clear={{ canWrite: clearing.canWrite, busy: clearing.busy, onClear: () => void clearing.clear(), spoken: spoken.length, onClearSpoken: () => void clearing.clearSpoken(spoken) }} kept={kept} renderCard={(decision) => <LiveDecisionCard key={decision.id} decision={decision} />} />
          </>
        )}
      </BandMain>
      <DashboardRouteBar bar={bar} at={AT_HILL} />
    </div>
  );
}

/** Scroll the open card the URL's hash names into view, once per hash, as soon as the list holds it. */
function useScrollToDecision(open: readonly HillDecision[]): void {
  const { hash } = useLocation();
  const id = hash.startsWith("#dc_") ? hash.slice(1) : null;
  const listed = id !== null && open.some((decision) => decision.id === id);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!listed || id === null || done.current === id) return;
    const card = [...document.querySelectorAll<HTMLElement>('[data-slot="decision-card"]')].find((element) => element.dataset.id === id);
    if (card === undefined) return;
    done.current = id;
    card.scrollIntoView({ block: "start" });
  }, [id, listed]);
}
