// Belt shade ideas, round eight. The operator picked belt-cue.tsx's option 1 — the compact band
// with today's shipped 32px chrome fade — over every other cue round seven tried, and asked for
// "more shade options": more takes on that ONE fade, not a fresh cue. So this round holds the shape
// belt-cue's option 1 settled (COMPACT, the shipped fade) and varies only the fade itself: its
// width, its curve, what colour it fades FROM, and two ways of decorating it further (a draining
// tint, a faint shadow) without replacing it.
//
// COMPACT CARRIES OVER FROM BELT-CUE.TSX UNCHANGED: every card here drops the scroller's own
// `py-1.5` (`[&_[data-overflow]>div>div]:py-0`, band is 32px not 44px) and the composer row's own
// `mb-1.5` shrinks to `mb-1` (`[&_[data-slot=composer-actions]]:mb-1`) — reached the usual way,
// through a wrapper selector, never a class added to `actions-row.tsx` or `overflow-edges.tsx`
// themselves.
//
// THE LEFT MASK IS LEFT ALONE ON EVERY CARD. This round is about the RIGHT end, the fixed Switch
// cell's own lead-in, and belt-cue's option 1 already kept the shipped left mask untouched — so
// every card here does too, and none of them clears it. There is no `CLEAR_MASK` constant in this
// file for that reason.
//
// `FixedSwitchCell` IS CARRIED OVER AGAIN, WIDER THIS TIME: `leadIn` now takes the `{ pl, mask }`
// SHAPE DIRECTLY, an object per card, rather than a named key into a lookup table — this round
// stages eight distinct widths and curves, so a table of names would just be eight one-off entries
// standing in the way. `leadInGround` is unchanged, a plain class string, `"bg-chrome"` by default.
// Option 5 alone needs a FOURTH thing: `cellGroundClassName`, an explicit chrome ground on the cell
// PROPER (the hairline-and-button span, past the lead-in) — see that card and the prop's own comment
// for why a translucent `leadInGround` needs it.
//
// OPTION 6's DRAINING TINT AND OPTION 8's INSET SHADOW BOTH USE `rgba`/`color-mix` VALUES THAT READ
// IN BOTH THEMES WITHOUT A `dark:` VARIANT — the shadow is plain black, which only ever darkens a
// ground lighter than itself (true in both themes here), and the tint drain is `color-mix(in oklab,
// var(--color-primary) 10%, transparent)`, the exact recipe belt-ground.tsx's own option 5 uses for
// the harness accent, fading to fully transparent rather than to a flat colour, so it reads correctly
// against either theme's chrome.
//
// STILL THE REAL ActionsRow (`components/actions-row.tsx`), mounted the way belt-cue.tsx mounts it
// (`useRoomyActions`, `agent="claude"`, `onRun={took}`, no `handle`), inside the same `BeltCard`
// phone mock. Every option reaches the scroller, `OverflowEdges`'s wrapper and the composer row from
// OUTSIDE, through wrapper selectors — never a class added to `actions-row.tsx` or
// `overflow-edges.tsx` themselves.
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
    "Round eight: the operator picked belt-cue's option 1, the compact band with today's shipped " +
    "fade, over every other cue. \"Give more shade options\" — nine cards, all on that one fade, " +
    "varying its width, curve and colour on the REAL ActionsRow. Say the number.",
};

// ── Shared: compaction, and the fade shape itself ─────────────────────────────

/** COMPACT, carried over from belt-cue.tsx unchanged — every card in this file carries it,
 *  including "As today", which is belt-cue's own option 1 and already compact. */
const COMPACT = "[&_[data-overflow]>div>div]:py-0 [&_[data-slot=composer-actions]]:mb-1";

/** The shipped 32px chrome fade — "As today", option 6 and option 8 all reuse this exact shape
 *  unchanged, because those three cards vary something OTHER than the fade itself. */
const FADE_32 = {
  pl: "pl-8",
  mask: "[mask-image:linear-gradient(to_right,transparent,black_2rem)]",
};

/** The fade shape the fixed Switch cell's lead-in follows: how far it reaches (`pl`) and the
 *  gradient it fades through (`mask`), as a literal pair rather than a named key — see this file's
 *  header for why. */
interface LeadIn {
  pl: string;
  mask: string;
}

/**
 * belt-cue.tsx's own `FixedSwitchCell`, widened: `leadIn` takes the `{ pl, mask }` shape directly,
 * and a new `cellGroundClassName` prop, option 5 alone.
 *
 * WHY `cellGroundClassName` EXISTS: every layer inside the masked backdrop (`bg-chrome`,
 * `bg-foreground/6`, `leadInGround`) spans the WHOLE cell, lead-in and cell-proper both — the mask
 * is what confines the FADE to the lead-in's own width, not the layers' own boxes. That is fine
 * while `leadInGround` is opaque (the default, `bg-chrome`): once the mask is fully open, an opaque
 * top layer is the only colour that shows, so the cell-proper reads as solid chrome for free.
 * Option 5's `leadInGround` (`bg-foreground/14`) is deliberately NOT opaque — the whole point is a
 * shade the pills read as a shadow — so left alone, that translucency would keep showing past the
 * lead-in too, tinting the hairline and the button. `cellGroundClassName` draws an explicit,
 * OPAQUE ground on the cell-proper's own span instead (`relative`, so it paints in its own stacking
 * position ABOVE the masked backdrop behind it, the same way the real Switch button's own
 * `STRIP_TAP_TARGET` class already does with `relative` for its tap-target `::before`), so the
 * shade stays confined to the lead-in and the button keeps reading as chrome.
 */
function FixedSwitchCell({
  leadIn,
  leadInGround = "bg-chrome",
  cellGroundClassName,
}: {
  leadIn: LeadIn;
  leadInGround?: string;
  /** Option 5 only — see this function's own header comment. */
  cellGroundClassName?: string;
}) {
  return (
    <span className={cn("absolute inset-y-0 right-0 z-10 flex items-center pr-3", leadIn.pl)}>
      <span aria-hidden className={cn("pointer-events-none absolute inset-0 bg-chrome", leadIn.mask)}>
        <span className="absolute inset-0 bg-foreground/6" />
        {leadInGround !== "none" && <span className={cn("absolute inset-0", leadInGround)} />}
      </span>
      <span
        className={cn(
          "flex items-center self-stretch",
          cellGroundClassName && "relative",
          cellGroundClassName,
        )}
      >
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

// ── The belt itself: the REAL ActionsRow, a wrapper for the wide-band selectors ──────────────────

interface BeltProps {
  /** The track's own extra look — option 6's draining tint, option 8's inset shadow — reached
   *  through `[data-overflow]` and its children, never a class added to `actions-row.tsx` or
   *  `overflow-edges.tsx` themselves. */
  className?: string;
  leadIn: LeadIn;
  leadInGround?: string;
  cellGroundClassName?: string;
}

function Belt({ className, leadIn, leadInGround, cellGroundClassName }: BeltProps) {
  const general = useRoomyActions();
  return (
    <div className={cn("relative bg-chrome px-3", COMPACT, className)}>
      <ActionsRow general={general} agent="claude" onRun={took} />
      <FixedSwitchCell leadIn={leadIn} leadInGround={leadInGround} cellGroundClassName={cellGroundClassName} />
    </div>
  );
}

/** One card's mock: the belt over a quiet stand-in for the input row, in a phone-width box — the
 *  same shape belt-cue.tsx's own `BeltCard` uses. */
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

export function BeltShadeSection() {
  return (
    <Section def={DEF}>
      <Group title="The belt, compact with today's fade, then eight variations on that one fade, round eight, on the real ActionsRow">
        <Card
          state="belt-shade-today"
          label="As today"
          reach="belt-cue's own option 1: the compact 32px band, with the fixed Switch cell's shipped 32px chrome fade and the scroller's own left mask, both unchanged."
          note="The reference every other card in this section varies from. Only the fade itself changes below; the band stays this height throughout."
        >
          <BeltCard>
            <Belt leadIn={FADE_32} />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-1"
          label="Option 1 · Short fade, 16px"
          reach="idea, not shipped: the fixed cell's own lead-in would shrink to 16px, half the shipped width."
          note="A tighter dissolve. Less of the last pill is obscured, and the cell reads as a smaller intrusion on the row."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-4",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
              }}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-2"
          label="Option 2 · Long fade, 48px"
          reach="idea, not shipped: the fixed cell's own lead-in would grow to 48px, half again the shipped width."
          note="A slower dissolve. More of the belt reads as transitional rather than as clean track, which may be too much room given up to a fade alone."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-12",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_3rem)]",
              }}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-3"
          label="Option 3 · Eased fade, 32px"
          reach="idea, not shipped: the same 32px lead-in as today, but the gradient would hold near-transparent for its first half and only finish opaque in the second."
          note="A slow start and a fast finish, rather than a straight line. A pill stays legible longer before it dissolves, then disappears over a shorter stretch."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-8",
                mask:
                  "[mask-image:linear-gradient(to_right,transparent,rgba(0,0,0,0.25)_45%,black_2rem)]",
              }}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-4"
          label="Option 4 · Fade into the band, not chrome"
          reach="idea, not shipped: the same 32px lead-in as today, but its top ground layer would be the belt's own band grey instead of chrome."
          note="Pills melt into the band's own grey rather than into the composer's chrome. Only the cell past the hairline still reads as chrome."
        >
          <BeltCard>
            <Belt leadIn={FADE_32} leadInGround="bg-foreground/6" />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-5"
          label="Option 5 · Shade, a darker lead-in"
          reach="idea, not shipped: the same 32px lead-in as today, but its top ground layer would be a darker wash than the track itself, and the cell past the hairline would carry its own explicit chrome ground."
          note="The lead-in reads as a shadow cast onto the pills rather than a fade into a surface. The button and hairline stay pure chrome throughout, unaffected by the darker wash beside them."
        >
          <BeltCard>
            <Belt leadIn={FADE_32} leadInGround="bg-foreground/14" cellGroundClassName="bg-chrome" />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-6"
          label="Option 6 · The tint drains out"
          reach="idea, not shipped: the fixed cell's own fade would stay exactly as today, but the track's own brand tint would fade away to nothing over its last 64px, rather than stopping abruptly at the cell."
          note="The pills still dissolve into chrome at the cell, same as today, but the colour underneath them has already drained away before they get there. Two fades agreeing rather than one hard stop."
        >
          <BeltCard>
            <Belt
              leadIn={FADE_32}
              className={cn(
                "[&_[data-overflow]]:bg-[linear-gradient(to_right,color-mix(in_oklab,var(--color-primary)_10%,transparent)_calc(100%-6rem),transparent_calc(100%-2rem))]",
                "[&_[data-overflow]>div>div]:bg-transparent",
              )}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-7"
          label="Option 7 · Fade that ends before the hairline"
          reach="idea, not shipped: the fixed cell would keep the shipped 32px width, but the gradient itself would finish at 24px, leaving the last 8px before the hairline solid chrome with no gradient left to cross."
          note="A short flat margin of solid chrome sits between the dissolve and the hairline, rather than the fade running all the way up to it. The cell reads as having a quiet edge of its own."
        >
          <BeltCard>
            <Belt
              leadIn={{
                pl: "pl-8",
                mask: "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]",
              }}
            />
          </BeltCard>
        </Card>

        <Card
          state="belt-shade-option-8"
          label="Option 8 · Fade plus a faint inset shadow"
          reach="idea, not shipped: the fixed cell's own fade would stay exactly as today, and the track's own wrapper would additionally carry a faint inner shadow at its right end."
          note="The fade does the same work it does today, and a second, quieter shadow sits just inside the track's own edge underneath it. Two weak cues rather than one strong one."
        >
          <BeltCard>
            <Belt
              leadIn={FADE_32}
              className="[&_[data-overflow]]:shadow-[inset_-14px_0_12px_-10px_rgba(0,0,0,0.12)]"
            />
          </BeltCard>
        </Card>
      </Group>
    </Section>
  );
}
