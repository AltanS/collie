// The step player of the tricks explainer. An animation explains ONE idea as numbered steps: it plays
// slowly once it scrolls into view, stops at the end, and replays on a tap. Each numbered step is a
// button, so a reader can stay on one step. Under reduced motion (the system setting, or the
// playground's own switch) nothing plays: the drawing shows its last step and every step is listed.
// No keyframes: the drawing changes by state, and Tailwind transitions soften it.
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { HUE_BG, HUE_BORDER, HUE_TEXT, type Hue } from "./hues";
import { useStill } from "./motion";

/** How long one step stays on screen. Calm: long enough to read the step and look at the drawing. */
export const STEP_MS = 3600;

export interface Step {
  readonly hue: Hue;
  readonly text: ReactNode;
}

/** True once the element has been half in view. */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || seen) return;
    if (!("IntersectionObserver" in window)) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/**
 * One animation. `children` draws the picture for a step (0-based); `all` is true when the reader sees
 * every step at once (reduced motion), and the picture then shows the whole story.
 */
export function Steps({
  label,
  steps,
  children,
  renderAside,
}: {
  label: string;
  steps: readonly Step[];
  children: (step: number, all: boolean) => ReactNode;
  /** Something beside the drawing that follows the step too (a real card, a phone). */
  renderAside?: (step: number, all: boolean) => ReactNode;
}) {
  const still = useStill();
  const box = useRef<HTMLDivElement>(null);
  const seen = useSeen(box);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = steps.length - 1;

  // Start once, when first seen.
  useEffect(() => {
    if (seen && !still) setPlaying(true);
  }, [seen, still]);

  useEffect(() => {
    if (!playing || still) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const id = window.setTimeout(() => setStep((s) => Math.min(s + 1, last)), STEP_MS);
    return () => window.clearTimeout(id);
  }, [playing, step, last, still]);

  const shown = still ? last : step;
  const all = still;

  return (
    <figure ref={box} aria-label={label} className="min-w-0 space-y-4">
      <div className="min-w-0">{children(shown, all)}</div>
      <div className={cn("grid min-w-0 grid-cols-1 gap-4", renderAside !== undefined && "lg:grid-cols-[minmax(0,1fr)_minmax(0,390px)] lg:items-start")}>
        <figcaption className="min-w-0">
          <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {still ? "Every step, in order." : playing ? `Step ${shown + 1} of ${steps.length}. Tap a step to stay on it.` : `Step ${shown + 1} of ${steps.length}. Tap a step to see it.`}
            </p>
            {!still && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 px-3 text-sm"
                onClick={() => {
                  setStep(0);
                  setPlaying(true);
                }}
              >
                <Icon name="restore" />
                Replay
              </Button>
            )}
          </div>
          <ol className="grid grid-cols-1 gap-1">
            {steps.map((s, i) => {
              const current = !all && i === shown;
              const done = all || i <= shown;
              return (
                <li key={i}>
                  <button
                    type="button"
                    aria-current={current ? "step" : undefined}
                    onClick={() => {
                      setPlaying(false);
                      setStep(i);
                    }}
                    className={cn(
                      "flex min-h-11 w-full items-start gap-3 rounded-sm border px-3 py-2 text-left text-sm leading-snug transition-colors duration-500 motion-reduce:transition-none",
                      current ? HUE_BORDER[s.hue] : "border-transparent",
                      current ? "bg-card" : "hover:bg-muted",
                      !done && "text-muted-foreground",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] font-semibold transition-colors duration-500 motion-reduce:transition-none",
                        HUE_BORDER[s.hue],
                        current ? cn(HUE_BG[s.hue], "text-background") : HUE_TEXT[s.hue],
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 pt-0.5">{s.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </figcaption>
        {renderAside !== undefined && <div className="min-w-0">{renderAside(shown, all)}</div>}
      </div>
    </figure>
  );
}
