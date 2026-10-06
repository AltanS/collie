// The per-device flags Settings owns that `lib/prefs.ts` does not carry, on the SAME localStorage
// keys and the same "1"/"0" form as web/, so one phone running either shell reads one choice:
//
//   collie:auto-zen-enabled:v1   zen's auto-landscape sub-switch (web/src/lib/zen.ts), default off
//   collie:stt-hands-free:v1     send a transcript instead of inserting it (web/src/lib/stt.ts), off
//   collie:tour:v1               the first-run screen's seen version; "0" asks to see it again
//
// web/'s modules cannot be imported here (each pulls React for its hook), so these are the same
// stores without the hook. Write-through, loaded at module evaluation, re-read on a `storage` event.
import { createStore, type Store } from "../../lib/store";

export const DEVICE_KEYS = {
  autoZen: "collie:auto-zen-enabled:v1",
  handsFree: "collie:stt-hands-free:v1",
  tour: "collie:tour:v1",
} as const;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface FlagStore extends Store<boolean> {
  readonly key: string;
  reload(): void;
}

const flags: FlagStore[] = [];

/** web/'s "1"/"0" flag: anything but "1" reads off, and a missing key reads the default. */
export function flagStore(key: string, fallback: boolean): FlagStore {
  const read = (): boolean => {
    try {
      const raw = storage()?.getItem(key) ?? null;
      return raw === null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  };
  const inner = createStore<boolean>(read());
  const flag: FlagStore = {
    key,
    get: inner.get,
    set(next) {
      if (next === inner.get()) return;
      try {
        storage()?.setItem(key, next ? "1" : "0");
      } catch {
        // Quota or private mode: the in-memory value still applies for this session.
      }
      inner.set(next);
    },
    update: (change) => flag.set(change(inner.get())),
    subscribe: inner.subscribe,
    version: inner.version,
    reload: () => inner.set(read()),
  };
  flags.push(flag);
  return flag;
}

export const autoZen = flagStore(DEVICE_KEYS.autoZen, false);
export const handsFree = flagStore(DEVICE_KEYS.handsFree, false);

/** The Settings row's "show it again" (web/src/lib/tour.ts `resetTour`): writes "0", never removes the key. */
export function resetTour(): void {
  try {
    storage()?.setItem(DEVICE_KEYS.tour, "0");
  } catch {
    // ignore: the row's tap still goes home
  }
}

let syncing = false;

/** Re-read a key when another tab writes it. Idempotent; started from the module that owns a store. */
export function startDeviceSync(target: Pick<Window, "addEventListener"> = window): void {
  if (syncing) return;
  syncing = true;
  target.addEventListener("storage", (event: StorageEvent) => {
    for (const flag of flags) if (event.key === null || event.key === flag.key) flag.reload();
  });
}

// Tests run without a window; the page always has one.
if ("window" in globalThis) startDeviceSync();
