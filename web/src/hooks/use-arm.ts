import { useCallback, useEffect, useRef, useState } from "react";

import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";

/** What one tap on an armable control came to. */
export type ArmTap =
  /** The first tap: the control is armed now, and nothing runs. */
  | "armed"
  /** The second tap, after the dwell and inside the window: run the act. The arm is spent. */
  | "fire"
  /** A tap inside the dwell: the same touch landing twice. Neither an act nor a disarm. */
  | "dwell";

/** An armable set of controls: the key armed now, the tap, and the way to drop the arm. */
export interface Arm<K extends string> {
  armed: K | null;
  tap: (key: K) => ArmTap;
  disarm: () => void;
}

/**
 * ARM, THEN ACT (#339, M68): the second-tap confirm, shared by every control that must not fire by
 * accident. The belt's Stop (`ScreenStop`, harness-bar.tsx) and the hill's Decision card read it, so
 * the window and the dwell cannot drift apart between them.
 *
 * The first tap on a key ARMS it: the caller changes the words (never the size) and shows the armed
 * tint. The arm lapses by itself after {@link ARM_MS}. A second tap on the same key counts only
 * {@link ARM_DWELL_MS} or more after the arm, so a double tap, or a thumb that lands twice, is neither
 * an act nor a disarm. ONE key is armed at a time: a tap on another key moves the arm there, so a card
 * with several confirmable buttons never holds two of them armed.
 *
 * The hook owns the timer and nothing else. The caller decides what a key is, what `fire` runs, and
 * when an arm stops making sense (`disarm`): a button that goes dim, a pane that changes.
 */
export function useArm<K extends string>(): Arm<K> {
  const [armed, setArmed] = useState<K | null>(null);
  const armedKey = useRef<K | null>(null);
  const armedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    armedKey.current = null;
    setArmed(null);
  }, []);

  const tap = useCallback(
    (key: K): ArmTap => {
      if (armedKey.current !== key) {
        armedKey.current = key;
        armedAt.current = Date.now();
        setArmed(key);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          armedKey.current = null;
          setArmed(null);
        }, ARM_MS);
        return "armed";
      }
      // Inside the dwell the tap is the same touch landing twice, not a second decision.
      if (Date.now() - armedAt.current < ARM_DWELL_MS) return "dwell";
      disarm();
      return "fire";
    },
    [disarm],
  );

  return { armed, tap, disarm };
}
