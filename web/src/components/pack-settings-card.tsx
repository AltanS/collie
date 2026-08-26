import { Network } from "lucide-react";
import { useNavigate } from "react-router";

import { Card } from "@/components/ui/card";
import { usePack } from "@/components/pack-provider";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { packPath } from "@/lib/nav";
import { useScope } from "@/lib/session";

/**
 * The Settings entry point. Gated on `multi` like every other piece of host chrome — a solo install
 * grows no row at all, which is the milestone's rule and the reason this lives behind `usePack()`
 * rather than behind a check on the loader's answer (Settings has no pack loader to check).
 */
export function PackSettingsCard() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();
  const { multi } = usePack();
  if (!multi) return null;

  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => navigate(packPath(scope))}
        className="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
      >
        <Network className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("pack.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{t("pack.entry.description")}</p>
        </div>
      </button>
    </Card>
  );
}
