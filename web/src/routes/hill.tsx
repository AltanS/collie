import { DashboardRouteBar, footAir } from "@/components/dashboard-route-bar";
import { HillHeader, HillView, LiveDecisionCard } from "@/components/hill-view";
import { BandMain } from "@/components/ui/strip-host";
import { useDashboardBar } from "@/hooks/use-dashboard-bar";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useHillClosed, useHillKept, useHillOpen } from "@/lib/hill/store";
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

const AT_HILL = { kind: "hill" } as const;

export function HillRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const open = useHillOpen();
  const closed = useHillClosed();
  const kept = useHillKept();
  const bar = useDashboardBar();
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <HillHeader count={open.length} nowCount={open.filter((d) => d.priority === "now").length} onBack={() => nav.up(homePath(scope))} />
      <BandMain base={16} data-slot="hill-scroll" className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4", footAir(bar.shown, "pb-4"))}>
        <HillView open={open} closed={closed} kept={kept} renderCard={(decision) => <LiveDecisionCard key={decision.id} decision={decision} />} />
      </BandMain>
      <DashboardRouteBar bar={bar} at={AT_HILL} />
    </div>
  );
}
