import { useLayoutEffect, useRef } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { CollieMark } from "@/components/collie-mark";
import type { HandoverPhase } from "@/hooks/use-handover";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ── A PANE JUST BECAME AN AGENT PANE ────────────────────────────────────────────────────────────
//
// You are looking at a bare shell on your phone. You type `opencode` at your desk. This is what the
// phone does about it: the Collie mark flies out of the header's own mark, blooms at the centre of
// the mirror, and hands the pane over to the agent's mark, which rises in its place.
//
// IT IS ONE SEQUENCE WITH THE BODY SWAP. The mark flies in and rests at the centre (covering, then
// covered); the pane's body may change from the terminal to Chat only at that rest, under the
// cover; then the mark goes home and the agent's mark rises (revealing). The rest is a fixed dwell
// and waits for nothing else: the body is decided at once (lib/chat-gate.ts), so the reveal uncovers
// the body that stays.
//
// IT MARKS A FACT, IT DOES NOT PREDICT ONE. The poll finds the change up to one interval late, so
// the agent is already running by the time this plays. There is no bar, no percentage and no word
// that implies waiting. It is punctuation.
//
// ── THREE RULES IT IS BUILT ON ───────────────────────────────────────────────
//
// 1. THE PANE NEVER MOVES. This is one absolutely positioned layer over the content region, which
//    is already `relative` for zen's exit button. Nothing here is in the pane's flow, so nothing
//    here can reflow it (DESIGN.md §2). The mark grows by `scale`, inside the layer.
//
// 2. NO ANIMATION IS LOAD-BEARING, AND NO TIMER IS THIS FILE'S. The layer draws the phase it is
//    handed (hooks/use-handover.ts: covering, covered, revealing) and reports two animation events
//    back, the end of the covering flight and the end of the last fade. The hook runs a timer for
//    every phase as well, because a killed animation never fires `animationend`: under
//    `prefers-reduced-motion` this draws its message as a still picture, and the timers alone move
//    it on. A different render and not a stripped one.
//
// 3. THE FLIGHT IS MEASURED, NOT WRITTEN DOWN. The header is the app shell's, mounted above the
//    outlet, so the mark's position depends on the strip band, the notch and the header's own
//    height. `--as-dx/--as-dy` are read off the real element on mount; the fallback is the layer's
//    own top-left, which is where the header sits anyway.

/** The size the travelling mark grows to at the centre. */
const MARK = 84;

const STYLE = `
@keyframes as-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes as-out { from { opacity: 1 } to { opacity: 0 } }
/* The veil's own leaving. A name of its own, so its end is the one event that says the layer is done
   (the icon and the word reuse as-out and must not be taken for it). */
@keyframes as-veil-out { from { opacity: 1 } to { opacity: 0 } }
@keyframes as-pop {
  from { opacity: 0; transform: scale(0.82) }
  to { opacity: 1; transform: scale(1) }
}
@keyframes as-rise {
  from { opacity: 0; transform: translateY(6px) }
  to { opacity: 1; transform: translateY(0) }
}
/* The flight. --as-dx/--as-dy are the header mark's offset from the layer's centre, measured on
   mount; --as-s is that mark's size over this one's, so it leaves at exactly the size it had. */
@keyframes as-go {
  from {
    opacity: 0.85;
    transform: translate(-50%, -50%) translate(var(--as-dx, 0px), var(--as-dy, 0px)) scale(var(--as-s, 0.3));
  }
  to { opacity: 1; transform: translate(-50%, -50%) translate(0px, 0px) scale(1) }
}
@keyframes as-back {
  from { opacity: 1; transform: translate(-50%, -50%) translate(0px, 0px) scale(1) }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) translate(var(--as-dx, 0px), var(--as-dy, 0px)) scale(var(--as-s, 0.3));
  }
}
/* COVERING and COVERED: the veil is in, the mark has flown to the centre and RESTS there (fill-mode
   both keeps its last frame for the dwell, while the body swaps under it). The reveal below
   adds its animations to these lists; the ones already running keep running, they do not restart. */
.as-veil { animation: as-in 150ms ease-out both; }
.as-mark {
  transform: translate(-50%, -50%);
  animation: as-go 380ms cubic-bezier(0.3, 0.8, 0.35, 1) both;
}
.as-icon, .as-word { opacity: 0; }
/* REVEALING: 640 ms from here, which is where the old 1400 ms run spent its last 640. */
.as-layer[data-phase="revealing"] .as-veil {
  animation: as-in 150ms ease-out both, as-veil-out 220ms 420ms ease-in forwards;
}
.as-layer[data-phase="revealing"] .as-mark {
  animation:
    as-go 380ms cubic-bezier(0.3, 0.8, 0.35, 1) both,
    as-back 380ms cubic-bezier(0.4, 0, 0.6, 1) forwards;
}
.as-layer[data-phase="revealing"] .as-icon {
  animation: as-pop 300ms cubic-bezier(0.2, 0.9, 0.3, 1) both, as-out 180ms 460ms ease-in forwards;
}
.as-layer[data-phase="revealing"] .as-word {
  animation: as-rise 240ms 120ms ease-out both, as-out 180ms 460ms ease-in forwards;
}

@media (prefers-reduced-motion: reduce) {
  .as-layer,
  .as-layer * {
    animation: none !important;
    transition: none !important;
  }
}
`;

/** Where the header's mark is, relative to `el`'s centre, and how big it is against {@link MARK}. */
function aimAtHeaderMark(el: HTMLElement): void {
  const box = el.getBoundingClientRect();
  const slot = document.querySelector("header [data-slot='collie-mark']");
  // The slot is the mark's 44px tap box (DESIGN.md §6); the drawing inside it is smaller. Measure
  // the `<svg>` where there is one, so the mark leaves at the size it is actually drawn at.
  const mark = slot?.querySelector("svg") ?? slot;
  // No header mark on screen (zen hides the row) — leave the layer's own top-left corner instead,
  // which is where the header would be. The move still reads as coming from up there.
  const from =
    mark === null
      ? { x: box.left + 38, y: box.top, size: 40 }
      : (() => {
          const r = mark.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width || 40 };
        })();
  el.style.setProperty("--as-dx", `${from.x - (box.left + box.width / 2)}px`);
  el.style.setProperty("--as-dy", `${from.y - (box.top + box.height / 2)}px`);
  el.style.setProperty("--as-s", String(from.size / MARK));
}

export function AgentStart({
  harness,
  phase,
  calm,
  onCovered,
  onFinish,
}: {
  harness: string;
  /** Where the sequence is (hooks/use-handover.ts). The layer draws it and decides nothing. */
  phase: HandoverPhase;
  /** The still-picture version, fixed when the sequence began. */
  calm: boolean;
  /** The covering flight ended. */
  onCovered: () => void;
  /** The last fade ended, or a tap: the layer can go. */
  onFinish: () => void;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    aimAtHeaderMark(el);
  }, []);

  const label = t("pane.agentStart.handed", { agent: harness });

  return (
    <div
      ref={ref}
      data-phase={phase}
      // A tap anywhere ends it at once, wherever the sequence is. The mirror is what the person came
      // for, and an announcement that cannot be dismissed is in the way by definition. The hook
      // applies a held body swap in the same commit.
      onPointerDown={onFinish}
      // The two events that are one clock with the picture. The hook's timers are the guarantee
      // for the case where they never come.
      onAnimationEnd={(e) => {
        if (e.animationName === "as-go") onCovered();
        if (e.animationName === "as-veil-out") onFinish();
      }}
      role="status"
      aria-label={label}
      className="as-layer absolute inset-0 z-20 overflow-hidden"
    >
      <style>{STYLE}</style>
      {calm ? (
        // The same sentence as a still picture: both marks side by side, and what happened. Nothing
        // here depends on a keyframe having run, so nothing can be left mid-fade.
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/82">
          <div className="flex items-center gap-4">
            <CollieMark size={44} weight="header" loading paper="var(--background)" />
            <AgentIcon agent={harness} className="size-11" />
          </div>
          <span className="text-sm text-foreground">{label}</span>
        </div>
      ) : (
        <>
          <div className="as-veil absolute inset-0 bg-background/82" />
          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3">
            <AgentIcon agent={harness} className={cn("as-icon size-14")} />
            <span className="as-word whitespace-nowrap text-sm text-foreground">{label}</span>
          </div>
          <div className="as-mark absolute left-1/2 top-1/2">
            <CollieMark size={MARK} loading paper="var(--background)" />
          </div>
        </>
      )}
    </div>
  );
}
