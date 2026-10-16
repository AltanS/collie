import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Mic, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import type { Hand } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVoiceLevels } from "@/hooks/use-voice-levels";
import type { LevelSource } from "@/lib/audio-meter";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE VOICE TAKEOVER (design 3.3, picked 2026-10-11).
//
// A tap on the microphone covers the WHOLE composer chrome block, the belt and the box and the
// padding under them, with a recorder: OK where the mic was, a bin at the far end, a live equalizer
// between them, and the word and the clock above.
//
// ZERO LAYOUT SHIFT IS THE REQUIREMENT, AND THE METHOD IS ONE SENTENCE: THE TAKEOVER ADDS NOTHING TO
// THE FLOW. It is `absolute inset-0` inside the `relative` chrome block that holds the
// composer (agent-chat.tsx), so it occupies exactly the box that block already has, and the real
// composer stays laid out underneath it (`invisible` and `inert`, set by the composer), keeping its
// height. Open, recording, transcribing and close
// all leave the pane above by zero pixels, because nothing in flow ever appeared or went. The block's
// height is therefore not written down anywhere here; it is whatever the composer under it is.
//
// OK STANDS ON THE MIC'S OWN BOX. The takeover copies the composer's geometry: the same `px-3` column
// with the same bottom padding (the caller passes the string, so the two cannot drift), the same
// bordered `p-1` row, and the round `size-9` face with the same 44px reach. The row is pinned to the
// bottom, as the real box is, so OK lands on the mic and a second tap on the same spot finishes. Under
// `hand="left"` the row runs mirrored exactly as the composer's does, OK on the left.
//
// ONE MOVING THING AT A TIME at the OK button. While the clip records, the ring around OK is the
// silence countdown, closing over SILENCE_FINISH_MS (2 s) once speech has been heard. While it transcribes, the ring is
// ONE rotating arc on its own track, OK keeps its static check, dimmed and disabled, and there is no
// separate spinner. Reduced motion draws that arc as a static full ring at reduced opacity. Running
// on the phone changes only the word ("Transcribing on this phone"); it adds no second moving thing.
//
// WHEN THE PHONE ENGINE FAILS (ADR 0096 Decision 12) the takeover stays open in a fourth state, in
// the same box. The sentence takes the word's place (two lines at most, nothing grows), the bars give
// their slot to a "Send to host" button when the host can serve, and OK's spot is left empty: there is
// nothing to finish. The bin throws the clip away. Nothing is sent unless the person taps the button.

/** Bars in the equalizer. Fixed, so the slots are reserved; they thin out on a narrow phone rather than overflow. */
export const VOICE_BAR_COUNT = 36;

/** Where the clip is. `requesting` is the browser's permission prompt, still showing the takeover. */
export type VoiceTakeoverPhase = "requesting" | "recording" | "transcribing" | "failed";

export interface VoiceTakeoverProps {
  phase: VoiceTakeoverPhase;
  /** `m:ss` since the clip started. */
  elapsed: string;
  /** The audio levels, or `null` when the browser gave none: resting bars, no auto-finish. */
  source: LevelSource | null;
  /** Which thumb the composer is laid out for. */
  hand?: Hand;
  /** The composer block's bottom padding classes, so the row lands where the real box does. */
  padClassName: string;
  /** True when the transcript will be sent straight away (hands-free), so OK says so. */
  sends?: boolean;
  /** Where the clip is transcribed. `phone` changes the transcribing word to say so. */
  engine?: "host" | "phone";
  /** In the `failed` phase: the sentence. */
  failure?: string | null;
  /** In the `failed` phase: send the clip to the host. Absent when the host cannot serve, and then no button is drawn. */
  onSendToHost?: (() => void) | null;
  /** OK, and the silence countdown running out: stop and transcribe. */
  onStop: () => void;
  /** The bin, and Escape: throw the clip away and abort any transcription in flight. */
  onDiscard: () => void;
  /** Move focus onto the takeover as it opens and as the phase changes. Off only for the playground, where four sit on one page. */
  takeFocus?: boolean;
  /** The takeover was opened from the keyboard, so the focus mark shows from the start. */
  keyboardOpened?: boolean;
}

export function VoiceTakeover({
  phase,
  elapsed,
  source,
  hand = "right",
  padClassName,
  sends = false,
  engine = "host",
  failure = null,
  onSendToHost = null,
  onStop,
  onDiscard,
  takeFocus = true,
  keyboardOpened = false,
}: VoiceTakeoverProps) {
  useLocale();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const transcribing = phase === "transcribing";
  const failed = phase === "failed";
  const { barRef, levelRef, ringRef } = useVoiceLevels({
    source,
    mode: phase === "recording" ? "live" : transcribing ? "frozen" : "rest",
    count: VOICE_BAR_COUNT,
    reduced,
    onFinish: onStop,
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const binRef = useRef<HTMLButtonElement>(null);
  // Focus follows the one control that can act: OK while recording, the bin while transcribing (OK
  // is disabled then), the region itself while the permission prompt is up.
  useEffect(() => {
    if (!takeFocus) return;
    const target = phase === "recording" ? okRef.current : transcribing || failed ? binRef.current : rootRef.current;
    target?.focus({ preventScroll: true });
  }, [phase, transcribing, failed, takeFocus]);

  // THE FOCUS MARK STAYS HIDDEN UNTIL A KEY ASKS FOR IT. Focus is moved onto OK by code, and a browser
  // draws the keyboard focus mark for focus that code moved, even after a tap. The mark is a 2px
  // ring a gap outside the button, which is exactly where the countdown ring closes, so a tap
  // would open the takeover on something that reads as the countdown already running. Tab (or
  // opening from the keyboard) turns it on, so a keyboard user loses nothing.
  const [keyboard, setKeyboard] = useState(keyboardOpened);
  const onDiscardRef = useRef(onDiscard);
  onDiscardRef.current = onDiscard;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") setKeyboard(true);
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onDiscardRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A live region has to exist before its words change to be read out, so it mounts empty and is
  // filled one effect later. The visible word is `aria-hidden`: this is the one the screen reader hears.
  const label = failed
    ? (failure ?? "")
    : transcribing
      ? t(engine === "phone" ? "composer.voice.transcribingPhone" : "composer.voice.transcribing")
      : t("composer.voice.listening");
  const [spoken, setSpoken] = useState("");
  useEffect(() => setSpoken(label), [label]);

  return (
    <div
      ref={rootRef}
      role="group"
      tabIndex={-1}
      aria-label={t("composer.voice.regionAria")}
      data-slot="voice-takeover"
      className={cn(
        "absolute inset-0 z-20 flex flex-col justify-end overflow-hidden bg-chrome px-3 outline-none",
        !keyboard && "[&_button:focus-visible]:[outline-color:transparent]",
        padClassName,
      )}
    >
      <span role={failed ? "alert" : "status"} className="sr-only">
        {spoken}
      </span>
      <div aria-hidden className="flex min-h-0 flex-1 items-center justify-between gap-2 px-1 text-xs">
        {failed ? (
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-status-blocked">
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="line-clamp-2 min-w-0 leading-4">{label}</span>
          </span>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-primary">
              <Mic className={cn("size-3.5 shrink-0", !transcribing && "animate-pulse motion-reduce:animate-none")} />
              <span className="min-w-0 truncate">{label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{elapsed}</span>
          </>
        )}
      </div>
      <div
        data-slot="voice-takeover-row"
        className={cn(
          "flex items-center gap-1 rounded-xl border border-input bg-background p-1",
          // The composer's own mirror: the DOM order stays bin, bars, OK; the row runs reversed.
          hand === "left" && "flex-row-reverse",
        )}
      >
        <Button
          ref={binRef}
          size="icon"
          variant="outline"
          className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full")}
          aria-label={t("composer.mic.discardAria")}
          onClick={onDiscard}
        >
          <Trash2 className="size-4" />
        </Button>
        {failed && onSendToHost !== null && (
          <Button
            variant="outline"
            className="h-9 min-w-0 flex-1 rounded-full px-3 text-xs"
            aria-label={t("composer.voice.sendToHostAria")}
            onClick={onSendToHost}
          >
            <span className="truncate">{t("composer.voice.sendToHost")}</span>
          </Button>
        )}
        <div
          ref={levelRef}
          aria-hidden
          data-level="idle"
          className={cn(
            "group/eq flex h-9 min-w-0 flex-1 items-center justify-center gap-[3px] px-1",
            (transcribing || failed) && "opacity-30",
            failed && onSendToHost !== null && "hidden",
          )}
        >
          {Array.from({ length: VOICE_BAR_COUNT }, (_, i) => (
            <span
              key={i}
              ref={barRef(i)}
              className="block h-full min-w-px max-w-1 flex-1 origin-center rounded-sm bg-muted-foreground/40 [transform:scaleY(0.08)] group-data-[level=quiet]/eq:bg-muted-foreground/60 group-data-[level=speaking]/eq:bg-primary"
            />
          ))}
        </div>
        <div className="relative size-9 shrink-0" data-slot="voice-takeover-ok">
          {!failed && (
            <Button
              ref={okRef}
              size="icon"
              className={cn(TOOLBAR_TAP_TARGET, "size-9 rounded-full")}
              disabled={phase !== "recording"}
              aria-label={sends ? t("composer.voice.okSendAria") : t("composer.voice.okAria")}
              onClick={onStop}
            >
              <Check className="size-4" />
            </Button>
          )}
          {phase === "recording" && (
            // The countdown: empty and invisible until speech was heard and then the quiet countdown begins;
            // the hook writes its offset and opacity per frame. `pathLength` makes 100 the whole circle.
            // The wrapper takes the inset, the svg fills it: index.css pins an svg's own size to the
            // default spacing step, so a theme's `roomy` density grows this box and the ring with it.
            <span aria-hidden className="pointer-events-none absolute -inset-1.5">
              <svg
                ref={ringRef}
                aria-hidden
                viewBox="-24 -24 48 48"
                className="block size-full -rotate-90 opacity-0"
              >
                <circle r="20" fill="none" strokeWidth="2.5" className="stroke-muted" />
                <circle
                  r="20"
                  fill="none"
                  strokeWidth="2.5"
                  pathLength={100}
                  strokeDasharray={100}
                  strokeDashoffset={100}
                  className="stroke-primary"
                />
              </svg>
            </span>
          )}
          {transcribing && (
            // The single indeterminate arc, turning on the ring's own track. THE ARC TURNS INSIDE THE
            // SVG, NOT THE BOX: a rotated 48px square sweeps its corners 1 to 3px past the takeover's
            // bottom edge, and that grew the scrollable height of every scroller above it four times a
            // second, so the pane's scrollbar flashed at the right edge (Pixel, 2026-10-11). An <svg>
            // clips its own content, so a turn inside it adds nothing to anyone's overflow. Reduced
            // motion stops the turn, hides the arc and shows the whole ring at 40%.
            <span aria-hidden className="pointer-events-none absolute -inset-1.5">
              <svg aria-hidden viewBox="-24 -24 48 48" className="block size-full -rotate-90">
                <circle r="20" fill="none" strokeWidth="2.5" className="stroke-muted" />
                <circle
                  r="20"
                  fill="none"
                  strokeWidth="2.5"
                  pathLength={100}
                  strokeDasharray="28 72"
                  className="animate-spin stroke-primary motion-reduce:animate-none motion-reduce:hidden"
                />
                <circle r="20" fill="none" strokeWidth="2.5" className="hidden stroke-primary opacity-40 motion-reduce:block" />
              </svg>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
