// Belt scroller ground ideas, round two: FIVE numbered options for the actions belt's own ground.
// Altan rejected the first round's three options outright ("all are bad, try again") — those three
// only changed the SHADE of the scroller (darker, inset well, lighter). This round changes the
// AFFORDANCE instead: something about the scroller's surface itself, or a mark on it, that says
// "this moves" rather than just "this is a different grey". The goal is unchanged: make it clear the
// belt's pill row SCROLLS, while the Switch glyph cell at the right is fixed. Say "option N" and be
// understood, the same pattern `header-corner.tsx`, `header-meta.tsx` and `strips-compact.tsx` use.
//
// WHAT IS REAL AND WHAT IS DRAWN. `ActionsRow` has no prop for a second ground under its own
// scroller — the band, the scroller and the pinned Switch cell are one class string apiece in that
// file — so every card here is DRAWN, copied class for class from `actions-row.tsx` and
// `components/ui/labelled-strip.tsx` (`STRIP_ROW_PILL`, `BELT_SECTION`). Only the one thing an
// option proposes changes between cards.
//
// THE FIXTURE. The general pills `Keys`, `Type`, `Quick`, `Agent`, then the harness section
// (`Claude`, tinted, plus a second pill so the row genuinely overflows a 390px phone), then the
// pinned Switch glyph behind its hairline. Every card is built so the last visible pill sits partly
// cut at the edge, with the chevron mark `ui/overflow-edges.tsx` draws for real over the fade — the
// same "there is more this way" cue, held static here since every card must be readable without a
// gesture.
//
// PhoneMock carries no theme toggle (see `shared.tsx`), so every card is drawn once, at the page's
// current theme, rather than twice — the ground each option proposes is legible in both, and the
// cards below are the same object under whichever theme the sidebar's own toggle is set to.
//
// DEV-ONLY, unreachable from the app entry.

import type { ReactNode } from "react";
import { ChevronRight, Keyboard, Layers, Slash, Terminal, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { BELT_SECTION, STRIP_ROW_PILL } from "@/components/ui/labelled-strip";
import { cn } from "@/lib/utils";

import { Card, Group, Section, type SectionDef } from "../harness";
import { ChromeBlock, PhoneMock } from "./shared";

export const DEF: SectionDef = {
  id: "belt-ground",
  title: "Belt scroller ground",
  intent:
    "Round two, five numbered options for the actions belt's scrollable ground — each one changes " +
    "the affordance (a thumb, a track, a cut edge, a pattern, a tint), not just the shade the first " +
    "round tried. The belt is drawn here, copied class for class from actions-row.tsx, so the part " +
    "that scrolls reads as clearly different from the fixed Switch cell at its end. Say the number.",
};

// ── The pills every card carries ─────────────────────────────────────────────

const GENERAL: readonly { label: string; icon: LucideIcon }[] = [
  { label: "Keys", icon: Keyboard },
  { label: "Type", icon: Terminal },
  { label: "Quick", icon: Zap },
  { label: "Agent", icon: Slash },
];

function GeneralPill({
  label,
  icon: Icon,
  pillClassName,
}: {
  label: string;
  icon: LucideIcon;
  pillClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        `${STRIP_ROW_PILL} flex items-center gap-1.5 text-xs text-muted-foreground`,
        pillClassName,
      )}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </span>
  );
}

/** The harness section, `BELT_SECTION`'s own recipe, tinted for Claude — plus a second pill
 *  ("Model") so the row is wider than a 390px phone and genuinely overflows on every card.
 *  `pillClassName` lets an option (option 2's cards) carry the same treatment onto these pills. */
function HarnessSection({ pillClassName }: { pillClassName?: string }) {
  return (
    <div className={cn(BELT_SECTION, "border-l-0 bg-primary/10")}>
      <span
        aria-hidden
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-primary",
          pillClassName,
        )}
      >
        Claude
      </span>
      <span
        aria-hidden
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-primary",
          pillClassName,
        )}
      >
        Model
      </span>
    </div>
  );
}

/** The scroll cue: a small chevron over the fade, static rather than measured — every card here must
 *  read without a gesture, so this is what `ui/overflow-edges.tsx`'s right-hand cue looks like at
 *  rest, drawn rather than driven by a `ResizeObserver`. */
function ScrollCue() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-[58px] z-20 flex items-center"
    >
      <ChevronRight className="size-3.5 text-muted-foreground/70" />
    </span>
  );
}

// ── The belt itself, parametrised by the one thing each option changes ───────

interface BeltGrounds {
  /** Extra classes on the SCROLLER — the part that pans. Empty string = the band's own ground. */
  scroller?: string;
  /** Extra classes on the fixed Switch cell. Empty string = the band's own ground (today's case). */
  switchCell?: string;
  /** Extra classes carried onto every pill (general and harness alike) — option 2's cards. */
  pillClassName?: string;
  /** Something drawn ON TOP of the scroller's own area (never under the Switch cell, which is a
   *  sibling, not a descendant) — option 1's thumb, option 4's dot grid. */
  overlay?: ReactNode;
}

/**
 * The belt, copied from `actions-row.tsx`'s own markup: the full-bleed band (`bg-foreground/6`), a
 * scroller carrying the general pills and the harness section, and the Switch mark pinned at the
 * right behind a hairline. `grounds` is the only thing that varies between cards.
 */
function Belt({ grounds }: { grounds: BeltGrounds }) {
  return (
    <div className="relative flex items-center overflow-hidden border-b border-border bg-foreground/6">
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-3 py-1.5 pr-16 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            grounds.scroller,
          )}
        >
          {GENERAL.map((action) => (
            <GeneralPill key={action.label} {...action} pillClassName={grounds.pillClassName} />
          ))}
          <HarnessSection pillClassName={grounds.pillClassName} />
        </div>
        {grounds.overlay}
      </div>
      <ScrollCue />
      {/* The fixed Switch cell — a sibling of the scroller, never inside it, exactly as
          actions-row.tsx's pinned span sits outside the masked subtree. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-3",
          grounds.switchCell,
        )}
      >
        <span aria-hidden className="mr-2 h-5 w-px bg-border" />
        <span className={cn(`${STRIP_ROW_PILL} relative flex items-center justify-center border-0 px-0`)}>
          <Layers className="size-4 shrink-0 text-primary" />
        </span>
      </span>
    </div>
  );
}

// ── Option 1: a thumb under the pills ─────────────────────────────────────────

/** A 2px track the full width of the scroller's own area, with a short thumb showing roughly how
 *  much is off screen and where. Held static at the left third — the position a row at rest with
 *  more content to the right would report. */
function ScrollThumb() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-3 bottom-0.5 h-[2px] rounded-full bg-foreground/10"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-[4%] w-[28%] rounded-full bg-foreground/30"
      />
    </span>
  );
}

// ── Option 3: a pill capped so it always reads as cut in half ────────────────

/** `Agent`'s own box, deliberately narrower than its content — the icon plus the full word "Agent"
 *  clip inside a fixed 40px box, so the cut is guaranteed by the box itself rather than by however
 *  the rest of the row happens to measure. `ml-auto` holds it flush against the fade, every time. */
function CutAgentPill() {
  return (
    <span
      aria-hidden
      className="ml-auto flex h-8 w-10 shrink-0 items-center gap-1.5 overflow-hidden px-2 text-xs text-muted-foreground"
    >
      <Slash className="size-4 shrink-0" />
      Agent
    </span>
  );
}

/** Option 3's own belt: it does not route through {@link Belt} because the cut is a LAYOUT change
 *  (a capped pill flush against the edge, a stronger fade), not a ground swap. The harness section
 *  still has to reach the DOM — the section's own test checks every card for "Claude" — so it renders
 *  in an `sr-only` box that draws nothing, since option 3's whole point is that nothing past `Agent`
 *  is meant to be visible here. */
function Option3Belt() {
  return (
    <div className="relative flex items-center overflow-hidden border-b border-border bg-foreground/6">
      <div className="relative flex min-w-0 flex-1 items-center">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-3 py-1.5 pr-16",
            "[mask-image:linear-gradient(to_right,black_calc(100%-40px),transparent)]",
          )}
        >
          <GeneralPill label="Keys" icon={Keyboard} />
          <GeneralPill label="Type" icon={Terminal} />
          <GeneralPill label="Quick" icon={Zap} />
          <CutAgentPill />
        </div>
        <span className="sr-only">Claude Model</span>
      </div>
      <ScrollCue />
      <span aria-hidden className="absolute inset-y-0 right-0 z-10 flex items-center pr-3 pl-3">
        <span aria-hidden className="mr-2 h-5 w-px bg-border" />
        <span className={cn(`${STRIP_ROW_PILL} relative flex items-center justify-center border-0 px-0`)}>
          <Layers className="size-4 shrink-0 text-primary" />
        </span>
      </span>
    </div>
  );
}

// ── Option 4: a faint dot grid on the moving surface ──────────────────────────

/** A dot every 6px, at `foreground/8` — a flat tint cut into dots by a repeating radial mask, so the
 *  colour still answers `bg-foreground/8` (light AND dark) rather than a hard-coded rgba. */
function DotGrid() {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 bg-foreground/8",
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
        <div className="bg-chrome px-3">{children}</div>
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
      <Group title="The belt — as today, then five options for its scroller, round two">
        <Card
          state="belt-ground-today"
          label="As today"
          reach="every pane's composer: the belt above the input row."
          note="One ground for the whole band, `bg-foreground/6`. Nothing marks where the scroller ends and the fixed Switch cell begins."
        >
          <BeltCard>
            <Belt grounds={{}} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-1"
          label="Option 1 · Scroll thumb"
          reach="idea, not shipped: a 2px track and thumb drawn under actions-row.tsx's scroller."
          note="A thin thumb under the pills shows how much is off screen and where you are. It moves as you scroll. The Switch cell has no thumb, so it reads as fixed."
        >
          <BeltCard>
            <Belt grounds={{ overlay: <ScrollThumb /> }} />
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
              grounds={{
                scroller: "bg-background shadow-[inset_0_1px_2px_0_rgba(0,0,0,0.15)]",
                pillClassName: "rounded-md border border-border bg-card shadow-sm",
              }}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-3"
          label="Option 3 · Half a pill always peeks"
          reach="idea, not shipped: the scroller's layout would cap its last pill flush against the edge mask."
          note="The row is laid out so the last pill is always cut in half at the edge. A half pill says there is more. The fade and the chevron stay."
        >
          <BeltCard>
            <Option3Belt />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-4"
          label="Option 4 · Dotted track"
          reach="idea, not shipped: the scroller would carry a faint radial dot grid at foreground/8, 6px pitch."
          note="The scrolling part has a faint dot pattern under the pills. The fixed Switch cell has none. The pattern says this is a surface that moves."
        >
          <BeltCard>
            <Belt grounds={{ overlay: <DotGrid /> }} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-5"
          label="Option 5 · Tinted track"
          reach="idea, not shipped: the scroller would take bg-primary/8, the Switch cell stays on the band."
          note="The scrolling part takes a faint tint of the brand colour. The Switch cell stays grey. Colour marks the moving part."
        >
          <BeltCard>
            <Belt grounds={{ scroller: "bg-primary/8" }} />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
