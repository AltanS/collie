import { Scissors } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

/**
 * Whether a session view keeps the recap the agent writes when it compacts its context.
 *
 * OFF by default. The recap is thousands of characters the agent wrote for itself, and drawing it
 * means building every one of them into the page. Off leaves one marker line where the compaction
 * happened and never builds the text. A per-device choice, beside Tool calls, for the same reason:
 * it decides what the page CONTAINS.
 */
export function CompactionsControl() {
  useLocale();
  const { prefs, setShowCompactions } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Scissors className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.compactions.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.compactions.description")}</p>
          </div>
        </div>
        <Switch
          checked={prefs.showCompactions}
          onCheckedChange={setShowCompactions}
          aria-label={t("settings.compactions.title")}
        />
      </div>
    </Card>
  );
}
