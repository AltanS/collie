import { CacheChip } from "@/components/cache-chip";
import { HostChip } from "@/components/host-chip";
import { SessionChip } from "@/components/session-chip";
import type { PaneCache } from "@/lib/types";
import { cn } from "@/lib/utils";

// A PANE'S ADDRESS AND ITS CACHE READING, drawn once for the two screens that carry them: the
// dashboard row (`agent-card.tsx`) and the pane header (`agent-chat.tsx`). Which machine a pane
// lives on and how long its work stays warm ride at the END OF THE NAME LINE on the dashboard and
// at the end of the WORKSPACE LINE in the pane header — one sentence, on the line the name or the
// workspace already owns, rather than a stack of its own.
//
// ── WHY IT IS ONE COMPONENT AND NOT TWO COPIES ───────────────────────────────
// The header's row was written as a copy of the card's, comment by comment, so a pane's header and
// a list of panes would read as one language. A copy is a promise nobody keeps: the two drifted on
// the first change, and the reader saw it as two different corners meaning two different things. The
// promise is now a component. Both screens pass their own facts and neither owns the geometry.
//
// ── ONE ROW, ON A LINE OF OTHER TYPE ──────────────────────────────────────────
// This states its own 12px height — the same box a path or workspace line already draws — so the
// line it sits at the end of measures the same 12px whatever the two chips have to say. Both chips
// self-hide exactly as before; an empty row is an invisible 12px box and nothing around it moves
// (DESIGN.md §2). On the dashboard row this box sits inside line 1, beside the pane's name, rather
// than trailing a line of its own — two fixed corners used to make the row read as three lines
// (Altan's phone feedback), and folding the address and the reading onto the name line closes that
// without losing the fact that a slot with nothing to say still holds its place.
//
// ── THE WHOLE ROW STANDS ON ONE BASELINE ─────────────────────────────────────
// `items-baseline`, not `items-center`, and the same word is on the bare `HostChip` and on the
// separator span below. `CacheChip` aligned its own glyph to its own number on 2026-09-14 and the
// row stayed wrong, because a flex container centres its CHILDREN as boxes: the host's box is
// 12px and the cache chip's is 15px (12px of glyph above the baseline plus the face's descent),
// so centring the two dropped the host run 1.5px and the two glyphs' feet sat on two different
// lines. Altan, from his phone, with a screenshot of `⊟ lodge · ⧗ 57m`. On the baseline the
// container synthesises one line for every child — an SVG's baseline is its bottom margin edge —
// so both glyphs' BOXES and both words' baselines land on the same y. That still was not the whole
// fix: a box edge is not ink, and Altan saw the gap a third time from his phone. Measured in real
// Chromium at device-pixel resolution, `Server`'s ink foot sat 0.26px and `Hourglass`'s 0.35px
// above their neighbouring word's own ink foot even with every box flush — lucide draws its paths a
// little inside the glyph's box on every mark it ships. `HostChip` and `CacheChip` each carry their
// own small downward nudge on the glyph now (`translate-y-[0.26px]` / `translate-y-[0.35px]`,
// their own files' headers), measured against ink rather than against the synthesised baseline
// alone, so this row inherits the fix without doing anything itself. The descent under the
// baseline is the only thing reaching past the 12px box, and the neighbouring words this row sits
// beside have no descenders, so nothing is drawn there.
//
// ── DASHBOARD CALLER: SELF-BASELINE INSIDE A CENTRED ROW ─────────────────────
// The dashboard's line 1 also carries a status dot and the agent's tile, which stay centred on the
// row's own line box — a dot or a tile has no baseline worth chasing. Only the pane's name and this
// component need to share one text baseline, so the card gives the row `items-center` and marks just
// those two children `self-baseline`; CSS computes the baseline group over the children that ask for
// it and leaves the rest centred, so the icons don't drift for a fix that isn't about them.
// Measured over CDP at 390px in Chromium: the name's ink foot and the cache chip's own ink foot land
// within a quarter pixel of each other on both a herd card and a place row — one shared baseline,
// same as the header's own workspace line.

interface PaneMetaProps {
  /** Which machine this pane lives on. Undefined = this one, and the tag says nothing. */
  host: string | undefined;
  /** How long this pane's prompt cache stays warm, or undefined when nothing has been measured. */
  cache: PaneCache | undefined;
  /** Which Herdr session on that machine. The dashboard's widened list passes it; the header does not. */
  session?: string | undefined;
  /**
   * Given: the cache reading becomes a BUTTON that opens the rule behind the number. Omitted: it is
   * a plain span, because the dashboard card is already one button and may not hold a second.
   */
  onOpenCache?: () => void;
  className?: string;
}

export function PaneMeta({ host, cache, session, onOpenCache, className }: PaneMetaProps) {
  return (
    <div
      data-slot="pane-meta"
      className={cn("flex h-3 shrink-0 items-baseline gap-1.5", className)}
    >
      <HostChip host={host} variant="bare" />
      <SessionChip session={session} />
      {/* THE SEPARATOR IS THE CSS'S TO DECIDE, NOT A PREDICATE'S. The dot belongs between the
          address and the reading and nowhere else, and asking "is the host shown?" here would be a
          second copy of a hide rule that already lives inside each chip (host-chip.tsx says so in
          as many words). So the wrapper draws the dot as its own `::before` and takes it back in
          the two cases where it would be wrong: `first:` — nothing stands to its left, so the
          reading opens the row — and `empty:` — the chip inside rendered nothing, so there is no
          row at all. A pseudo-element does not make an element non-`:empty`, which is what lets
          the two rules sit on one box. */}
      <span className="flex items-baseline gap-1.5 before:text-muted-foreground/60 before:content-['·'] first:before:content-none empty:hidden">
        <CacheChip
          cache={cache}
          host={host}
          // A control on the header, a plain span anywhere that does not offer the rule behind the
          // number — the same one difference the two callers already have.
          variant={onOpenCache === undefined ? "row" : "button"}
          onOpen={onOpenCache}
          // Reached, not drawn: 12px of line plus 16px above and below is 44px. A drawn box would
          // be nearly four times the line and would set the surrounding row's height on its own.
          className={cn(
            "text-[11px]/3",
            onOpenCache !== undefined &&
              "relative before:absolute before:inset-x-0 before:-inset-y-4 before:content-['']",
          )}
        />
      </span>
    </div>
  );
}
