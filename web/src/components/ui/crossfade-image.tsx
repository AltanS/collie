import { useEffect, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/components/ui/collapse";
import { CROSSFADE_MS, CROSSFADE_QUIET_MS } from "@/components/ui/crossfade-text";
import { cn } from "@/lib/utils";

// A PICTURE THAT CHANGES, FADED INSTEAD OF SWAPPED (issue 811, ADR 0160).
//
// `CrossfadeText`'s rule for a picture: a box of a fixed size shows `src` (a URL), or `fallback` when
// `src` is null, and when the SAME thing (`identity`) changes what it shows, the old layer fades out and
// the new one in over `CROSSFADE_MS`. Opacity only, nothing moves: both layers fill the same box, which
// the caller sizes. A new identity (another pane in this place, a reused row), the first draw and every
// change under `prefers-reduced-motion` swap at once. A change sooner than `CROSSFADE_QUIET_MS` after the
// last one swaps at once too, so a picture an agent rewrites quickly never leaves the box half faded.
//
// The picture is decorative (`alt=""`): the caller names the box. The keyframes are the text's
// (`.crossfade-in`, `.crossfade-out` in index.css), off under reduced motion.

interface Shown {
  identity: string;
  src: string | null;
  /** What is fading out (a URL, or null for the fallback), or `undefined` when nothing is. */
  from: string | null | undefined;
  beat: number;
  since: number;
}

function Layer({ src, fallback, imgClassName }: { src: string | null; fallback: ReactNode; imgClassName?: string }) {
  if (src === null) return <>{fallback}</>;
  return <img src={src} alt="" draggable={false} className={cn("size-full object-contain", imgClassName)} />;
}

/**
 * A fixed box that crossfades between pictures (and a fallback) when what it shows changes and its
 * `identity` stays. `className` sizes and shapes the box; `imgClassName` styles the picture.
 */
export function CrossfadeImage({
  src,
  identity,
  fallback,
  className,
  imgClassName,
}: {
  src: string | null;
  identity: string;
  fallback: ReactNode;
  className?: string;
  imgClassName?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState<Shown>(() => ({ identity, src, from: undefined, beat: 0, since: Date.now() }));
  let view = shown;
  if (shown.identity !== identity) {
    view = { identity, src, from: undefined, beat: 0, since: Date.now() };
    setShown(view);
  } else if (shown.src !== src) {
    const now = Date.now();
    const quiet = now - shown.since >= CROSSFADE_QUIET_MS;
    view = { identity, src, from: reduced || !quiet ? undefined : shown.src, beat: shown.beat + 1, since: now };
    setShown(view);
  }
  const { from, beat } = view;
  useEffect(() => {
    if (from === undefined) return;
    const timer = setTimeout(() => setShown((s) => (s.beat === beat ? { ...s, from: undefined } : s)), CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [from, beat]);
  return (
    <span data-slot="crossfade-image" data-state={from === undefined ? "still" : "fading"} data-picture={view.src === null ? "off" : "on"} className={cn("relative inline-grid shrink-0 overflow-hidden", className)}>
      {from !== undefined && (
        <span key={`out-${String(beat)}`} aria-hidden data-slot="crossfade-out" className="crossfade-out pointer-events-none absolute inset-0 grid">
          <Layer src={from} fallback={fallback} imgClassName={imgClassName} />
        </span>
      )}
      <span key={`in-${String(beat)}`} data-slot="crossfade-in" className={cn("grid size-full", from !== undefined && "crossfade-in")}>
        <Layer src={view.src} fallback={fallback} imgClassName={imgClassName} />
      </span>
    </span>
  );
}
