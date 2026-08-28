import type { ReactNode } from "react";
import { AArrowDown, AArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { FONT_MAX, FONT_MIN } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// The mirror's display prefs, as LABELLED rows behind the composer's ⚙ toggle.
//
// These used to be a permanent icon-only "View" row above the Controls row — five 28px glyphs that
// cost a whole row of a phone viewport for settings you touch once and then never again. Worse, the
// raw-terminal toggle was a bare `>_` icon whose only explanation was a `title` attribute no phone
// ever shows; nobody could tell what it did. Behind the ⚙ each pref gets a real name and, where it
// isn't self-evident, a sentence.
//
// It rides the same in-flow ComposerDock as Keys/Quick rather than a covering sheet, deliberately:
// every control here changes how the mirror LOOKS, so you have to be able to see the mirror while
// you flip it.

interface DisplayPrefsContentProps {
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
}

// One settings row: name (+ optional explanation) on the left, control on the right. Module-level so
// it isn't a fresh component type each render.
function Row({
  label,
  hint,
  htmlFor,
  control,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function DisplayPrefsContent({
  prefs,
  setWrap,
  stepFontSize,
  setRawTerminal,
  setTapToFocus,
}: DisplayPrefsContentProps) {
  useLocale();
  return (
    <div className="divide-y divide-border border-t border-rule bg-muted/30 px-3 py-1">
      <Row
        label={t("settings.display.wrap.label")}
        hint={t("settings.display.wrap.hint")}
        htmlFor="pref-wrap"
        control={
          <Switch
            id="pref-wrap"
            checked={prefs.wrap}
            onCheckedChange={setWrap}
            aria-label={t("settings.display.wrap.label")}
          />
        }
      />
      <Row
        label={t("settings.display.tapToType.label")}
        hint={t("settings.display.tapToType.hint")}
        htmlFor="pref-tap-to-focus"
        control={
          <Switch
            id="pref-tap-to-focus"
            checked={prefs.tapToFocus}
            onCheckedChange={setTapToFocus}
            aria-label={t("settings.display.tapToType.label")}
          />
        }
      />
      <Row
        label={t("settings.display.rawTerminal.label")}
        hint={t("settings.display.rawTerminal.hint")}
        htmlFor="pref-raw"
        control={
          <Switch
            id="pref-raw"
            checked={prefs.rawTerminal}
            onCheckedChange={setRawTerminal}
            aria-label={t("settings.display.rawTerminal.label")}
          />
        }
      />
      <Row
        label={t("settings.display.textSize.label")}
        control={
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={prefs.fontSize <= FONT_MIN}
              onClick={() => stepFontSize(-1)}
              aria-label={t("settings.display.textSize.decrease")}
            >
              <AArrowDown className="size-4" />
            </Button>
            <span className="w-8 text-center font-mono text-xs tabular-nums text-muted-foreground">
              {prefs.fontSize}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={prefs.fontSize >= FONT_MAX}
              onClick={() => stepFontSize(1)}
              aria-label={t("settings.display.textSize.increase")}
            >
              <AArrowUp className="size-4" />
            </Button>
          </div>
        }
      />
    </div>
  );
}
