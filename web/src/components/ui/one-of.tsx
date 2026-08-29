import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One box, several alternatives, exactly one of them shown — and the box is as big as the BIGGEST
 * of them, always.
 *
 * This is the app's answer to DESIGN.md §2 for the case the transparent-border technique cannot
 * reach. §2's canonical fix reserves an *edge*; it says nothing about a run of TEXT whose word
 * changes with the state. "needs you" is 54.6px and "done" is 27.9px, so a strip that renders one
 * or the other has two widths, and everything beside it moves when the state changes. Reserving a
 * pixel number is not a fix either: the same slot is "braucht dich" (72.2px) in German and
 * "desconocido" (70.0px) in Spanish, so any constant clips one language or wastes space in another.
 *
 * The technique: every alternative is rendered, all of them in ONE grid cell (`[grid-area:1/1]`),
 * and the losers are held at `opacity-0`. The cell is therefore sized by the widest and tallest
 * occupant IN THE ACTIVE LOCALE, computed by the layout engine from the real glyphs, and a change
 * of `active` is a repaint of the cell rather than a resize of it. Nothing measures anything, and
 * there is no number to keep up to date.
 *
 * `ui/strip-host.tsx` is where this idiom was first written, for the band above the header, and it
 * is the reason this file exists rather than a second copy of those six lines: DESIGN.md §1 says
 * the primitive lands the moment a second place needs the same visual idea. The band still owns
 * everything ABOVE the idiom — which slot wins, the dissolve between them, the ghost it keeps
 * painting while it collapses, the two permanent live regions — and hands only the stacking here.
 *
 * A loser is `inert` AND `aria-hidden`. `inert` is the load-bearing one and the reason `hidden`
 * would not do: a losing layer may hold a focusable control (the band's Retry button), and taking
 * something out of the accessibility tree without also taking it out of the tab order is the worse
 * of the two bugs. `aria-hidden` rides along because `inert` is younger than the oldest engine this
 * PWA runs on, and because a test renderer with no layout still honours it.
 *
 * Alignment INSIDE the cell is the caller's: pass `justify-items-end` for a run that hugs a right
 * edge, `justify-items-start` for one anchored on the left. The primitive states no opinion, the
 * same way it states no opinion about tone — where the reserved space falls is a fact about the
 * strip, not about stacking.
 */
export function OneOf({
  active,
  options,
  className,
  layerClassName,
}: {
  /** Which option is on top. `null` shows none of them — the box keeps its reserved size, which is
   *  the point: a state with nothing to say must not resize the row it stands in. */
  active: string | null;
  /** Every alternative this slot can ever show. Keys are React keys and the `active` vocabulary. */
  options: ReadonlyArray<{ key: string; node: ReactNode }>;
  /** The box. Give it its display (`grid` / `inline-grid`), its alignment and its flex behaviour. */
  className?: string;
  /** Applied to EVERY layer, winner and loser alike — a transition belongs here, so the two sides
   *  of a swap animate on the same terms. */
  layerClassName?: string;
}) {
  return (
    <div className={cn("grid", className)}>
      {options.map((option) => {
        const front = option.key === active;
        return (
          <div
            key={option.key}
            data-active={front ? "" : undefined}
            inert={!front}
            aria-hidden={front ? undefined : true}
            className={cn(
              "[grid-area:1/1]",
              layerClassName,
              // `opacity-100` is written out rather than left to the default, so a layer says which
              // side of the swap it is on in its own class list — the front layer is a positive
              // fact, not the absence of one.
              front ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            {option.node}
          </div>
        );
      })}
    </div>
  );
}
