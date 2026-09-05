import { ChevronDown, Globe } from "lucide-react";

import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { LOCALES, isLocale, t } from "@/lib/i18n";

// The language selector. It shares the icon/title/description header of every other settings card,
// but the control itself is a NATIVE <select>, not the vertical radiogroup this used to be.
//
// Seven rows, each 44px, made the tallest card in Settings out of a set-once preference and pushed
// everything below it off the screen — you scrolled past seven languages to reach Haptics. A select
// collapses that to one row and hands the list to the platform, which is also what makes it the
// right control here rather than a prettier custom one: iOS and Android open their own wheel or
// dialog, sized and scrolled the way the phone's own settings do, with the keyboard, the screen
// reader, and typeahead already correct. There is no Select primitive in components/ui, and this
// is not the case to add one for — a modal dropdown we own would be more code doing less.
//
// Native names are never translated: LOCALES carries a language's own name for itself, which is the
// only label useful to someone who cannot yet read the current UI language. The `lang` attribute on
// each option says which language that name IS, so a screen reader pronounces it with the right
// voice instead of reading it in the current UI language's.
//
// This card is the first surface actually wired to `t()` — its title and its one line of prose come
// from the dictionary, so switching languages here is also the first thing that visibly proves the
// layer works.
//
// It carries ONE sentence, and it is the only one a reader cannot work out from the control itself:
// the terminal mirror is never translated. "Choose the language Collie speaks" said what a globe, a
// heading reading "Language" and a list of languages already say, and a footer band repeating the
// selected name and the option count said it a third time. On a phone that was five lines of chrome
// around a set-once preference, so the two redundant halves are gone and the caveat stays.
export function LanguageControl() {
  const { locale, setLocale } = useLocale();

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

        {/* The select fills this box and is transparent; the chevron and the border belong to the
            wrapper. A native control cannot be styled past its own box on every engine — iOS Safari
            in particular keeps its own caret and padding — so the arrow is ours and the select's is
            removed with `appearance-none`. `shrink-0` because the description beside it wraps. */}
        <div className="relative shrink-0">
          <select
            value={locale}
            // A DOM value is a plain string whatever the options say, so it is parsed back to a
            // Locale at this boundary rather than asserted. An unknown value is ignored, which is
            // the same thing the stored-pin reader does with a stale code.
            onChange={(event) => {
              const next = event.target.value;
              if (isLocale(next)) setLocale(next);
            }}
            aria-label={t("settings.language.title")}
            // min-h-11 = 44px, the same comfort target every other control in Settings uses.
            // pr-9 leaves room for the chevron drawn over it.
            className="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
          >
            {LOCALES.map((option) => (
              <option key={option.code} value={option.code} lang={option.code}>
                {option.nativeName}
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      </div>
    </Card>
  );
}
