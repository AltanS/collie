import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

interface DogGallopProps {
  /** Play the gallop cycle. When false the collie rests on a single frame. */
  running?: boolean;
  /** Any CSS length for the (square) render size. Defaults to 1.5rem — the header logo size. */
  size?: string;
  /** Accessible name. Omit to render the mascot as decorative (aria-hidden). */
  label?: string;
  className?: string;
}

// The Collie mascot doubling as the app's activity indicator: a 6-frame gallop sprite
// (public/dog-gallop.png — a 768×128 strip of six 128px cells, transparent background) stepped
// through with a pure-CSS steps(6) animation. No JS timers, no layout thrash, GPU-cheap — the whole
// cycle is one repainting background-position. It gallops while the app is loading/reconnecting
// (`running`) and rests on the first frame when idle. `prefers-reduced-motion` pins it to the rest
// frame (see index.css). `--dog-size` drives both the box and the sprite scale, so one length keeps
// them in lockstep at any placement.
export function DogGallop({ running = false, size = "1.5rem", label, className }: DogGallopProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ "--dog-size": size } as CSSProperties}
      className={cn("dog-gallop", running && "dog-gallop--running", className)}
    />
  );
}
