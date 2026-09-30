import type { ReactNode } from "react";
import { AArrowDown, AArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, FONT_MAX, FONT_MIN } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { PaneView } from "@/lib/pane-view";
import { cn } from "@/lib/utils";

// The pane body's display prefs, as LABELLED rows behind the composer's ⚙ toggle.
//
// These used to be a permanent icon-only "View" row above the Controls row — five 28px glyphs that
// cost a whole row of a phone viewport for settings you touch once and then never again. Worse, the
// raw-terminal toggle was a bare `>_` icon whose only explanation was a `title` attribute no phone
// ever shows; nobody could tell what it did. Behind the ⚙ each pref gets a real name and, where it
// isn't self-evident, a sentence.
//
// It rides the same in-flow ComposerDock as Keys/Quick rather than a covering sheet, deliberately:
// every control here changes how the pane LOOKS, so you have to be able to see it while you flip it.
//
// ── IT ANSWERS FOR THE BODY YOU ARE LOOKING AT (M41) ────────────────────────
// A pane has two bodies now, and five of the six rows below are about the terminal mirror alone: a
// wrap, a raw-terminal escape hatch, an inversion override. Drawn over a Chat stream they were six
// controls of which one did anything, with no way to tell which. So the dock takes the pane's view
// and draws the rows that ANSWER for it, with the switch between the two at the top — the same
// value the pane's ⋮ menu writes, in the place a reader already opens to change how a pane looks.
//
// Text size comes FIRST in both, and it is the one row that exists in both. It was last, under five
// switches, so on a short viewport the one control an operator reaches for by eyesight was the one
// they had to scroll a dock to find.

/**
 * The Chat side of this dock, when this device has opted into the experiment.
 *
 * Absent means Chat is off (Settings → Experiments) and the dock says nothing about it: no switch,
 * no rows, exactly the dock that shipped before Chat existed.
 */
export interface PaneViewControl {
  /** The standing choice this device holds, and what the segmented control writes. */
  chosen: PaneView;
  /** What this pane is actually DRAWING. Differs from {@link chosen} on a pane with no journal. */
  showing: PaneView;
  /** Write the standing choice. The pane's ⋮ menu writes the same value. */
  onChange: (view: PaneView) => void;
  /** Why THIS pane keeps the terminal, when it must. Set means Chat cannot be chosen here. */
  note?: string;
  /** Whether the stream draws the agent's tool calls. Settings → Appearance writes the same value. */
  showToolCalls: boolean;
  setShowToolCalls: (on: boolean) => void;
  /** The stream's own text size in px, and its stepper. Its own number, never the mirror's. */
  chatFontSize: number;
  stepChatFontSize: (delta: number) => void;
}

interface DisplayPrefsContentProps {
  prefs: DisplayPrefs;
  setWrap: (wrap: boolean) => void;
  stepFontSize: (delta: number) => void;
  setRawTerminal: (raw: boolean) => void;
  setTapToFocus: (tapToFocus: boolean) => void;
  /** Effective native rendering for THIS pane: the agent bit from .adr/0047 as overridden by the
   *  operator (lib/mirror-invert.ts). */
  mirrorNative: boolean;
  /** Choose native rendering for this pane. Setting it back to the agent's own answer clears the
   *  override rather than pinning it, so a later change to that answer is still followed. */
  setMirrorNative: (native: boolean) => void;
  setExpandClippedReply: (expandClippedReply: boolean) => void;
  /** The body switch and the Chat rows. Absent while the experiment is off. */
  paneView?: PaneViewControl;
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

/** A minus / number / plus stepper. One component, because the mirror and the stream both want one
 *  and they differ only in which number they are stepping and where it stops. */
function TextSizeRow({
  size,
  min,
  max,
  step,
  hint,
}: {
  size: number;
  min: number;
  max: number;
  step: (delta: number) => void;
  hint?: string;
}) {
  return (
    <Row
      label={t("settings.display.textSize.label")}
      hint={hint}
      control={
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={size <= min}
            onClick={() => step(-1)}
            aria-label={t("settings.display.textSize.decrease")}
          >
            <AArrowDown className="size-4" />
          </Button>
          <span className="w-8 text-center text-xs tabular-nums text-muted-foreground">{size}</span>
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={size >= max}
            onClick={() => step(1)}
            aria-label={t("settings.display.textSize.increase")}
          >
            <AArrowUp className="size-4" />
          </Button>
        </div>
      }
    />
  );
}

/**
 * Which body this pane draws: the app's segmented three-way in its two-way form (theme-control.tsx,
 * belt-size-control.tsx), so a choice between named alternatives looks the same everywhere.
 *
 * The Chat segment goes DISABLED rather than missing on a pane with no session log, and the reason
 * is spelled out under it. A control that disappears on some panes is how an operator concludes the
 * app is broken.
 */
function ViewRow({ view }: { view: PaneViewControl }) {
  const options: { value: PaneView; label: string }[] = [
    { value: "terminal", label: t("chat.mode.option.terminal") },
    { value: "chat", label: t("chat.mode.option.chat") },
  ];
  return (
    <div className="py-1.5">
      <div className="mb-1.5 text-sm font-medium">{t("chat.mode.view.label")}</div>
      <div role="radiogroup" aria-label={t("chat.mode.view.label")} className="flex gap-1">
        {options.map((option) => {
          const selected = option.value === view.chosen;
          const blocked = option.value === "chat" && view.note !== undefined;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={blocked}
              onClick={() => view.onChange(option.value)}
              className={cn(
                "flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                "disabled:opacity-50",
                selected
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground active:bg-muted",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {view.note !== undefined && (
        <p className="mt-1 text-xs leading-snug text-muted-foreground">{view.note}</p>
      )}
    </div>
  );
}

export function DisplayPrefsContent({
  prefs,
  setWrap,
  stepFontSize,
  setRawTerminal,
  setTapToFocus,
  mirrorNative,
  setMirrorNative,
  setExpandClippedReply,
  paneView,
}: DisplayPrefsContentProps) {
  useLocale();
  // What is on screen, not what was chosen: a pane with no journal holds `chat` and draws the
  // terminal, and the rows must answer for the terminal it is actually drawing.
  const chat = paneView?.showing === "chat";
  return (
    <div className="divide-y divide-border border-t border-rule bg-muted/30 px-3 py-1">
      {paneView && <ViewRow view={paneView} />}
      {chat && paneView ? (
        <>
          <TextSizeRow
            size={paneView.chatFontSize}
            min={CHAT_FONT_MIN}
            max={CHAT_FONT_MAX}
            step={paneView.stepChatFontSize}
          />
          <Row
            label={t("settings.tools.title")}
            hint={t("settings.tools.description")}
            htmlFor="pref-tool-calls"
            control={
              <Switch
                id="pref-tool-calls"
                checked={paneView.showToolCalls}
                onCheckedChange={paneView.setShowToolCalls}
                aria-label={t("settings.tools.title")}
              />
            }
          />
        </>
      ) : (
        <>
          <TextSizeRow size={prefs.fontSize} min={FONT_MIN} max={FONT_MAX} step={stepFontSize} />
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
            label={t("settings.display.fullReply.label")}
            hint={t("settings.display.fullReply.hint")}
            htmlFor="pref-expand-clipped-reply"
            control={
              <Switch
                id="pref-expand-clipped-reply"
                checked={prefs.expandClippedReply}
                onCheckedChange={setExpandClippedReply}
                aria-label={t("settings.display.fullReply.label")}
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
            label={t("settings.display.noInvert.label")}
            hint={t("settings.display.noInvert.hint")}
            htmlFor="pref-no-invert"
            control={
              <Switch
                id="pref-no-invert"
                checked={mirrorNative}
                onCheckedChange={setMirrorNative}
                aria-label={t("settings.display.noInvert.label")}
              />
            }
          />
        </>
      )}
    </div>
  );
}
