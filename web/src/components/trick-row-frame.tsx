import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { Icon } from "@/components/icons/icon";
import { ROW_OPEN_BUTTON, ROW_OPEN_ROW } from "@/components/ui/row-open";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE FRAME OF A ROW IN THE TRICK LIST (Settings → Tricks). A trick's row, an official entry before Add and the Hill's
// row are one markup: the name with its chevron as the one link (its stretched layer is the whole row,
// `ui/row-open.ts`), the labels beside it, the description clamped to two lines, the lines the row adds, and the
// control at the right, a sibling of the link and lifted above its layer. The row's own parts (a trick's warnings and
// Undo, the Hill's armed note) go under it as `below`. The frame draws nothing else, so the rows look alike.

/**
 * THE NAME LINE OF A ROW (2026-11-12): the name with its chevron, then the labels (Official or Community, and
 * "Uses agent tokens") as ONE group. The line wraps: the labels stay beside the name while they fit, else
 * the whole group moves to a line of its own right under the name. So a name is never cut while a second
 * line has room; only a name wider than the line alone truncates, and the chip cuts its words only when the
 * group alone is wider than the row. The labels are the trick's facts, the same before and after Add and
 * whether it is on, so a row's height follows its width and language, never its state.
 */
export const NAME_LINE = "flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-left font-medium";

/** The labels' group: one flex item, never split across lines; the chip inside it shrinks last. */
export const LABELS = "flex max-w-full min-w-0 items-center gap-1";

/** The name and the chevron: the name keeps its width up to the line's, then truncates. */
export function RowName({ name }: { name: string }) {
  return (
    <span data-slot="row-name" className="flex max-w-full min-w-0 items-center gap-1">
      <span className="min-w-0 truncate">{name}</span>
      {/* The cue that the name opens something: the app's own "this row opens another screen" glyph. */}
      <Icon name="row-go" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </span>
  );
}

/** The link a row's name is: to the details page, with the list as the entry it came from, so Back steps back here. */
export function RowLink({ to, name, slot, children }: { to: string; name: string; slot: string; children: ReactNode }) {
  const { pathname, search } = useLocation();
  return (
    <Link to={to} state={{ from: `${pathname}${search}` }} data-slot={slot} data-row-open="" aria-label={t("settings.tricks.about.open", { name })} className={cn(ROW_OPEN_BUTTON, NAME_LINE)}>
      {children}
    </Link>
  );
}

export interface TrickRowFrameProps {
  /** The data attributes that name the row (`data-trick`, `data-hill-row`), for the tests, the shots and the search's mark. */
  rowData: Readonly<Record<`data-${string}`, string>>;
  /** Classes of the row's own, after the frame's. */
  className?: string;
  /** The details page the name opens. */
  to: string;
  name: string;
  /** The link's `data-slot`. */
  linkSlot: string;
  /** The labels after the name, or null for none: drawn as one group so they wrap together. */
  labels: ReactNode;
  /** A glyph before the text column (the Hill's mountain). Absent for a trick, which draws none. */
  glyph?: ReactNode;
  /** The one muted description, at most two lines. Absent: no line. */
  description: string | undefined;
  /** The lines under the description, in the text column. */
  children?: ReactNode;
  /** The control at the right (the switch, Add): the caller lifts it above the stretched layer. */
  control: ReactNode;
  /** What stands under the whole row: the changes line, the update line, the Hill's armed note. */
  below?: ReactNode;
}

/** One row of the trick list. */
export function TrickRowFrame({ rowData, className, to, name, linkSlot, labels, glyph, description, children, control, below }: TrickRowFrameProps) {
  const column = (
    <div className="min-w-0 flex-1">
      {/* The name is the link to the details page, and its stretched layer is the whole row (ui/row-open.ts): the
          lines under it are no controls, so a tap on any of them opens the page. */}
      <RowLink to={to} name={name} slot={linkSlot}>
        <RowName name={name} />
        {labels !== null && (
          <span data-slot="row-labels" className={LABELS}>
            {labels}
          </span>
        )}
      </RowLink>
      {description !== undefined && (
        <p data-line="description" className="line-clamp-2 break-words text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {children}
    </div>
  );
  return (
    <div {...rowData} className={cn(ROW_OPEN_ROW, "px-4 py-3", className)}>
      <div className="flex min-h-11 items-center justify-between gap-4">
        {glyph === undefined ? (
          column
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-3">
            {glyph}
            {column}
          </div>
        )}
        {control}
      </div>
      {below}
    </div>
  );
}
