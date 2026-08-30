import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface AddressTagProps {
  /**
   * The accessible name for the WHOLE tag. Required, and there is no default: the pieces inside are
   * all `aria-hidden`, so a tag without this reaches a screen reader as nothing at all. It also has
   * to say what the name MEANS — a bare machine or session name is a noun with no verb.
   */
  "aria-label": string;
  /** The leading mark, already sized by the caller (a 12px lucide glyph in both callers today). */
  glyph: ReactNode;
  /** A quiet word before the name — the `target` variant's "on". Omitted everywhere else. */
  prefix?: string;
  /** The name itself. Rendered as a text node, never markup: it is operator-supplied. */
  name: string;
  /** `sm` (10px) is the row tag; `md` (11px) heads a write surface, where it is a pill among pills. */
  size?: "sm" | "md";
  /** `alert` is the degraded reading — dashed, in the blocked colour. The caller owns the condition. */
  tone?: "quiet" | "alert";
  className?: string;
}

// One component of a pane's ADDRESS, drawn as a small read-only pill: which machine, which session.
//
// ── WHY THIS IS A PRIMITIVE (DESIGN.md §1) ───────────────────────────────────
// The recipe below was written once for the host chip and is now needed by the session chip, which
// is the same visual idea one dimension over — a quiet bordered tag naming part of where a row
// lives. Two copies would drift the two ways a copy always does: one gains a radius the other does
// not, and one keeps a max-width the other loses, so the two halves of a single address stop
// matching in the one place they are always seen together (a row that names both).
//
// ── IT IS NOT A CONTROL, AND MUST NOT BECOME ONE ─────────────────────────────
// No tap target, no chevron, no hover state. Two lookalike pills, one of them tappable, is a mis-tap
// on the surface where a mis-tap means typing into the wrong terminal. The switchers are elsewhere,
// they look different, and they say so.
//
// The HIDE RULE lives in the CALLER, not here: whether a dimension is worth naming at all is a fact
// about the snapshot (is this a pack? is this row's session the primary one?), and each caller owns
// its own answer. This component renders what it is given.
export function AddressTag({
  "aria-label": ariaLabel,
  glyph,
  prefix,
  name,
  size = "sm",
  tone = "quiet",
  className,
}: AddressTagProps) {
  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        // `max-w-[8rem]` and `shrink-0` are one decision: the tag never gives up width to its
        // neighbours, and the NAME truncates inside it instead. A tag that shrank would let a long
        // row title erase the answer to "where is this?" exactly when the row is busiest.
        "inline-flex max-w-[8rem] shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium",
        size === "md" ? "text-[11px]" : "text-[10px]",
        tone === "alert"
          ? // Unreachable is a STATE, not a disappearance (PACK_PROTOCOL.md §10.2) — it stays
            // legible, dashed rather than dimmed, so a blocked agent on a down machine is never
            // greyed away.
            "border-dashed border-status-blocked/50 bg-status-blocked/10 text-status-blocked"
          : "border-border bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {glyph}
      {prefix !== undefined && (
        <span className="shrink-0 text-muted-foreground/70" aria-hidden>
          {prefix}
        </span>
      )}
      <span className="truncate" aria-hidden>
        {name}
      </span>
    </span>
  );
}
