import { CacheChip } from "@/components/cache-chip";
import { HostChip } from "@/components/host-chip";
import { SessionChip } from "@/components/session-chip";
import type { PaneCache } from "@/lib/types";
import { cn } from "@/lib/utils";

// A PANE'S ADDRESS AND ITS CACHE READING, drawn once for the two screens that carry them: the
// dashboard row (`agent-card.tsx`) and the pane header (`agent-chat.tsx`).
//
// ── TWO LAYOUTS, ONE PAIR ────────────────────────────────────────────────────
// `column` is the dashboard row's two fixed corners, unchanged to the pixel. `inline` is one row of
// the same chips for the pane header, which now carries them at the END OF ITS PATH LINE rather
// than in a stack in the corner: where a pane LIVES and how long its work stays warm are one
// sentence, so they ride on the line the working directory already owns and the corner keeps the ⋮
// alone. WHICH chips, and in which order, is stated once below and shared by both — a second list
// is how the header and the dashboard would start naming a pane two different ways.
//
// ── WHY IT IS ONE COMPONENT AND NOT TWO COPIES ───────────────────────────────
// The header's column was written as a copy of the card's, comment by comment, so a pane's header and
// a list of panes would read as one language. A copy is a promise nobody keeps: the two drifted on
// the first change, and the reader saw it as two different corners meaning two different things. The
// promise is now a component. Both screens pass their own facts and neither owns the geometry.
//
// ── A COLUMN OF TWO FIXED SLOTS, NOT AN INLINE ROW ───────────────────────────
// A row let the two positions trade places: a pane with no cache reading showed only the host tag,
// which slid into the spot the cache reading holds on the pane next to it, so the same corner meant
// two things from row to row (Altan's phone feedback, with a screenshot). Each slot owns a fixed spot
// and a fixed height — `21px` for the bordered `AddressTag` pair and `h-4` for the borderless cache
// chip, both measured off the chips' own rendered boxes — and draws that height even when the chip
// inside it self-hides, so an empty slot is an invisible box and nothing downstream ever moves
// (DESIGN.md §2). `self-stretch` plus `justify-between` pins the top slot to the top and the bottom
// slot to the bottom of whatever the surface gives it.
//
// ── EVERY RIGHT EDGE ON ONE LINE ─────────────────────────────────────────────
// `items-end` is the whole alignment story, and it only works because nothing ELSE shares these
// slots. The header used to put its ⋮ in the top slot beside the tag, so the tag's border ended 28px
// left of the cache reading below it: a bordered tag and a bare glyph cannot share an edge. The ⋮ now
// stands in its own column beside this one, in `agent-chat.tsx`, which is where it belongs — the
// dashboard row has no twin for it, and a menu is not part of a pane's address.

interface PaneMetaProps {
  /** Which machine this pane lives on. Undefined = this one, and the tag says nothing. */
  host: string | undefined;
  /** How long this pane's prompt cache stays warm, or undefined when nothing has been measured. */
  cache: PaneCache | undefined;
  /** Which Herdr session on that machine. The dashboard's widened list passes it; the header does not. */
  session?: string | undefined;
  /**
   * Given: the cache reading becomes a BUTTON that opens the rule behind the number, which is the one
   * difference between the two corners. Omitted: it is a plain span, because the dashboard card is
   * already one button and may not hold a second.
   */
  onOpenCache?: () => void;
  /**
   * `column` — the dashboard row's two fixed corners, a slot each. `inline` — one row of the same
   * chips, at the end of the pane header's path line. See this file's header for why there are two.
   */
  layout?: "column" | "inline";
  className?: string;
}

export function PaneMeta({
  host,
  cache,
  session,
  onOpenCache,
  layout = "column",
  className,
}: PaneMetaProps) {
  // ONE ROW, ON A LINE OF OTHER TYPE. It states its own 12px height — the path line's own box — so
  // line 2 measures the same 12px whatever the two chips have to say, and the header's arithmetic
  // (20 + 4 + 12 = 36px, under the 44px identity floor) is untouched. Both chips self-hide exactly
  // as they do in the column; an empty row is an invisible 12px box and nothing around it moves
  // (DESIGN.md §2).
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
  // baseline is the only thing reaching past the 12px box, and `lodge` / `57m` have no descenders,
  // so nothing is drawn there.
  if (layout === "inline") {
    return (
      <div
        data-slot="pane-meta"
        data-layout="inline"
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
            // number — the same one difference the column's two callers already have.
            variant={onOpenCache === undefined ? "row" : "button"}
            onOpen={onOpenCache}
            // Reached, not drawn, the same trick the column uses one slot down: 12px of line plus
            // 16px above and below is 44px. A drawn box would be nearly four times the line and
            // would set the header row's height on its own.
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

  return (
    <div
      data-slot="pane-meta"
      className={cn("flex shrink-0 flex-col items-end justify-between gap-1 self-stretch", className)}
    >
      {/* Top slot — the pane's ADDRESS, in the order the address itself reads: which machine, then
          which session on it. Each chip self-hides — the host when there is no crew, the session when
          the pane is in the primary one or the list was never widened — and the slot keeps its height
          either way. */}
      <div className="flex h-[21px] items-center gap-2">
        <HostChip host={host} variant="tag" />
        <SessionChip session={session} />
      </div>
      {/* Bottom slot — how long this pane's prompt cache stays warm. Self-hides like the two above: a
          pane whose agent has not taken a turn yet carries no reading, and nothing is guessed before
          one exists. */}
      <div className="flex h-4 items-center">
        {onOpenCache === undefined ? (
          <CacheChip cache={cache} host={host} />
        ) : (
          <CacheChip
            cache={cache}
            host={host}
            variant="button"
            onOpen={onOpenCache}
            // The tap box is REACHED, not drawn: 16px of line plus 14px above and below is 44px, the
            // negative-inset trick `ui/labelled-strip.tsx`'s STRIP_TAP_TARGET already uses. A drawn
            // 44px box here would be more than twice the slot and would set the header's height on
            // its own. Nothing clips it — neither surface is a scroll container.
            className="relative before:absolute before:inset-x-0 before:-inset-y-[14px] before:content-['']"
          />
        )}
      </div>
    </div>
  );
}
