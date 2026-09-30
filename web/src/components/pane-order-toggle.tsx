import { Clock, FolderTree, Hourglass } from "lucide-react";

import { cn } from "@/lib/utils";
import { PANE_ORDERS, type PaneOrder } from "@/lib/pane-order";
import { t, type MessageKey } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// Place, Activity or Cache: the segmented choice that decides which way a pane list runs
// (lib/pane-order.ts, ADR 0071). ONE control, drawn in two places — at the top of the pane switcher
// where the order is read, and on the Settings page where a person goes looking for it — because the
// two write the same stored value and a person who finds one should recognise the other.
//
// THE SELECTED SEGMENT IS `bg-muted`, NOT `bg-primary`, and that is deliberate on the sheet's
// account. The switcher keeps the primary ink for two things only: the row you are in, and the mark
// that says a pane needs you (ADR 0063 point 3, "urgency is a mark, and it has one place to go"). A
// filled segment here would be the loudest thing on a sheet whose whole job is to let an alarm be
// seen. Same treatment as `ChangesLayoutToggle`, which answers the same kind of question.
//
// ── AND IT HAS A COMPACT FORM, BECAUSE THE SHEET IS A PHONE SCREEN ──────────
// Three labelled segments at the 44px floor, over a summary line of their own, cost two rows of a
// sheet whose job is to show panes. `compact` drops the words and keeps the square: the glyph is the
// control, the row it shares says what is on screen, and the section heading below spells the order
// in words anyway ("Newest first", "Going cold first"). Settings keeps the labelled form, because
// nobody arrives there already knowing which glyph is which.
const SEGMENTS = {
  place: { label: "paneOrder.place", Icon: FolderTree },
  activity: { label: "paneOrder.activity", Icon: Clock },
  // The chip's own glyph (components/cache-chip.tsx), so the control and the number it sorts by are
  // obviously about the same thing.
  cache: { label: "paneOrder.cache", Icon: Hourglass },
} as const satisfies Record<PaneOrder, { label: MessageKey; Icon: typeof Clock }>;

export function PaneOrderToggle({
  order,
  onChange,
  compact = false,
  className,
}: {
  order: PaneOrder;
  onChange: (order: PaneOrder) => void;
  /** Glyphs only, sized to share a row. See the note above {@link SEGMENTS}. */
  compact?: boolean;
  className?: string;
}) {
  useLocale();
  return (
    <div
      role="radiogroup"
      aria-label={t("paneOrder.aria")}
      className={cn("flex gap-1", compact && "shrink-0", className)}
    >
      {PANE_ORDERS.map((value) => {
        const { label, Icon } = SEGMENTS[value];
        const selected = value === order;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            // The word is the name in both forms. Compact hides it from the eye, never from the
            // accessibility tree, so the control reads the same to a screen reader either way.
            aria-label={compact ? t(label) : undefined}
            onClick={() => onChange(value)}
            className={cn(
              // 44px floor, and the weight is unconditional so a selection repaints and never
              // re-lays-out the row beneath it.
              "flex min-h-11 items-center justify-center rounded-md text-sm font-medium transition-colors",
              compact ? "size-11 shrink-0" : "flex-1 gap-2 px-3 py-2",
              selected ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {!compact && t(label)}
          </button>
        );
      })}
    </div>
  );
}
