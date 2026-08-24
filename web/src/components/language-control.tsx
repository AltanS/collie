import { Check, Globe } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { LOCALES, t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The language selector. Structurally ThemeControl's sibling — same icon/title/description header,
// same `role="radiogroup"` of buttons — but stacked VERTICALLY rather than in a pill row: six native
// names don't fit ThemeControl's three-wide strip, so each option is its own row with a trailing
// checkmark for the selected one, the same "active row gets a Check" language SessionSwitcher and
// ServerSwitcher already use for their sheets. No new primitive: a settings Card scrolls with the
// rest of the page, so there is no reason to put this behind a modal sheet the way those switchers
// do from a compact header pill.
//
// This card is the first surface actually wired to `t()` — its own title/description/status line
// come from the dictionary, so switching languages here is also the first thing that visibly proves
// the layer works. Native names are never translated: LOCALES carries a language's own name for
// itself, which is the only label useful to someone who cannot yet read the current UI language.
export function LanguageControl() {
  const { locale, setLocale } = useLocale();
  const activeName = LOCALES.find((option) => option.code === locale)?.nativeName ?? locale;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Globe className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.language.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.language.description")}</p>
          </div>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t("settings.language.title")}
        className="flex flex-col gap-1 border-t border-border/60 p-2"
      >
        {LOCALES.map((option) => {
          const selected = option.code === locale;
          return (
            <button
              key={option.code}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setLocale(option.code)}
              className={cn(
                // min-h-11 = 44px, the same comfort target ThemeControl's row uses.
                "flex min-h-11 items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                selected
                  ? "bg-primary font-medium text-primary-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              <span>{option.nativeName}</span>
              {selected && <Check className="size-4 shrink-0" />}
            </button>
          );
        })}
      </div>

      <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
        {t("settings.language.active", { language: activeName })}{" "}
        {tn("settings.language.available", LOCALES.length)}
      </p>
    </Card>
  );
}
