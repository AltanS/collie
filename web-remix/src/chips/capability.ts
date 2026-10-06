// What the multiplexer can do, read off `/api/config` (web/'s pure `muxCapability`, reused read-only).
// A capability the bridge did not mention reads as present; an absent one carries the adapter's own
// reason. Asked of the ambient config: web/ asks a crew member's own config for a peer's pane, which
// this shell does not fetch yet, so a peer's controls follow the lead's multiplexer (a gap until the
// per-member config read lands).
import { muxCapability, type MuxCapabilityState } from "@web/lib/mux-capability";
import type { MuxCapability } from "@web/lib/types";

import { config } from "../lib/data";

export type { MuxCapabilityState };

export function capability(name: MuxCapability): MuxCapabilityState {
  return muxCapability(config.get().data?.mux ?? null, name);
}
