import { useCallback, useRef, useState } from "react";

import { postWalky } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { mintWalkyId, type WalkyReceipt } from "@/lib/walky";

/** What one send came to: the bridge's receipts, or why no answer came. */
export type WalkySendResult = { ok: true; receipts: WalkyReceipt[] } | { ok: false; error: string };

/**
 * One operator message send, with the request id kept per ATTEMPT (M62, decision 7).
 *
 * The id is minted once, when an attempt starts, and a retry of the same attempt reuses it, so a
 * lost answer never types the message twice: the bridge returns the receipt it already wrote for an
 * id it has seen and types nothing. An attempt is the triple (`to`, `body`, `replyTo`). It ENDS the
 * moment any answer arrives, whatever the receipt says, because a refusal is an answer too and the
 * person's next tap is a new intent with a new id. A thrown request (no answer) leaves the attempt
 * open, which is exactly the retry case. This is the same rule the Send Protocol's intent follows
 * (lib/reply-action.ts), on the smaller thing a message is.
 *
 * It owns no words and no outcome display: the composer and the Crew sheet each draw the receipts
 * their own way. `sending` is a ref-backed guard as well as state, so two quick taps are one send.
 */
export function useWalkySend() {
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);

  const send = useCallback(async (to: string, body: string, replyTo?: string): Promise<WalkySendResult | null> => {
    if (inFlight.current) return null;
    const key = JSON.stringify([to, body, replyTo ?? null]);
    if (attempt.current?.key !== key) attempt.current = { key, id: mintWalkyId() };
    const id = attempt.current.id;
    inFlight.current = true;
    setSending(true);
    try {
      const receipts = await postWalky(replyTo === undefined ? { id, to, body } : { id, to, body, replyTo });
      attempt.current = null;
      return { ok: true, receipts };
    } catch (thrown) {
      return { ok: false, error: describeThrownError(thrown) };
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }, []);

  return { send, sending };
}
