import { useEffect, useSyncExternalStore } from "react";

import { fetchMathPack } from "@/lib/api";
import type { MathPackStatus } from "@/lib/types";

// THE MATH PACK ON THE HOST, as the phone sees it (ADR 0132). The engines are not in the install:
// the host downloads them on a tap in Settings → Appearance → Math and serves them under `/math/`.
// This module holds the host's last answer for the Math card, reads it when the card opens, and
// polls it once a second while a download runs and the page is visible, like the Whistle card.
//
// It never downloads anything by itself, and nothing here changes how Chat renders: a device that
// chose an engine on a host with no pack keeps its choice, the engine's import fails, and its
// formulas stay source (lib/math/engine.ts). `null` is "not read yet", or a bridge older than the
// pack that answers 404, and the card then draws the three choices as before.

/** The pack's size, for the download button. Measured on 1.29's pack; the host's total wins once read. */
export const MATH_PACK_APPROX_BYTES = 4_000_000;

/** How often the card asks while the host downloads. */
export const MATH_PACK_POLL_MS = 1000;

/** Consecutive failed polls after which the poll stops until the card opens again. */
const POLL_FAILURE_LIMIT = 10;

let current: MathPackStatus | null = null;
const listeners = new Set<() => void>();

/** Record what the host answered, from a read or from a POST or DELETE. */
export function noteMathPack(status: MathPackStatus): void {
  current = status;
  for (const fn of listeners) fn();
}

/** Ask the host where the pack stands, and answer it. A failure keeps the last answer. */
export async function refreshMathPack(signal?: AbortSignal): Promise<MathPackStatus | null> {
  try {
    noteMathPack(await fetchMathPack(signal));
  } catch {
    /* an older bridge (404), offline, or a refused read: the card keeps what it had */
  }
  return current;
}

/** Whether an engine can be chosen: the host serves the engines, or this bridge cannot say. */
export function mathEnginesServed(status: MathPackStatus | null): boolean {
  return status === null || status.state === "ready";
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The host's pack, read when the caller mounts and polled while it downloads. */
export function useMathPack(): MathPackStatus | null {
  const status = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    const controller = new AbortController();
    void refreshMathPack(controller.signal);
    return () => controller.abort();
  }, []);
  const downloading = status?.state === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    let inFlight = false;
    let failures = 0;
    async function poll(): Promise<void> {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        noteMathPack(await fetchMathPack(controller.signal));
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= POLL_FAILURE_LIMIT) clearInterval(id);
      } finally {
        inFlight = false;
      }
    }
    const id = setInterval(() => void poll(), MATH_PACK_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [downloading]);
  return status;
}

/** Test seam: forget the host's last answer. */
export function __resetMathPack(): void {
  current = null;
}
