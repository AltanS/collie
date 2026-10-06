// The push endpoint this device last registered with the bridge, remembered across reloads.
//
// Its own module, with no imports, so the wipe (lib/wipe.ts) can forget it without importing
// lib/push.ts, which imports lib/api.ts, which calls the wipe on a pairing refusal. lib/push.ts
// explains why the endpoint is remembered at all (issue #104: a new endpoint names its predecessor).

/** localStorage key holding the endpoint this device last registered with the bridge. */
export const PUSH_ENDPOINT_KEY = "collie:push-endpoint";

// The acknowledgement for this page when persistent storage refused the write. `undefined` means
// "read localStorage"; null is a real "no endpoint".
let volatileEndpoint: string | null | undefined;

export function rememberedEndpoint(): string | null {
  if (volatileEndpoint !== undefined) return volatileEndpoint;
  try {
    return localStorage.getItem(PUSH_ENDPOINT_KEY);
  } catch {
    return null;
  }
}

export function rememberEndpoint(endpoint: string | null): void {
  try {
    if (endpoint === null) localStorage.removeItem(PUSH_ENDPOINT_KEY);
    else localStorage.setItem(PUSH_ENDPOINT_KEY, endpoint);
    volatileEndpoint = undefined;
  } catch {
    // Keep the acknowledgement for this page when persistent storage is unavailable.
    volatileEndpoint = endpoint;
  }
}
