import { Moon, MonitorSmartphone, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useTheme } from "@/hooks/use-theme";
import type { Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

// Appearance lives in ONE place: a labelled three-way in Settings. An earlier revision also put a
// cycling icon in every header; it was removed because a control you meet three times per screen
// implies you are meant to keep reaching for it, and this is a set-once preference — System already
// follows the phone, which is the situational flip (outdoors, in bed) happening on its own.

const OPTIONS: ReadonlyArray<{ value: Theme; label: string; icon: LucideIcon }> = [
  { value: "system", label: "System", icon: MonitorSmartphone },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** The icon names the CURRENT mode, not the next one — so the button reads as a status display you
 *  can also press. Tapping advances System → Light → Dark → System. */
export function themeIcon(theme: Theme): LucideIcon {
  return OPTIONS.find((o) => o.value === theme)?.icon ?? MonitorSmartphone;
}

/** Settings card. Mirrors the icon/title/description shape of the other rows. */
export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  const Icon = themeIcon(theme);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Appearance</div>
            <p className="text-sm text-muted-foreground">Follow your phone, or pin one.</p>
          </div>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label="Appearance"
        className="flex gap-1 border-t border-border/60 p-2"
      >
        {OPTIONS.map((option) => {
          const selected = option.value === theme;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(option.value)}
              className={cn(
                // min-h-11 = 44px, the iOS/Android comfort target rather than the 24px AA floor.
                "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                // Selected is a filled pill, not a tint: `bg-secondary` on a white card is 1.09:1,
                // which leaves the selection carried entirely by the label weight.
                selected
                  ? "bg-primary font-medium text-primary-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              <option.icon className="size-4 shrink-0" />
              {option.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
