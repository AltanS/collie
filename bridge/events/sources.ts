// THE BUS'S SOURCES (M105 spec 03, decision 8). One state engine per multiplexer session
// (bridge/state-engine.ts) reports each status change of an agent pane; this module turns those
// transitions into bus events. No harness name and no multiplexer name is read here: the status is the
// engine's, already the same word for every harness and every multiplexer.
//
//   every transition                      -> session.status { state: to }
//   a turn ends (the rule below)          -> also ONE turn.end
//   any status into `blocked`             -> also ask.open
//
// THE ASK OBSERVER IS THE TRANSITION. The engine lifts a pane to `blocked` when its last screen read
// shows an ask (`StateEngine.liftScreenAsks`, wired to the Surface's `askOnScreen` in bridge/index.ts),
// and a multiplexer that reports `blocked` itself says the same. So the move into `blocked` is the one
// place an ask opens, and `ask.open` rides it. The inside hub's part events (bridge/inside/hub.ts,
// `ask.open` from a linked harness) are not a second source in this step: they would double the event.
//
// THE TURN-END RULE. A turn ends when a pane goes from `working` or `blocked` to `idle` or `done`
// (the same pair `isTurnEnd` in bridge/account-windows.ts reads): Herdr up to 0.8 says `done`, Herdr
// 0.9 can say `idle`, and tmux and zellij never say `done` (bridge/notifications.ts, issue #345). An ask
// the person turned down can end a turn straight from `blocked`. ONE `turn.end` per turn: once a pane's
// turn has ended, no other `turn.end` comes for it until the pane is `working` again. So
// `working -> done -> idle` emits one (the second step is no turn end anyway), and so does
// `working -> done -> blocked -> done` (an ask lifted on a finished pane is no new turn). A pane the
// bridge first saw mid-turn has no history and its first turn end counts.
//
// THE SESSION ID. Every event names the pane by its opaque session id (session-id.ts), built from this
// bridge's id, the pane id and the pane's WalkyTalky instance token. The mux session's name only looks
// the token up; it is never encoded (a person chose it, decision 4). A pane with no
// token, or a moment the id cannot be read (the bridge still starting), publishes nothing: an event is
// never invented with a made-up id. The token is PEEKED, never minted (`WalkyInstances.peek`): minting
// touches `lastSeen` and can write `instances.json`, on every transition and with no trick on. Walky's
// own tick observes every pane of the bridge every INSTANCE_TICK_MS (10 s) and mints the tokens, and so
// does the snapshot; so a pane's events flow from its first tick on, and a transition in the first
// seconds of a new pane's life, before any token, is not published.
//
// ONLY THE PANES `sessions` LISTS (security read 2, item 4). A transition of a pane the local API would
// not list (a bare shell; a trick session never reaches an engine anyway) publishes nothing. The test is
// the predicate `sessions` uses, injected as `listed`, beside the token check below.
//
// The source never throws into the engine's poll: the engine calls its listeners inline, so a failure
// here is caught and the event is skipped.

import type { AgentStatus } from "../types.ts";
import type { PublishInput, SessionState } from "./bus.ts";
import { encodeSessionId } from "./session-id.ts";

/** What the source reads of the pane a transition names: its id, and its kind for the `listed` test. */
export interface TransitionPane {
  readonly paneId: string;
  readonly kind?: string;
  /** `"error"` on a `blocked` pane that stopped on a failure: it opens no ask (AgentView.blockedBy). */
  readonly blockedBy?: string;
}

/** The part of a state engine this source needs: its transition and removal feeds. */
export interface TransitionFeed {
  onTransition(fn: (agent: TransitionPane, from: AgentStatus, to: AgentStatus) => void): () => void;
  onRemove(fn: (paneId: string) => void): () => void;
}

export interface SessionSourceOptions {
  /** The engine of one multiplexer session. */
  readonly engine: TransitionFeed;
  /** The name of that multiplexer session. */
  readonly muxSession: string;
  /** This bridge's stable id (bridge/bridge-id.ts). */
  readonly machine: () => string;
  /**
   * Whether the local API's `sessions` would list this pane (security read 2, item 4): bridge/index.ts
   * passes the one predicate `apiListedPane` (bridge/api/listed.ts), which this folder may not import. A
   * shell pane or a trick session publishes nothing, so no event names an id `sessions` never lists.
   */
  readonly listed: (pane: TransitionPane) => boolean;
  /** The pane's WalkyTalky instance token, or null when it has none. Must mint nothing (`WalkyInstances.peek`). */
  readonly instanceOf: (muxSession: string, paneId: string) => string | null;
  /** Where the events go: the bus's `publish`. */
  readonly publish: (input: PublishInput) => void;
  /** Told, with the error's message, when a transition could not become events. Default: nothing. */
  readonly onError?: (message: string) => void;
}

// AgentStatus and the bus's own spelling are one set of words; this only compiles while they agree.
function stateOf(status: AgentStatus): SessionState {
  return status;
}

/** A pane's turn ended, by the rule in the header (the guard against a second one is the caller's). */
export function endsTurn(from: AgentStatus, to: AgentStatus): boolean {
  return (from === "working" || from === "blocked") && (to === "idle" || to === "done");
}

/**
 * What one transition publishes, in order, for a pane whose turn has `ended` or not. A move into
 * `blocked` opens an ask, unless the pane stopped on an `error`: that one asks nothing, and its
 * `session.status` still says `blocked`.
 */
export function eventsOf(session: string, from: AgentStatus, to: AgentStatus, ended: boolean, error = false): PublishInput[] {
  const out: PublishInput[] = [{ type: "session.status", session, data: { state: stateOf(to) } }];
  if (!ended && endsTurn(from, to)) out.push({ type: "turn.end", session });
  if (to === "blocked" && !error) out.push({ type: "ask.open", session });
  return out;
}

/** Attach the source to one engine. Returns the detach. */
export function attachSessionSource(opts: SessionSourceOptions): () => void {
  // Panes whose turn has ended and that have not been `working` since.
  const ended = new Set<string>();
  const offTransition = opts.engine.onTransition((agent, from, to) => {
    try {
      const paneId = agent.paneId;
      if (to === "working") ended.delete(paneId);
      if (!opts.listed(agent)) return;
      const instance = opts.instanceOf(opts.muxSession, paneId);
      if (instance === null) return;
      const session = encodeSessionId({ machine: opts.machine(), paneId, instance });
      const events = eventsOf(session, from, to, ended.has(paneId), agent.blockedBy === "error");
      if (events.some((event) => event.type === "turn.end")) ended.add(paneId);
      for (const event of events) opts.publish(event);
    } catch (error) {
      opts.onError?.(error instanceof Error ? error.message : String(error));
    }
  });
  const offRemove = opts.engine.onRemove((paneId) => ended.delete(paneId));
  return () => {
    offTransition();
    offRemove();
  };
}
