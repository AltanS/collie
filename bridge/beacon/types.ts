// THE BEACON CONTRACT — what an agent may tell Collie about itself, and nothing more.
//
// A pane Collie did not spawn has no identity: the multiplexer adapters underneath (tmux, zellij)
// declare `agentDetection: false` and say why at the line — `pane_current_command` is whatever is in
// the foreground this second, and a wrong agent name picks a wrong harness grammar AND a wrong
// journal adapter. The agent itself, however, knows exactly who it is. A beacon is the one way it
// can say so: its own hooks write this record, Collie reads it, and nothing is inferred.
//
// ── A BEACON IS A HINT, NEVER A CONTROL CHANNEL (.adr/0024) ───────────────────────────────────────
//
// Everything below is READ. No field here can cause a send, a key, a rename or a close, arm a mode,
// relax a guard or bypass a gate. The reader's output is consumed by the snapshot join (M11/03) and
// the journal key (M11/04) and by nothing else. Anything that can write into the beacon directory is
// the threat model — not the operator who installed the hook — so a `path` carried in a beacon has
// exactly the standing of pi's `path` session ref: attacker-shaped by construction, and it reaches
// the filesystem only through `journal/files.ts` containment or not at all.
//
// ── KEYED BY THE PANE, NOT THE SESSION ────────────────────────────────────────────────────────────
//
// One file per pane, named by a digest of the markers ({@link ../beacon/paths.ts}). Keying by session
// id would make `/clear` — which mints a new session id mid-pane — leave a stale beacon beside the
// fresh one, and the pane would carry two identities until a TTL expired one. Keyed by the pane,
// `/clear` is an ordinary overwrite. One live agent per pane is the truth on every multiplexer
// Collie drives.

import type { AgentSessionRef } from "../journal/types.ts";

/**
 * The format version this build writes and reads.
 *
 * A record from a NEWER schema is skipped rather than guessed at (see parse.ts): a beacon whose
 * meaning we do not know is a beacon we must not act on, and skipping it degrades to exactly the
 * "absent" case the reader already handles honestly.
 */
export const BEACON_SCHEMA_VERSION = 1;

// The heartbeat backstop, and it must be LONGER THAN ANY SINGLE AGENT TURN: a Claude session can
// think for half an hour with no hook firing between `UserPromptSubmit` and `Stop`, so a short TTL
// would expire an agent that is working. Twelve hours is far above any turn and far below a day, so
// yesterday's crashed session is never today's identity. The pid check is the precise signal; this
// is only what catches a machine that lost its `SessionEnd` — a `kill -9`, a laptop lid.
export const BEACON_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The beacon's OWN status vocabulary — three words, taken from paseo's event map.
 *
 * Deliberately NOT `AgentStatus`. Collie's five words are a triage vocabulary with no `waiting` in
 * them, and mapping into it (`waiting → blocked`, because `STATUS_RANK.blocked = 0`) is a decision
 * about how Collie sorts, which belongs to the decorator (M11/03) and not to the file format.
 */
export type BeaconStatus = "working" | "waiting" | "idle";

/**
 * One multiplexer's environment markers, exactly as the emitter read them in its own pane.
 *
 * MARKERS ARE A LIST, NOT A FIELD (see {@link BeaconRecord.markers}). Each entry is namespaced by the
 * multiplexer whose environment supplied it, and each is stored RAW — the value the env var held,
 * with no transformation whatsoever. Any prefixing or normalisation a multiplexer's Collie ids need
 * is applied by that adapter's matcher at the join (M11/03), because the emitter cannot know which
 * multiplexer the operator's Collie is configured for, and a value rewritten on the way in can never
 * be un-rewritten on the way out.
 */
export interface BeaconMarker {
  /** The multiplexer whose env supplied this entry — the adapter's own registry key. */
  readonly namespace: string;
  /**
   * What distinguishes ONE addressing space of that multiplexer from another on the same host: the
   * tmux server socket path from `$TMUX`, the zellij session name from `$ZELLIJ_SESSION_NAME`. Pane
   * ids are per-server on tmux and per-session on zellij, so `%7` from another server and pane `3`
   * from another session are different panes. Without this the join would hand a pane somebody
   * else's agent identity.
   */
  readonly scope: string;
  /** The pane marker, raw: `$TMUX_PANE` (`%7`), `$ZELLIJ_PANE_ID` (a bare integer). */
  readonly pane: string;
}

/**
 * One beacon file, as it is on disk. Every field is what an agent's own hook could truthfully say
 * about itself, and nothing here is an instruction.
 */
export interface BeaconRecord {
  /** {@link BEACON_SCHEMA_VERSION} at the time of writing. A different value is not read. */
  readonly schemaVersion: number;
  /** The harness the agent is, in the journal registry's own vocabulary (`claude`, `codex`, `pi`). */
  readonly harness: string;
  /** How the agent named its session — the journal's own {@link AgentSessionRef}, not a new type. */
  readonly session: AgentSessionRef;
  /** What the agent last said it was doing. Discarded once the beacon expires (see reader.ts). */
  readonly status: BeaconStatus;
  /** The emitting process's pid. Liveness is checked against it, never trusted from it. */
  readonly pid: number;
  /**
   * The pid's process start time, in whatever unit the platform probe reports.
   *
   * This is the pid-reuse guard and it is not optional: pids recycle, and a recycled pid would
   * otherwise resurrect a dead agent's identity on a live stranger's pane. A pid that is running
   * with a DIFFERENT start time is a dead beacon, not a live one.
   */
  readonly pidStartTime: number;
  /**
   * Every marker set the emitter could see, one per multiplexer namespace.
   *
   * A list because NESTING IS REAL — tmux inside zellij, zellij inside tmux — and the emitter cannot
   * know which multiplexer Collie is driving. Recording every set it can see costs two environment
   * reads and removes the whole class of "works until you nest" bug: the join picks the entry
   * belonging to its own adapter and ignores the rest.
   */
  readonly markers: readonly BeaconMarker[];
  /** Epoch ms of the last hook event. The TTL is measured from here ({@link BEACON_TTL_MS}). */
  readonly heartbeatMs: number;
}

/**
 * What one beacon means RIGHT NOW — and the expired/live split is in this type rather than in a
 * comment, because it is the rule the milestone can most easily get wrong.
 *
 * An EXPIRED beacon still supplies `session` and `harness`: history is history, and a finished
 * conversation is still readable (M11/04). What it stops supplying is `status` — the `live` variant
 * is the only one that carries the field at all, so there is no way to read a stale status by
 * accident. It asserts no liveness of any kind.
 *
 * ABSENT is the third case and it is not in this union on purpose: the reader simply returns nothing
 * for that pane, and the pane reads as a shell with `unknown` status exactly as it does today.
 * "No beacon" and "the agent is resting" look identical from outside and mean opposite things to a
 * triage sort, so absence must never become `idle`.
 */
export type BeaconReading =
  | {
      readonly liveness: "live";
      /** The file's name minus `.json` — the pane digest that named it (paths.ts). */
      readonly key: string;
      readonly harness: string;
      readonly session: AgentSessionRef;
      readonly markers: readonly BeaconMarker[];
      readonly status: BeaconStatus;
    }
  | {
      readonly liveness: "expired";
      readonly key: string;
      readonly harness: string;
      readonly session: AgentSessionRef;
      readonly markers: readonly BeaconMarker[];
    };
