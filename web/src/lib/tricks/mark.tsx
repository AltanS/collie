// A TRICK'S MARK (M94 slice 02): the belt mark, the tab mark and the `mark` node, drawn from one `Mark`.
//
// IT IS NOT A STATUS MARK, AND IT MUST NOT LOOK LIKE ONE (design section 2, ADR 0063 point 3). A pane's
// status is a shape in a 12px box (DESIGN.md section 3: the disc, the half disc, the ring, the dashed
// ring, the triangle). A trick's mark is the trick's own icon and face word inside its own frame, a 2px
// cornered outline in the border token, so a trick's red reads as "this trick says red" and never as "an
// agent needs you". It imports nothing from the status components, and a test holds it to that.
//
// The tone inks the icon, the face and the count through the schema's tone map only. A busy tap swaps
// the icon for Collie's spinner in the same box; an unknown outcome swaps it for a question mark in
// the same box. Neither changes the mark's width.
//
// "Shows nothing" is a state (design section 5): when a trick drops its mark, the mark keeps its slot,
// drawn invisible from the last mark it showed, so the belt beside it does not move. A slot that never
// had a mark takes no room.
//
// ONE CONTROL (step 3). A mark is always the same element, a button in its own frame with the 44px
// reach, whether it has an intent, opens its trick's session, or does nothing at all. It used to drop
// to a plain span when it had no tap, and that span shrank away under the belt's pinned block when the
// belt overflowed. A mark with nothing to do says so with `aria-disabled` and keeps its box.

import { CircleHelp, Loader2 } from "lucide-react";
import { useRef } from "react";

import { t } from "../i18n";
import { cn } from "../utils";
import { trickIconOf } from "./icons";
import type { Mark } from "./schema";
import { inkOf } from "./tone";

/** A 28px frame with a reach of 8px above and below, so the tap target is the 44px floor (DESIGN.md section 6). */
const MARK_REACH = "relative before:absolute before:-inset-x-1 before:-inset-y-2 before:content-['']";

export interface TrickMarkProps {
  /** The mark to draw. Absent: the trick shows nothing now, and the slot keeps the last mark's width. */
  mark: Mark | undefined;
  /** The trick's name, for the accessible name when the mark carries no `label`. */
  trickName: string;
  /** The part is past its fresh window: the tone goes. */
  stale?: boolean;
  /** A tap on this mark is in flight. */
  busy?: boolean;
  /** The last tap on this mark got no answer. */
  unknown?: boolean;
  /** Called on a tap: the mark's intent, or the trick's session. Absent: the mark does nothing, and says so. */
  onTap?: () => void;
  /** The accessible name when the tap does something the mark's words do not say ("Open Browser leg"). */
  actionLabel?: string;
  className?: string;
}

function accessibleName(mark: Mark, trickName: string): string {
  // Since the re-cut the mark's `label` is its face word (the tree's button label), and `badge` its count.
  const face = mark.label ?? (mark.badge === undefined || mark.badge === "" ? undefined : mark.badge);
  return face === undefined ? trickName : t("tricks.mark.named", { trick: trickName, face });
}

function MarkFace({ mark, stale, busy, unknown }: { mark: Mark; stale: boolean; busy: boolean; unknown: boolean }) {
  const ink = inkOf(mark.tone, stale);
  const Icon = trickIconOf(mark.icon);
  const glyph = "size-3.5 shrink-0";
  return (
    <>
      {busy ? (
        <Loader2 aria-hidden data-slot="trick-mark-busy" className={cn(glyph, "animate-spin text-muted-foreground")} />
      ) : unknown ? (
        <CircleHelp aria-hidden data-slot="trick-mark-unknown" className={cn(glyph, "text-muted-foreground")} />
      ) : (
        <Icon aria-hidden className={cn(glyph, ink)} />
      )}
      {mark.label !== undefined && (
        <span data-slot="trick-mark-face" className={cn("font-mono text-[11px] leading-none tabular-nums whitespace-nowrap", ink)}>
          {mark.label}
        </span>
      )}
      {/* A badge is a count, or the tree's dot when it is the empty string: in the mark's ink, never a status colour. */}
      {mark.badge !== undefined && mark.badge !== "" && (
        <span data-slot="trick-mark-count" className={cn("text-[11px] leading-none font-semibold tabular-nums", ink)}>
          {mark.badge}
        </span>
      )}
      {mark.badge === "" && <span aria-hidden data-slot="trick-mark-dot" className={cn("size-1.5 shrink-0 rounded-full bg-current", ink === "" ? "text-foreground" : ink)} />}
    </>
  );
}

/** The frame every mark draws in: a 2px cornered outline in the border token, 28px tall. */
const MARK_FRAME = "inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-border bg-transparent px-1.5 text-foreground";

export function TrickMark({ mark, trickName, stale = false, busy = false, unknown = false, onTap, actionLabel, className }: TrickMarkProps) {
  const last = useRef<Mark | undefined>(mark);
  if (mark !== undefined) last.current = mark;
  const shown = mark ?? last.current;
  if (shown === undefined) return null;
  if (mark === undefined) {
    return (
      <span aria-hidden inert data-slot="trick-mark" data-empty="" className={cn(MARK_FRAME, "invisible", className)}>
        <MarkFace mark={shown} stale={stale} busy={false} unknown={false} />
      </span>
    );
  }
  const name = actionLabel ?? accessibleName(mark, trickName);
  const face = <MarkFace mark={mark} stale={stale} busy={busy} unknown={unknown} />;
  return (
    <button
      type="button"
      aria-label={unknown ? `${name}, ${t("tricks.tap.unknown")}` : name}
      aria-busy={busy}
      aria-disabled={onTap === undefined || undefined}
      disabled={busy}
      data-slot="trick-mark"
      onClick={onTap}
      className={cn(
        MARK_FRAME,
        MARK_REACH,
        "transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:pointer-events-none",
        // Nothing to do: the same control, with no hover and no press to promise a tap.
        "aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:active:scale-100",
        className,
      )}
    >
      {face}
    </button>
  );
}
