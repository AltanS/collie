import { useEffect, useSyncExternalStore } from "react";

import { apiErrorStatus, fetchMathPack } from "@/lib/api";
import { designPrefs, mathEngineOf, setDesignMath, type MathEngine } from "@/lib/design";
import { loadMathEngine, mathEngineFailed } from "@/lib/math/engine";
import type { MathPackStatus } from "@/lib/types";

// THE MATH PACK ON THE HOST, as the phone sees it (ADR 0132). The engines are not in the install:
// the host downloads them on a tap in Settings → Appearance → Math and serves them under `/math/`.
// This module holds the host's last answer for the Math card, reads it when the card opens, and
// polls it while a download runs or the host did not answer, like the Whistle card.
//
// It never downloads anything by itself. Nothing here changes how Chat renders either: a device that
// chose an engine on a host with no pack keeps its choice, the engine's import fails, and its formulas
// stay source (lib/math/engine.ts).
//
// THE STATE IS THE MODULE'S, NOT THE CARD'S, so leaving Settings mid-download loses nothing: the engine
// a person chose while the host had no pack (`wanted`) is applied when the pack is ready, by whichever
// answer brings `ready` first. A failed download clears it.
//
// AN ENGINE THAT FAILED ON THIS PAGE IS NOT IMPORTED AGAIN (engine.ts says why: Vite's preload helper
// would skip its stylesheet). When the pack arrives and the device's engine failed earlier on this page,
// the page reloads ONCE, and the next load starts clean. A guard in sessionStorage stops a loop.
//
// `null` is "not read yet", or a bridge older than the pack that answers 404: the card then draws the
// three choices as before. A read that got no answer before any did is `unreachable`: the engines
// stay disabled and the poll keeps asking.

/** What the card draws from: the host's answer, `unreachable`, or null for "cannot say". */
export type MathPackView = MathPackStatus | { state: "unreachable" } | null;

type Engine = Exclude<MathEngine, "off">;

/** The pack's size, for the download button. Measured on 1.29's pack; the host's total wins once read. */
export const MATH_PACK_APPROX_BYTES = 4_000_000;

/** How often the card asks while the host downloads. */
export const MATH_PACK_POLL_MS = 1000;

/** How long the poll waits after a failed read. It never gives up: a lost connection comes back. */
export const MATH_PACK_BACKOFF_MS = 5000;

/** The guard that keeps the one reload from becoming a loop. */
const RELOAD_KEY = "collie:math-reload:v1";

let current: MathPackView = null;
let wanted: Engine | null = null;
const listeners = new Set<() => void>();
let reload: () => void = () => window.location.reload();

function notify(): void {
  for (const fn of listeners) fn();
}

/** The engine to apply when the pack is ready: the person's pick while it downloads. */
export function setWantedMathEngine(engine: Engine | null): void {
  wanted = engine;
}

/** The host's pack arrived: apply the engine, or reload once when it already failed on this page. */
function arrived(): void {
  if (wanted !== null) {
    setDesignMath(wanted);
    wanted = null;
  }
  const engine = mathEngineOf(designPrefs());
  if (engine === "off") return;
  if (!mathEngineFailed(engine)) {
    forgetReload();
    void loadMathEngine(engine);
    return;
  }
  reloadOnce();
}

function reloadOnce(): void {
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === "1") return;
    sessionStorage.setItem(RELOAD_KEY, "1");
  } catch {
    // No session storage (Safari private mode): no guard, so no reload. Formulas show their source
    // until the next page load.
    return;
  }
  reload();
}

function forgetReload(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* nothing to forget without storage */
  }
}

/** Record what the host answered, from a read or from a POST or DELETE. */
export function noteMathPack(status: MathPackStatus): void {
  current = status;
  if (status.state === "absent" || status.state === "unavailable") wanted = null;
  if (status.state === "ready") arrived();
  notify();
}

/**
 * Ask the host where the pack stands, and answer what the card now holds. A 404 is a bridge older
 * than the pack: nothing changes. Any other failure before a first answer is `unreachable`; after
 * one, the last answer stays.
 */
export async function refreshMathPack(signal?: AbortSignal): Promise<MathPackView> {
  try {
    noteMathPack(await fetchMathPack(signal));
  } catch (error) {
    if (signal?.aborted === true || apiErrorStatus(error) === 404) return current;
    if (current === null) {
      current = { state: "unreachable" };
      notify();
    }
  }
  return current;
}

/** Whether an engine can be chosen: the host serves the engines, or this bridge cannot say. */
export function mathEnginesServed(view: MathPackView): boolean {
  return view === null || view.state === "ready";
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The host's pack, read when the caller mounts, and polled while it downloads or did not answer. */
export function useMathPack(): MathPackView {
  const view = useSyncExternalStore(subscribe, () => current, () => null);
  useEffect(() => {
    const controller = new AbortController();
    void refreshMathPack(controller.signal);
    return () => controller.abort();
  }, []);
  const polling = view?.state === "downloading" || view?.state === "unreachable";
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), ms);
    };
    async function poll(): Promise<void> {
      if (inFlight || controller.signal.aborted) return;
      if (document.visibilityState === "hidden") return; // `visibilitychange` re-arms it
      inFlight = true;
      try {
        noteMathPack(await fetchMathPack(controller.signal));
        schedule(MATH_PACK_POLL_MS);
      } catch {
        if (!controller.signal.aborted) schedule(MATH_PACK_BACKOFF_MS);
      } finally {
        inFlight = false;
      }
    }
    const now = () => {
      if (document.visibilityState !== "hidden") schedule(0);
    };
    window.addEventListener("online", now);
    document.addEventListener("visibilitychange", now);
    schedule(MATH_PACK_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("online", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [polling]);
  return view;
}

/** Test seam: forget the host's last answer and the wanted engine; reload with `fn` instead. */
export function __resetMathPack(fn?: () => void): void {
  current = null;
  wanted = null;
  reload = fn ?? (() => window.location.reload());
}
