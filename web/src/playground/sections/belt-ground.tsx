// Belt scroller ground ideas, round three: FIVE numbered options for the actions belt's own ground.
// Altan rejected round one's three options outright ("all are bad, try again") — those only changed
// the SHADE of a DRAWN copy of the belt. Round two changed the affordance instead of the shade, but
// was still a drawn copy, and the operator caught it: "the band is wider than the PhoneMock and
// spills past its right edge, the harness Claude pill runs under the Switch glyph instead of the
// Switch sitting fixed at the far right behind its hairline, and in option 3 the Agent pill is
// clipped inside the row rather than at the phone's edge. Drawn copies are not faithful enough
// here." So round three MOUNTS THE REAL `ActionsRow` (`components/actions-row.tsx`) inside a real
// 390px `PhoneMock`, the way `header-corner.tsx` mounts it for its own Switch-pill options — same
// fixture (`useRoomyActions`, `agent="claude"`, `onRun={took}`), same width, same real
// `OverflowEdges` measuring the real scroller. Nothing about the belt's own markup, fade or overflow
// math is redrawn; every option changes only the ONE thing it proposes, reached from outside through
// a wrapper `<div>` and Tailwind arbitrary-variant selectors — NO EDIT to `actions-row.tsx` or any
// other shipped file. The selectors reach the scroller through `[data-overflow]`, the attribute
// `OverflowEdges` (`ui/overflow-edges.tsx`) already draws on the scroller's own wrapper for real, so
// `[data-overflow]>div>div` is the real scroller `OverflowEdges` measures — not a guess, not a class
// added for this section.
//
// THE ONE THING STILL DRAWN: the fixed Switch cell. `ActionsRow` only draws its pinned Switch pill
// when handed a `handle` (a real drag-to-switch gesture object), which a static mock has none of —
// so every card here carries a copy of that pill, byte-for-byte the markup `actions-row.tsx` draws
// in its own `handle` branch, exactly as `header-corner.tsx`'s `BeltWithSwitch` already does for its
// own Switch-pill options. It is the ONE thing every option in this section holds fixed, so it is
// the one thing worth a shared, faithful copy rather than five improvised ones.
//
// OPTION 3 NEEDS NO DRAWN CUT EITHER. Giving the dock a narrower width than the phone makes
// `OverflowEdges` genuinely measure a smaller box and genuinely fade and cut a pill at THAT edge —
// the real fade, the real chevron, working against a real, smaller container, which is what "the row
// is laid out so the last pill is always cut" means as a design, not a screenshot trick.
//
// PhoneMock carries no theme toggle (see `shared.tsx`), so every card is drawn once, at the page's
// current theme, rather than twice — the ground each option proposes is legible in both, and the
// cards below are the same object under whichever theme the sidebar's own toggle is set to.
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
  id: "belt-ground",
  title: "Belt scroller ground",
  intent:
    "Round three, five numbered options for the actions belt's scrollable ground, this time on the " +
    "REAL ActionsRow inside a real 390px phone frame rather than a drawn copy — each option changes " +
    "one thing (a thumb, a track, a cut edge, a pattern, a tint), reached from outside through a " +
    "wrapper and Tailwind selectors, never a class added to actions-row.tsx itself. Say the number.",
};

// ── The Switch cell, the one thing every card draws a copy of ────────────────

/**
 * A byte-for-byte copy of `actions-row.tsx`'s own pinned Switch pill (the `handle` branch), pinned
 * over the same two-layer fade. `ActionsRow` only draws this when handed a real drag handle, which a
 * static mock has none of — `header-corner.tsx`'s `BeltWithSwitch` solved the same problem the same
 * way, and this is that copy, so both sections' Switch cells can never quietly drift apart from
 * `actions-row.tsx`'s real one without a person noticing both places.
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

// The Switch cell's own drawn width is 97px — `pr-3`(12) + `pl-8`(32) + the 44px pill, the same
// number `actions-row.tsx` names `SWITCH_PILL_INSET` for the real fade's own inset. `ScrollThumb`
// and `DotGrid` below both stop there (`right-[97px]`), written as that literal at each call site
// rather than composed from a shared constant: Tailwind v4 scans source TEXT for class names, so a
// class assembled at runtime from a variable compiles to no CSS at all — the same trap
// `actions-row.tsx` and `overflow-edges.tsx` document at their own literal strings.

// ── The belt itself: the REAL ActionsRow, a wrapper for selectors, the copied Switch cell ───────

interface BeltProps {
  /** Extra classes on the WRAPPER around the real `ActionsRow`. Arbitrary-variant selectors reach
   *  the real scroller through `[data-overflow]>div>div` — the attribute `OverflowEdges` draws on
   *  the scroller's own wrapper for real — and its pills through `[data-overflow]>div>div button`.
   *  No class is ever added to `actions-row.tsx` itself. */
  className?: string;
  /** Drawn ON TOP of the scroller's own area only, stopping short of the Switch cell's 97px —
   *  option 1's thumb, option 4's dot grid. The wrapper is `relative`, so this positions against it. */
  overlay?: ReactNode;
  /** Option 3 only: the dock's own width, in px, narrower than the phone — not a drawn cut, a
   *  smaller real box for the real `OverflowEdges` to measure and genuinely fade and cut against. */
  dockWidth?: number;
}

function Belt({ className, overlay, dockWidth }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div
      className={cn("relative bg-chrome px-3", className)}
      style={dockWidth !== undefined ? { width: dockWidth } : undefined}
    >
      <ActionsRow general={general} agent="claude" onRun={took} />
      {overlay}
      <FixedSwitchCell />
    </div>
  );
}

// ── Option 1: a thumb under the pills ─────────────────────────────────────────

/** A 2px track over the scroller's own area, stopping short of the Switch cell, with a short thumb
 *  showing roughly how much is off screen and where. Held static at the left third — the position a
 *  row at rest with more content to the right would report. */
function ScrollThumb() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-[97px] bottom-0.5 left-3 z-10 h-[2px] rounded-full bg-foreground/10"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-[4%] w-[28%] rounded-full bg-foreground/30"
      />
    </span>
  );
}

// ── Option 4: a faint dot grid on the moving surface ──────────────────────────

/** A dot every 6px, at `foreground/8` — a flat tint cut into dots by a repeating radial mask, so the
 *  colour still answers `bg-foreground/8` (light AND dark) rather than a hard-coded rgba. Drawn over
 *  the scroller's own area, stopping short of the Switch cell. */
function DotGrid() {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-0 left-0 right-[97px] z-10 bg-foreground/8",
        "[mask-image:radial-gradient(circle,black_1px,transparent_1.4px)] [mask-size:6px_6px] [mask-repeat:repeat]",
      )}
    />
  );
}

/** One card's mock: the belt over a quiet stand-in for the input row, in a phone-width box — the
 *  same shape `header-corner.tsx`'s `BeltCard` uses for the belt section there. */
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

export function BeltGroundSection() {
  return (
    <Section def={DEF}>
      <Group title="The belt — as today, then five options for its scroller, round three, on the real ActionsRow">
        <Card
          state="belt-ground-today"
          label="As today"
          reach="every pane's composer: the belt above the input row. This card is the real ActionsRow, unmodified."
          note="One ground for the whole band, `bg-foreground/6`. Nothing marks where the scroller ends and the fixed Switch cell begins."
        >
          <BeltCard>
            <Belt />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-1"
          label="Option 1 · Scroll thumb"
          reach="idea, not shipped: a 2px track and thumb would sit under actions-row.tsx's scroller."
          note="A thin thumb under the pills shows how much is off screen and where you are. It moves as you scroll. The Switch cell has no thumb, so it reads as fixed."
        >
          <BeltCard>
            <Belt overlay={<ScrollThumb />} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-2"
          label="Option 2 · Pills as cards on a recessed track"
          reach="idea, not shipped: the scroller would drop to bg-background with an inset shadow, each pill a small card."
          note="The pills become small cards on a sunken track. Cards on a track read as things you can slide. The Switch stays flat, so it reads as a button, not a card."
        >
          <BeltCard>
            <Belt
              className={cn(
                "[&_[data-overflow]>div>div]:bg-background",
                "[&_[data-overflow]>div>div]:shadow-[inset_0_1px_2px_0_rgba(0,0,0,0.15)]",
                "[&_[data-overflow]>div>div_button]:rounded-md",
                "[&_[data-overflow]>div>div_button]:border",
                "[&_[data-overflow]>div>div_button]:border-border",
                "[&_[data-overflow]>div>div_button]:bg-card",
                "[&_[data-overflow]>div>div_button]:shadow-sm",
              )}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-3"
          label="Option 3 · Half a pill always peeks"
          reach="idea, not shipped: the dock itself would be laid out narrower, so the real fade always cuts the last pill."
          note="The row is laid out so the last pill is always cut in half at the edge. A half pill says there is more. The fade and the chevron stay — they are the real ones, measuring a narrower row."
        >
          <BeltCard>
            <Belt dockWidth={300} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-4"
          label="Option 4 · Dotted track"
          reach="idea, not shipped: the scroller would carry a faint radial dot grid at foreground/8, 6px pitch."
          note="The scrolling part has a faint dot pattern under the pills. The fixed Switch cell has none. The pattern says this is a surface that moves."
        >
          <BeltCard>
            <Belt overlay={<DotGrid />} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-5"
          label="Option 5 · Tinted track"
          reach="idea, not shipped: the scroller would take bg-primary/8, the Switch cell stays on the band."
          note="The scrolling part takes a faint tint of the brand colour. The Switch cell stays grey. Colour marks the moving part."
        >
          <BeltCard>
            <Belt className="[&_[data-overflow]>div>div]:bg-primary/8" />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
