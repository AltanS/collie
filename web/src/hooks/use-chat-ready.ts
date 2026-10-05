import { useState } from "react";

/**
 * Is the chat body ready to take the screen from the terminal?
 *
 * Choosing Chat from the pane menu flips `wanted` in the same tick the menu starts to close, and the
 * stream has asked nothing yet, so the swap used to land on an empty box and the turns popped in
 * after it. Here the swap waits for the EVENT that makes it worth taking: the first live read for
 * this pane comes back (`answered`, which the caller reads as an answer in hand OR a read that
 * failed). There is no clock. A read cannot hang the swap: the fetch carries its own request
 * deadline (lib/api.ts), so it always comes back one way or the other, and a failure releases the
 * swap exactly as an answer does. The caller warms the read while the menu is open, so the usual
 * case is an answer already in hand and no wait at all.
 *
 * Only a swap WHILE the pane is open is held. A pane that opens already on Chat starts ready: there
 * is no body to hold, and flashing the terminal first would be the new wrong frame.
 *
 * Latched once ready. A pane switch inside Chat resets the window to empty, and that must stay
 * the stream's own empty state, not a bounce back to the terminal.
 */
export function useChatReady(wanted: boolean, answered: boolean): boolean {
  const [ready, setReady] = useState(wanted);
  // Both edges taken in the render that sees them (the adjust-state-in-render pattern), so the
  // answer swaps in the same render it lands in, not one effect later.
  if (!wanted && ready) setReady(false);
  if (wanted && answered && !ready) setReady(true);
  return wanted && (ready || answered);
}
