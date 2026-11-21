import { Icon } from "@/components/icons/icon";

import { Card } from "@/components/ui/card";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { USAGE_ROWS, type UsageRow } from "@/lib/usage-row";

// How the usage row above the belt draws context and limits (lib/usage-row.ts holds the choice):
// a percentage, or five dots. A per-device choice in Appearance, in BeltSizeControl's segmented
// form. Percent is the default, so a device that never opened this shows it.

const LABELS = {
  percent: "settings.usageRow.option.percent",
  dots: "settings.usageRow.option.dots",
} as const satisfies Record<UsageRow, MessageKey>;

export function UsageRowControl() {
  useLocale();
  const { prefs, setUsageRow } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="harness-model" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.contextLimits.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.contextLimits.hint")}</p>
          </div>
        </div>
      </div>

      <div role="radiogroup" aria-label={t("settings.contextLimits.title")} className="flex gap-1 border-t border-border p-2">
        {USAGE_ROWS.map((choice) => {
          const selected = choice === prefs.usageRow;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setUsageRow(choice)}
              className={cn(
                "flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
              )}
            >
              {t(LABELS[choice])}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
