// Belt capsule ideas, round six. The operator rejected every edge treatment round five staged
// (belt-edge.tsx) — none of the fade, dim or hard-cut variations answered what he actually wanted.
// New direction, verbatim from the phone, 2026-09-14: "lets try one with rounded borders, and have
// shape icon completely outside as its own floating component next to the rounded belt, the rounded
// shape could allude to it being scrollable."
//
// THIS OVERRIDES THE OLDER RULE. belt-edge.tsx (and belt-ground.tsx before it) carried "no rounded
// ends anywhere, a belt with rounded ends is a capsule again" as settled — that was true up to
// round five. The operator overrides it here, on 2026-09-14, by name: a rounded capsule is back on
// the table, and the Switch mark comes off the belt entirely to stand beside it. Don't re-cite the
// old rule against this round; it is superseded for THIS shape, not deleted from history.
//
// THE SHARED SHAPE: the belt stops being an edge-to-edge band and becomes a rounded TRACK — the
// scroller alone, clipped to a radius — and the Switch mark stands OUTSIDE it, its own floating
// control in the same row, no hairline, no fade, no ground unless the card says so. STILL THE REAL
// ActionsRow (`components/actions-row.tsx`), mounted with no `handle` (nothing pins a Switch pill
// inside it — the mark here is drawn once, at the wrapper level, never by `actions-row.tsx` itself).
// Every option reaches the scroller and its `OverflowEdges` wrapper from OUTSIDE, through wrapper
// selectors, and neutralises the shipped band's own edge-to-edge styling the same way — never a
// class added to `actions-row.tsx` or `overflow-edges.tsx` themselves.
//
// NO FADES ANYWHERE IN THIS ROUND. Every option clears `OverflowEdges`'s mask outright
// (`[mask-image:none]` on the middle div), which answers both edges at once since the primitive
// paints its whole mask from that one property — there is no separate "clear the right edge" class
// needed. A cut pill at a rounded end is the cue this round tries instead.
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
  id: "belt-capsule",
  title: "Belt capsule",
  intent:
    "Round six: every edge treatment round five staged was rejected. New shape from the operator, " +
    "verbatim: rounded borders, and the Switch mark floating outside the belt as its own control, " +
    "then a compactness pass on top of it. Nine cards, on the REAL ActionsRow, no fades anywhere. " +
    "Say the number.",
};

// ── Neutralising the shipped band, and the shared floating mark ──────────────

/** Strips the shipped belt's own band styling — the full-bleed `-mx-3`, the bottom margin that
 *  separates it from the input row, the hairline and the band's own `bg-foreground/6` — off
 *  `actions-row.tsx`'s root element, reached the same way every other selector here reaches the
 *  scroller: through a wrapper class, never a class added to the component itself. Every option
 *  carries this; only what it strips TO (the wrapper's own ground) differs per card. */
const NEUTRALIZE_BAND =
  "[&_[data-slot=composer-actions]]:mx-0 [&_[data-slot=composer-actions]]:mb-0 " +
  "[&_[data-slot=composer-actions]]:border-0 [&_[data-slot=composer-actions]]:bg-transparent";

/** Clears `OverflowEdges`'s own mask outright — no fade, on either edge, ever, this round. */
const CLEAR_MASK = "[&_[data-overflow]>div]:[mask-image:none]";

/** Clips the scroller's own wrapper to whatever radius the card's `className` adds next to it —
 *  the round end is what cuts a pill rather than fading it. */
const CLIP = "[&_[data-overflow]]:overflow-hidden";

/** Drops `STRIP_SCROLLER`'s own `py-1.5` so the capsule's height is exactly the pill's own drawn
 *  height (32px, or 28px under options 7 and 8) rather than the scroller's padded 44px — the
 *  operator's compactness pass, 2026-09-14: "it needs to be way more compact, less vertical
 *  padding." Applied to every capsule option automatically, via {@link Belt}'s own base classes,
 *  beside {@link NEUTRALIZE_BAND}. */
const COMPACT_TRACK = "[&_[data-overflow]>div>div]:py-0";

interface BeltProps {
  /** The track's own look: radius, fill, border, and the wrapper's own ground — every one of these
   *  reaches `[data-overflow]` or the Belt wrapper itself through a selector, never a class on
   *  `actions-row.tsx` or `overflow-edges.tsx`. */
  className?: string;
  /** The floating Switch mark's own presentation. `"bare"` (the default) is the icon alone, sized
   *  like {@link STRIP_ROW_PILL} so it answers the same tap target every other pill on this belt
   *  does. `"circle"` (option 4 alone) draws it centred in its own round ground, the way the send
   *  button below it already sits. */
  mark?: "bare" | "circle";
}

/** The belt itself: the REAL ActionsRow, mounted with no `handle` — this round's Switch mark is
 *  never `actions-row.tsx`'s own pinned pill, it is drawn here, once, outside the scroller entirely. */
function Belt({ className, mark = "bare" }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div
      className={cn("flex items-center gap-2 bg-chrome px-3 pb-1", NEUTRALIZE_BAND, COMPACT_TRACK, className)}
    >
      <div className="min-w-0 flex-1">
        <ActionsRow general={general} agent="claude" onRun={took} />
      </div>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          mark === "circle"
            ? "size-9 rounded-full bg-foreground/6"
            : cn(STRIP_ROW_PILL, "relative border-0 px-0"),
        )}
      >
        <Layers className="size-4 shrink-0 text-primary" />
      </span>
    </div>
  );
}

/**
 * The shipped look, for reference: `actions-row.tsx`'s own pinned Switch pill, over the same 32px
 * chrome fade every round before this one shipped — copied from belt-edge.tsx's own `FixedSwitchCell`
 * at its `leadIn="fade-32"` default, for this one card only. Every other card in this section draws
 * the mark {@link Belt}'s own way, floating outside the scroller.
 */
function FixedSwitchCell() {
  return (
    <span className="absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-8">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-chrome [mask-image:linear-gradient(to_right,transparent,black_2rem)]"
      >
        <span className="absolute inset-0 bg-foreground/6" />
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

/** The "As today" card's mock: the shipped band, unmodified, with its own copied Switch cell. */
function BeltToday() {
  const general = useRoomyActions();
  return (
    <div className="relative bg-chrome px-3">
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell />
    </div>
  );
}

/** One card's mock: the belt over a quiet stand-in for the input row, in a phone-width box, the
 *  same shape belt-edge.tsx's own `BeltCard` uses. `inputPt` is option 8's own knob alone: `pt-1`
 *  instead of the shipped `pt-1.5`, so the capsule above it sits 4px of air off the input row. */
function BeltCard({ children, inputPt = "pt-1.5" }: { children: ReactNode; inputPt?: "pt-1" | "pt-1.5" }) {
  return (
    <PhoneMock>
      <div className="h-16 bg-background" />
      <ChromeBlock>
        {children}
        <div className={cn("flex items-end gap-3 bg-chrome px-3 pb-2", inputPt)}>
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

export function BeltCapsuleSection() {
  return (
    <Section def={DEF}>
      <Group title="The belt, as today, then eight capsule treatments, round six, on the real ActionsRow">
        <Card
          state="belt-capsule-today"
          label="As today"
          reach="shipped in components/actions-row.tsx: the belt runs edge to edge, tinted, with the pinned Switch pill fading in over its own last 32px."
          note="Shipped, and the shape the operator asked to leave behind. The band and the fade both go this round; the track rounds off and the mark steps outside it."
        >
          <BeltCard>
            <BeltToday />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-1"
          label="Option 1 · Capsule, brand tint, bare mark"
          reach="idea, not shipped: the scroller's own wrapper would clip to a full pill radius, keep its shipped brand tint, and the Switch mark would stand beside it, bare."
          note="The track is a capsule now, not a band. A pill still scrolling when it reaches the rounded end simply clips there, and that clip is the whole of the cue."
        >
          <BeltCard>
            <Belt className={cn(CLEAR_MASK, CLIP, "[&_[data-overflow]]:rounded-full")} />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-2"
          label="Option 2 · Rounded corners, 8px"
          reach="idea, not shipped: the same track as option 1, but clipped to an 8px corner radius instead of a full pill."
          note="Less capsule, more rounded card. The corner still reads as a boundary, and a pill still cuts there rather than fading."
        >
          <BeltCard>
            <Belt className={cn(CLEAR_MASK, CLIP, "[&_[data-overflow]]:rounded-lg")} />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-3"
          label="Option 3 · Capsule, outlined not filled"
          reach="idea, not shipped: the same capsule as option 1, but the tint would be cleared and a hairline border drawn around it instead."
          note="No tint at all, just a hairline pill. Quieter than the filled track, and the rounded outline alone carries the scrollable cue."
        >
          <BeltCard>
            <Belt
              className={cn(
                CLEAR_MASK,
                CLIP,
                "[&_[data-overflow]]:rounded-full [&_[data-overflow]]:border [&_[data-overflow]]:border-border [&_[data-overflow]>div>div]:bg-transparent",
              )}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-4"
          label="Option 4 · Capsule, and the mark in its own round ground"
          reach="idea, not shipped: the same capsule as option 1, but the Switch mark would sit centred in its own round bg-foreground/6 ground, the way the send button below it already does."
          note="The mark reads as a second, smaller control next to the track, matching the round send button underneath it. Nothing about the track itself changes."
        >
          <BeltCard>
            <Belt
              mark="circle"
              className={cn(CLEAR_MASK, CLIP, "[&_[data-overflow]]:rounded-full")}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-5"
          label="Option 5 · Capsule on the band"
          reach="idea, not shipped: the belt's own full-width band would stay, bg-foreground/6 with a hairline underneath it, and the tinted capsule would sit inside that band rather than replacing it."
          note="The only option here where the band survives. The capsule is the scrollable track inside a still-visible composer row, closer to a change on top of today than a replacement of it."
        >
          <BeltCard>
            <Belt
              className={cn(
                CLEAR_MASK,
                CLIP,
                "[&_[data-overflow]]:rounded-full bg-foreground/6 border-b border-border",
              )}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-6"
          label="Option 6 · Runs off the left edge, rounded on the right"
          reach="idea, not shipped: like option 1, but the track would start flush at the screen's left edge and round only its right end, where the Switch mark sits."
          note="The track reads as continuing off-screen to the left and stopping, rounded, at the mark on the right. Only one end says stop; the other says there is more this way."
        >
          <BeltCard>
            <Belt
              className={cn(CLEAR_MASK, CLIP, "[&_[data-overflow]]:rounded-r-full pl-0")}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-7"
          label="Option 7 · Capsule, 28px pills"
          reach="idea, not shipped: option 1's capsule, but every pill inside the scroller would shrink to a 28px minimum height instead of the shipped 32px, and the track would shrink to match."
          note="The track is four pixels shorter than option 1's. The pill text stays the same size, only the box drawn around it gets smaller."
        >
          <BeltCard>
            <Belt
              className={cn(
                CLEAR_MASK,
                CLIP,
                "[&_[data-overflow]]:rounded-full [&_[data-overflow]_button]:h-7 [&_[data-overflow]_button]:min-h-0",
              )}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-capsule-option-8"
          label="Option 8 · Capsule, 28px, flush to the input"
          reach="idea, not shipped: option 7's 28px capsule, but the belt wrapper would drop its own bottom padding to nothing and the input row above it would lose half its top padding too."
          note="The capsule sits four pixels above the input row and nothing more. This is the most compact of the eight; every spare pixel between the track and the box below it is gone."
        >
          <BeltCard inputPt="pt-1">
            <Belt
              className={cn(
                CLEAR_MASK,
                CLIP,
                "[&_[data-overflow]]:rounded-full [&_[data-overflow]_button]:h-7 [&_[data-overflow]_button]:min-h-0 pb-0",
              )}
            />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
