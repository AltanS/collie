import { CollieMark } from "@/components/collie-mark";
import { cn } from "@/lib/utils";

import type { MarkProps } from "./contract";

/**
 * The dog, as a mark of the contract. The generated `<CollieMark/>` has one state axis, `loading`,
 * and the lost look was two classes at each call site; they live here now, so the three states are
 * one prop. The DOM is the one the call sites drew before (theme-mark.test.tsx holds the header's
 * outer HTML byte for byte): the grey classes come AFTER the caller's, and an empty class list
 * passes `undefined`, because `<CollieMark/>` would write an empty `class=""` for an empty string.
 */
export function CollieMarkAdapter({ size, state = "idle", paper, title, className, weight }: MarkProps) {
  const classes = cn(className, state === "lost" && "opacity-40 grayscale");
  return (
    <CollieMark
      size={size}
      loading={state === "loading"}
      paper={paper}
      title={title}
      className={classes === "" ? undefined : classes}
      weight={weight}
    />
  );
}
