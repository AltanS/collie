// The Terminal font card: the mirror's face and size, and the composer draft field's size. Port of
// web/'s FontSettingsControl over the `displayPrefs` store (`collie:display-prefs:v4`). It is NOT the
// app's own typeface (the card above it). The sample line is one line OF the mirror, in the mirror's
// own dark space, so what you read here is what the pane renders. The chat text size lives in the
// pane's Display dock in web/, not here.
import { on, type Handle } from "remix/component";
import { AArrowDown, AArrowUp, ChevronDown, Type } from "lucide";

import { MIRROR_INVERT, MIRROR_SPACE } from "@web/components/mirror-space";
import {
  DRAFT_FONT_MAX,
  DRAFT_FONT_MIN,
  FONT_FAMILIES,
  FONT_MAX,
  FONT_MIN,
  isFontFamily,
  mirrorFont,
  type FontFamily,
} from "@web/hooks/use-display-prefs";
import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { displayPrefs } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { CardHead } from "./parts";

// Family names are proper nouns and are not translated; only "System default" has a key.
const FAMILY_LABELS = {
  jetbrains: "JetBrains Mono",
  cascadia: "Cascadia Mono",
  menlo: "Menlo / SF Mono",
  roboto: "Roboto Mono",
  dejavu: "DejaVu Sans Mono",
  courier: "Courier New",
} satisfies Record<Exclude<FontFamily, "system">, string>;

// The shapes a monospace face is judged on: a prompt, 0/O and 1/l/I, a box-drawing run.
const SAMPLE = "~/collie  0O1lI │ ok";

const clamp = (lo: number, hi: number, n: number): number => Math.max(lo, Math.min(hi, n));

interface StepperProps {
  value: number;
  min: number;
  max: number;
  decrease: string;
  increase: string;
  onStep: (delta: number) => void;
}

/** 44 px buttons and a fixed tabular slot, so the number never resizes its own box as it steps. */
function Stepper(handle: Handle<StepperProps>) {
  return () => {
    const { value, min, max, decrease, increase } = handle.props;
    return (
      <div class="flex shrink-0 items-center gap-1">
        <Button variant="outline" size="icon" class="size-11" disabled={value <= min} aria-label={decrease} mix={on("click", () => handle.props.onStep(-1))}>
          <Icon icon={AArrowDown} class="size-4" />
        </Button>
        <span class="w-8 text-center text-xs text-muted-foreground tabular-nums" data-testid="stepper-value">
          {value}
        </span>
        <Button variant="outline" size="icon" class="size-11" disabled={value >= max} aria-label={increase} mix={on("click", () => handle.props.onStep(1))}>
          <Icon icon={AArrowUp} class="size-4" />
        </Button>
      </div>
    );
  };
}

export function FontSettingsControl(handle: Handle) {
  const read = useStore(handle, displayPrefs);
  useLocale(handle);
  return () => {
    const prefs = read();
    const sample = mirrorFont(prefs.fontFamily);
    return (
      <Card class="gap-0 py-0" data-testid="terminal-font-card">
        <CardHead icon={Type} title={t("settings.fonts.title")} description={t("settings.fonts.description")} />
        <div class="divide-y divide-border border-t border-border">
          <div class="flex items-center justify-between gap-4 px-4 py-3">
            <label for="pref-font-family" class="text-sm font-medium">
              {t("settings.fonts.family")}
            </label>
            <div class="relative shrink-0">
              <select
                id="pref-font-family"
                data-testid="terminal-font-select"
                class="min-h-11 appearance-none rounded-md border border-border/60 bg-background py-2 pr-9 pl-3 text-sm font-medium text-foreground"
                mix={on("change", (event) => {
                  const next = event.currentTarget.value;
                  if (isFontFamily(next)) displayPrefs.update((p) => ({ ...p, fontFamily: next }));
                })}
              >
                {FONT_FAMILIES.map((family) => (
                  <option key={family} value={family} selected={family === prefs.fontFamily}>
                    {family === "system" ? t("settings.fonts.system") : FAMILY_LABELS[family]}
                  </option>
                ))}
              </select>
              <Icon
                icon={ChevronDown}
                class="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
            </div>
          </div>

          <div class="flex items-center justify-between gap-4 px-4 py-3">
            <div class="text-sm font-medium">{t("settings.fonts.size")}</div>
            <Stepper
              value={prefs.fontSize}
              min={FONT_MIN}
              max={FONT_MAX}
              decrease={t("settings.display.textSize.decrease")}
              increase={t("settings.display.textSize.increase")}
              onStep={(delta) => displayPrefs.update((p) => ({ ...p, fontSize: clamp(FONT_MIN, FONT_MAX, p.fontSize + delta) }))}
            />
          </div>

          {/* The draft field is not the mirror: its own size, and a hint, because on iOS the lower
              half of the range does nothing (Safari zooms into a smaller focused field). */}
          <div class="flex items-start justify-between gap-4 px-4 py-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">{t("settings.fonts.draftSize")}</div>
              <p class="mt-0.5 text-xs leading-snug text-muted-foreground">{t("settings.fonts.draftSize.hint")}</p>
            </div>
            <Stepper
              value={prefs.draftFontSize}
              min={DRAFT_FONT_MIN}
              max={DRAFT_FONT_MAX}
              decrease={t("settings.fonts.draftSize.decrease")}
              increase={t("settings.fonts.draftSize.increase")}
              onStep={(delta) =>
                displayPrefs.update((p) => ({ ...p, draftFontSize: clamp(DRAFT_FONT_MIN, DRAFT_FONT_MAX, p.draftFontSize + delta) }))
              }
            />
          </div>

          {/* No layout shift: a fixed 16 px line box, `whitespace-pre overflow-hidden`. */}
          <div aria-hidden="true" class={cn("h-12 overflow-hidden px-4 py-4 leading-none", MIRROR_SPACE, MIRROR_INVERT, sample.className)} style={sample.style?.fontFamily === undefined ? undefined : { fontFamily: sample.style.fontFamily }}>
            <div class="overflow-hidden font-mono whitespace-pre" style={{ fontSize: `${String(prefs.fontSize)}px`, lineHeight: "16px" }}>
              {SAMPLE}
            </div>
          </div>
        </div>
      </Card>
    );
  };
}
