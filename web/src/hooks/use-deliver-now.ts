import { useCallback, useEffect, useState } from "react";

import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import type { DeliverNow } from "@/lib/walky";

/** How long a delivered message may still read as held before the button is free again: one list read and some. */
export const DELIVER_SETTLE_MS = 5_000;

export type DeliverPhase = "idle" | "sending" | "sent";

/**
 * Deliver now on one held message (deliver-now prototype): the phase of the call, and the line a failure leaves.
 *
 * `sending` is the call in flight. `sent` is the call answered but the list not yet read again: the message
 * still reads as held, so the button stays taken and a second tap cannot hand it over twice. The phase ends
 * when the message stops being held (the row's receipt moved), or after {@link DELIVER_SETTLE_MS} at most, so a
 * receipt that never moves cannot lock the button for good. A failed call frees the button and leaves a line.
 * A message that no longer waited at the tap (`"gone"`) is no failure: the button frees, and `gone` carries one
 * neutral line that stays after the row stops being held, for the row's receipt now tells what became of it.
 */
export function useDeliverNow(held: boolean, onDeliverNow: DeliverNow | undefined) {
  const [phase, setPhase] = useState<DeliverPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  // A message that left its held state settles the question: the call's phase and its failure go with it.
  if (!held && (phase !== "idle" || error !== null)) {
    setPhase("idle");
    setError(null);
  }
  useEffect(() => {
    if (phase !== "sent") return;
    const timer = setTimeout(() => setPhase("idle"), DELIVER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const run = useCallback(
    async (id: string) => {
      if (onDeliverNow === undefined || phase !== "idle") return;
      setPhase("sending");
      setError(null);
      setGone(null);
      try {
        const end = await onDeliverNow(id);
        if (end === "gone") {
          setPhase("idle");
          setGone(t("walky.sheet.deliverGone"));
          return;
        }
        setPhase("sent");
      } catch (thrown) {
        setPhase("idle");
        setError(t("walky.sheet.deliverFailed", { error: describeThrownError(thrown) }));
      }
    },
    [onDeliverNow, phase],
  );
  return { phase, busy: phase !== "idle", error, gone, run };
}
