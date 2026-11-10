import type { ReactNode } from "react";

/**
 * A quiet line of the thread: centred 11px muted text between two hairlines. Chat's notices, compaction
 * marker and top-of-thread line, and History's day divider and compaction marker draw through it, so
 * the two screens never disagree about what a quiet line looks like. Owns no words.
 *
 * `partial` is a state hook for a line still being written (`data-partial`); it changes no pixel.
 */
export function DividedLine({ partial = false, children }: { partial?: boolean; children: ReactNode }) {
  return (
    <div data-partial={partial ? "true" : undefined} className="flex items-center gap-2 py-1">
      <div aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <p className="max-w-[80%] text-center text-[11px] font-medium leading-snug text-muted-foreground">{children}</p>
      <div aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}
