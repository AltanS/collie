// Retry a safe GET once (research note 07, c.10; ACTION-PLAN D.7).
//
// A phone that sleeps and changes networks gets blips from `fetch`: the same URL worked a moment ago,
// and the next request rejects with a bare TypeError. Mobile Safari says `Load failed`, Chromium says
// `Failed to fetch` (Chromium Mobile adds the origin, `Failed to fetch (host)`), Firefox says
// `NetworkError when attempting to fetch resource.` The match is these EXACT messages and nothing
// wider, so any other TypeError (a bad URL, "Failed to fetch dynamically imported module") still
// surfaces as itself.
//
// WHY IT CANNOT HIDE A REAL OUTAGE. The retry is one immediate second send. An outage fails it too and
// the rejection reaches the poll exactly as before, so the connection strip's clocks (amber at 4 s,
// red at 15 s since the last live answer, `shell/connection-state.ts`) are untouched: they count from
// the last answer that proved the bridge live, and a blip that the retry rescues is a live answer.
// What it removes is the amber flash a single lost poll caused on the 6 s beat (the poll that fails
// is already 6 s past the last live one, so one blip crossed the 4 s line at once).
//
// It never retries an aborted request (a superseded poll), a request with a body, or a second time.

/** The exact messages of a network blip, with Chromium's optional ` (origin)` suffix. */
const NETWORK_BLIP = /^(?:Load failed|Failed to fetch(?: \([^)]*\))?|NetworkError when attempting to fetch resource\.)$/u;

/** Whether `error` is the TypeError a browser's `fetch` rejects with on a transient network failure. */
export function isNetworkBlip(error: Error): boolean {
  return error instanceof TypeError && NETWORK_BLIP.test(error.message.trim());
}

/**
 * Run `send`; if it rejects with a network blip and `signal` is not aborted, run it once more and let
 * that answer or rejection stand. `send` builds a fresh request each call (a new deadline, say).
 */
export async function sendRetryingOnce(send: () => Promise<Response>, signal: AbortSignal | undefined): Promise<Response> {
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof Error) || !isNetworkBlip(error) || signal?.aborted === true) throw error;
    return send();
  }
}
