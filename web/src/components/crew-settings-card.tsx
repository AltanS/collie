
import { Card } from "@/components/ui/card";
import { useNav } from "@/hooks/use-nav";
import { useCrew } from "@/components/crew-provider";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { crewPath, machinesPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { Icon } from "@/components/icons/icon";

/**
 * The machines in Settings, Devices and machines: the Machines page on every install (a solo collie is one
 * machine with a load worth watching), and the crew's census above it only on a crew. The crew row is gated
 * on `multi` like every other piece of host chrome, behind `useCrew()` rather than a check on a loader's
 * answer (Settings has no crew loader to check).
 */
export function CrewSettingsCard() {
  const nav = useNav();
  const scope = useScope();
  useLocale();
  const { multi } = useCrew();

  return (
    <Card className="gap-0 py-0">
      {multi && <button
        type="button"
        onClick={() => nav.down(crewPath(scope))}
        className="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
      >
        <Icon name="crew" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("crew.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{t("crew.entry.description")}</p>
        </div>
      </button>}
      {/* The census says WHO is in the crew; Machines says how hard each machine is working. Settings has no
          index row for Machines (ADR 0170): this is its door. */}
      <button
        type="button"
        onClick={() => nav.down(machinesPath(scope))}
        className={cn("flex w-full items-center gap-3 p-4 text-left active:bg-muted/60", multi && "border-t border-border")}
      >
        <Icon name="machine-activity" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("machines.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{t("machines.entry.description")}</p>
        </div>
      </button>
    </Card>
  );
}
