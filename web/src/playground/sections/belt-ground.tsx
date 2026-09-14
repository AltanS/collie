// Belt scroller ground ideas, round four: the operator picked a direction. Round one drew three
// shades of a hand-copied belt and all three were rejected ("all are bad, try again"). Round two
// drew five affordances on the same hand-copied belt and was caught as unfaithful: "the band is
// wider than the PhoneMock and spills past its right edge... Drawn copies are not faithful enough
// here." Round three mounted the REAL `ActionsRow` and tried five different affordances (a thumb, a
// track, a cut edge, a pattern, a tint) on it. The operator's verdict on THAT round: option 5,
// the tint, is the one he likes — scrap the rest. Round four is six numbered variations on that one
// idea, all on the real `ActionsRow`: colour and strength, nothing else changes.
//
// STILL THE REAL ActionsRow (`components/actions-row.tsx`), inside a real 390px `PhoneMock`, the
// way `header-corner.tsx` mounts it for its own Switch-pill options — same fixture
// (`useRoomyActions`, `agent="claude"`, `onRun={took}`), same width, same real `OverflowEdges`
// measuring the real scroller. Every option reaches the scroller from OUTSIDE, through a wrapper
// `<div>` and a Tailwind arbitrary-variant selector on `[data-overflow]>div>div` — the attribute
// `OverflowEdges` (`ui/overflow-edges.tsx`) already draws on the scroller's own wrapper for real —
// never a class added to `actions-row.tsx` itself.
//
// THE ONE THING STILL DRAWN: the fixed Switch cell. `ActionsRow` only draws its pinned Switch pill
// when handed a `handle` (a real drag-to-switch gesture object), which a static mock has none of —
// so every card here carries a copy of that pill, byte-for-byte the markup `actions-row.tsx` draws
// in its own `handle` branch, exactly as `header-corner.tsx`'s `BeltWithSwitch` already does for its
// own Switch-pill options.
//
// OPTION 5's ACCENT IS THE REAL ONE. It reads `AGENT_BRANDS` the same way `harness-bar.tsx`'s own
// `accentFor` does, and hands it to the wrapper as a CSS custom property (`--belt-tint`) that the
// scroller's own tint utility resolves at paint time — the same shape `overflow-edges.tsx` already
// uses for `--edge-inset-right`, never a class assembled from a JS string (Tailwind scans source
// TEXT; a class built at runtime from a variable compiles to no CSS at all).
//
// PhoneMock carries no theme toggle (see `shared.tsx`), so every card is drawn once, at the page's
// current theme, rather than twice — every tint here answers a CSS variable or an alpha wash of a
// themed colour, so it is legible in both, and the cards below are the same object under whichever
// theme the sidebar's own toggle is set to.
//
// DEV-ONLY, unreachable from the app entry.

import type { CSSProperties, ReactNode } from "react";
import { Layers } from "lucide-react";

import { ActionsRow } from "@/components/actions-row";
import { AGENT_BRANDS } from "@/components/agent-icon-data";
import { STRIP_ROW_PILL } from "@/components/ui/labelled-strip";
import { canonicalAgent } from "@/lib/operator-scope";
import { cn } from "@/lib/utils";

import { Card, Group, Section, type SectionDef } from "../harness";
import { ChromeBlock, PhoneMock, took, useRoomyActions } from "./shared";

export const DEF: SectionDef = {
  id: "belt-ground",
  title: "Belt scroller ground",
  intent:
    "Round four: the operator picked the tint from round three's five affordances. Six numbered " +
    "variations on it, colour and strength only, all on the REAL ActionsRow inside a real 390px " +
    "phone frame, reached from outside through a wrapper and a Tailwind selector, never a class " +
    "added to actions-row.tsx itself. Say the number.",
};

/** Claude's own brand accent, read the way `harness-bar.tsx`'s own `accentFor` reads it — through
 *  `AGENT_BRANDS`, keyed by `canonicalAgent`. Every card here mounts on `agent="claude"`, so this is
 *  computed once rather than re-derived per card. */
const CLAUDE_ACCENT = AGENT_BRANDS.get(canonicalAgent("claude"))?.accent;

// SAFETY: `--belt-tint` is a custom property, which `CSSProperties` has no key for — the same
// widening `overflow-edges.tsx` does at its own `maskStyle` for `--edge-inset-right`. The object
// carries no other key, so nothing but the custom property rides through this cast.
const OPTION_5_STYLE: (CSSProperties & Record<string, string>) | undefined =
  CLAUDE_ACCENT !== undefined ? ({ "--belt-tint": CLAUDE_ACCENT } as CSSProperties & Record<string, string>) : undefined;

// ── The Switch cell, the one thing every card draws a copy of ────────────────

/**
 * A byte-for-byte copy of `actions-row.tsx`'s own pinned Switch pill (the `handle` branch), pinned
 * over the same two-layer fade. `ActionsRow` only draws this when handed a real drag handle, which a
 * static mock has none of — `header-corner.tsx`'s `BeltWithSwitch` solved the same problem the same
 * way, and this is that copy, so both sections' Switch cells can never quietly drift apart from
 * `actions-row.tsx`'s real one without a person noticing both places.
 */
function FixedSwitchCell({ groundClassName = "bg-foreground/6" }: { groundClassName?: string }) {
  return (
    <span className="absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-8">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-chrome [mask-image:linear-gradient(to_right,transparent,black_2rem)]"
      >
        {/* The belt's own ground, `bg-foreground/6`, by default — option 6 alone drops this to
            `bg-background` so the fixed cell reads as plain against a tinted, moving track. */}
        <span className={cn("absolute inset-0", groundClassName)} />
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

// ── The belt itself: the REAL ActionsRow, a wrapper for the tint selector, the copied Switch cell ──

interface BeltProps {
  /** The tint, as a Tailwind arbitrary-variant class reaching the real scroller through
   *  `[data-overflow]>div>div` — the attribute `OverflowEdges` draws on the scroller's own wrapper
   *  for real. No class is ever added to `actions-row.tsx` itself. */
  className: string;
  /** Option 5 only: `--belt-tint`, the harness accent the tint class resolves via `var()`. */
  style?: CSSProperties;
  /** Option 6 only: the Switch cell's own ground drops to `bg-background`. Every other option
   *  leaves it at the belt's default, `bg-foreground/6`. */
  switchCellClassName?: string;
}

function Belt({ className, style, switchCellClassName }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div className={cn("relative bg-chrome px-3", className)} style={style}>
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell groundClassName={switchCellClassName} />
    </div>
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
      <Group title="The belt — as today, then six tints for its scroller, round four, on the real ActionsRow">
        <Card
          state="belt-ground-today"
          label="As today"
          reach="every pane's composer: the belt above the input row. This card is the real ActionsRow, unmodified."
          note="Shipped: the band's own ground is bg-foreground/6, the scroller inside it takes a faint brand tint (bg-primary/10), and the fixed Switch cell drops to plain bg-background — the moving part and the fixed part read apart."
        >
          <BeltCard>
            <Belt className="" switchCellClassName="bg-background" />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-1"
          label="Option 1 · Tint, faint"
          reach="idea, not shipped: the scroller would take bg-primary/6 over its own ground."
          note="The scrolling part takes a very faint wash of the brand colour, six percent. It is barely there, a quiet hint rather than a mark."
        >
          <BeltCard>
            <Belt className="[&_[data-overflow]>div>div]:bg-primary/6" />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-2"
          label="Option 2 · Tint, ten percent"
          reach="idea, not shipped: the scroller would take bg-primary/10 over its own ground."
          note="The scrolling part takes the brand colour at ten percent. The tint reads clearly without shouting."
        >
          <BeltCard>
            <Belt className="[&_[data-overflow]>div>div]:bg-primary/10" />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-3"
          label="Option 3 · Tint, strong"
          reach="idea, not shipped: the scroller would take bg-primary/16 over its own ground."
          note="The scrolling part takes a strong wash of the brand colour, sixteen percent. The moving surface is unmistakable."
        >
          <BeltCard>
            <Belt className="[&_[data-overflow]>div>div]:bg-primary/16" />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-4"
          label="Option 4 · Cool blue, not the brand"
          reach="idea, not shipped: the scroller would take bg-status-info/10, the app's own cool blue, in place of the brand colour."
          note="The scrolling part takes the app's cool blue instead of the brand colour, at ten percent. Blue marks it as a system surface, not a brand one."
        >
          <BeltCard>
            <Belt className="[&_[data-overflow]>div>div]:bg-status-info/10" />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-5"
          label="Option 5 · The open pane's own harness colour"
          reach="idea, not shipped: the scroller would take the open pane's own harness accent at 10%, the same colour the harness segment's brand fill already uses."
          note="The scrolling part takes the open pane's own harness colour, at ten percent. On a Claude pane, shown here, the track picks up Claude's own orange."
        >
          <BeltCard>
            <Belt
              className="[&_[data-overflow]>div>div]:bg-[color-mix(in_oklab,var(--belt-tint)_10%,transparent)]"
              style={OPTION_5_STYLE}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-6"
          label="Option 6 · Tinted track, plain Switch cell"
          reach="shipped in components/actions-row.tsx: the scroller takes bg-primary/10 and the fixed Switch cell's own ground drops to bg-background."
          note="Shipped. The scrolling part takes the brand colour at ten percent, and the Switch cell drops to plain background. The contrast between the two is the strongest here."
        >
          <BeltCard>
            <Belt
              className="[&_[data-overflow]>div>div]:bg-primary/10"
              switchCellClassName="bg-background"
            />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
