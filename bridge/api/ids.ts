// THE LOCAL API'S SESSION IDS (M105 spec 03, decision 12). Every operation of the local API names an
// agent session by its opaque session id (`ses_...`, bridge/events/session-id.ts), the id the bus's
// events carry and `sessions` lists. No operation takes a bare pane id: a multiplexer reuses a pane id
// once the pane closes, and a bare id would then reach the new session in that pane.
//
// RESOLVING. An id holds the machine, the pane id and the pane's WalkyTalky instance token
// (bridge/walky/instances.ts). It resolves as a WalkyTalky address with a token resolves: across every
// multiplexer session of this bridge, to the ONE pane whose pane id AND current instance token both
// match. The instance registry never gives two panes with the same pane id the same token, so a match
// is unique; two matches anyway (a broken invariant) resolve to nothing, the closed side.
//
//   malformed text, another machine's id, no pane with that pane id   -> api.session_unknown
//   a pane with that pane id, but its token now differs (or it has none) -> api.session_replaced
//
// THE 30 SECOND GRACE (security read 1, note 1). `session_replaced` is answered once Collie has SEEN the
// pane gone: the registry drops a token only after the pane was out of sight for 30 s
// (bridge/walky/instances.ts, INSTANCE_GRACE_MS). So when the multiplexer reuses a pane id inside that
// time, the new pane may still hold the old token, and an old session id reads the new session's screen
// for up to 30 s. For a read by the same Unix user this is accepted (decision 16: such a program can read
// the screen through the multiplexer anyway). It is NOT accepted for a send (step two) or the remote tier.
//
// Another machine's id is unknown here, never forwarded: the local tier answers for this bridge only.
// A crew member's id that the lead lists (later) is resolved by its own bridge, not by this one.
//
// Pure: the panes and their tokens come in through a view; nothing here reads the bridge.

import { decodeSessionId, encodeSessionId } from "../events/session-id.ts";

/** One pane an id may name, in one multiplexer session of this bridge. */
export interface PaneSighting {
  readonly muxSession: string;
  readonly paneId: string;
}

/** What resolving needs to see of the bridge, read at each call. */
export interface SessionView {
  /** This bridge's stable id (bridge/bridge-id.ts), the `machine` inside every id it makes. */
  machine(): string;
  /** Every pane an id may name now, across this bridge's multiplexer sessions. */
  panes(): readonly PaneSighting[];
  /** The instance token the pane holds now, or null. Must mint nothing (WalkyInstances.peek). */
  instanceOf(muxSession: string, paneId: string): string | null;
}

/** A session id resolved to its pane. */
export interface ResolvedSession {
  readonly id: string;
  readonly muxSession: string;
  readonly paneId: string;
  readonly instance: string;
}

export type ResolveResult =
  | ({ readonly ok: true } & ResolvedSession)
  | { readonly ok: false; readonly code: "api.session_unknown" | "api.session_replaced" };

/** The session id of one pane instance of a machine, for an answer. */
export function idOf(machine: string, paneId: string, instance: string): string {
  return encodeSessionId({ machine, paneId, instance });
}

/** Resolve a session id against this bridge's panes now (see the header for the cases). */
export function resolveSession(id: string, view: SessionView): ResolveResult {
  const parts = decodeSessionId(id);
  if (parts === null || parts.machine !== view.machine()) return { ok: false, code: "api.session_unknown" };
  const sameId = view.panes().filter((pane) => pane.paneId === parts.paneId);
  if (sameId.length === 0) return { ok: false, code: "api.session_unknown" };
  const found = sameId.filter((pane) => view.instanceOf(pane.muxSession, pane.paneId) === parts.instance);
  if (found.length === 0) return { ok: false, code: "api.session_replaced" };
  if (found.length > 1) return { ok: false, code: "api.session_unknown" };
  const pane = found[0]!;
  return { ok: true, id, muxSession: pane.muxSession, paneId: pane.paneId, instance: parts.instance };
}
