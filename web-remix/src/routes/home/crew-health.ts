// The live read of the crew's tier-2 health: the snapshot plus the cadence the scheduler is running
// on. A component that calls this in render must also `useStore(handle, snapshot)` in setup.
import type { HostHealth } from "@web/lib/host-health";
import type { SnapshotResponse } from "@web/lib/types";

import { snapshot } from "../../lib/data";
import { focus, intervalFor } from "../../lib/polling";
import { crewHealth } from "./crew-model";

/**
 * Every member's health for `body`. `pollMs` is `intervalFor` with no burst pending, which is what
 * web/'s `usePolling` hands its `CrewProvider` for the home screen.
 */
export function crewHealthFor(body: SnapshotResponse | undefined): ReadonlyMap<string, HostHealth> {
  if (body === undefined) return crewHealth(undefined, 0);
  const pollMs = intervalFor(body, focus.get(), { bursting: false, changed: false, topology: false });
  return crewHealth(body, pollMs);
}

/** {@link crewHealthFor} on the snapshot as it stands. */
export function crewHealthNow(): ReadonlyMap<string, HostHealth> {
  return crewHealthFor(snapshot.get().data);
}
