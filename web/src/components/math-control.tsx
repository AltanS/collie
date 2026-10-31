import { Sigma } from "lucide-react";

import { Card } from "@/components/ui/card";
import { OneOf } from "@/components/ui/one-of";
import { Select } from "@/components/ui/select";
import { MATH_ENGINES, isMathEngine, mathEngineOf, setDesignMath, useDesignPrefs, type MathEngine } from "@/lib/design";
import { loadMathEngine } from "@/lib/math/engine";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// The Math card — which engine typesets LaTeX in Markdown, per device. Off is the default, and Off
// is exactly the app before math existed: `$` is a dollar and no engine is downloaded.
//
// Laid out like the Typeface card: a set-once preference in a native select (`ui/select.tsx`), and
// a note under it. The three notes share one cell (`ui/one-of.tsx`), so the card is as tall as the
// longest note in this locale and choosing never changes its height (DESIGN.md §2).
//
// ENGINE NAMES ARE PROPER NOUNS and are not translated; "Off" and the notes are phrases and go
// through the dictionary.

const ENGINE_LABELS = { katex: "KaTeX", mathjax: "MathJax" } satisfies Record<Exclude<MathEngine, "off">, string>;

const NOTE_KEYS = {
  off: "settings.math.note.off",
  katex: "settings.math.note.katex",
  mathjax: "settings.math.note.mathjax",
} as const satisfies Record<MathEngine, `settings.math.note.${string}`>;

/** Settings card: the math engine. Device-local, like the typeface. */
export function MathControl() {
  useLocale();
  const engine = mathEngineOf(useDesignPrefs());

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Sigma className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.math.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.math.description")}</p>
          </div>
        </div>
      </div>

      <div data-slot="list-group" className="border-t border-border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label htmlFor="pref-math" className="text-sm font-medium">
            {t("settings.math.engine")}
          </label>
          <Select
            id="pref-math"
            className="shrink-0"
            value={engine}
            // A DOM value is a plain string, so it is parsed back here rather than asserted. The
            // engine starts loading on the change, so Chat finds it ready.
            onChange={(event) => {
              const next = event.target.value;
              if (!isMathEngine(next)) return;
              setDesignMath(next);
              void loadMathEngine(next);
            }}
          >
            {MATH_ENGINES.map((choice) => (
              <option key={choice} value={choice}>
                {choice === "off" ? t("settings.math.off") : ENGINE_LABELS[choice]}
              </option>
            ))}
          </Select>
        </div>
        <OneOf
          className="px-4 py-2.5"
          active={engine}
          options={MATH_ENGINES.map((choice) => ({
            key: choice,
            node: <p className="text-xs text-muted-foreground">{t(NOTE_KEYS[choice])}</p>,
          }))}
        />
      </div>
    </Card>
  );
}
