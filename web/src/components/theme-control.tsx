import { Moon, MonitorSmartphone, Sun } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useTheme } from "@/hooks/use-theme";
import type { Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

// The two faces of one preference: a labelled three-way in Settings, and a cycling icon in the
// header for the situational flip (outdoors, in bed) that is the whole reason this is worth a
// control at all.

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

const LABEL: Record<Theme, string> = {
  system: "Theme: follow system",
  light: "Theme: light",
  dark: "Theme: dark",
};

/** Header affordance. Styled to match SettingsGear exactly — they sit next to each other. */
export function ThemeToggle() {
  const { theme, cycleTheme } = useTheme();
  const Icon = themeIcon(theme);
  return (
    <button
      type="button"
      onClick={cycleTheme}
      aria-label={LABEL[theme]}
      // A real 44px box, NOT padding pulled back by a negative margin. The negative-margin trick
      // keeps the icons visually tight but lets adjacent boxes overlap (two -m-3 buttons pull 24px
      // against a 12px gap, so the gear stole 12px of the theme button's hit area) and drags the
      // last one past the header's padding into document overflow. Costs horizontal room, which the
      // breadcrumb absorbs — it already truncates by design. SettingsGear matches.
      className="grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="size-5" />
    </button>
  );
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
