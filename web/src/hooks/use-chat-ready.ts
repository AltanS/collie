import { useEffect, useState } from "react";

/** The longest the terminal body holds the screen for a chat answer that has not come. A slow or
 *  failed read must not strand the operator on the body they just left. */
export const CHAT_HOLD_MS = 1500;

/**
 * Is the chat body ready to take the screen from the terminal?
 *
 * Choosing Chat from the pane menu flips `wanted` in the same tick the menu starts to close, and the
 * stream has asked nothing yet, so the swap used to land on an empty box and the turns popped in
 * after it. Here the swap waits for the first answer (`answered`), or for {@link CHAT_HOLD_MS}, and
 * the terminal stays up until then. The caller warms the read while the menu is open, so the usual
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
  useEffect(() => {
    if (!wanted) {
      setReady(false);
      return;
    }
    if (answered) {
      setReady(true);
      return;
    }
    const id = setTimeout(() => setReady(true), CHAT_HOLD_MS);
    return () => clearTimeout(id);
  }, [wanted, answered]);
  // `answered` is read directly as well, so an answer already in hand (the warmed read) swaps in the
  // same render as the choice, not one effect later.
  return wanted && (ready || answered);
}
