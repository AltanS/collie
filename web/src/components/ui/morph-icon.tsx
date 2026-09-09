import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// One morphing toggle glyph, shared by the Keys pad tab and the agents row's pin: the idle
// mark shrinks and fades while the X grows, untwists, and fades in. One component, not two
// copies of the same class strings, so the toggles cannot drift apart again — the pin wore a
// plainer crossfade while the pad tab twisted, and the difference read as a missing animation.
// The untwist is deliberately small (90°, same 200ms as the fade): a scale-only swap reads as
// a pop, a full spin reads as a loading state, 90° reads as one mark becoming the other.
export function MorphIcon({ open, shut, show }: { open: boolean; shut: LucideIcon; show: LucideIcon }) {
  const Shut = shut;
  const Show = show;
  return (
    <span aria-hidden="true" className="relative block size-4">
      <Shut
        className={cn(
          "absolute inset-0 size-4 transition-all duration-200 motion-reduce:transition-none",
          open ? "scale-50 opacity-0" : "scale-100 opacity-100",
        )}
      />
      <Show
        className={cn(
          "absolute inset-0 size-4 transition-all duration-200 motion-reduce:transition-none",
          open ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-50 opacity-0",
        )}
      />
    </span>
  );
}
