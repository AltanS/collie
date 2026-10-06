// THE DEVICE CREDENTIAL THIS PHONE HOLDS, without React.
//
// A one-for-one port of web/src/lib/pairing.ts. The storage key, the refusal body and the two
// deliberate shapes are the same, so a phone paired by the React app is paired here and the other
// way round:
//
//   1. The token is read from localStorage on EVERY access, never cached in a module variable. It is
//      written by the pairing card and read by every request (lib/api.ts reads the same key), and a
//      module copy would be a second source of truth a second tab could desync.
//   2. `refused` is a latch, not a poll. Reads are ungated, so only a WRITE can learn that this
//      device is unpaired (a 403 with the body below). It clears on proof of the opposite: a
//      successful write, a fresh pairing, or a `/api/devices` answer that names this device.
//
// web/'s module cannot be reused as it stands: it imports React for `usePairing`. The difference is
// that one hook, replaced by a `Store` for `useStore`.
import { createStore, type Store } from "./store";

/** localStorage key holding this device's bearer token. Same key as web/src/lib/pairing.ts. */
export const TOKEN_STORAGE_KEY = "collie:device-token";

/** The exact body the bridge sends when a write is refused for want of pairing. */
export const NOT_PAIRED_BODY = "device not paired";

export interface PairingStatus {
  /** This device's stored token, or null. */
  token: string | null;
  /** True once a write came back "device not paired": the token is missing or rejected. */
  refused: boolean;
}

let refused = false;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** This device's bearer token, or null when it has never paired (or was revoked here). */
export function getDeviceToken(): string | null {
  try {
    return storage()?.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    // Private-mode or locked-down storage: behave exactly like an unpaired device.
    return null;
  }
}

function read(): PairingStatus {
  return { token: getDeviceToken(), refused };
}

/** The token and the latch, for `useStore`. Rewritten on every mutation in this module. */
export const pairing: Store<PairingStatus> = createStore<PairingStatus>(
  read(),
  (a, b) => a.token === b.token && a.refused === b.refused,
);

function emit(): void {
  pairing.set(read());
}

/** Store the token minted by a successful `/api/pair`. Clears the refusal latch: we just proved it. */
export function setDeviceToken(token: string): void {
  try {
    storage()?.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore: the in-memory session still works until reload
  }
  refused = false;
  emit();
}

/** Forget this device's token (revoking yourself, or re-pairing after a rejection). */
export function clearDeviceToken(): void {
  try {
    storage()?.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** The `Authorization` header for an API request, or nothing when this device holds no token. */
export function authHeader(): Record<string, string> {
  const token = getDeviceToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Latch "the bridge refused a write because this device isn't paired". Idempotent. */
export function markNotPaired(): void {
  if (refused) return;
  refused = true;
  emit();
}

/** Clear the latch: this device IS accepted (or pairing is off). */
export function clearNotPaired(): void {
  if (!refused) return;
  refused = false;
  emit();
}

/** Whether a write has been refused for want of pairing since the last proof of the opposite. */
export function isNotPaired(): boolean {
  return refused;
}

/**
 * Feed one API answer to the latch, exactly as web/src/lib/api.ts `notePairing` does: a GET never
 * moves it, a write refused with the not-paired body sets it, any other 2xx write clears it.
 */
export function notePairing(method: string, status: number, detail?: string): void {
  if (method === "GET") return;
  if (status === 403 && detail?.trim() === NOT_PAIRED_BODY) {
    markNotPaired();
    return;
  }
  if (status >= 200 && status < 300) clearNotPaired();
}

/** Re-read storage into the store: another tab may have paired or unpaired this origin. */
export function refreshPairing(): void {
  emit();
}

/** Test seam: drop the latch and re-read storage. */
export function __resetPairing(): void {
  refused = false;
  emit();
}
