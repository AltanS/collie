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
 * attention/"needs you" cards, the pane-switcher rows — the row IS the container, and wrapping
 * them would be a box inside a box. A gap list gets no group border, ever.
 */
function ListGroup({
  className,
  as: Comp = "div",
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "div" | "dl" | "ul" }) {
  return (
    <Comp
      data-slot="list-group"
      className={cn("flex flex-col divide-y divide-border rounded-sm border border-rule", className)}
      {...props}
    />
  );
}

export { ListGroup };
