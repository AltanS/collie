import { useEffect, useRef, useState } from "react";

import { sendHillTest } from "@/lib/api";
import { mutate } from "@/lib/mutate";

// "SEND A TEST DECISION" ON THE HILL'S PAGE (2026-11-22, bridge/hill/test-card.ts). One press asks the bridge to post a
// Decision of Collie's own a few seconds later, and the bridge answers at once with the seconds to wait and the first
// reason no notification would be sent. The answer stays as a sentence under the button (the pattern of "Tell all
// sessions now": done words in place, never a status line that vanishes). After a success the button stays
// disabled for the seconds the bridge named, which is the bridge's own one-test-at-a-time rule; there is no countdown, the
// sentence says it. A refusal or a failed call is one line in the same place.

/** What the last press came to: the bridge's answer, or a failure. */
export type HillTestResult = { readonly kind: "sent"; readonly seconds: number; readonly rings: string | null } | { readonly kind: "failed" };

export interface HillTestControl {
  /** The last press's outcome, or null before the first one. It stays until the next press. */
  readonly result: HillTestResult | null;
  /** A call is in flight, or the seconds the bridge named have not passed: the button is disabled. */
  readonly busy: boolean;
  readonly send: () => Promise<void>;
}

/** The inert state a page draws before any press, and where nothing is wired (a test seam, the playground's base). */
export const HILL_TEST_IDLE: HillTestControl = { result: null, busy: false, send: () => Promise.resolve() };

export function useHillTest(): HillTestControl {
  const [result, setResult] = useState<HillTestResult | null>(null);
  const [calling, setCalling] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function send(): Promise<void> {
    if (inFlight.current || waiting) return;
    inFlight.current = true;
    setCalling(true);
    const res = await mutate(() => sendHillTest(), { ownError: true });
    if (res.ok) {
      setResult({ kind: "sent", seconds: res.value.inSeconds, rings: res.value.rings });
      setWaiting(true);
      timer.current = setTimeout(() => setWaiting(false), res.value.inSeconds * 1000);
    } else setResult({ kind: "failed" });
    inFlight.current = false;
    setCalling(false);
  }

  return { result, busy: calling || waiting, send };
}
