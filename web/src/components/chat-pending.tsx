import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * How long a Chat body waits for its first page before it draws the pending bars. A switch that is answered
 * inside it (the usual one, and every one that starts from a held window) never shows them.
 */
export const CHAT_PENDING_DELAY_MS = 150;

/** Bar widths, top to bottom: the shape of a few message lines, no words. */
const BARS = ["w-3/5", "w-4/5", "w-2/5", "w-1/2", "w-3/4"] as const;

/**
 * What the reading area shows while a pane's Chat has not been read yet and the wait has run past
 * {@link CHAT_PENDING_DELAY_MS}: a few muted bars where message lines will be. No text, no spinner. They
 * breathe with `.count-skeleton`, which holds still under reduced motion, and they sit where the first lines
 * of the thread start, so the thread replaces them in place.
 */
export function ChatPending() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), CHAT_PENDING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  return (
    <div data-slot="chat-pending" aria-hidden className="flex min-w-0 flex-col gap-3 px-2 py-4">
      {BARS.map((width, index) => (
        <span key={index} className={cn("count-skeleton h-2.5 rounded-full bg-muted", width)} />
      ))}
    </div>
  );
}
