// The doors this bridge tries before the screen (ADR 0141), by the harness id the multiplexer reports.
// A harness with no row here keeps the Send Protocol's screen path.

import { doorRegistry, type DoorRegistry } from "./door.ts";

export const DOORS: DoorRegistry = doorRegistry([]);
