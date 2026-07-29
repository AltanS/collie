import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SectionHeaderProps {
  /** Section name, e.g. "Recent". Rendered uppercase. */
  label: string;
  /** Item count shown beside the label. Omit to show no count. */
  count?: number;
  /** Bullet colour class from the status palette (e.g. "bg-status-blocked"). */
  dot?: string;
  /** Render the label in the alert colour — the "Needs you" section. */
  accent?: boolean;
  /**
   * Fold state. Omit entirely for a section that can't fold: the header then renders as a plain
   * heading with no caret and no button, so there is nothing to press and nothing to announce.
   */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /**
   * Id of the element this header folds — wired to `aria-controls`, but ONLY while that element is
   * actually rendered. Callers unmount the body when collapsed (rather than hiding it), so emitting
   * the attribute in that state would point assistive tech at an id that does not exist — exactly
   * when a screen-reader user is deciding whether to expand.
   */
  controls?: string;
  /**
   * The section's own control (a sort toggle, a "new" button). Rendered as a SIBLING of the fold
   * button, never inside it: nesting would be invalid markup and would make pressing the control
   * also fold the section.
   */
  trailing?: ReactNode;
  /** Heading level. 2 on a page; 3 inside the pane-switcher sheet, whose own title is the h2. */
  level?: 2 | 3;
  className?: string;
}

// The one section heading the dashboard uses, foldable or not. Recent and Spaces fold; the three
// attention sections don't (collapsing an alert defeats the alert), and they pass no `open` at all
// rather than a disabled toggle — a control that never does anything shouldn't be in the a11y tree.
//
// Keeping both cases in one component is deliberate: the two foldable sections behaved identically
// in the design, and two copies of "caret + aria-expanded + trailing slot" would drift.
export function SectionHeader({
  label,
  count,
  dot,
  accent,
  open,
  onToggle,
  controls,
  trailing,
  level = 2,
  className,
}: SectionHeaderProps) {
  const foldable = open !== undefined && onToggle !== undefined;
  const Heading = level === 3 ? "h3" : "h2";

  const inner = (
    <>
      {foldable && (
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      )}
      {dot && <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />}
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="opacity-60 tabular-nums">({count})</span>}
    </>
  );

  // Always an <h2>, foldable or not — the sections are the page's outline, and a section that can
  // be folded shouldn't vanish from it. When foldable the heading WRAPS the button (the standard
  // disclosure pattern) instead of being replaced by one.
  const tone = accent
    ? "text-status-blocked"
    : cn("text-muted-foreground", foldable && "hover:text-foreground");
  // Set explicitly on BOTH branches, never inherited from the heading: a <button> does not inherit
  // text-transform or font-size (the UA sheet resets form controls), so leaving these on the
  // <h2> rendered pinned sections as small-caps "WORKING" and foldable ones as larger, sentence-case
  // "Recent" — making the low-priority tail the loudest heading on the page.
  const type = "text-xs font-semibold uppercase tracking-wide";

  return (
    <div className={cn("flex items-center gap-2 px-1", className)}>
      <Heading className="flex min-w-0 flex-1">
        {foldable ? (
          <button
            type="button"
            onClick={() => onToggle(!open)}
            aria-expanded={open}
            {...(controls && open ? { "aria-controls": controls } : {})}
            // min-h-9 keeps the row on the 36px touch floor even though the text is tiny.
            className={cn(
              "flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded text-left transition-colors",
              type,
              tone,
            )}
          >
            {inner}
          </button>
        ) : (
          <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", type, tone)}>{inner}</span>
        )}
      </Heading>
      {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
    </div>
  );
}
