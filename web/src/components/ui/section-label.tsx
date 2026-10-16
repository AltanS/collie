import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Where the label sits relative to the thing it names.
 *
 * - `inline` — beside the row, as the row's first child. The original treatment; every existing
 *   call site gets this by default and looks exactly as it did.
 * - `above` — on its own line, over the row. Slightly smaller and un-bolded, because a label that
 *   owns a whole line does not need weight to separate it from its neighbours, and the strips it
 *   serves are denser than the dock. The values are `quick-actions.tsx:56`'s, at `mb-1` rather than
 *   `mb-1.5`, and with `leading-none` added.
 *
 *   `leading-none` is the one deliberate divergence from that source, so: WHY. `text-[10px]` is an
 *   arbitrary size and carries no line-height of its own, so it inherits the body's 1.5 and draws a
 *   15px line box around 10px of type. All three numbers below are browser measurements at phone
 *   width, not estimates. With the inherited leading the label cost the space, tab and pane strips
 *   +17, +17 and +19px of height — +53px in total, every pixel of it above the fold on a phone, for
 *   5px of empty leading per row. A 10px uppercase label has no descenders using that space. At
 *   `leading-none` the same three cost +12, +12 and +14px — +38px, and nothing about the word reads
 *   differently. `inline` keeps the inherited leading: it appears once, beside a row rather than
 *   above it, and its slack costs nothing there. The two placements differ because their contexts
 *   do, not by drift.
 *
 * This is a placement, not a state. Nothing ever flips an element between the two at runtime, so
 * the type metrics differing between them cannot move anything — the no-shift rule is about state.
 */
export type SectionLabelPlacement = "inline" | "above";

const PLACEMENT = {
  inline: "shrink-0 text-[11px] font-semibold text-muted-foreground",
  above: "mb-1 block text-[10px] leading-none text-muted-foreground",
} satisfies Record<SectionLabelPlacement, string>;

interface SectionLabelProps {
  children: ReactNode;
  className?: string;
  placement?: SectionLabelPlacement;
  /**
   * Set by the structural half of this pattern so a wrapper can point `aria-labelledby` at the
   * label. Without it the label is a stray word in front of an unnamed run of buttons.
   */
  id?: string;
  /**
   * `false` for a label written as it is, in the label's size and spacing but not in capitals (a file
   * path, a heading the catalog already cases). Default `true`: the theme's label case, capitals in
   * Collie (`label-caps`, M57 spec 17). Use this, not a `normal-case` class: both would set the same
   * property and the stylesheet's order, not the class order, would pick the winner.
   */
  caps?: boolean;
}

// The small uppercase tag that names a control/navigation row — Spaces · Tabs · Panes · Controls.
// The case and the spacing are the theme's `labels` word, through the `label-caps` utility in
// index.css: capitals and Tailwind's `tracking-wide` (0.025em) in Collie, as written under `sentence`.
// One component so the "name the section" pattern stays visually identical everywhere it's used.
//
// This primitive owns the TYPE only: what the word looks like. It renders a <span> and therefore
// cannot restructure its own parent, so it does NOT own the structure the strips need — the
// non-scrolling wrapper, the `aria-labelledby` pair and the edge-to-edge scroller inside it. That
// belongs to a sibling primitive, `LabelledStrip` in `ui/labelled-strip.tsx`, which composes this
// one and passes it `placement="above"` and an `id`. Anything that wants the "above" placement
// should reach for that pair rather than for this half alone.
export function SectionLabel({ children, className, placement = "inline", id, caps = true }: SectionLabelProps) {
  return (
    <span id={id} className={cn(PLACEMENT[placement], caps ? "label-caps" : "label-tracking", className)}>
      {children}
    </span>
  );
}
