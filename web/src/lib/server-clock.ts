// THE BRIDGE'S CLOCK, AS THE PHONE ESTIMATES IT.
//
// An ask's `expiresAt` is a time on the program's clock, and the bridge is the one that compares it
// (bridge/mux/durable/protocol.ts `askExpired`). A phone whose own clock is minutes off would count
// a permission card down to the wrong moment, so the card counts against the bridge's clock instead.
//
// NO WIRE CHANGE. Every bridge response already carries the HTTP `Date` header (Bun.serve sets it),
// and every request of this app passes one fetch site (lib/api.ts `apiFetch`). That site hands each
// response's `Date` here with the phone's clock before and after the round trip; this module keeps
// the offset `bridge - phone` as the median of the last few samples.
//
// A SAMPLE IS ONLY AS GOOD AS ITS ROUND TRIP. The bridge stamped the header somewhere between the send
// and the reply, so a slow round trip leaves a wide window and is dropped. The header has whole
// seconds, so the middle of its second is the guess, and an offset under one second is read as none:
// the header cannot tell it from noise, and a phone in step keeps exactly the clock it had.
//
// No sample yet, an older proxy that strips the header, or a test with no header: the offset is 0,
// which is the phone's own clock, as before.

/** How many recent samples the median is taken over. */
const SAMPLES = 5;
/** A round trip slower than this says too little about when the bridge stamped its header. */
export const MAX_ROUND_TRIP_MS = 1500;
/** The `Date` header's resolution: whole seconds. */
const DATE_RESOLUTION_MS = 1000;

const offsets: number[] = [];
let skewMs = 0;

/**
 * Note one response's `Date` header. `sentAt` and `receivedAt` are the phone's clock (epoch ms) just
 * before the request went out and when the response's headers arrived.
 */
export function noteServerDate(date: string | null, sentAt: number, receivedAt: number): void {
  if (date === null) return;
  const server = Date.parse(date);
  if (!Number.isFinite(server)) return;
  const roundTrip = receivedAt - sentAt;
  if (roundTrip < 0 || roundTrip > MAX_ROUND_TRIP_MS) return;
  offsets.push(server + DATE_RESOLUTION_MS / 2 - (sentAt + roundTrip / 2));
  if (offsets.length > SAMPLES) offsets.shift();
  const middle = median(offsets);
  skewMs = Math.abs(middle) < DATE_RESOLUTION_MS ? 0 : Math.round(middle);
}

/** The bridge's clock minus the phone's, in ms. 0 until a usable sample arrived. */
export function serverSkewMs(): number {
  return skewMs;
}

/** A moment on the phone's clock, moved onto the bridge's. */
export function onBridgeClock(phoneNow: number): number {
  return phoneNow + skewMs;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Reset the module for a test. Not called by app code: the page talks to one bridge. */
export function resetServerClockForTests(): void {
  offsets.length = 0;
  skewMs = 0;
}
