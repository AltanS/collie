import { useEffect, useState } from "react";

import { usePrefersReducedMotion } from "@/components/ui/collapse";
import { cn } from "@/lib/utils";

// A NAME THAT CHANGES, FADED INSTEAD OF SWAPPED (2026-11-19, the operator's ask).
//
// A rename of a session, tab or Space used to swap the words in one frame. `CrossfadeText` draws a
// text as a plain inline run and, when the SAME thing gets a new text, fades the old words out and
// the new words in over `CROSSFADE_MS`. `identity` says which thing the text belongs to (a pane id,
// a tab id, a space id). A new identity is another item taking this place (a different pane opened,
// a list row reused), and that is no rename, so the text swaps at once. So does the first draw, and
// every change under `prefers-reduced-motion`.
//
// NO SHIFT. The new text stays in the flow, so the box takes its new width at once. The old text is
// an out-of-flow copy (`absolute`) with NO offsets of its own, so it stays at its static position: the start
// of the same line box, with the same line height. A `top-0 left-0` put its line box at the top of the
// inline box's content area instead, half a leading above the new words (measured, 1 px). It holds no room
// and nothing beside or below it moves. The fade is opacity only, no drift: the two copies share one line (measured in an engine, e2e/rename-fade.spec.ts).
//
// TRUNCATION. Both copies are inline spans in the caller's own run, so a `truncate` or `line-clamp`
// parent clips them (the old copy is one non-wrapping line, clipped by the parent's `overflow`).
//
// QUIET TIME. A name that changes fast must not fade (a terminal title the process rewrites every turn,
// a spinner glyph in it): a fade restarted several times a second leaves the name half transparent. A
// change fades only when the identity's previous change (or its mount, or the switch to it) is at least
// `CROSSFADE_QUIET_MS` old. A sooner change swaps at once and drops a fade that is running.
//
// SCREEN READERS. The accessible name is the new text, read once: the outgoing copy is `aria-hidden`.
// The keyframes live in index.css (`.crossfade-in`, `.crossfade-out`), which turns them off under reduced motion.

/** How long the old and new words overlap, in ms. One number in CSS (`.crossfade-*`) and in the timer. */
export const CROSSFADE_MS = 200;

/** How long an identity's text must have held still before its next change fades, in ms. */
export const CROSSFADE_QUIET_MS = 1000;

interface Shown {
  identity: string;
  text: string;
  /** The words on their way out, or null when nothing is fading. */
  from: string | null;
  /** Counts the changes of this identity, so a second change inside one fade restarts it. */
  beat: number;
  /** The clock reading of this identity's last change, its mount or the switch to it. */
  since: number;
}

/**
 * A text that crossfades when it changes and its `identity` stays. Renders inline spans only, so the
 * caller's `truncate` / `line-clamp` still applies. The caller owns the type and the colour.
 */
export function CrossfadeText({ text, identity, className }: { text: string; identity: string; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState<Shown>(() => ({ identity, text, from: null, beat: 0, since: Date.now() }));
  let view = shown;
  if (shown.identity !== identity) {
    view = { identity, text, from: null, beat: 0, since: Date.now() };
    setShown(view);
  } else if (shown.text !== text) {
    const now = Date.now();
    const quiet = now - shown.since >= CROSSFADE_QUIET_MS;
    view = { identity, text, from: reduced || !quiet ? null : shown.text, beat: shown.beat + 1, since: now };
    setShown(view);
  }
  const { from, beat } = view;
  useEffect(() => {
    if (from === null) return;
    const timer = setTimeout(() => setShown((s) => (s.beat === beat ? { ...s, from: null } : s)), CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [from, beat]);
  return (
    <span data-slot="crossfade-text" data-state={from === null ? "still" : "fading"} className={cn("relative", className)}>
      {from !== null && (
        <span key={`out-${String(beat)}`} aria-hidden data-slot="crossfade-out" className="crossfade-out pointer-events-none absolute whitespace-nowrap">
          {from}
        </span>
      )}
      <span key={`in-${String(beat)}`} data-slot="crossfade-in" className={cn(from !== null && "crossfade-in")}>
        {view.text}
      </span>
    </span>
  );
}
