import { ChevronDown, Sigma } from "lucide-react";

import { Card } from "@/components/ui/card";
import { MATH_ENGINES, isMathEngine, mathEngineOf, setDesignMath, useDesignPrefs, type MathEngine } from "@/lib/design";
import { loadMathEngine } from "@/lib/math/engine";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// The Math card — which engine typesets LaTeX in Markdown, per device. Off is the default, and Off
// is exactly the app before math existed: `$` is a dollar and no engine is downloaded.
//
// Built like the Typeface card, for its reasons: a set-once preference, so a native <select>, and a
// note line under it that is always one line, so choosing never changes the card's height.
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
          <div className="relative shrink-0">
            <select
              id="pref-math"
              value={engine}
              // A DOM value is a plain string, so it is parsed back here rather than asserted. The
              // engine starts loading on the change, so Chat finds it ready.
              onChange={(event) => {
                const next = event.target.value;
                if (!isMathEngine(next)) return;
                setDesignMath(next);
                void loadMathEngine(next);
              }}
              className="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pl-3 pr-9 text-sm font-medium text-foreground"
            >
              {MATH_ENGINES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice === "off" ? t("settings.math.off") : ENGINE_LABELS[choice]}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>
        <p className="px-4 py-2.5 text-xs text-muted-foreground">{t(NOTE_KEYS[engine])}</p>
      </div>
    </Card>
  );
}
