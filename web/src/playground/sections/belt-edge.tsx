// Belt scroller edge ideas, round five. Rounds one to four settled the belt's GROUND: the band is
// `bg-foreground/6`, the scroller inside it carries `bg-primary/10`, and the fixed Switch cell sits
// on `bg-chrome` — all shipped, all unchanged here. What the operator rejects now, from the phone on
// 2026-09-14, is the FADE: the Switch block's 32px `bg-chrome` lead-in that dissolves the pills
// toward the right end, and the matching 1.5rem left fade `OverflowEdges` paints once scrolled. His
// words: "i dont like the way the 'shadow' looks that suggests the belt is scrollable... take
// another stab at this... create more variations of this layout." The tint stays. The Switch cell
// stays on chrome with its hairline. Only the edge treatment changes, per card.
//
// Rounds two and three already rejected a thumb, a track, a pattern and a plain cut edge WITHOUT the
// tint — those were tried before the tint existed, so a cut edge on top of the tint is fair game now.
// No rounded ends anywhere (a belt with rounded ends is a capsule again, rejected earlier), and never
// a thick left border on anything.
//
// STILL THE REAL ActionsRow (`components/actions-row.tsx`), inside a real 390px `PhoneMock`, the same
// fixture (`useRoomyActions`, `agent="claude"`, `onRun={took}`) belt-ground.tsx uses. Every option
// reaches the scroller and its `OverflowEdges` wrapper from OUTSIDE, through a wrapper `<div>` and a
// Tailwind arbitrary-variant selector — never a class added to `actions-row.tsx` or
// `ui/overflow-edges.tsx` themselves.
//
// THE FIXED SWITCH CELL IS DRAWN HERE, LIKE BELT-GROUND'S, AND FOR THE SAME REASON: `ActionsRow` only
// draws its pinned Switch pill when handed a real `handle`, which a static mock has none of. This
// file's own copy carries a NEW prop, `leadIn`, over belt-ground's `groundClassName` — this round is
// about the cell's lead-in fade itself, not the colour under it, so the knob that changes per card is
// the fade's shape (its width and whether it fades at all), not a flat ground swap. A `leadInGround`
// prop stands in for belt-ground's `groundClassName`, kept for option 3 alone.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Layers } from "lucide-react";

import { ActionsRow } from "@/components/actions-row";
import { STRIP_ROW_PILL } from "@/components/ui/labelled-strip";
import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

import { Card, Group, Section, type SectionDef } from "../harness";
import { ChromeBlock, PhoneMock, took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "belt-edge",
  title: "Belt scroller edge",
  intent:
    "Round five: the tint from round four stays. The operator now rejects the FADE, the Switch " +
    "block's 32px chrome lead-in and the matching left mask. Seven cards, on the REAL ActionsRow, " +
    "each a different edge treatment. Say the number.",
};

// ── The Switch cell, the one thing every card draws a copy of ────────────────

/** The lead-in shape the fixed Switch cell fades over, chosen per card:
 *   - `"fade-32"` — shipped: 32px (`pl-8`), gradient to `black_2rem`. The reference every other
 *     option is measured against.
 *   - `"fade-12"` — a short fade, 12px (`pl-3`), gradient to `black_0.75rem`. Still a fade, just a
 *     third of the shipped width.
 *   - `"solid-8"` — no gradient at all: an 8px (`pl-2`) solid chrome strip that reads as a margin
 *     rather than a dissolve.
 *   - `"none"` — no gradient and no separate strip either: the same 8px (`pl-2`) of spacing the
 *     button always needed, drawn solid chrome with nothing marking it as a "lead-in" at all.
 *   - `"band-8"` — the same 8px (`pl-2`) of spacing, no gradient, but paired with
 *     `leadInGround="none"` (option 4) it drops the opaque top layer and shows the belt's own
 *     `bg-foreground/6` band instead of chrome, so the strip reads as plain band, not cell. */
type LeadIn = "fade-32" | "fade-12" | "solid-8" | "none" | "band-8";

const LEAD_IN = {
  "fade-32": { pl: "pl-8", mask: "[mask-image:linear-gradient(to_right,transparent,black_2rem)]" },
  "fade-12": { pl: "pl-3", mask: "[mask-image:linear-gradient(to_right,transparent,black_0.75rem)]" },
  // No mask at all: the empty string is a no-op `cn()` argument, never a class.
  "solid-8": { pl: "pl-2", mask: "" },
  none: { pl: "pl-2", mask: "" },
  "band-8": { pl: "pl-2", mask: "" },
} satisfies Record<LeadIn, { pl: string; mask: string }>;

/**
 * A byte-for-byte-shaped copy of `actions-row.tsx`'s own pinned Switch pill (the `handle` branch),
 * the way belt-ground.tsx's own copy is, see that file's header for why a copy exists at all.
 *
 * THREE STACKED LAYERS UNDER ONE MASK, not belt-ground's two: the outer span's own `bg-chrome`, then
 * a fixed `bg-foreground/6` (the belt band's own ground, always present), then `leadInGround`
 * (`bg-chrome` by default, opaque, so it alone is what shows once the mask is fully open, and the
 * layers under it never matter). All three share the outer span's one mask, so at the left edge
 * (mask fully transparent) all three are invisible and the pill scrolling underneath shows through;
 * by the lead-in's own width the mask is fully opaque and only the TOP layer's colour remains.
 * Options 3 and 5 set `leadInGround` to the translucent `bg-primary/10`, layered over the fixed
 * `bg-chrome` + `bg-foreground/6` underneath it, that reconstructs the scroller's own resting colour
 * exactly (chrome, then the band's tint, then the scroller's own tint), so the fade there dissolves
 * into the track rather than into chrome. Option 4 sets it to `"none"`, which renders no top layer
 * at all, so only the fixed `bg-foreground/6` over `bg-chrome` shows: the belt's own plain band.
 */
function FixedSwitchCell({
  leadIn,
  leadInGround = "bg-chrome",
}: {
  leadIn: LeadIn;
  /** The top lead-in layer's own colour class, `"bg-chrome"` by default. The literal string
   *  `"none"` renders no top layer at all rather than a Tailwind class (option 4 alone). */
  leadInGround?: string;
}) {
  const { pl, mask } = LEAD_IN[leadIn];
  return (
    <span className={cn("absolute inset-y-0 right-0 z-10 flex items-center pr-3", pl)}>
      <span aria-hidden className={cn("pointer-events-none absolute inset-0 bg-chrome", mask)}>
        <span className="absolute inset-0 bg-foreground/6" />
        {leadInGround !== "none" && <span className={cn("absolute inset-0", leadInGround)} />}
      </span>
      <span className="flex items-center self-stretch">
        <span aria-hidden className="mr-2 h-5 w-px bg-border" />
        <span
          className={cn(`${STRIP_ROW_PILL} relative flex items-center justify-center border-0 px-0`)}
        >
          <Layers className="size-4 shrink-0 text-primary" />
        </span>
      </span>
    </span>
  );
}

// ── Option 6's quiet position mark ────────────────────────────────────────────

interface ScrollMark {
  /** The thumb's left offset, as a percentage of the real scroller's `scrollWidth`. */
  left: number;
  /** The thumb's width, as a percentage of the real scroller's `scrollWidth`. */
  width: number;
}

/**
 * Finds the real scroller inside `wrapperRef` (`[data-overflow] > div > div`, the same selector
 * shape the wrapper classes below reach it with) and tracks its `scrollLeft`/`scrollWidth` and
 * `clientWidth`/`scrollWidth` as percentages, for option 6's thumb. `null` while disabled, before the
 * scroller is found, or when it has no measurable width yet (jsdom under a test, or a card that
 * fits with nothing to scroll).
 */
function useScrollMark(wrapperRef: RefObject<HTMLDivElement | null>, enabled: boolean): ScrollMark | null {
  const [mark, setMark] = useState<ScrollMark | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const wrapper = wrapperRef.current;
    const scroller = wrapper?.querySelector<HTMLDivElement>("[data-overflow] > div > div");
    if (!scroller) return;

    const measure = () => {
      const { scrollLeft, scrollWidth, clientWidth } = scroller;
      if (scrollWidth <= 0) return;
      setMark({ left: (scrollLeft / scrollWidth) * 100, width: (clientWidth / scrollWidth) * 100 });
    };

    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const ro = hasResizeObserver() ? new ResizeObserver(measure) : undefined;
    ro?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [enabled, wrapperRef]);

  return mark;
}

// ── The belt itself: the REAL ActionsRow, a wrapper for the edge selectors ───────────────────────

interface BeltProps {
  /** The scroller's/wrapper's tint and mask, as Tailwind arbitrary-variant classes reaching them
   *  through `[data-overflow]`, `[data-overflow]>div` (the mask) and `[data-overflow]>div>div` (the
   *  scroller) — the attribute and the nesting `OverflowEdges` (`ui/overflow-edges.tsx`) already
   *  draws for real. No class is ever added to `actions-row.tsx` or `overflow-edges.tsx` themselves. */
  className?: string;
  /** The fixed Switch cell's own lead-in, per card, see {@link LeadIn}. */
  leadIn: LeadIn;
  /** Options 3, 4 and 5 only, see {@link FixedSwitchCell}. */
  leadInGround?: string;
  /** Option 6 only: draws the quiet position mark under the tint, tracking the real scroller. */
  trackMark?: boolean;
}

function Belt({ className, leadIn, leadInGround, trackMark = false }: BeltProps) {
  const general = useRoomyActions();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mark = useScrollMark(wrapperRef, trackMark);
  return (
    <div ref={wrapperRef} className={cn("relative bg-chrome px-3", className)}>
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell leadIn={leadIn} leadInGround={leadInGround} />
      {trackMark && mark && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0.5 h-px rounded-full bg-primary/30"
          style={{ left: `${mark.left}%`, width: `${mark.width}%` }}
        />
      )}
    </div>
  );
}

/** One card's mock: the belt over a quiet stand-in for the input row, in a phone-width box — the
 *  same shape belt-ground.tsx's own `BeltCard` uses. */
function BeltCard({ children }: { children: ReactNode }) {
  return (
    <PhoneMock>
      <div className="h-16 bg-background" />
      <ChromeBlock>
        {children}
        <div className="flex items-end gap-3 bg-chrome px-3 pb-2 pt-1.5">
          <div className="flex h-9 min-w-0 flex-1 items-center rounded-2xl border border-border bg-background px-3 text-[13px] text-muted-foreground">
            Type a reply…
          </div>
          <div className="size-11 shrink-0 rounded-full bg-primary" />
        </div>
      </ChromeBlock>
    </PhoneMock>
  );
}

// ── The cards ────────────────────────────────────────────────────────────────

export function BeltEdgeSection() {
  return (
    <Section def={DEF}>
      <Group title="The belt, as today, then six edge treatments, round five, on the real ActionsRow">
        <Card
          state="belt-edge-today"
          label="As today"
          reach="shipped in components/actions-row.tsx: the fixed Switch cell fades in from transparent over its own last 32px, and the scroller's left mask fades over 1.5rem once scrolled."
          note="Shipped, and the thing this round replaces. The fade reads as a smudge on the phone."
        >
          <BeltCard>
            <Belt leadIn="fade-32" />
          </BeltCard>
        </Card>

        <Card
          state="belt-edge-option-1"
          label="Option 1 · Hard edge, no fade"
          reach="idea, not shipped: the fixed cell's own lead-in fade would be gone (leadIn=none) and the scroller's left mask cleared."
          note="Pills clip hard at the cell's edge. The tint alone says track. The cut pill at the edge is the cue, the way an iOS list cuts a row at the screen edge."
        >
          <BeltCard>
            <Belt leadIn="none" className="[&_[data-overflow]>div]:[mask-image:none]" />
          </BeltCard>
        </Card>

        <Card
          state="belt-edge-option-2"
          label="Option 2 · Short fade, 12px"
          reach="idea, not shipped: the fixed cell's lead-in would shrink to 12px (leadIn=fade-12) and the scroller's left mask would shorten to match."
          note="Still a fade, just a third as wide. Enough to soften the edge without reading as a shadow that spans a third of the belt."
        >
          <BeltCard>
            <Belt
              leadIn="fade-12"
              className="[&_[data-overflow]>div]:[mask-image:linear-gradient(to_right,transparent,black_0.75rem)]"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-edge-option-3"
          label="Option 3 · Pills fade, the track stays solid"
          reach="idea, not shipped: the tint would move to the outer wrapper, and the fixed cell's own lead-in ground would turn the same tint instead of chrome."
          note="The pills dissolve into the solid track rather than into chrome, so the track runs unbroken up to the hairline. Only the cell itself, past the hairline, stays chrome. The left mask is unchanged, so this is one change at a time."
        >
          <BeltCard>
            <Belt
              leadIn="fade-32"
              leadInGround="bg-primary/10"
              className="[&_[data-overflow]]:bg-primary/10 [&_[data-overflow]>div>div]:bg-transparent"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-edge-option-4"
          label="Option 4 · A gap of plain band before the cell"
          reach="idea, not shipped: the fixed cell would draw a plain 8px band strip with no tint and no gradient (leadIn=band-8, leadInGround=none), and the scroller's left mask cleared."
          note="From left to right: tinted track, a hard cut, 8px of the belt's own plain band, the hairline, then the button. Nothing fades, and the gap reads as breathing room, not a smudge."
        >
          <BeltCard>
            <Belt
              leadIn="band-8"
              leadInGround="none"
              className="[&_[data-overflow]>div]:[mask-image:none]"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-edge-option-5"
          label="Option 5 · Dim, not dissolve"
          reach="idea, not shipped: the tint would move to the outer wrapper, the fixed cell's own lead-in would match the track (leadIn=none, leadInGround=bg-primary/10), and the scroller's left mask would dim the pills near the cell instead of hiding them."
          note="The pills go faint under the cell, they do not melt into it. The track underneath stays solid the whole way, so nothing looks like it dissolved."
        >
          <BeltCard>
            <Belt
              leadIn="none"
              leadInGround="bg-primary/10"
              className="[&_[data-overflow]]:bg-primary/10 [&_[data-overflow]>div>div]:bg-transparent [&_[data-overflow]>div]:[mask-image:linear-gradient(to_right,black_calc(100%-6.5rem),rgba(0,0,0,0.35)_calc(100%-4.5rem),rgba(0,0,0,0.35))]"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-edge-option-6"
          label="Option 6 · A quiet position mark"
          reach="idea, not shipped: a hard edge (leadIn=none, left mask cleared) plus a 1px mark tracking the real scroller's scrollLeft and scrollWidth, drawn under the tint."
          note="Rounds two and three rejected a thumb before the tint existed. This one is 2px and sits under the tint, so it is offered once more as a quiet mark, not a scrollbar."
        >
          <BeltCard>
            <Belt
              leadIn="none"
              trackMark
              className="[&_[data-overflow]>div]:[mask-image:none]"
            />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
