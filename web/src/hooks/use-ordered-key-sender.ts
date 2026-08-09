import { useCallback, useEffect, useRef, useState } from "react";

// Bound one request when an IME or paste commits a large string at once. The remainder stays queued
// behind it, preserving order without handing the bridge an unbounded JSON array.
const MAX_BATCH = 64;

// Serialize bursts of keys through Herdr's one-shot RPC. Ordering is guaranteed inside one
// `send_keys` array, but not across concurrent connections, so one batch stays in flight while any
// later input accumulates into the next batch. This is transport backpressure, not a typing delay:
// the first key leaves immediately and a slow round trip merely makes the following batch larger.
export function useOrderedKeySender(
  send: (keys: string[]) => Promise<boolean>,
  onFailure: () => void,
) {
  const pending = useRef<string[]>([]);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const sendRef = useRef(send);
  const failureRef = useRef(onFailure);
  const pumpRef = useRef<() => void>(() => {});
  const [busy, setBusy] = useState(false);

  sendRef.current = send;
  failureRef.current = onFailure;

  const pump = useCallback(() => {
    if (inFlight.current || pending.current.length === 0) return;

    const batch = pending.current.splice(0, MAX_BATCH);
    const batchGeneration = generation.current;
    inFlight.current = true;

    const flush = async () => {
      try {
        let ok = false;
        try {
          ok = await sendRef.current(batch);
        } catch {
          // A thrown transport failure has the same stop-now semantics as a false verdict.
        }
        if (!ok && batchGeneration === generation.current) {
          // A failure makes the target's input state unknown. Stop immediately and discard anything
          // that had not reached the wire rather than resuming blind after a transient error.
          pending.current = [];
          generation.current += 1;
          failureRef.current();
        }
      } finally {
        inFlight.current = false;
        if (pending.current.length > 0) {
          pumpRef.current();
        } else if (mounted.current) {
          setBusy(false);
        }
      }
    };
    void flush();
  }, []);
  pumpRef.current = pump;

  const enqueue = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    pending.current.push(...keys);
    if (mounted.current) setBusy(true);
    pumpRef.current();
  }, []);

  // Invalidate queued work when the pane changes. An RPC already in flight cannot be recalled, but
  // it captured the old target before the reset; no unsent key is allowed to leak into the new pane.
  const reset = useCallback(() => {
    generation.current += 1;
    pending.current = [];
    if (!inFlight.current && mounted.current) setBusy(false);
  }, []);

  useEffect(
    () => () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = [];
    },
    [],
  );

  return { enqueue, reset, busy };
}
