// The Typeface card: the APP's own face, per device (ADR 0033). Port of web/'s TypefaceControl. The
// chosen face dresses chrome and never an agent's words: nothing here touches --font-mono or
// --font-content. A native <select> for the reasons LanguageControl gives; family names are proper
// nouns and are not translated, the note under the select is a phrase and is.
//
// ALSO OWNS THE PAINTING. web/ applies the stored face at boot (`initDesign`) and the operator's
// faces when /api/config lands (`loadOperatorCommands`); here both run from the two stores, once, for
// the page's life: the stored choice sets the `font-*` class on <html> (index.css turns it into
// `--font-sans`), and the validated operator rows become the one injected <style> element.
import { on, type Handle } from "remix/component";
import { CaseSensitive, ChevronDown } from "lucide";

import { applyFontClass, SHIPPED_FONTS } from "@web/lib/design";
import { t } from "@web/lib/i18n";
import { applyOperatorFonts, operatorFontValue, type OperatorFontFace } from "@web/lib/operator-fonts";

import { config } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { designPrefs } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { CardHead } from "./parts";
import { acceptedFaces, noteKey, pickedDesign, shownFont } from "./typeface-model";

let faces: readonly OperatorFontFace[] = [];

/** The operator's validated faces: the same array until the rows change. */
function operatorFaces(): readonly OperatorFontFace[] {
  faces = acceptedFaces(config.get().data?.operatorFonts, faces);
  return faces;
}

function paint(): void {
  const { font } = designPrefs.get();
  applyFontClass(font);
  applyOperatorFonts(operatorFaces(), font);
}

// App-lifetime subscriptions, like `startPrefSync`: the face is the document's, not a component's.
// Browser only: the bridge imports this module to render documents (S1), where a primed store must
// paint nothing.
if ("document" in globalThis) {
  designPrefs.subscribe(paint);
  config.subscribe(paint);
  paint();
}

/** The shipped faces' display names. Untranslated, and typed so a new key cannot skip one. */
const FAMILY_LABELS = {
  grotesk: "Space Grotesk",
  aldrich: "Aldrich",
} satisfies Record<Exclude<(typeof SHIPPED_FONTS)[number], "system">, string>;

export function TypefaceControl(handle: Handle) {
  const read = useStore(handle, designPrefs);
  useStore(handle, config);
  useLocale(handle);
  return () => {
    const available = operatorFaces();
    const chosen = shownFont(read().font, available);
    return (
      <Card class="gap-0 py-0" data-testid="typeface-card">
        <CardHead icon={CaseSensitive} title={t("settings.typeface.title")} description={t("settings.typeface.description")} />
        <div class="divide-y divide-border border-t border-border">
          <div class="flex items-center justify-between gap-4 px-4 py-3">
            <label for="pref-typeface" class="text-sm font-medium">
              {t("settings.typeface.family")}
            </label>
            <div class="relative shrink-0">
              <select
                id="pref-typeface"
                data-testid="typeface-select"
                class="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pr-9 pl-3 text-sm font-medium text-foreground"
                mix={on("change", (event) => {
                  const next = pickedDesign(event.currentTarget.value, operatorFaces());
                  if (next !== null) designPrefs.set(next);
                })}
              >
                {SHIPPED_FONTS.map((font) => (
                  <option key={font} value={font} selected={font === chosen}>
                    {font === "system" ? t("settings.typeface.system") : FAMILY_LABELS[font]}
                  </option>
                ))}
                {/* The operator's faces UNDER the shipped ones: they add to the list, never replace it. */}
                {available.map((face) => (
                  <option key={face.basename} value={operatorFontValue(face)} selected={operatorFontValue(face) === chosen}>
                    {face.family}
                  </option>
                ))}
              </select>
              <Icon
                icon={ChevronDown}
                class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </div>
          {/* One line per choice, always present, so a pick never changes the card's height. */}
          <p class="px-4 py-2.5 text-xs text-muted-foreground">{t(noteKey(chosen))}</p>
        </div>
      </Card>
    );
  };
}
