import { PeakGlyph, type PeakCount } from "@/components/ui/peak-glyph";
import type { HillPriority } from "@/lib/hill/wire";
import { priorityWord } from "@/lib/hill/words";
import { cn } from "@/lib/utils";

// A DECISION'S PRIORITY, AS THE HILL DRAWS IT (M96): the three-peak glyph (`ui/peak-glyph.tsx`) with as
// many peaks filled as the Decision is urgent, and the word. The card's first line and the Hill's
// group headings both wear it, so the two cannot drift.
//
// The inks are the chosen options' (B1, C1): the glyph `now` in the caution ink, `today` plain, `later`
// muted; the word `now` in the caution ink and plain otherwise, so `Later` reads as a word, not a hint.
// The shape carries the level without the colour, and the word carries it without the shape.

const FILLED = { now: 3, today: 2, later: 1 } as const satisfies Record<HillPriority, PeakCount>;

export const PRIORITY_INK = {
  now: "text-status-working",
  today: "text-foreground",
  later: "text-muted-foreground",
} as const satisfies Record<HillPriority, string>;

/** The word's ink: only `now` is coloured. */
export const PRIORITY_WORD_INK = {
  now: "text-status-working",
  today: "text-foreground",
  later: "text-foreground",
} as const satisfies Record<HillPriority, string>;

/** The glyph alone. Named with the priority's word unless `decorative`, for a caller that says the word beside it. */
export function HillPriorityGlyph({
  priority,
  surface,
  decorative = false,
  className,
}: {
  priority: HillPriority;
  surface?: "card" | "background";
  decorative?: boolean;
  className?: string;
}) {
  return (
    <PeakGlyph
      filled={FILLED[priority]}
      label={decorative ? undefined : priorityWord(priority)}
      surface={surface}
      className={cn(PRIORITY_INK[priority], className)}
    />
  );
}

/**
 * The glyph and the word, on the card's first line. The glyph is the name; the word is for the eye. The
 * wrapper draws no box (`contents`), so both are items of the line and sit its own gap apart, as B1 has them.
 */
export function HillPriorityMark({ priority }: { priority: HillPriority }) {
  return (
    <span data-slot="decision-priority" data-priority={priority} className="contents">
      <HillPriorityGlyph priority={priority} surface="card" />
      <span aria-hidden className={cn("shrink-0 font-semibold", PRIORITY_WORD_INK[priority])}>
        {priorityWord(priority)}
      </span>
    </span>
  );
}
