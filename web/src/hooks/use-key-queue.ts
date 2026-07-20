import { useCallback, useMemo, useState } from "react";

import type { Modifier, ModMode } from "@/lib/key-queue";
import { MODIFIER_ORDER, composeKey, nextModMode, normalizeBaseChar } from "@/lib/key-queue";

// Re-exported so consumers can name the arm-state without reaching into lib/key-queue.
export type { ModMode };

// Result of press(): either the keys should fire immediately (nothing is being composed) or they
// were staged onto the queue for review-then-send. A discriminated union so the caller branches
// cleanly — `if (r.mode === "fire") onSend(r.keys)`.
export type PressResult = { mode: "fire"; keys: string[] } | { mode: "queued" };

type ModState = Record<Modifier, ModMode>;

const ALL_OFF: ModState = { ctrl: "off", alt: "off", shift: "off" };

// After a key is staged (press / pushBase) or the queue is sent (take), every `once` modifier is
// spent → back to off, but `locked` modifiers stay armed. That's the whole point of locking: fire
// the same chord repeatedly without re-arming.
function settleMods(cur: ModState): ModState {
  return {
    ctrl: cur.ctrl === "once" ? "off" : cur.ctrl,
    alt: cur.alt === "once" ? "off" : cur.alt,
    shift: cur.shift === "once" ? "off" : cur.shift,
  };
}

// The nav-tray's key-composition state: a set of armed modifiers plus a visible queue of composed
// keys awaiting an explicit Send. Plain useState — no context, no global; instantiate it where the
// keys are pressed.
//
// Modifiers are CHECKBOXES, not radios: each cycles independently off → once → locked → off, so any
// subset can be armed at once and combine into one chord (`ctrl+shift+p`). `once` is the classic
// one-shot (consumed by the next staged key); `locked` survives both a press and a Send, released
// only by cycling it back off or by Clear. "Composing" = any modifier is armed OR the queue is
// non-empty; while composing, every press is staged instead of fired.
export function useKeyQueue() {
  const [queue, setQueue] = useState<string[]>([]);
  const [mods, setMods] = useState<ModState>(ALL_OFF);

  // The armed modifiers in canonical order — what composeKey and the strip both consume.
  const activeMods = useMemo<Modifier[]>(
    () => MODIFIER_ORDER.filter((m) => mods[m] !== "off"),
    [mods],
  );

  const composing = activeMods.length > 0 || queue.length > 0;

  // Cycle ONE modifier through off → once → locked → off. Independent per modifier (checkbox), so
  // arming a second modifier leaves the first alone.
  const arm = useCallback((m: Modifier) => {
    setMods((cur) => ({ ...cur, [m]: nextModMode(cur[m]) }));
  }, []);

  // Not composing → hand the keys back to fire immediately. Composing → append each key composed
  // with the active modifiers, then settle (spend `once`, keep `locked`).
  const press = useCallback(
    (keys: string[]): PressResult => {
      if (activeMods.length === 0 && queue.length === 0) return { mode: "fire", keys };
      setQueue((q) => [...q, ...keys.map((k) => composeKey(activeMods, k))]);
      setMods(settleMods);
      return { mode: "queued" };
    },
    [activeMods, queue.length],
  );

  // The one-char key input: normalise the raw input to a base char, compose with the active mods,
  // stage it, and settle. Ignores non-printable input (returns null from normalizeBaseChar).
  const pushBase = useCallback(
    (char: string) => {
      const base = normalizeBaseChar(char);
      if (base === null) return;
      setQueue((q) => [...q, composeKey(activeMods, base)]);
      setMods(settleMods);
    },
    [activeMods],
  );

  const removeAt = useCallback((i: number) => {
    setQueue((q) => q.filter((_, idx) => idx !== i));
  }, []);

  // The one explicit escape hatch: drop the queue AND release every modifier, including locked.
  const clear = useCallback(() => {
    setQueue([]);
    setMods(ALL_OFF);
  }, []);

  // Hand back the queued keys (for Send) and settle the modifiers — `locked` survives the Send so
  // you can immediately stage the same chord again without re-arming; `once` is spent. Reads the
  // currently-rendered queue — Send is only reachable with a non-empty queue.
  const take = useCallback((): string[] => {
    const taken = queue;
    setQueue([]);
    setMods(settleMods);
    return taken;
  }, [queue]);

  return { queue, mods, activeMods, composing, arm, press, pushBase, removeAt, clear, take };
}
