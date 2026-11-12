// The doors one session tries before the screen (ADR 0141), by the harness id the multiplexer reports.
// A harness with no row here keeps the Send Protocol's screen path.

import { doorRegistry, type Door, type DoorRegistry } from "./door.ts";
import { hermesDoor, type HermesDoorDeps } from "./hermes.ts";
import { piDoor, type PiDoorDeps } from "./pi.ts";

/** What each door needs from the session. A door whose part is absent is not in the registry. */
export interface SessionDoorDeps {
  readonly pi?: PiDoorDeps;
  readonly hermes?: HermesDoorDeps;
}

/** The registry for one session. */
export function doorsFor(deps: SessionDoorDeps): DoorRegistry {
  const doors: Door[] = [];
  if (deps.pi !== undefined) doors.push(piDoor(deps.pi));
  if (deps.hermes !== undefined) doors.push(hermesDoor(deps.hermes));
  return doorRegistry(doors);
}
