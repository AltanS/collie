import { useCallback, useState } from "react";

import type { Modifier } from "@/lib/key-queue";
import { composeKey, normalizeBaseChar } from "@/lib/key-queue";

// Result of press(): either the keys should fire immediately (nothing is being composed) or they
// were staged onto the queue for review-then-send. A discriminated union so the caller branches
// cleanly — `if (r.mode === "fire") onSend(r.keys)`.
export type PressResult = { mode: "fire"; keys: string[] } | { mode: "queued" };

// The nav-tray's key-composition state: an armed one-shot modifier plus a visible queue of composed
// keys awaiting an explicit Send. Plain useState — no context, no global; instantiate it where the
// keys are pressed. `mod` has radio semantics (arming one disarms the other); the modifier is
// one-shot (consumed by the next key, like the old sticky Shift). "Composing" = a mod is armed OR
// the queue is non-empty; while composing, every press is staged instead of fired.
export function useKeyQueue() {
  const [queue, setQueue] = useState<string[]>([]);
  const [mod, setMod] = useState<Modifier | null>(null);

  const composing = mod !== null || queue.length > 0;

  // Radio + toggle: arming the already-armed modifier disarms it; arming the other switches.
  const arm = useCallback((m: Modifier) => {
    setMod((cur) => (cur === m ? null : m));
  }, []);

  // Not composing → hand the keys back to fire immediately. Composing → append each key composed
  // with the armed modifier, then disarm it (one-shot).
  const press = useCallback(
    (keys: string[]): PressResult => {
      if (mod === null && queue.length === 0) return { mode: "fire", keys };
      setQueue((q) => [...q, ...keys.map((k) => composeKey(mod, k))]);
      setMod(null);
      return { mode: "queued" };
    },
    [mod, queue.length],
  );

  // The one-char key input: normalise the raw input to a base char, compose with the armed mod, stage
  // it, and consume the modifier. Ignores non-printable input (returns null from normalizeBaseChar).
  const pushBase = useCallback(
    (char: string) => {
      const base = normalizeBaseChar(char);
      if (base === null) return;
      setQueue((q) => [...q, composeKey(mod, base)]);
      setMod(null);
    },
    [mod],
  );

  const removeAt = useCallback((i: number) => {
    setQueue((q) => q.filter((_, idx) => idx !== i));
  }, []);

  const clear = useCallback(() => {
    setQueue([]);
    setMod(null);
  }, []);

  // Hand back the queued keys (for Send) and reset composition state. Reads the currently-rendered
  // queue — Send is only reachable with a non-empty queue.
  const take = useCallback((): string[] => {
    const taken = queue;
    setQueue([]);
    setMod(null);
    return taken;
  }, [queue]);

  return { queue, mod, composing, arm, press, pushBase, removeAt, clear, take };
}
