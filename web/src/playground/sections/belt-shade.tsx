// Belt shade ideas, round two (round one is git history — see `chore(playground): drop the
// design-pick decks that had served`, commit 60a68c40, and belt-shade round one's own commit
// before it). The operator picked round one's option 2 (the long 48px fade) and option 6 (the
// tint draining out) as the two directions worth going deeper on, and asked for two more things
// on top: "decrease the width of the layers icon/pane switcher button, and the belt is vertically
// scrollable, fix that."
//
// THE VERTICAL-SCROLL BUG, AND THE FIX EVERY CARD CARRIES: `STRIP_TAP_TARGET`'s `::before` extends
// a pill's HIT box to 46px tall so a 32px-drawn pill still answers a 44px tap
// (`components/ui/labelled-strip.tsx`), and that extension is normally absorbed by the scroller's
// own `py-1.5` (6px top and bottom, so 32 + 6 + 6 + the `::before`'s own reach = 44, the same
// number `STRIP_TAP_TARGET`'s own comment measures). COMPACT drops that `py-1.5` to `py-0` — the
// whole point, a 32px band instead of 44px — but the `::before` still reaches its full 46px, now
// with nothing to absorb it, so it overflows the scroller's own box. `overflow-x: auto` forces
// `overflow-y` to compute to `auto` as well (the scroller is a scroll container on BOTH axes, the
// same fact `STRIP_TAP_TARGET`'s own comment already measures), so that overflow becomes a real
// vertical scrollbar on the belt. Fixed here per card with `[&_[data-overflow]>div>div]:overflow-y-
// hidden`; the shipped fix, WHEN THIS ROUND LANDS, is `STRIP_SCROLLER` itself gaining
// `overflow-y-hidden` — it already forces `overflow-x-auto`, so pairing it with an explicit
// `overflow-y-hidden` costs nothing today and stops any future compaction from reopening this bug.
//
// THE NARROW SWITCH: the copied `FixedSwitchCell` used `STRIP_ROW_PILL` unmodified, which carries a
// `min-w-11` (44px) floor — the same floor every belt pill stands on. The Switch mark is a single
// centred icon with no label, so a `switchWidth` prop overrides just that one utility with a
// narrower pair (`w-<n> min-w-<n>`, both needed since `min-w-11` would otherwise still win against
// a bare `w-<n>`), while everything else about the pill — the tap-target `::before`, the `mr-2`
// hairline spacing beside it — is untouched. Default is 36px (`w-9 min-w-9`); options 5 and 6 go
// further, to 32px (`w-8 min-w-8`). "As today" alone keeps the shipped 44px floor, unmodified, as
// the width every other card is measured against.
//
// COMPACT CARRIES OVER FROM ROUND ONE UNCHANGED: every card drops the scroller's own `py-1.5`
// (`[&_[data-overflow]>div>div]:py-0`) and the composer row's own `mb-1.5` shrinks to `mb-1`
// (`[&_[data-slot=composer-actions]]:mb-1`). THE LEFT MASK IS STILL LEFT ALONE ON EVERY CARD — this
// round, like round one, is about the right end.
//
// STILL THE REAL ActionsRow (`components/actions-row.tsx`), mounted with no `handle`
// (`useRoomyActions`, `agent="claude"`, `onRun={took}`), inside the same `BeltCard` phone mock.
// Every option reaches the scroller, `OverflowEdges`'s wrapper and the composer row from OUTSIDE,
// through wrapper selectors — never a class added to `actions-row.tsx` or `overflow-edges.tsx`
// themselves.
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
  id: "belt-shade",
  title: "Belt shade",
  intent:
    "Round two: the operator picked round one's long fade and its draining tint to go deeper on, " +
    "and asked for a narrower Switch mark and a fix for a vertical-scroll bug the compaction " +
    "introduced. Seven cards, on the REAL ActionsRow. Say the number.",
};

// ── Shared: compaction, the vertical-scroll fix, and the fade shape ──────────

/** COMPACT, carried over from round one unchanged. */
const COMPACT = "[&_[data-overflow]>div>div]:py-0 [&_[data-slot=composer-actions]]:mb-1";

/** The fix for the bug COMPACT introduces — see this file's header for the mechanism. Every card
 *  carries this, "As today" included. */
const FIX_VERTICAL_SCROLL = "[&_[data-overflow]>div>div]:overflow-y-hidden";

/** The shipped 32px chrome fade — "As today" and options 2 and 4 all reuse this exact shape
 *  unchanged, because those three cards vary something OTHER than the fade itself. */
const FADE_32 = {
  pl: "pl-8",
  mask: "[mask-image:linear-gradient(to_right,transparent,black_2rem)]",
};

/** The fade shape the fixed Switch cell's lead-in follows: how far it reaches (`pl`) and the
 *  gradient it fades through (`mask`), as a literal pair. */
interface LeadIn {
  pl: string;
  mask: string;
}

/**
 * Round one's own `FixedSwitchCell`, with one new prop: `switchWidth`, overriding
 * `STRIP_ROW_PILL`'s own `min-w-11` floor on the Switch mark alone — see this file's header for
 * why a floor override needs both a `w-<n>` and a `min-w-<n>` class.
 */
function FixedSwitchCell({
  leadIn,
  switchWidth = "w-9 min-w-9",
}: {
  leadIn: LeadIn;
  /** `"w-11 min-w-11"` is the shipped, unmodified floor — "As today" alone. Every other card
   *  narrows it: `"w-9 min-w-9"` (36px, the new default) or `"w-8 min-w-8"` (32px, options 5
   *  and 6). */
  switchWidth?: "w-11 min-w-11" | "w-9 min-w-9" | "w-8 min-w-8";
}) {
  return (
    <span className={cn("absolute inset-y-0 right-0 z-10 flex items-center pr-3", leadIn.pl)}>
      <span aria-hidden className={cn("pointer-events-none absolute inset-0 bg-chrome", leadIn.mask)}>
        <span className="absolute inset-0 bg-foreground/6" />
        <span className="absolute inset-0 bg-chrome" />
      </span>
      <span className="flex items-center self-stretch">
        <span aria-hidden className="mr-2 h-5 w-px bg-border" />
        <span
          className={cn(
            STRIP_ROW_PILL,
            switchWidth,
            "relative flex items-center justify-center border-0 px-0",
          )}
        >
          <Layers className="size-4 shrink-0 text-primary" />
        </span>
      </span>
    </span>
  );
}

// ── The belt itself: the REAL ActionsRow, a wrapper for the wide-band selectors ──────────────────

interface BeltProps {
  /** The track's own extra look — the draining-tint gradients — reached through `[data-overflow]`
   *  and its children, never a class added to `actions-row.tsx` or `overflow-edges.tsx`
   *  themselves. */
  className?: string;
  leadIn: LeadIn;
  switchWidth?: "w-11 min-w-11" | "w-9 min-w-9" | "w-8 min-w-8";
}

function Belt({ className, leadIn, switchWidth }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div className={cn("relative bg-chrome px-3", COMPACT, FIX_VERTICAL_SCROLL, className)}>
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell leadIn={leadIn} switchWidth={switchWidth} />
    </div>
  );
}

/** One card's mock: the belt over a quiet stand-in for the input row, in a phone-width box — the
 *  same shape round one's own `BeltCard` uses. */
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

/** Option 2's own draining-tint gradient — the track's brand tint fades to nothing over its last
 *  64px, rather than stopping abruptly at the cell. Reused by option 3, at a longer fade. */
const DRAIN_64PX = cn(
  "[&_[data-overflow]]:bg-[linear-gradient(to_right,color-mix(in_oklab,var(--color-primary)_10%,transparent)_calc(100%-6rem),transparent_calc(100%-2rem))]",
  "[&_[data-overflow]>div>div]:bg-transparent",
);

export function BeltShadeSection() {
  return (
    <Section def={DEF}>
      <Group title="The belt, as today, then six variations on the long fade and the draining tint, round two, on the real ActionsRow">
        <Card
          state="belt-shade-today"
          label="As today"
          reach="belt-cue's own option 1, compacted: the compact 32px band, the fixed Switch cell's shipped 32px chrome fade, and the shipped 44px Switch mark width, all unchanged."
          note="The reference every other card in this section varies from. This one keeps the old Switch width on purpose, so the narrowing below has something to be measured against."
        >
          <BeltCard>
            <Belt leadIn={FADE_32} switchWidth="w-11 min-w-11" />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-1"
          label="Option 1 · Long fade, 48px, Switch 36px"
          reach="idea, not shipped: the fixed cell's own lead-in would grow to 48px, and the Switch mark would narrow to 36px."
          note="Round one's long fade, now paired with the narrower mark. Both changes read together: more room given to the dissolve, less to the control that ends it."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-12",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_3rem)]",
              }}
              switchWidth="w-9 min-w-9"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-2"
          label="Option 2 · The tint drains out, Switch 36px"
          reach="idea, not shipped: the fixed cell's own fade would stay exactly as today, the track's own brand tint would fade away to nothing over its last 64px, and the Switch mark would narrow to 36px."
          note="Round one's draining tint, now paired with the narrower mark. The pills still dissolve into chrome at the cell; the colour underneath them has already drained away before they get there."
        >
          <BeltCard>
            <Belt leadIn={FADE_32} className={DRAIN_64PX} switchWidth="w-9 min-w-9" />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-3"
          label="Option 3 · Both, tint drains over 64px, pills fade over 48px"
          reach="idea, not shipped: option 2's draining tint, plus the fixed cell's own lead-in growing to 48px at the same time."
          note="The two ideas combined rather than judged apart. The tint is gone before the pills reach the cell, and the pills themselves take longer to dissolve once they do."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-12",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_3rem)]",
              }}
              className={DRAIN_64PX}
              switchWidth="w-9 min-w-9"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-4"
          label="Option 4 · Tint drains over 96px, pills fade 32px"
          reach="idea, not shipped: the track's own brand tint would fade away over its last 96px instead of 64px, while the fixed cell's own lead-in stays the shipped 32px."
          note="The tint alone announces the belt is ending, well before the pills reach the cell, which keeps its shipped fade unchanged. The two cues no longer start at the same point."
        >
          <BeltCard>
            <Belt
              leadIn={FADE_32}
              className={cn(
                "[&_[data-overflow]]:bg-[linear-gradient(to_right,color-mix(in_oklab,var(--color-primary)_10%,transparent)_calc(100%-8rem),transparent_calc(100%-2rem))]",
                "[&_[data-overflow]>div>div]:bg-transparent",
              )}
              switchWidth="w-9 min-w-9"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-5"
          label="Option 5 · Both, Switch 32px"
          reach="idea, not shipped: option 3's combination, tint draining over 64px and a 48px fade, but the Switch mark would narrow further, to 32px."
          note="The same combined cue as option 3, with the narrowest mark in this section. The track keeps most of the belt's own width now that the control at its end asks for less of it."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-12",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_3rem)]",
              }}
              className={DRAIN_64PX}
              switchWidth="w-8 min-w-8"
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-6"
          label="Option 6 · Long fade 64px, Switch 32px"
          reach="idea, not shipped: the fixed cell's own lead-in would grow to 64px, twice the shipped width, paired with the narrowest Switch mark, 32px."
          note="The fade alone, taken further than option 1, with no draining tint alongside it. The narrower mark gives the longer fade room to work in without the belt growing any shorter."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-16",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_4rem)]",
              }}
              switchWidth="w-8 min-w-8"
            />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
