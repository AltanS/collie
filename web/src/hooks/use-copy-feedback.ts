import { useCallback, useEffect, useRef, useState } from "react";

/** How long a copy control shows the outcome of a copy before it returns to its resting glyph. */
export const COPY_FEEDBACK_MS = 1500;

export type CopyFeedback = "idle" | "done" | "failed";

/** The outcome a copy control shows (the copied or failed glyph and word), and the way to set it for {@link COPY_FEEDBACK_MS}. */
export function useCopyFeedback(): readonly [CopyFeedback, (next: "done" | "failed") => void] {
  const [state, setState] = useState<CopyFeedback>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = useCallback((next: "done" | "failed") => {
    window.clearTimeout(timer.current);
    setState(next);
    timer.current = window.setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
  }, []);
  return [state, show];
}
