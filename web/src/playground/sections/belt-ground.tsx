// Belt scroller ground ideas: THREE numbered options for the actions belt's own ground. Altan likes
// the belt (`components/actions-row.tsx`'s full-bleed band) and wants the part that SCROLLS to carry
// a different background from the part that doesn't, so the row reads as clearly scrollable rather
// than as one flat strip. This section exists so he can say "option N" and be understood, the same
// pattern `header-corner.tsx`, `header-meta.tsx` and `strips-compact.tsx` already use.
//
// WHAT IS REAL AND WHAT IS DRAWN. `ActionsRow` has no prop for a second ground under its own
// scroller — the band, the scroller and the pinned Switch cell are one class string apiece in that
// file — so every card here is DRAWN, copied class for class from `actions-row.tsx` and
// `components/ui/labelled-strip.tsx` (`STRIP_ROW_PILL`, `BELT_SECTION`). Only the one thing an
// option proposes — the scroller's fill, the Switch cell's fill — changes between cards.
//
// THE FIXTURE. The general pills `Keys`, `Type`, `Quick`, `Agent`, then the harness section
// (`Claude`, tinted, plus a second pill so the row genuinely overflows a 390px phone), then the
// pinned Switch glyph behind its hairline. Every card is built wide enough that the last pill sits
// partly under the fixed Switch cell, with a small chevron mark over the fade — the same "there is
// more this way" cue `ui/overflow-edges.tsx` draws for real, held static here since every card must
// be readable without a gesture.
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
    "Three numbered options for the actions belt's scrollable ground, so the part that scrolls " +
    "reads as clearly different from the fixed Switch cell at its end. The belt is drawn here, " +
    "copied class for class from actions-row.tsx, wide enough on every card that the last pill sits " +
    "partly under the fixed cell and a scroll chevron shows. Say the number.",
};

// ── The pills every card carries ─────────────────────────────────────────────

const GENERAL: readonly { label: string; icon: LucideIcon }[] = [
  { label: "Keys", icon: Keyboard },
  { label: "Type", icon: Terminal },
  { label: "Quick", icon: Zap },
  { label: "Agent", icon: Slash },
];

function GeneralPill({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  return (
    <span
      aria-hidden
      className={cn(`${STRIP_ROW_PILL} flex items-center gap-1.5 text-xs text-muted-foreground`)}
    >
      <Icon className="size-4 shrink-0" />
      {label}
    </span>
  );
}

/** The harness section, `BELT_SECTION`'s own recipe, tinted for Claude — plus a second pill
 *  ("Model") so the row is wider than a 390px phone and genuinely overflows on every card. */
function HarnessSection() {
  return (
    <div className={cn(BELT_SECTION, "border-l-0 bg-primary/10")}>
      <span
        aria-hidden
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-primary"
      >
        Claude
      </span>
      <span
        aria-hidden
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-primary"
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
}

/**
 * The belt, copied from `actions-row.tsx`'s own markup: the full-bleed band (`bg-foreground/6`), a
 * scroller carrying the general pills and the harness section, and the Switch mark pinned at the
 * right behind a hairline. `grounds` is the only thing that varies between cards.
 */
function Belt({ grounds }: { grounds: BeltGrounds }) {
  return (
    <div className="relative flex items-center overflow-hidden border-b border-border bg-foreground/6">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-3 py-1.5 pr-16 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          grounds.scroller,
        )}
      >
        {GENERAL.map((action) => (
          <GeneralPill key={action.label} {...action} />
        ))}
        <HarnessSection />
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
      <Group title="The belt — as today, then three options for its scroller">
        <Card
          state="belt-ground-today"
          label="As today"
          reach="every pane's composer: the belt above the input row."
          note="One ground for the whole band, `bg-foreground/6`. The scroller and the fixed Switch cell read as the same surface — nothing marks where one ends and the other begins."
        >
          <BeltCard>
            <Belt grounds={{}} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-1"
          label="Option 1 · Darker track"
          reach="idea, not shipped: actions-row.tsx's scroller div would take its own `bg-background`."
          note="The scrolling part sits one step darker than the band. The Switch cell keeps the band's colour, so the fixed part and the moving part differ."
        >
          <BeltCard>
            <Belt grounds={{ scroller: "bg-background" }} />
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-2"
          label="Option 2 · Inset well"
          reach="idea, not shipped: the scroller would gain a rounded, inset ground of its own inside the band."
          note="The scrolling part is a shallow well inside the band, with rounded ends. It reads as a track you can drag."
        >
          <BeltCard>
            <div className="p-[2px]">
              <Belt
                grounds={{
                  scroller: "mx-[2px] my-[2px] rounded-md bg-background/60 shadow-inner",
                }}
              />
            </div>
          </BeltCard>
        </Card>

        <Card
          state="belt-ground-option-3"
          label="Option 3 · Lighter track"
          reach="idea, not shipped: the scroller would take `bg-foreground/10`, the Switch cell `bg-background`."
          note="The scrolling part is lighter than the rest. The Switch cell is plain background, so it reads as a button outside the track."
        >
          <BeltCard>
            <Belt grounds={{ scroller: "bg-foreground/10", switchCell: "bg-background" }} />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
