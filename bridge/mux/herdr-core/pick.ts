import { muxEndpointVar } from "../registry.ts";
import { HERDR_CORE_MUX, herdrCoreSocketFor } from "./adapter.ts";

// WHEN NOBODY NAMED A MULTIPLEXER, AND ONLY THE NEW CORE IS HERE (M74, decided 2026-10-30).
//
// The default stays `herdr`, the Herdr TUI. One case moves: no `COLLIE_MUX`, no Herdr TUI socket,
// and a herdr-core socket where `hc` would dial. That box runs herdr-app and not the TUI, and
// `herdr` there would mirror a socket that is not there. Both the bridge (`bridge/config.ts`) and
// `collie start` (`cli/mux.ts`) ask this one function, so the two cannot disagree.
//
// A socket FILE is the evidence, as for the TUI (`doctor`'s `herdr-socket` row): nothing is dialled
// here. A stale socket of a dead core is picked too, and then reads as unreachable, which names
// the socket.

/** herdr-core picked in place of the default, with the reason for an operator to read. */
export interface HerdrCorePick {
  readonly mux: string;
  /** The socket the adapter will dial. */
  readonly socket: string;
  readonly evidence: string;
}

/**
 * herdr-core, when the Herdr TUI socket is absent and the core's socket is present; else `null`.
 * The caller has already checked that `COLLIE_MUX` is unset.
 */
export function herdrCoreInPlaceOfTui(
  tuiSocket: string,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): HerdrCorePick | null {
  if (exists(tuiSocket)) return null;
  const socket = herdrCoreSocketFor(env[muxEndpointVar(HERDR_CORE_MUX)] ?? "", env);
  if (!exists(socket)) return null;
  return { mux: HERDR_CORE_MUX, socket, evidence: `a herdr-core socket at ${socket}, and no Herdr socket at ${tuiSocket}` };
}
