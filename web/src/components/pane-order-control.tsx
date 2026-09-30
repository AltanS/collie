import { ArrowDownUp } from "lucide-react";

import { Card } from "@/components/ui/card";
import { PaneOrderToggle } from "@/components/pane-order-toggle";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * Which way a pane list runs: by PLACE, or by ACTIVITY.
 *
 * Place by default, and that default is a decision rather than a habit. ADR 0063 took status out of
 * every list because a row that moves while a state changes is a row the thumb misses, and on the
 * switcher a missed tap opens the wrong terminal. Activity is the one order that ADR 0063's own
 * closing clause allows, "on the operator's own request", and ADR 0071 is that request taken up:
 * the list reads the clock when it opens and holds that reading while it is on screen, so nothing
 * moves under a finger even in activity order.
 *
 * A per-device choice, like the Changes depth and zen's availability, and it sits in Appearance
 * because it decides how a surface is ARRANGED. The switcher's own toggle writes this same value, so
 * the two never disagree: this card is the place you find the setting, not a second copy of it.
 */
export function PaneOrderControl() {
  useLocale();
  const { prefs, setPaneOrder } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <ArrowDownUp className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("paneOrder.aria")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.paneOrder.description")}</p>
          </div>
        </div>
      </div>

      <div className="border-t border-border p-2">
        <PaneOrderToggle order={prefs.paneOrder} onChange={setPaneOrder} />
      </div>
    </Card>
  );
}
