import { Network } from "lucide-react";
import { useNavigate } from "react-router";

import { Card } from "@/components/ui/card";
import { useCrew } from "@/components/crew-provider";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { crewPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

/**
 * The Settings entry point. Gated on `multi` like every other piece of host chrome — a solo install
 * grows no row at all, which is the milestone's rule and the reason this lives behind `useCrew()`
 * rather than behind a check on the loader's answer (Settings has no crew loader to check).
 */
export function CrewSettingsCard() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();
  const { multi } = useCrew();
  if (!multi) return null;

  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => navigate(crewPath(scope))}
        className="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
      >
        <Network className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("crew.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{t("crew.entry.description")}</p>
        </div>
      </button>
    </Card>
  );
}
