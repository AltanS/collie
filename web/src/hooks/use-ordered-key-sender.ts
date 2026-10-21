import { useCallback, useEffect, useRef, useState } from "react";

// Bound one request when an IME or paste commits a large string at once. The remainder stays queued
// behind it, preserving order without handing the bridge an unbounded JSON array.
const MAX_BATCH = 64;

// Serialize bursts of keys through Herdr's one-shot RPC. Ordering is guaranteed inside one
// `send_keys` array, but not across concurrent connections, so one batch stays in flight while any
// later input accumulates into the next batch. This is transport backpressure, not a typing delay:
// the first key leaves immediately and a slow round trip merely makes the following batch larger.
//
// `enqueue` answers with the verdict of the batch that carried the LAST of its keys: true when that
// batch went through, false when it failed or when the keys never reached the wire (discarded by an
// earlier failure, by `reset`, or by unmount). A caller that must follow queued text, such as a Keys
// dock key behind Type mode's line, enqueues here and awaits that answer instead of sending beside it.
export function useOrderedKeySender(
  send: (keys: string[]) => Promise<boolean>,
  onFailure: () => void,
) {
  const pending = useRef<string[]>([]);
  // Running counts of keys queued and keys handed to a batch. A waiter stores the queued count just
  // after its keys, so it is carried by the batch that brings `taken` up to that mark.
  const queued = useRef(0);
  const taken = useRef(0);
  const waiters = useRef<{ end: number; resolve: (ok: boolean) => void }[]>([]);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const sendRef = useRef(send);
  const failureRef = useRef(onFailure);
  const pumpRef = useRef<() => void>(() => {});
  const [busy, setBusy] = useState(false);

  sendRef.current = send;
  failureRef.current = onFailure;

  // Drop every key not yet on the wire, and answer false to everyone still waiting for one.
  const discardPending = useCallback(() => {
    pending.current = [];
    taken.current = queued.current;
    const dropped = waiters.current;
    waiters.current = [];
    for (const waiter of dropped) waiter.resolve(false);
  }, []);

  const pump = useCallback(() => {
    if (inFlight.current || pending.current.length === 0) return;

    const batch = pending.current.splice(0, MAX_BATCH);
    taken.current += batch.length;
    const carriedCount = waiters.current.findIndex((waiter) => waiter.end > taken.current);
    const carried = waiters.current.splice(0, carriedCount === -1 ? waiters.current.length : carriedCount);
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
        for (const waiter of carried) waiter.resolve(ok);
        if (!ok && batchGeneration === generation.current) {
          // A failure makes the target's input state unknown. Stop immediately and discard anything
          // that had not reached the wire rather than resuming blind after a transient error.
          discardPending();
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
  }, [discardPending]);
  pumpRef.current = pump;

  const enqueue = useCallback((keys: string[]): Promise<boolean> => {
    // Nothing to send, so nothing can fail.
    if (keys.length === 0) return Promise.resolve(true);
    pending.current.push(...keys);
    queued.current += keys.length;
    const verdict = new Promise<boolean>((resolve) => {
      waiters.current.push({ end: queued.current, resolve });
    });
    if (mounted.current) setBusy(true);
    pumpRef.current();
    return verdict;
  }, []);

  // Invalidate queued work when the pane changes. An RPC already in flight cannot be recalled, but
  // it captured the old target before the reset; no unsent key is allowed to leak into the new pane.
  const reset = useCallback(() => {
    generation.current += 1;
    discardPending();
    if (!inFlight.current && mounted.current) setBusy(false);
  }, [discardPending]);

  useEffect(
    () => () => {
      mounted.current = false;
      generation.current += 1;
      discardPending();
    },
    [discardPending],
  );

  return { enqueue, reset, busy };
}
