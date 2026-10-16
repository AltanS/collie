import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A list of flat rows, rendered as ONE bordered region.
 *
 * A `divide-y` run on a bare page has no first edge and no last edge: the section label floats
 * above an open-ended sequence of hairlines and the eye has to infer where the group stops. This
 * gives it a beginning and an end for 2px of height — one border top, one border bottom.
 *
 * No fill and NO PADDING. The frame sits flush on the outermost row's own edge, so a row inside a
 * group and a row inside a `Card` land their content on the same x by construction (14px row
 * padding + 1px border). That is what retires the hand-computed `px-[0.9375rem]` this component
 * replaced.
 *
 * WHICH LINE GOES WHERE, and why it is not the obvious split:
 * `--rule` is deliberately STRONGER than `--border` (1.34:1 vs 1.16:1 light — see index.css). So
 * the frame takes `--rule` and the hairlines inside take `--border`, not the other way around:
 *   · the outer edge separates one REGION from the page, which is `--rule`'s stated job (the
 *     header's bottom edge, a strip's edge — the cut between two regions of chrome);
 *   · the hairlines inside subdivide a SINGLE region, so they are the lesser line.
 * Built the other way the group gets a frame fainter than its own internal dividers, which reads
 * as five lines with a ghost around them. This refines the card/chip/input split rather than
 * breaking it: those are control boxes, not region boundaries.
 *
 * NOT for a gap list. Where the rows are already bordered objects with air between them — the
 * pane-switcher's `Card` rows — the row IS the container, and wrapping them would be a box inside
 * a box. A gap list gets no group border, ever. The dashboard's "Needs you" and "Ready · unseen"
 * sections used to be a gap list of `Card`s too; that changed 2026-09-14 (agent-list.tsx) — their
 * rows are flat now, so they use this wrapper the same as every workspace group.
 */
/**
 * The corners a painted row takes from its place in the group. A row is square (see the herd rows),
 * but under a soft or round theme a square, painted first or last row (a tint, a hover fill, an
 * opaque sticky row) covers the group's rounded corner and the frame looks cut. So the group's first
 * child sets `--row-top` and its last child `--row-bottom` to the group's inner corner, and the
 * painted part of a row reads them through {@link LIST_ROW_CORNERS}. Two pixels inside the group's
 * own radius, floored at 0: at Collie's 2px both are 0, so the default look does not change, and a
 * middle row never rounds. The two classes on the group spell the value out, because Tailwind reads
 * class names from the source text and cannot see one built from a variable.
 */
/** The classes a painted part of a ListGroup row wears so its outer corners follow the group's. */
export const LIST_ROW_CORNERS = "rounded-t-[var(--row-top,0px)] rounded-b-[var(--row-bottom,0px)]";

function ListGroup({
  className,
  as: Comp = "div",
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "div" | "dl" | "ul" }) {
  return (
    <Comp
      data-slot="list-group"
      className={cn(
        "flex flex-col divide-y divide-border rounded-sm border border-rule",
        "[&>:first-child]:[--row-top:max(0px,calc(var(--radius-sm)_-_2px))] [&>:last-child]:[--row-bottom:max(0px,calc(var(--radius-sm)_-_2px))]",
        className,
      )}
      {...props}
    />
  );
}

export { ListGroup };
