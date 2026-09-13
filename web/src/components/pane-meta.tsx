import { CacheChip } from "@/components/cache-chip";
import { HostChip } from "@/components/host-chip";
import { SessionChip } from "@/components/session-chip";
import type { PaneCache } from "@/lib/types";
import { cn } from "@/lib/utils";

// A PANE'S TWO CORNERS, drawn once for the two screens that draw them: the dashboard row
// (`agent-card.tsx`) and the pane header (`agent-chat.tsx`).
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
  className?: string;
}

export function PaneMeta({ host, cache, session, onOpenCache, className }: PaneMetaProps) {
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
