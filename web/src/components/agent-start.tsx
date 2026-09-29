import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AgentIcon } from "@/components/agent-icon";
import { CollieMark } from "@/components/collie-mark";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ── A PANE JUST BECAME AN AGENT PANE ────────────────────────────────────────────────────────────
//
// You are looking at a bare shell on your phone. You type `opencode` at your desk. This is what the
// phone does about it: the Collie mark flies out of the header's own mark, blooms at the centre of
// the mirror, and hands the pane over to the agent's mark, which rises in its place.
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
// 2. NO ANIMATION IS LOAD-BEARING. `onDone` is always a TIMER, never an `animationend`. A killed
//    animation never fires one, so a variant waiting for it would leave the overlay up for good
//    under `prefers-reduced-motion`. Under reduced motion this draws its message as a still picture
//    and leaves on a short timer, which is a different render and not a stripped one.
//
// 3. THE FLIGHT IS MEASURED, NOT WRITTEN DOWN. The header is the app shell's, mounted above the
//    outlet, so the mark's position depends on the strip band, the notch and the header's own
//    height. `--as-dx/--as-dy` are read off the real element on mount; the fallback is the layer's
//    own top-left, which is where the header sits anyway.

/** The size the travelling mark grows to at the centre. */
const MARK = 84;
/** The whole run, and the short still-picture version under reduced motion. */
const RUN_MS = 1400;
const CALM_MS = 800;

const STYLE = `
@keyframes as-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes as-out { from { opacity: 1 } to { opacity: 0 } }
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
.as-veil { animation: as-in 150ms ease-out both, as-out 220ms 1180ms ease-in forwards; }
.as-mark {
  transform: translate(-50%, -50%);
  animation:
    as-go 380ms cubic-bezier(0.3, 0.8, 0.35, 1) both,
    as-back 380ms 760ms cubic-bezier(0.4, 0, 0.6, 1) forwards;
}
.as-icon { animation: as-pop 300ms 760ms cubic-bezier(0.2, 0.9, 0.3, 1) both, as-out 180ms 1220ms ease-in forwards; }
.as-word { animation: as-rise 240ms 880ms ease-out both, as-out 180ms 1220ms ease-in forwards; }

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

export function AgentStart({ harness, onDone }: { harness: string; onDone: () => void }) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [calm, setCalm] = useState(false);
  const fired = useRef(false);
  const timer = useRef<number | null>(null);

  const done = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    onDone();
  }, [onDone]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    aimAtHeaderMark(el);
    // Read the setting ONCE, on mount. A change mid-flight is not worth a second render, and the
    // still-picture branch below is what carries the message when it is on.
    // Optional-call, the spelling lib/glide.ts already uses for the same query.
    setCalm(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  }, []);

  useEffect(() => {
    timer.current = window.setTimeout(done, calm ? CALM_MS : RUN_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [calm, done]);

  const label = t("pane.agentStart.handed", { agent: harness });

  return (
    <div
      ref={ref}
      // A tap anywhere ends it at once. The mirror is what the person came for, and an announcement
      // that cannot be dismissed is in the way by definition.
      onPointerDown={done}
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
