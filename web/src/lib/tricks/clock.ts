// THE CLOCK A TRICK'S TIMES ARE READ AGAINST (M94 slice 02): the page's one ticking clock
// (lib/cache-clock.ts, one interval for every reader, stopped while the page is hidden), moved onto
// the bridge's clock (lib/server-clock.ts), because `asOf` and a `time` node's `at` were written on
// the bridge's machine. A phone whose own clock is minutes off still ages a part correctly.

import { useSyncExternalStore } from "react";

import { cacheClockNow, subscribeCacheClock } from "../cache-clock";
import { onBridgeClock } from "../server-clock";

function bridgeNow(): number {
  return onBridgeClock(cacheClockNow());
}

/** Now on the bridge's clock, re-read every second. `fixed` pins it, for a test or a playground card. */
export function useBridgeNow(fixed?: number): number {
  const ticking = useSyncExternalStore(subscribeCacheClock, bridgeNow, bridgeNow);
  return fixed ?? ticking;
}
