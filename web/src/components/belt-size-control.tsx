import { Rows3 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { BELT_SCALES, useDashPrefs, type BeltScale } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The composer's action belt size: one factor, `--belt-scale`, that the belt's band, pills, icons and
// words all grow from together (`components/actions-row.tsx`). A per-device choice that sits with
// appearance, beside the harness-shortcuts row that decides what the same belt carries. The choice
// is ThemeControl's segmented three-way, not a slider: three sizes the belt was measured at, and no
// in-between one it was not.

const LABELS = {
  1.15: "settings.beltSize.option.default",
  1.3: "settings.beltSize.option.large",
  1.5: "settings.beltSize.option.larger",
} as const satisfies Record<BeltScale, MessageKey>;

export function BeltSizeControl() {
  useLocale();
  const { prefs, setBeltScale } = useDashPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Rows3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.beltSize.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.beltSize.description")}</p>
          </div>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t("settings.beltSize.title")}
        className="flex gap-1 border-t border-border p-2"
      >
        {BELT_SCALES.map((scale) => {
          const selected = scale === prefs.beltScale;
          return (
            <button
              key={scale}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setBeltScale(scale)}
              className={cn(
                // ThemeControl's segmented choice: 44px floor, the weight unconditional so a
                // selection repaints and never re-lays-out.
                "flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
              )}
            >
              {t(LABELS[scale])}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
