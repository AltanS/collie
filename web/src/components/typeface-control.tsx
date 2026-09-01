import { ChevronDown, CaseSensitive } from "lucide-react";

import { Card } from "@/components/ui/card";
import { DEFAULT_FONT, SHIPPED_FONTS, isDesignFont, setDesignFont, useDesignPrefs } from "@/lib/design";
import { findOperatorFont, operatorFontValue, type OperatorFontFace } from "@/lib/operator-fonts";
import { useOperatorFonts } from "@/lib/operator-config";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// The Typeface card — the APP's own face, per device.
//
// This setting exists because the one that used to be here didn't. The face was the maker's choice
// and the code said so in two places ("round-4 F-D1"); the maker asked for the setting, and ADR 0033
// records what fell and what replaced it. What SURVIVED is the other half of that rule and it is
// still absolute: the chosen face dresses chrome and never an agent's words. Nothing here touches
// --font-mono or --font-content, and nothing here may learn to.
//
// IT SITS DIRECTLY ABOVE THE TERMINAL FONT CARD, and there is deliberately NO section heading over
// the pair. Settings is a flat stack of cards; a labelled "Design" group would be the first heading
// on the page and would imply four more. Two adjacent cards, one named for the app's face and one
// named for the terminal's, say the same thing with less furniture — and the ADJACENCY is the point,
// because "which font does this change" is the only question either card raises.
//
// A NATIVE <select>, for exactly the reasons LanguageControl and the terminal family picker give:
// this is a set-once preference, stacked radios would make it the tallest card on the page, and the
// platform's own picker is better than one we could draw.
//
// FAMILY NAMES ARE PROPER NOUNS and are not translated. The NOTE under the select is a phrase about
// a face rather than the name of one, so it goes through the dictionary like every other sentence.

/** The shipped faces' display names. Untranslated, and typed so a new key cannot skip one. */
const FAMILY_LABELS = {
  grotesk: "Space Grotesk",
  aldrich: "Aldrich",
} satisfies Record<Exclude<(typeof SHIPPED_FONTS)[number], "system">, string>;

const NOTE_KEYS = {
  system: "settings.typeface.note.system",
  grotesk: "settings.typeface.note.grotesk",
  aldrich: "settings.typeface.note.aldrich",
} as const;

/** Settings card: the app's own typeface. Device-local, like theme and language. */
export function TypefaceControl() {
  useLocale();
  const prefs = useDesignPrefs();
  const operatorFonts = useOperatorFonts();

  // The value the select shows. A stored `op:` choice whose row has gone — the operator deleted it,
  // or /api/config has not answered yet — must not leave the select on a value it has no option for,
  // because a <select> silently shows its FIRST option in that case and would misreport the setting
  // as "System default". Showing the default is honest about what is on screen, and the stored
  // preference is untouched: index.css renders the default stack for it and the row coming back
  // restores it (ADR 0033).
  const chosen = resolveShown(prefs.font, operatorFonts);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <CaseSensitive className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.typeface.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.typeface.description")}</p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-border border-t border-border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label htmlFor="pref-typeface" className="text-sm font-medium">
            {t("settings.typeface.family")}
          </label>
          {/* Same construction as LanguageControl's select: the wrapper owns the border and the
              chevron, `appearance-none` removes the engine's caret, `shrink-0` keeps a long family
              name from resizing the row. */}
          <div className="relative shrink-0">
            <select
              id="pref-typeface"
              value={chosen}
              // A DOM value is a plain string whatever the options say, so it is parsed back at this
              // boundary rather than asserted. An operator face is looked up in the CURRENT list, so
              // the row mirrored into storage is one this client has already accepted — never one
              // reconstructed from the select's own value.
              onChange={(event) => {
                const next = event.target.value;
                if (!isDesignFont(next)) return;
                const face = findOperatorFont(next, operatorFonts);
                if (face === null) setDesignFont(next);
                else setDesignFont(next, face);
              }}
              className="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
            >
              {SHIPPED_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font === "system" ? t("settings.typeface.system") : FAMILY_LABELS[font]}
                </option>
              ))}
              {/* The operator's faces, UNDER the shipped ones — they add to the list, they never
                  replace it (ADR 0033). Rendered from the validated set, so a row this client
                  refused never becomes an option someone can pick. */}
              {operatorFonts.map((face) => (
                <option key={face.basename} value={operatorFontValue(face)}>
                  {face.family}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>

        {/* The note. One line per choice, always present and always one line, so choosing a face
            never changes the card's height — the no-shift rule applies to a settings row as much as
            to a banner. Aldrich's is the one that has to be here: it discloses that the face has a
            single weight, so bold text under it is not heavier, which is a cost the reader should
            meet before they choose it and not afterwards. */}
        <p className="px-4 py-2.5 text-xs text-muted-foreground">{t(noteKey(chosen))}</p>
      </div>
    </Card>
  );
}

/** The value the select can actually show: the stored one, or the default when it resolves to nothing. */
function resolveShown(font: string, faces: readonly OperatorFontFace[]): string {
  if (!font.startsWith("op:")) return font;
  return findOperatorFont(font, faces) === null ? DEFAULT_FONT : font;
}

function noteKey(font: string): (typeof NOTE_KEYS)[keyof typeof NOTE_KEYS] | "settings.typeface.note.operator" {
  if (font === "system" || font === "aldrich" || font === "grotesk") return NOTE_KEYS[font];
  return "settings.typeface.note.operator";
}
