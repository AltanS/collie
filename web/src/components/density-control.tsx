import { PanelLeft, PanelRight, Rows3 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { usePinSide, type PinSide } from "@/hooks/use-pin-side";
import { t, type MessageKey } from "@/lib/i18n";
import { setDenseKeysEnabled, useDenseKeysEnabled } from "@/lib/density";
import { cn } from "@/lib/utils";

// The dense key surfaces, beside Theme and the two font cards: all of them are "how this phone
// presents itself", and this one is the same shape of decision — set once, per device, standing.
//
// It is not in the pane's Display dock, which is explicitly "how the MIRROR looks" and holds prefs
// the operator flips while watching output. This changes the chrome around the mirror instead, and
// changing it mid-session moves every control under the thumb — a page-level setting, deliberately
// a walk away from the pane.
//
// Off by default: an install that never opens Settings keeps the layout it already has.
//
// THE PIN-SIDE ROW IS THIS CARD'S DEPENDENT, AND IT IS ABSENT RATHER THAN DISABLED. The edge only
// exists as a question once the dense layout is drawing pinned tabs; with the toggle off there is
// no /Agents pin and no rail pad, so a greyed two-way would be asking about controls that are not
// on screen. ZenControl's sub-row is disabled-not-hidden for the opposite reason — its choice
// changes what ROTATION does, which the operator cannot see either way, so leaving it visible is
// what stops a hidden flip. Here the answer becomes visible the moment it becomes real.
export function DensityControl() {
  useLocale();
  const enabled = useDenseKeysEnabled();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Rows3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.density.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.density.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={enabled}
            onCheckedChange={setDenseKeysEnabled}
            aria-label={t("settings.density.title")}
          />
        </div>
      </div>

      {enabled && <PinSideRow />}
    </Card>
  );
}

const OPTIONS: ReadonlyArray<{ value: PinSide; labelKey: MessageKey; icon: LucideIcon }> = [
  { value: "left", labelKey: "settings.pins.option.left", icon: PanelLeft },
  { value: "right", labelKey: "settings.pins.option.right", icon: PanelRight },
];

/**
 * Which edge the dense layout's fixed tabs dock to — the agents row's /Agents pin and the key
 * rail's pad. A set-once preference (which hand holds the phone), not a mode, so it gets no cycling
 * icon anywhere else.
 *
 * Its label and choices hang under the card title's text rather than the card edge: `pl-12` is the
 * card's own `px-4` plus the 32px icon gutter above, so one left edge runs down the whole card.
 */
function PinSideRow() {
  const { side, setSide } = usePinSide();

  return (
    <div className="border-t border-border py-3 pl-12 pr-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("settings.pins.title")}</div>
        <p className="text-xs text-muted-foreground">{t("settings.pins.description")}</p>
      </div>

      <div role="radiogroup" aria-label={t("settings.pins.title")} className="mt-2 flex gap-1">
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
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              <option.icon className="size-4 shrink-0" />
              {t(option.labelKey)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
