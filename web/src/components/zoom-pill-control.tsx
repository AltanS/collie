import { Icon } from "@/components/icons/icon";

import { Card } from "@/components/ui/card";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { useActiveTheme } from "@/lib/theme/store";
import { cn } from "@/lib/utils";
import { ZOOM_PILLS, effectiveZoomPill, type ZoomPill } from "@/lib/zoom-pill";

// Whether the belt's Zoom pill is drawn (lib/zoom-pill.ts holds the rule): in the Screen view, or never.
// A per-device choice that sits beside the belt's size, in BeltSizeControl's segmented form. Until the
// person taps, the choice on show is the active theme's `zoom` word (or Screen view); a tap stores the
// device's own choice, which then wins over any theme.

const LABELS = {
  screen: "settings.zoomPill.option.screen",
  off: "settings.zoomPill.option.off",
} as const satisfies Record<ZoomPill, MessageKey>;

export function ZoomPillControl() {
  useLocale();
  const { prefs, setZoomPill } = useDashPrefs();
  const { theme } = useActiveTheme();
  const shown = effectiveZoomPill(prefs.zoomPill, theme.surface?.zoom);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="zoom" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.zoomPill.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.zoomPill.description")}</p>
          </div>
        </div>
      </div>

      <div role="radiogroup" aria-label={t("settings.zoomPill.title")} className="flex gap-1 border-t border-border p-2">
        {ZOOM_PILLS.map((choice) => {
          const selected = choice === shown;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setZoomPill(choice)}
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
