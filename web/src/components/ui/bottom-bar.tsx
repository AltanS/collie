import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The band at the foot of a screen that holds its own controls: a rule above, the page colour, and
 * the safe area under the buttons so the home indicator never covers one (DESIGN.md §4, chrome is
 * never a fill). It owns the band and nothing in it: no words, no buttons, no state. The Changes
 * screen's Previous / Next pair on a diff is its first caller, and the Back it repeats at the thumb
 * on a phone sits in the same band (DESIGN.md §12).
 *
 * `sticky bottom-0` keeps it at the foot of a scrolling column it sits inside of; as a sibling under
 * the scroller it simply stays where the layout puts it. Either way the content above can scroll
 * fully clear of it. A button in it states its own `h-11`, the floor of §6.
 */
function BottomBar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-bar"
      className={cn("sticky bottom-0 shrink-0 border-t border-rule bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]", className)}
      {...props}
    />
  );
}

export { BottomBar };
