import { useCallback, useEffect, useRef, useState } from "react";

import { buzz } from "@/lib/haptics";

// Local, synchronous press feedback for fire-and-forget controls.
//
// The problem this exists to solve: a nav-tray key press used to be SILENT on success (the mirror
// was the only acknowledgement), and the mirror can be ~2s behind — the refetch waited out a 300ms
// debounce, and if it beat the TUI's repaint you saw nothing until the next 1.5s poll. So a tap on
// Enter felt like it went nowhere. The dialog blocks already solved this with their `busy` option
// tone (option-button.tsx): the pressed row goes accent while its keystroke is in flight. This hook
// is that idea extracted so the keypad, the quick replies and the key-queue Send share ONE state
// machine instead of three (or, as it was, none).
//
// The phase change is synchronous with the tap — it never waits on the network — which is the whole
// point: `pending` appears on the press, `done` confirms the bridge accepted it, and the mirror
// catching up remains the actual source of truth.

/** How long the ✓ holds after a successful action before the control settles back to idle. */
export const ECHO_DONE_MS = 700;

/** `pending` = in flight, `done` = the ✓ flash, `idle` = resting (also where a FAILED action lands —
 *  the error is the status channel's job, so the control just returns to normal rather than
 *  inventing a second, redundant error surface). */
export type EchoPhase = "idle" | "pending" | "done";

export interface ActionEcho {
  /** Phase for one control in the group, keyed by whatever stable id the caller chose. */
  phaseOf: (id: string) => EchoPhase;
  /** True while ANY action in the group is in flight. Callers that want sibling dimming (the quick
   *  replies — you pick one thing) read this; the keypad deliberately ignores it, because dimming
   *  eight keys on every arrow press would strobe under rapid input. */
  pending: boolean;
  /**
   * Run one action under the echo. `action` resolves true when the bridge accepted it (→ ✓) and
   * false when it didn't (→ straight back to idle). It must surface its own error copy; a throw is
   * caught here and treated as a plain failure so a rejected promise can't wedge a control in
   * `pending` forever.
   */
  run: (id: string, action: () => Promise<boolean>) => Promise<void>;
}

export function useActionEcho(doneMs: number = ECHO_DONE_MS): ActionEcho {
  // Sparse map — only non-idle controls have an entry, so a keypad with nothing in flight renders
  // off an empty object and `pending` is a cheap check.
  const [phases, setPhases] = useState<Record<string, EchoPhase>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Guards the post-await writes: a dock that unmounts mid-flight (tapping Close, or Quick closing
  // itself after the ✓) must not set state on the way out.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const set = useCallback((id: string, phase: EchoPhase) => {
    setPhases((prev) => {
      if (phase === "idle") {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (prev[id] === phase) return prev;
      return { ...prev, [id]: phase };
    });
  }, []);

  const run = useCallback(
    async (id: string, action: () => Promise<boolean>) => {
      // Re-pressing the same control restarts its cycle rather than letting a stale ✓ timer from the
      // previous press cut the new one short.
      const running = timers.current.get(id);
      if (running) {
        clearTimeout(running);
        timers.current.delete(id);
      }
      set(id, "pending");
      // On the PRESS, not the ✓: feedback has to be simultaneous with the tap to read as caused by
      // it, and buzzing again on acknowledgement is just noise.
      buzz();

      let ok = false;
      try {
        ok = await action();
      } catch {
        ok = false; // the caller owns the error copy; here it's just "no ✓"
      }
      if (!alive.current) return;
      if (!ok) {
        set(id, "idle");
        return;
      }
      set(id, "done");
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          if (alive.current) set(id, "idle");
        }, doneMs),
      );
    },
    [set, doneMs],
  );

  const phaseOf = useCallback((id: string): EchoPhase => phases[id] ?? "idle", [phases]);
  const pending = Object.values(phases).some((p) => p === "pending");

  return { phaseOf, pending, run };
}
