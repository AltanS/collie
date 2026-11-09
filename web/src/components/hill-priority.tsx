import { PeakGlyph, type PeakCount } from "@/components/ui/peak-glyph";
import type { HillPriority } from "@/lib/hill/wire";
import { priorityWord } from "@/lib/hill/words";
import { cn } from "@/lib/utils";

// A DECISION'S PRIORITY, AS THE HILL DRAWS IT (M96): the three-peak glyph (`ui/peak-glyph.tsx`) with as
// many peaks filled as the Decision is urgent, and the word. The card's first line and the Hill's
// group headings both wear it, so the two cannot drift.
//
// The ink is today's chip's: `now` in the caution ink, `today` plain, `later` muted. It is the only
// status colour on the card, and it marks only `now` (DESIGN.md §4). The shape carries the level
// without the colour, and the word carries it without the shape.

const FILLED = { now: 3, today: 2, later: 1 } as const satisfies Record<HillPriority, PeakCount>;

export const PRIORITY_INK = {
  now: "text-status-working",
  today: "text-foreground",
  later: "text-muted-foreground",
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

/** The glyph and the word, on the card's first line. The glyph is the name; the word is for the eye. */
export function HillPriorityMark({ priority }: { priority: HillPriority }) {
  return (
    <span data-slot="decision-priority" data-priority={priority} className={cn("inline-flex shrink-0 items-center gap-1.5 font-semibold", PRIORITY_INK[priority])}>
      <HillPriorityGlyph priority={priority} surface="card" />
      <span aria-hidden>{priorityWord(priority)}</span>
    </span>
  );
}
