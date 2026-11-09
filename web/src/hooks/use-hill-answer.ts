import { useCallback, useRef, useState } from "react";

import { postHillAnswer } from "@/lib/api";
import { noteHillAnswer, useHillAnswerHeld } from "@/lib/hill/store";
import { hillNode, type HillReceipt } from "@/lib/hill/wire";
import { mintRequestId } from "@/lib/worktree-name";

/**
 * Where one card's answer is.
 *  - `idle`: nothing sent, or the last answer was refused and the card takes a new one.
 *  - `sending`: the request is in flight.
 *  - `failed`: no answer came (the network). The same tap again retries with the same request id.
 *  - `answered`: the bridge answered with a receipt, held in the store until the next list.
 */
export type HillAnswerState =
  | { phase: "idle" }
  | { phase: "sending"; intent: string; text: string | null }
  | { phase: "failed"; intent: string; text: string | null }
  | { phase: "answered"; intent: string; text: string | null; receipt: HillReceipt };

export const HILL_IDLE: HillAnswerState = { phase: "idle" };

/** One card's answer: where it is, and the call that sends one. */
export interface HillAnswer {
  state: HillAnswerState;
  send: (intent: string, text: string | null) => Promise<void>;
}

/**
 * One person's answer to one Decision on the hill (M96), with the request id kept per ATTEMPT.
 *
 * The rule is `useWalkySend`'s. The id is minted once, when an attempt starts, and a retry of the
 * same attempt reuses it, so a lost answer never answers twice: the bridge returns the receipt it
 * already wrote for an id it has seen and runs nothing. An attempt is (`intent`, `text`) on this
 * decision. It ENDS the moment any answer arrives, whatever the receipt says, because a refusal is an
 * answer too and the person's next tap is a new intent with a new id. A thrown request (no answer)
 * leaves the attempt open, which is exactly the retry case.
 *
 * The receipt goes into the store (lib/hill/store.ts) beside the decision, so it holds until the next
 * list, whichever component asks. `sending` is a ref-backed guard as well as state, so two quick taps
 * are one answer.
 */
export function useHillAnswer(decisionId: string): HillAnswer {
  const attempt = useRef<{ key: string; rid: string } | null>(null);
  const inFlight = useRef(false);
  const [local, setLocal] = useState<HillAnswerState>(HILL_IDLE);
  const held = useHillAnswerHeld(decisionId);

  const send = useCallback(
    async (intent: string, text: string | null) => {
      if (inFlight.current) return;
      const key = JSON.stringify([intent, text]);
      if (attempt.current?.key !== key) attempt.current = { key, rid: mintRequestId() };
      const rid = attempt.current.rid;
      inFlight.current = true;
      setLocal({ phase: "sending", intent, text });
      try {
        const receipt = await postHillAnswer({ rid, node: hillNode(decisionId), intent, value: { text } });
        attempt.current = null;
        noteHillAnswer(decisionId, { receipt, intent, text });
        setLocal(HILL_IDLE);
      } catch {
        setLocal({ phase: "failed", intent, text });
      } finally {
        inFlight.current = false;
      }
    },
    [decisionId],
  );

  // What this card is doing now wins over what the store holds from an earlier answer.
  if (local.phase !== "idle" || held === null) return { state: local, send };
  return { state: { phase: "answered", intent: held.intent, text: held.text, receipt: held.receipt }, send };
}
