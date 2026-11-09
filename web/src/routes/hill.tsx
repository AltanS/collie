import { HillHeader, HillView, LiveDecisionCard } from "@/components/hill-view";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useHillClosed, useHillKept, useHillOpen } from "@/lib/hill/store";
import { homePath } from "@/lib/nav";
import { useScope } from "@/lib/session";

// THE HILL'S ROUTE (M96), `/hill`: one level below the Dashboard, which is its only way in and the
// place Back goes up to (ADR 0067). The lists come from the hill's store, which the root loader keeps
// current from the snapshot's `hillRev` (lib/hill/store.ts), so this route has no loader of its own
// and a poll that moved the hill redraws it here. Each open Decision is a card wired to the bridge.

export function HillRoute() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const open = useHillOpen();
  const closed = useHillClosed();
  const kept = useHillKept();
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <HillHeader count={open.length} onBack={() => nav.up(homePath(scope))} />
      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <HillView open={open} closed={closed} kept={kept} renderCard={(decision) => <LiveDecisionCard key={decision.id} decision={decision} />} />
      </BandMain>
    </div>
  );
}
