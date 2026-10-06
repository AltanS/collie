// The three pairing endpoints, on the same wire contract as web/src/lib/api.ts:
//
//   POST /api/pair             claim the code `bin/collie pair` printed; the bootstrap, sent with no
//                              token on an unpaired phone (the one door an unpaired phone may use)
//   GET  /api/devices          the registry, read-level; the one read that can clear or set the latch
//   POST /api/devices/revoke   write-level, so it carries this device's own token
//
// Every request carries what web/'s `doReq` sends: `content-type: application/json`, the XHR header
// (a fronting proxy answers 401 instead of a redirect), the bearer token from lib/pairing.ts, and
// `redirect: "manual"` with any redirect read as a 401. The build header lands in the shared
// `serverBuild` store, and every answer goes through `notePairing`, as in web/.
import { mounted } from "@web/lib/base-path";
import { asJsonString, parseJsonObject } from "@web/lib/json";
import type { DevicesResponse, PairFailure, PairedDeviceWire } from "@web/lib/types";

import { ApiError, serverBuild } from "./api";
import { authHeader, clearNotPaired, markNotPaired, notePairing } from "./pairing";
import { createStore } from "./store";

const XHR_HEADER = "x-requested-with";
const XHR_HEADER_VALUE = "XMLHttpRequest";
const SERVER_BUILD_HEADER = "x-collie-build";
const GET_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Recover<T> = (status: number, detail: string) => T | null;

function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    return (await res.text()) || res.statusText;
  } catch {
    return res.statusText;
  }
}

async function request<T>(path: string, init: RequestInit = {}, recover?: Recover<T>): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const res = await fetch(mounted(path), {
    ...init,
    redirect: "manual",
    signal: deadline(init.signal ?? undefined, method === "GET" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      [XHR_HEADER]: XHR_HEADER_VALUE,
      ...authHeader(),
    },
  });
  const build = res.headers.get(SERVER_BUILD_HEADER);
  if (build) serverBuild.set(build);
  if (res.type === "opaqueredirect" || REDIRECT_STATUSES.has(res.status)) {
    throw new ApiError(path, 401, "fronting identity proxy requires sign-in");
  }
  if (!res.ok) {
    const detail = await errorDetail(res);
    notePairing(method, res.status, detail);
    const recovered = recover?.(res.status, detail);
    if (recovered !== null && recovered !== undefined) return recovered;
    throw new ApiError(path, res.status, detail);
  }
  notePairing(method, res.status);
  // SAFETY: a 2xx on these three endpoints is the bridge's own response type by contract (the same
  // contract web/src/lib/api.ts rests on); every non-ok answer threw or was recovered above.
  return (await res.json()) as T;
}

/** Why a claim was refused, in the order web/src/lib/api.ts lists them. */
const PAIR_FAILURES: readonly PairFailure[] = [
  "no-pending",
  "expired",
  "exhausted",
  "bad-code",
  "duplicate-label",
  "bad-request",
];

/**
 * A refused claim is a normal answer (a mistyped code, a code never minted), recovered into a value
 * the card renders a sentence for. Anything but a well-formed 400 still throws. An unknown reason
 * reads as the bridge's catch-all, `bad-request`, exactly as web/ does.
 */
export const recoverPairFailure: Recover<{ ok: false; reason: PairFailure }> = (status, detail) => {
  if (status !== 400) return null;
  const body = parseJsonObject(detail);
  if (!body) return null;
  const named = asJsonString(body.error);
  if (named === undefined) return null;
  return { ok: false, reason: PAIR_FAILURES.find((f) => f === named) ?? "bad-request" };
};

export type PairResult = { ok: true; token: string; label: string } | { ok: false; reason: PairFailure };

/** Claim the code `bin/collie pair` printed and enrol this device under `label`. */
export async function pairDevice(code: string, label: string): Promise<PairResult> {
  const res = await request<{ token: string; label: string } | { ok: false; reason: PairFailure }>(
    "/api/pair",
    { method: "POST", body: JSON.stringify({ code, label }) },
    recoverPairFailure,
  );
  return "token" in res ? { ok: true, token: res.token, label: res.label } : res;
}

/** The paired-device registry. Read-level, so an unpaired device may ask (and learn it is unpaired). */
export function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
  return request<DevicesResponse>("/api/devices", signal ? { signal } : {});
}

/** Revoke a paired device by label (this device included, which self-unpairs). Write-level. */
export function revokeDevice(label: string): Promise<DevicesResponse> {
  return request<DevicesResponse>("/api/devices/revoke", { method: "POST", body: JSON.stringify({ label }) });
}

// ── The registry as a store (web/src/lib/loaders.ts `devicesLoader`) ─────────────────────────────

export interface DevicesData {
  /** Whether writes require a bearer token, i.e. whether anything at all is paired. */
  enforced: boolean;
  /** The label THIS device's token authenticated as, or null. */
  current: string | null;
  devices: PairedDeviceWire[];
  /** True when the read failed: the lists are then empty rather than authoritative. */
  error: boolean;
  /** False until the first answer (or failure) lands, so the card does not flash the pair form. */
  loaded: boolean;
}

export const EMPTY_DEVICES: DevicesData = { enforced: false, current: null, devices: [], error: false, loaded: false };

export const devices = createStore<DevicesData>(EMPTY_DEVICES);

/**
 * Fold one registry answer into the store and the latch, as web/'s `devicesLoader` does: enforcement
 * off, or a token that authenticated as someone, clears the latch; enforcement on and nobody sets it.
 * Exported for the unit test; `loadDevices` is the caller.
 */
export function applyDevices(res: DevicesResponse): DevicesData {
  if (!res.enforced || res.current !== null) clearNotPaired();
  else markNotPaired();
  return { enforced: res.enforced, current: res.current, devices: res.devices, error: false, loaded: true };
}

/** One read of the registry into `devices`. A failed read leaves the latch exactly as it was. */
export async function loadDevices(signal?: AbortSignal): Promise<boolean> {
  try {
    const next = applyDevices(await fetchDevices(signal));
    const changed = JSON.stringify(next) !== JSON.stringify(devices.get());
    devices.set(next);
    return changed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && signal?.aborted) throw error;
    devices.set({ enforced: false, current: null, devices: [], error: true, loaded: true });
    return false;
  }
}
