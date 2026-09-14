// Belt scroll cue ideas, round seven. Rounds five (belt-edge.tsx) and six (belt-capsule.tsx) both
// missed. The operator's verdict, verbatim, 2026-09-14: "i still prefer 1 (current), but also make
// it more compact and lets work on the effect please that displays/indicates that its scrollable,
// the shadow." We read "1 (current)" as the SHIPPED band — the "As today" card below — not round
// six's capsule: he is picking the band shape back up, on two axes at once, compactness and the
// scroll cue itself, which is the shipped 32px chrome fade he already called a smudge in round five.
//
// SO THIS ROUND STAYS ON THE BAND, THE SHIPPED SHAPE, and does two things to it. First, COMPACT:
// every card drops the scroller's own `py-1.5` (`[&_[data-overflow]>div>div]:py-0`, the band is 32px
// rather than 44px) and the composer row's `mb-1.5` shrinks to `mb-1`
// (`[&_[data-slot=composer-actions]]:mb-1`) — both reached the usual way, through a wrapper selector,
// never a class added to `actions-row.tsx` or `overflow-edges.tsx` themselves. Second, THE CUE: five
// fresh stabs at "this is scrollable" that are not the shipped chrome fade — a drop shadow cast BY
// the fixed cell onto the pills sliding under it, an inset shadow painted INTO the track's own end, a
// frosted blur, and combinations of these with the compact track from round six.
//
// EVERY SHADOW HERE IS `rgba(0,0,0,…)`, BLACK, NEVER A THEME TOKEN. It still reads in the dark theme
// because the ground it sits on (`--chrome`, `--primary/10`) is always LIGHTER than pure black, in
// both themes — a black shadow darkens either ground, the same way a real cast shadow would, so one
// rgba value serves both without a `dark:` variant.
//
// STILL THE REAL ActionsRow (`components/actions-row.tsx`), mounted the way belt-edge.tsx mounts it
// (`useRoomyActions`, `agent="claude"`, `onRun={took}`, no `handle`), inside the same `BeltCard`
// phone mock. The fixed Switch cell is belt-edge.tsx's own copied `FixedSwitchCell`, carried over
// with its `leadIn`/`leadInGround` props unchanged, plus one new prop here, `shadowClassName`, for
// the drop-shadow options. Every option reaches the scroller, `OverflowEdges`'s wrapper and the
// composer row from OUTSIDE, through wrapper selectors — never a class added to `actions-row.tsx` or
// `overflow-edges.tsx` themselves.
//
// LEFT MASK CLEARED EVERYWHERE EXCEPT WHERE STATED. "As today" and option 1 both keep the shipped
// left fade on purpose — option 1 is compaction ALONE, so the operator can judge that axis with
// nothing else moving. Every other option replaces the fade with its own cue and clears the mask.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { Layers } from "lucide-react";

import { ActionsRow } from "@/components/actions-row";
import { STRIP_ROW_PILL } from "@/components/ui/labelled-strip";
import { cn } from "@/lib/utils";

import { Card, Group, Section, type SectionDef } from "../harness";
import { ChromeBlock, PhoneMock, took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "belt-cue",
  title: "Belt scroll cue",
  intent:
    "Round seven: the operator picked the shipped band back up over round six's capsule, and asked " +
    "for two things on top of it, more compact and a better scrollable cue than the chrome fade. " +
    "Seven cards, on the REAL ActionsRow. Say the number.",
};

// ── Shared: compaction, mask clearing, and the shadow recipes ────────────────

/** COMPACT: drops the scroller's own vertical padding (band is 32px, not 44px) and shrinks the
 *  composer row's own bottom margin — every card but "As today" carries this. */
const COMPACT = "[&_[data-overflow]>div>div]:py-0 [&_[data-slot=composer-actions]]:mb-1";

/** Clears `OverflowEdges`'s own left mask outright — the fade this round is trying to replace. */
const CLEAR_MASK = "[&_[data-overflow]>div]:[mask-image:none]";

/** Option 2, 5 and 6's own cue: a soft shadow cast BY the fixed cell onto whatever scrolls under
 *  it, drawn on the cell's own outer span via {@link FixedSwitchCell}'s `shadowClassName` prop. */
const CELL_SHADOW = "shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.28)]";

/** Option 3's own cue: an inset shadow painted INTO the track's own right end, so the track itself
 *  darkens toward the cell rather than the cell casting a shadow onto it. */
const TRACK_INSET_SHADOW =
  "[&_[data-overflow]]:shadow-[inset_-14px_0_12px_-10px_rgba(0,0,0,0.22)]";

/** Option 5's second shadow: a left inset that only appears once the row has actually scrolled —
 *  `data-overflow` is the measured edge (`ui/overflow-edges.tsx`), so `=left`/`=both` are live,
 *  not static; flicking the card left is what paints this one in. */
const TRACK_LEFT_SCROLLED_SHADOW =
  "[&_[data-overflow=left]]:shadow-[inset_14px_0_12px_-10px_rgba(0,0,0,0.22)] " +
  "[&_[data-overflow=both]]:shadow-[inset_14px_0_12px_-10px_rgba(0,0,0,0.22)]";

/** Option 6's own addition on top of {@link CELL_SHADOW}: the scroller's own pills shrink to a
 *  28px minimum height, the same recipe round six's option 7 used. */
const COMPACT_PILLS = "[&_[data-overflow]_button]:h-7 [&_[data-overflow]_button]:min-h-0";

// ── The Switch cell, carried over from belt-edge.tsx with one new prop ───────

/** The lead-in shape the fixed Switch cell fades over, chosen per card. `"fade-32"` and `"none"`
 *  are belt-edge.tsx's own values, carried over unchanged; `"frost-24"` is new here: 24px
 *  (`pl-6`) of `backdrop-blur-[3px]` over a translucent `bg-chrome/70`, no mask and no separate
 *  `bg-foreground/6` base layer under it (the blur alone is the effect, so there is nothing for a
 *  solid base layer to do). */
type LeadIn = "fade-32" | "none" | "frost-24";

const LEAD_IN = {
  "fade-32": { pl: "pl-8", mask: "[mask-image:linear-gradient(to_right,transparent,black_2rem)]" },
  none: { pl: "pl-2", mask: "" },
  "frost-24": { pl: "pl-6", mask: "" },
} satisfies Record<LeadIn, { pl: string; mask: string }>;

/**
 * belt-edge.tsx's own `FixedSwitchCell`, carried over with its `leadIn`/`leadInGround` props
 * unchanged, plus `shadowClassName` (options 2, 5 and 6). `overflow-visible` is explicit rather
 * than relied on as the browser default, because the drop-shadow options need the shadow to reach
 * OUTSIDE this span's own box, over the pills sliding under it, and a future class added here must
 * not clip it by accident.
 */
function FixedSwitchCell({
  leadIn,
  leadInGround = "bg-chrome",
  shadowClassName,
}: {
  leadIn: LeadIn;
  /** Carried over from belt-edge.tsx; unused by any card in this file, kept for shape parity. */
  leadInGround?: string;
  /** Options 2, 5 and 6 only: {@link CELL_SHADOW}, drawn on this cell's own outer span. */
  shadowClassName?: string;
}) {
  const { pl, mask } = LEAD_IN[leadIn];
  const isFrost = leadIn === "frost-24";
  return (
    <span
      className={cn(
        "absolute inset-y-0 right-0 z-10 flex items-center overflow-visible pr-3",
        pl,
        shadowClassName,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0",
          isFrost ? "bg-chrome/70 backdrop-blur-[3px]" : "bg-chrome",
          mask,
        )}
      >
        {!isFrost && <span className="absolute inset-0 bg-foreground/6" />}
        {!isFrost && leadInGround !== "none" && (
          <span className={cn("absolute inset-0", leadInGround)} />
        )}
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

// ── The belt itself: the REAL ActionsRow, a wrapper for the cue selectors ────

interface BeltProps {
  /** The scroller's/wrapper's mask and shadow, as Tailwind arbitrary-variant classes reaching them
   *  through `[data-overflow]` and its children — never a class added to `actions-row.tsx` or
   *  `overflow-edges.tsx` themselves. */
  className?: string;
  leadIn: LeadIn;
  leadInGround?: string;
  shadowClassName?: string;
}

function Belt({ className, leadIn, leadInGround, shadowClassName }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div className={cn("relative bg-chrome px-3", COMPACT, className)}>
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell leadIn={leadIn} leadInGround={leadInGround} shadowClassName={shadowClassName} />
    </div>
  );
}

/** "As today" alone: no {@link COMPACT}, the shipped 32px fade, the shipped left mask. The
 *  reference every other card in this section is measured against. */
function BeltToday() {
  const general = useRoomyActions();
  return (
    <div className="relative bg-chrome px-3">
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell leadIn="fade-32" />
    </div>
  );
}

/** One card's mock: the belt over a quiet stand-in for the input row, in a phone-width box — the
 *  same shape belt-edge.tsx's own `BeltCard` uses. */
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

export function BeltCueSection() {
  return (
    <Section def={DEF}>
      <Group title="The belt, as today, then a compaction pass and six scroll cues, round seven, on the real ActionsRow">
        <Card
          state="belt-cue-today"
          label="As today"
          reach="shipped in components/actions-row.tsx: the 44px band, the fixed Switch cell's 32px chrome fade, and the scroller's own left mask once scrolled."
          note="Shipped, unchanged. Neither axis moves here: not the height, not the cue. Every other card in this section changes one or both."
        >
          <BeltCard>
            <BeltToday />
          </BeltCard>
        </Card>

        <Card
          state="belt-cue-option-1"
          label="Option 1 · Compact, today's fade"
          reach="idea, not shipped: the band would drop to 32px and the composer's own margin would tighten, but the fixed cell's fade and the scroller's own left mask would stay exactly as shipped."
          note="Compaction alone, nothing else moves. This is what the height change looks like on its own, with the shipped fade still doing the same job it does today."
        >
          <BeltCard>
            <Belt leadIn="fade-32" />
          </BeltCard>
        </Card>

        <Card
          state="belt-cue-option-2"
          label="Option 2 · The cell casts a shadow onto the track"
          reach="idea, not shipped: the fixed cell would drop its own fade (leadIn=none) and instead cast a soft shadow leftward, over whatever pill is sliding under it."
          note="Pills pass under a real shadow, as if under a lip. The shadow is the cell's own, not a mask on the scroller, so it stays put at a fixed size regardless of scroll position."
        >
          <BeltCard>
            <Belt leadIn="none" shadowClassName={CELL_SHADOW} className={CLEAR_MASK} />
          </BeltCard>
        </Card>

        <Card
          state="belt-cue-option-3"
          label="Option 3 · Inset shadow at the track's end"
          reach="idea, not shipped: the fixed cell would drop its own fade, and the track's own wrapper would carry an inner shadow at its right end instead."
          note="The track itself darkens toward the cell, rather than the cell casting light onto the track. The darkening is inside the track's own edge, not a separate shape drawn over it."
        >
          <BeltCard>
            <Belt leadIn="none" className={cn(CLEAR_MASK, TRACK_INSET_SHADOW)} />
          </BeltCard>
        </Card>

        <Card
          state="belt-cue-option-4"
          label="Option 4 · Frosted edge"
          reach="idea, not shipped: the fixed cell's own lead-in would become a 24px frosted strip, backdrop-blur over a translucent chrome ground, with no gradient at all."
          note="Pills go blurry rather than fading or clipping as they near the cell. The blur alone says something is happening at that edge, no shadow and no hard line."
        >
          <BeltCard>
            <Belt leadIn="frost-24" className={CLEAR_MASK} />
          </BeltCard>
        </Card>

        <Card
          state="belt-cue-option-5"
          label="Option 5 · Shadow at both ends once scrolled"
          reach="idea, not shipped: option 2's cast shadow at the cell, plus a left inset shadow on the track that only appears once the row has actually scrolled."
          note="At rest only the cell's own shadow shows. Once flicked left, the track's own left end darkens too, so the two ends agree there is more to see in both directions."
        >
          <BeltCard>
            <Belt
              leadIn="none"
              shadowClassName={CELL_SHADOW}
              className={cn(CLEAR_MASK, TRACK_LEFT_SCROLLED_SHADOW)}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-cue-option-6"
          label="Option 6 · Shadow and a tighter track, 28px pills"
          reach="idea, not shipped: option 2's cast shadow, plus every pill inside the scroller shrinking to a 28px minimum height instead of the shipped 32px."
          note="The shortest band in this section. The shadow still reads at the smaller pill height, so compaction and the cue are not in tension with each other."
        >
          <BeltCard>
            <Belt
              leadIn="none"
              shadowClassName={CELL_SHADOW}
              className={cn(CLEAR_MASK, COMPACT_PILLS)}
            />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
