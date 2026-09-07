import { useCallback, useState } from "react";
import { asJsonObject, type JsonValue } from "@/lib/json";

// Which screen edge the fixed pins dock to — the agents row's /Agents tab and the key rail's pad
// tab. Persisted in localStorage, following use-dash-prefs' shape (guarded load, coerced parse,
// silent save). Left by default: a left-held phone reaches it with the holding thumb.

export type PinSide = "left" | "right";

const STORAGE_KEY = "collie:pin-side:v1";

const DEFAULT_SIDE: PinSide = "left";

/**
 * Coerce an untrusted parsed value into a {@link PinSide}. Anything but an explicit "right" is
 * the default — a corrupt store must fail toward the reachable edge, not toward nowhere.
 */
export function coercePinSide(raw: JsonValue | undefined): PinSide {
  const p = asJsonObject(raw);
  if (!p) return DEFAULT_SIDE;
  return p.side === "right" ? "right" : DEFAULT_SIDE;
}

function loadSide(): PinSide {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return DEFAULT_SIDE;
    return coercePinSide(JSON.parse(raw));
  } catch {
    return DEFAULT_SIDE;
  }
}

function saveSide(side: PinSide): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ side }));
    }
  } catch {
    // Ignore quota / SSR write errors — a lost chrome preference is not worth a broken render.
  }
}

export interface UsePinSideReturn {
  side: PinSide;
  setSide: (side: PinSide) => void;
}

export function usePinSide(): UsePinSideReturn {
  const [side, setSideState] = useState<PinSide>(loadSide);

  const setSide = useCallback((next: PinSide) => {
    setSideState(next);
    saveSide(next);
  }, []);

  return { side, setSide };
}
