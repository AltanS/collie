import { AArrowDown, AArrowUp, ChevronDown, Type } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import {
  FONT_FAMILIES,
  FONT_MAX,
  FONT_MIN,
  isFontFamily,
  mirrorFont,
  useDisplayPrefs,
  type FontFamily,
} from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The Terminal font card. It configures the mirror's face and its size, and nothing else.
//
// THE APP'S OWN TYPEFACE IS NOT HERE, and that is still true — but for the opposite reason it used
// to be. This comment said the app face was "the maker's choice" with no setting and no hook
// (round-4 F-D1). That decision fell in round 5: it is a per-device preference now, and it has its
// own card, <TypefaceControl/>, mounted directly ABOVE this one (ADR 0033). So don't add a second
// control for it here — the two faces are two settings because they are two questions, and merging
// them would put the app's own voice behind a heading that says "Terminal".
//
// Shape follows the cards already in Settings rather than inventing a third one: the
// icon/title/description header every row here shares, then the controls in their own band under a
// `border-border` divider (ThemeControl), with the family on a native <select> for exactly the reason
// LanguageControl gives — seven stacked 44px radios would make this the tallest card on the page for
// a set-once preference, and the platform's own picker is better than one we could draw.
//
// The family names are PROPER NOUNS and are not translated; only "System default" is a phrase, and
// only it has a message key. A font is named the same in every locale.

const FAMILY_LABELS = {
  jetbrains: "JetBrains Mono",
  cascadia: "Cascadia Mono",
  menlo: "Menlo / SF Mono",
  roboto: "Roboto Mono",
  dejavu: "DejaVu Sans Mono",
  courier: "Courier New",
} satisfies Record<Exclude<FontFamily, "system">, string>;

// A line with the shapes a monospace face is actually judged on: a shell prompt, the digit/letter
// pairs that collide in a bad one (0/O, 1/l/I), a box-drawing run, and a Powerline separator from
// the bundled Nerd Font subset. If the separator renders as tofu, the leading "Nerd Font Symbols"
// entry has been lost from the stack — which is the one way this control can break the mirror.
const SAMPLE = "~/collie  0O1lI │ ok";

/** Settings card: the terminal mirror's font family and size. Device-local, like every display pref. */
export function FontSettingsControl() {
  useLocale();
  const { prefs, setFontFamily, stepFontSize } = useDisplayPrefs();

  const sampleFace = mirrorFont(prefs.fontFamily);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Type className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.fonts.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.fonts.description")}</p>
          </div>
        </div>
      </div>

      <div className="divide-y divide-border border-t border-border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label htmlFor="pref-font-family" className="text-sm font-medium">
            {t("settings.fonts.family")}
          </label>
          {/* Same construction as LanguageControl's select, for the same reasons: the wrapper owns
              the border and the chevron, `appearance-none` removes the engine's own caret, and the
              box is `shrink-0` so a long family name never resizes the row. */}
          <div className="relative shrink-0">
            <select
              id="pref-font-family"
              value={prefs.fontFamily}
              // A DOM value is a plain string whatever the options say, so it is parsed back at this
              // boundary rather than asserted. An unknown value is ignored — the same thing
              // loadPrefs does with a stale stored key.
              onChange={(event) => {
                const next = event.target.value;
                if (isFontFamily(next)) setFontFamily(next);
              }}
              className="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
            >
              {FONT_FAMILIES.map((family) => (
                <option key={family} value={family}>
                  {family === "system" ? t("settings.fonts.system") : FAMILY_LABELS[family]}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="text-sm font-medium">{t("settings.fonts.size")}</div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              disabled={prefs.fontSize <= FONT_MIN}
              onClick={() => stepFontSize(-1)}
              aria-label={t("settings.display.textSize.decrease")}
            >
              <AArrowDown className="size-4" />
            </Button>
            {/* Fixed width + tabular figures: the number must not resize its own slot as it steps,
                or the two buttons beside it walk. */}
            <span className="w-8 text-center text-xs tabular-nums text-muted-foreground">
              {prefs.fontSize}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-11"
              disabled={prefs.fontSize >= FONT_MAX}
              onClick={() => stepFontSize(1)}
              aria-label={t("settings.display.textSize.increase")}
            >
              <AArrowUp className="size-4" />
            </Button>
          </div>
        </div>

        {/* The proof. Settings does not show the mirror, so the card shows one line OF the mirror —
            in the mirror's own dark space, inverted in light with it (ADR 0002), so what you read
            here is what the pane will render.
            NO LAYOUT SHIFT: the row's height is pinned by `leading-none` on a fixed 16px line box,
            not by the chosen face's own metrics, and the text is `whitespace-pre overflow-hidden`,
            so a wider face runs off the edge instead of wrapping the card taller. */}
        <div
          aria-hidden="true"
          className={cn(
            "h-12 overflow-hidden px-4 py-4 leading-none",
            MIRROR_SPACE,
            MIRROR_INVERT,
            sampleFace.className,
          )}
          style={sampleFace.style}
        >
          <div
            className="overflow-hidden whitespace-pre font-mono"
            style={{ fontSize: `${prefs.fontSize}px`, lineHeight: "16px" }}
          >
            {SAMPLE}
          </div>
        </div>
      </div>
    </Card>
  );
}
