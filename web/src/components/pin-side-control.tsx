import { PanelLeft, PanelRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { usePinSide, type PinSide } from "@/hooks/use-pin-side";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Which edge the fixed tabs dock to — the agents row's /Agents pin and the key rail's pad pin.
// A labelled two-way in Settings, the ThemeControl shape: this is a set-once preference (holding
// hand), not a mode, so it gets no cycling icon anywhere else.

const OPTIONS: ReadonlyArray<{ value: PinSide; labelKey: MessageKey; icon: LucideIcon }> = [
  { value: "left", labelKey: "settings.pins.option.left", icon: PanelLeft },
  { value: "right", labelKey: "settings.pins.option.right", icon: PanelRight },
];

/** Settings card. Mirrors ThemeControl's icon/title/description shape and radiogroup row. */
export function PinSideControl() {
  useLocale();
  const { side, setSide } = usePinSide();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          {side === "left" ? (
            <PanelLeft className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          ) : (
            <PanelRight className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="font-medium">{t("settings.pins.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.pins.description")}</p>
          </div>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t("settings.pins.title")}
        className="flex gap-1 border-t border-border p-2"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === side;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setSide(option.value)}
              className={cn(
                // min-h-11 = 44px, the iOS/Android comfort target (ThemeControl's floor).
                "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
              )}
            >
              <option.icon className="size-4 shrink-0" />
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
