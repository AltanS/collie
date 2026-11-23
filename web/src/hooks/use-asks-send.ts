import { useCallback, useRef, useState } from "react";

import { sendHillAnswers } from "@/lib/api";
import type { MarkedAnswer } from "@/lib/hill/answers-message";
import { clearAskDrafts } from "@/lib/hill/asks-drafts";
import { clearAskNotes, noteAskSend } from "@/lib/hill/asks-notes";
import { goneWords, refusalWords, sendRequest } from "@/lib/hill/asks-send";
import { readHillNow } from "@/lib/hill/store";
import { mintRequestId } from "@/lib/worktree-name";

// ONE SEND FOR ONE SESSION (Asks build 2, 2026-11-23): the request of `POST /api/hill/answers`, with the request id kept per
// ATTEMPT. The id is minted when an attempt starts and a retry of the same answers reuses it, so a lost answer never
// goes twice (the bridge answers a repeated id with what it stored and runs nothing). Any answer, a refusal too, ends the
// attempt. A ref-backed guard keeps two quick taps one Send. A success clears the drafts of every ask the Send named,
// closed or not; an ask that closed before the Send says so in plain words on its own screen (lib/hill/asks-notes.ts).

/**
 * Where a Send is.
 *  - `idle`: nothing sent, or the last attempt got an answer the person can act on.
 *  - `sending`: the request is in flight.
 *  - `failed`: no answer came (the network). The same tap again retries with the same id.
 *  - `refused`: the bridge turned the whole Send away; `words` says why. Nothing closed and nothing was typed.
 *  - `sent`: the bridge answered and the drafts are cleared.
 */
export type AsksSendState = { phase: "idle" } | { phase: "sending" } | { phase: "failed" } | { phase: "refused"; words: string } | { phase: "sent" };

export interface AsksSend {
  state: AsksSendState;
  /** Send these answers. Resolves true when the bridge took the Send. */
  send: (answers: readonly MarkedAnswer[]) => Promise<boolean>;
  /** Back to `idle`, when the sheet closes. */
  reset: () => void;
}

export function useAsksSend(): AsksSend {
  const attempt = useRef<{ key: string; rid: string } | null>(null);
  const inFlight = useRef(false);
  const [state, setState] = useState<AsksSendState>({ phase: "idle" });

  const send = useCallback(async (answers: readonly MarkedAnswer[]): Promise<boolean> => {
    if (inFlight.current || answers.length === 0) return false;
    const request = sendRequest("", answers);
    const key = JSON.stringify(request.answers);
    if (attempt.current?.key !== key) attempt.current = { key, rid: mintRequestId() };
    const body = { ...request, rid: attempt.current.rid };
    const ids = answers.map((answer) => answer.ask.id);
    inFlight.current = true;
    setState({ phase: "sending" });
    try {
      const outcome = await sendHillAnswers(body);
      attempt.current = null;
      if (!outcome.ok) {
        const refusal = refusalWords(outcome);
        if (refusal.ask !== null) noteAskSend(refusal.ask, refusal.words);
        setState({ phase: "refused", words: refusal.words });
        return false;
      }
      clearAskNotes(ids);
      for (const item of outcome.result.items) {
        if (item.code === "gone") noteAskSend(item.id, goneWords(item));
      }
      clearAskDrafts(ids);
      setState({ phase: "sent" });
      readHillNow();
      return true;
    } catch {
      setState({ phase: "failed" });
      return false;
    } finally {
      inFlight.current = false;
    }
  }, []);

  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, send, reset };
}
