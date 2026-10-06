// Appearance: the theme and the language. Port of web/'s ThemeControl and LanguageControl. The
// typeface and terminal-font cards are not in this build (the typeface reads operator fonts off the
// config, ADR 0033, and the mirror's font belongs to the pane screen).
import { on, type Handle } from "remix/component";
import { ChevronDown, Globe, MonitorSmartphone, Moon, Sun, type IconNode } from "lucide";

import { LOCALES, isLocale, t, type MessageKey } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { setLocale, useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { setTheme, theme, type Theme } from "./theme";

const THEMES: ReadonlyArray<{ value: Theme; labelKey: MessageKey; icon: IconNode }> = [
  { value: "system", labelKey: "settings.theme.option.system", icon: MonitorSmartphone },
  { value: "light", labelKey: "settings.theme.option.light", icon: Sun },
  { value: "dark", labelKey: "settings.theme.option.dark", icon: Moon },
];

export function ThemeControl(handle: Handle) {
  const readTheme = useStore(handle, theme);
  useLocale(handle);
  return () => {
    const current = readTheme();
    const icon = THEMES.find((o) => o.value === current)?.icon ?? MonitorSmartphone;
    return (
      <Card class="gap-0 py-0">
        <div class="flex items-start gap-3 p-4">
          <Icon icon={icon} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{t("settings.theme.title")}</div>
            <p class="text-sm text-muted-foreground">{t("settings.theme.description")}</p>
          </div>
        </div>
        <div role="radiogroup" aria-label={t("settings.theme.title")} class="flex gap-1 border-t border-border p-2">
          {THEMES.map((option) => {
            const selected = option.value === current;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected ? "true" : "false"}
                mix={on("click", () => setTheme(option.value))}
                class={cn(
                  "flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
                )}
              >
                <Icon icon={option.icon} class="size-4 shrink-0" />
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      </Card>
    );
  };
}

export function LanguageControl(handle: Handle) {
  const readLocale = useLocale(handle);
  return () => (
    <Card class="gap-0 py-0">
      <div class="flex items-center justify-between gap-4 p-4">
        <div class="flex min-w-0 items-start gap-3">
          <Icon icon={Globe} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{t("settings.language.title")}</div>
            <p class="text-sm text-muted-foreground">{t("settings.language.description")}</p>
          </div>
        </div>
        {/* The select is transparent inside a bordered box that owns the chevron: iOS keeps its own
            caret otherwise. Each option names its language in that language. */}
        <div class="relative shrink-0">
          <select
            aria-label={t("settings.language.title")}
            data-testid="language-select"
            class="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pr-9 pl-3 text-sm font-medium text-foreground"
            mix={on("change", (event) => {
              const next = event.currentTarget.value;
              if (isLocale(next)) setLocale(next);
            })}
          >
            {LOCALES.map((option) => (
              <option key={option.code} value={option.code} lang={option.code} selected={option.code === readLocale().locale}>
                {option.nativeName}
              </option>
            ))}
          </select>
          <Icon
            icon={ChevronDown}
            class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      </div>
    </Card>
  );
}
