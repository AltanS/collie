import { Activity, Network } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useNav } from "@/hooks/use-nav";
import { useCrew } from "@/components/crew-provider";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { crewPath, machinesPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

/**
 * The Settings entry point. Gated on `multi` like every other piece of host chrome — a solo install
 * grows no row at all, which is the milestone's rule and the reason this lives behind `useCrew()`
 * rather than behind a check on the loader's answer (Settings has no crew loader to check).
 */
export function CrewSettingsCard() {
  const nav = useNav();
  const scope = useScope();
  useLocale();
  const { multi } = useCrew();
  if (!multi) return null;

  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => nav.down(crewPath(scope))}
        className="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
      >
        <Network className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("crew.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{t("crew.entry.description")}</p>
        </div>
      </button>
      {/* The machines list is one more way into the same crew: the census says WHO is in it, this says
          how hard each machine is working. Its Settings index row is always there; this one is the
          crew's own door to it. */}
      <button
        type="button"
        onClick={() => nav.down(machinesPath(scope))}
        className="flex w-full items-center gap-3 border-t border-border p-4 text-left active:bg-muted/60"
      >
        <Activity className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("machines.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{t("machines.entry.description")}</p>
        </div>
      </button>
    </Card>
  );
}
