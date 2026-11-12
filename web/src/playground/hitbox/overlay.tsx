// THE LIVE OVERLAY: draws what a finger reaches on top of a REAL component. Children are the real thing
// (a phone frame holding the app's own route table); after they settle, `scanTargets` measures every tap
// target under them in place, and this draws two outlines for each: a SOLID one where the control is
// drawn, and a DASHED one around where `document.elementFromPoint` says it is hit. Where the dashed line
// sits outside the solid one the control reaches further than it looks (a `::before` reach); where it
// sits inside, something lies over the control or its own box is smaller than its picture.
//
// It reads the page and changes nothing in the component: the overlay layer is `pointer-events-none`,
// outside the frame's tree, and the scanner dispatches no event. DEV-ONLY, like the rest of `src/playground/`.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { CardControls } from "../layout";
import { scanTargets, type Rect, type Target } from "./scan";
import { judge, type Verdict, type VerdictTally } from "./verdict";

interface Mark {
  readonly box: Rect;
  readonly hit: Rect | null;
  readonly verdict: Verdict;
  readonly name: string;
  readonly flags: readonly string[];
}

/** Settle time after the frame changes before it is measured again: the 240ms slide and the paint after it. */
const SETTLE_MS = 700;

export function HitOverlay({ id, children }: { id: string; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<readonly Mark[]>([]);
  const [shown, setShown] = useState(true);
  const [measured, setMeasured] = useState(false);

  const measure = useCallback(() => {
    const el = wrap.current;
    // A page with no hit testing (jsdom) has nothing to measure.
    if (el === null || !("elementFromPoint" in document)) return;
    const origin = el.getBoundingClientRect();
    const result = scanTargets({ root: `[data-hb-frame="${id}"]`, scroll: false, margin: 20 });
    const rel = (r: Rect): Rect => ({ x: r.x - origin.x, y: r.y - origin.y, w: r.w, h: r.h });
    setMarks(
      result.targets
        .filter((t: Target) => t.box.w > 0 && t.box.h > 0 && t.box.x >= origin.x - 1 && t.box.y >= origin.y - 1 && t.box.x + t.box.w <= origin.x + origin.width + 1 && t.box.y + t.box.h <= origin.y + origin.height + 1 && t.box.y >= 0 && t.box.y + t.box.h <= window.innerHeight && t.pointerEvents !== "none")
        .map((t) => {
          const j = judge(t);
          return { box: rel(t.box), hit: t.hit === null ? null : rel(t.hit), verdict: j.verdict, name: t.name, flags: j.flags };
        }),
    );
    setMeasured(true);
  }, [id]);

  // Measure once the card is on screen (`elementFromPoint` answers nothing for a point off the viewport),
  // and again after the frame's tree changes (a tap that moved the screen).
  useEffect(() => {
    const el = wrap.current;
    if (el === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, SETTLE_MS);
    };
    const seen = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.3)) later();
    }, { threshold: [0.3] }) : null;
    seen?.observe(el);
    const changed = new MutationObserver(later);
    changed.observe(el, { childList: true, subtree: true });
    // A list that scrolls moves every box under its outline: draw them again once it stops.
    el.addEventListener("scroll", later, true);
    return () => {
      el.removeEventListener("scroll", later, true);
      clearTimeout(timer);
      seen?.disconnect();
      changed.disconnect();
    };
  }, [measure]);

  const counts: VerdictTally = { ok: 0, small: 0, covered: 0, shifts: 0, "dead-time": 0 };
  for (const m of marks) counts[m.verdict] += 1;
  const worst = marks.filter((m) => m.verdict !== "ok").toSorted((a, b) => b.flags.length - a.flags.length).slice(0, 4);

  return (
    <>
      <CardControls className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={() => { wrap.current?.scrollIntoView({ block: "center" }); setTimeout(measure, 350); }}>
          Measure now
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[11px]" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          {shown ? "Hide outlines" : "Show outlines"}
        </Button>
        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <i className="inline-block h-3 w-5 border border-primary" aria-hidden /> drawn
          <i className="ml-2 inline-block h-3 w-5 border-2 border-dashed border-status-blocked" aria-hidden /> reached
        </span>
      </CardControls>
      <div ref={wrap} className="relative inline-block max-w-full">
        <div data-hb-frame={id}>{children}</div>
        <div aria-hidden data-hb-skip="" className="pointer-events-none absolute inset-0 z-[70] overflow-hidden rounded-[1.75rem]">
          {shown &&
            marks.map((m, i) => (
              <div key={i}>
                <span className="absolute border border-primary" style={{ left: m.box.x, top: m.box.y, width: m.box.w, height: m.box.h }} />
                {m.hit !== null && (
                  <span
                    className={cn("absolute border-2 border-dashed", m.verdict === "covered" ? "border-status-blocked" : "border-status-blocked/80")}
                    style={{ left: m.hit.x - 2, top: m.hit.y - 2, width: m.hit.w + 4, height: m.hit.h + 4 }}
                  />
                )}
              </div>
            ))}
        </div>
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground" data-slot="hitbox-overlay-counts">
        {measured ? `${String(marks.length)} targets: ${(["ok", "small", "covered", "shifts", "dead-time"] as const).map((v) => `${String(counts[v])} ${v}`).join(", ")}` : "measuring when the card is on screen"}
      </p>
      {worst.length > 0 && (
        <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
          {worst.map((m, i) => (
            <li key={i}>
              {m.name}: {m.flags[0]}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
