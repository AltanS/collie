import { Check, Dog } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { useDesignPrefs, setDesignMark } from "@/lib/design";
import { t } from "@/lib/i18n";
import { useThemeMarkId } from "@/lib/mark";
import { MARK_IDS, markName, type MarkId } from "@/lib/mark-ids";
import { cn } from "@/lib/utils";

// The Mark card: which logo the header draws on this device. "From the theme" is the default and is
// stored as the ABSENCE of the field (lib/design.ts), so a device that goes back to it stores what a
// device that never chose stores. The others are fixed ids (lib/mark-ids.ts).
//
// One row per choice, each with its mark drawn small beside the words. A native <select> cannot hold a
// drawing, so this is a radio group of rows rather than the Typeface card's select. "From the theme"
// draws the mark the worn theme would give (its own, else Collie), so the row shows what it means.
//
// THE MARKS ARE DRAWN ON THE CARD (`paper="var(--card)"`), because the knockout that makes a bead read
// as in front of the head must be the colour it sits on. A selected row therefore cannot be a filled
// pill like ThemeControl's: the fill would show as a halo around every bead. Selection is a check in a
// slot that is always there, so choosing repaints and re-lays-out nothing (DESIGN.md §2).
//
// MARK NAMES ARE PROPER NOUNS and are not translated; "From the theme" and the note are phrases.

const MARK_SIZE = 28;

type Choice = MarkId | "theme";

const CHOICES: readonly Choice[] = ["theme", ...MARK_IDS];

/** Settings card: the header logo. Device-local, like the typeface. */
export function MarkControl() {
  useLocale();
  const chosen: Choice = useDesignPrefs().mark ?? "theme";
  const fromTheme = useThemeMarkId();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Dog className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.mark.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.mark.description")}</p>
          </div>
        </div>
      </div>

      <div role="radiogroup" aria-label={t("settings.mark.title")} data-slot="list-group" className="border-t border-border">
        {CHOICES.map((choice) => {
          const selected = choice === chosen;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                if (!selected) setDesignMark(choice === "theme" ? null : choice);
              }}
              className="flex min-h-11 w-full items-center gap-3 border-b border-border px-4 py-2 text-left text-sm font-medium transition-colors active:bg-muted/60"
            >
              <span className="grid size-7 shrink-0 place-items-center">
                <BrandMark mark={choice === "theme" ? fromTheme : choice} size={MARK_SIZE} weight="header" paper="var(--card)" />
              </span>
              <span className="min-w-0 flex-1 truncate">{choice === "theme" ? t("settings.mark.fromTheme") : markName(choice)}</span>
              <Check aria-hidden className={cn("size-4 shrink-0 text-foreground", !selected && "invisible")} />
            </button>
          );
        })}
      </div>

      <p className="px-4 py-2.5 text-xs text-muted-foreground">{t("settings.mark.note")}</p>
    </Card>
  );
}
