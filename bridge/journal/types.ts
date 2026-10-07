// The journal's shared vocabulary — the shape every harness adapter must produce, and the seams the
// store drives them through. Nothing agent-specific lives here.
//
// WHY A JOURNAL EXISTS AT ALL. A pane running an agent usually sits on the terminal's ALTERNATE
// SCREEN, which has no scrollback ring — Herdr's terminal core keeps nothing behind the viewport, so
// `pane.read` can never return more than one screenful (see journal/claude.ts for the measurements).
// The history does exist, though: every harness writes its own session log. This module's job is to
// make "read that log" a per-harness decision behind one interface, so a new harness is an adapter
// rather than a fork of the reader.

import type { CacheProbe } from "../cache/engine.ts";
import type { Cursor, ReadSince } from "./cursor.ts";
import type { RowReducer } from "./reduce.ts";
import type { ToolCall } from "./tool-call.ts";

/**
 * How an agent named its session, straight off Herdr's `agent_session` record.
 *
 * Two kinds are in the wild and they are NOT interchangeable:
 *  - `id`   — an opaque session id (Claude, Codex). The adapter must find the file itself, so the
 *             value never touches a path until the adapter has validated its shape.
 *  - `path` — an absolute path to the log, reported by the agent (pi). Convenient, but it is
 *             attacker-shaped input by construction: it arrives over the socket from a process we
 *             do not control, so the adapter must still confine it to its own root.
 */
export interface AgentSessionRef {
  kind: "id" | "path";
  value: string;
}

/** One renderable piece of a turn. Deliberately small — the phone renders these as text nodes. */
export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  /**
   * Extended-thinking text. Whether this ever carries anything is per-harness: Claude Code persists
   * `thinking` blocks with the text stripped (empty every time), while Codex and pi both write real
   * reasoning summaries. The branch is universal; only the harnesses that fill it differ.
   */
  | { kind: "thinking"; text: string; truncated?: boolean }
  /** An image attachment or tool output. */
  | { kind: "image"; url: string; mimeType?: string }
  /** A tool call. `result` is filled in from the result row that answers it, when one exists. */
  | {
      kind: "tool";
      name: string;
      /** One-line gist of the call's input (the file read, the command run) — never the whole input. */
      summary: string;
      /**
       * The harness's own id for this call, where it has one (Claude's `tool_use_id`, pi's call id).
       * Kept so a view can match a call to a permission dialog about it, and so a result arriving
       * later addresses one call rather than the newest one.
       */
      id?: string;
      /**
       * The same call, structured (see tool-call.ts). ADDITIVE and OPTIONAL: `name` and `summary`
       * stay authoritative for anything that already reads them, and an adapter not yet taught to
       * fill this leaves it absent.
       */
      call?: ToolCall;
      result?: {
        text: string;
        truncated?: boolean;
        isError?: boolean;
        imageUrl?: string;
        /**
         * The person refused the call. NOT the same as `isError`: nothing went wrong, somebody said
         * no, and a view that draws the two alike tells the reader a lie about their own session.
         */
        denied?: boolean;
      };
    };

/**
 * One turn of the conversation.
 *
 * `user`/`assistant` are speech. The other two are NOT, and are rendered set apart so they can't be
 * mistaken for it: `summary` is a compaction summary the agent wrote about its own history, and
 * `note` is machine-injected content that still belongs on screen (a background task finishing, a
 * local command's output).
 */
export interface TranscriptEntry {
  /**
   * The paging cursor (`?before=`), and it must be stable across reads of the same log.
   *
   * Where a harness gives rows their own id (Claude, pi) this IS that id. Codex rows carry none, so
   * its adapter synthesises one — see journal/codex.ts for why that synthetic form has to be
   * anchored to the END of the file.
   */
  uuid: string;
  /** ISO timestamp from the log; empty when the row carried none. */
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
  /**
   * The agent rewound past this turn: it is not on the session's current branch. Views hide it.
   *
   * ABSENT when false, never `false`, which is this module's convention everywhere.
   *
   * One harness needs it. pi keeps every branch in ONE append-only log and every row names its
   * parent, so a rewind is ANNOUNCED by the row that arrives rather than hidden in a flag that flips
   * on disk. That is what makes it expressible here at all, and it is the distinction ADR 0073's
   * addendum turns on: `Reduction` still has no `removed`, because nothing is removed. A turn that
   * left the branch is a turn that CHANGED, reported through `changed` like any other in-place edit,
   * and a rewind back onto it clears the mark the same way.
   *
   * It is a flag and not a filter on purpose. `?before=` pages come off the store and `pageEntries`
   * resolves the client's cursor by finding its uuid, so a hidden turn's uuid must still resolve;
   * dropping it in `parse` would break that and make the live path and the History path disagree
   * about one session. Both paths carry the flag, and the VIEWS hide it.
   */
  abandoned?: true;
}

/** What the history endpoint answers with, minus the pane id the route adds. */
export interface TranscriptPage {
  paneId: string;
  /** Oldest-first, ready to render top-down. */
  entries: TranscriptEntry[];
  /** True when older turns exist before `entries[0]` — drives "load older". */
  hasMore: boolean;
  /** Total turns available in the parsed window (after sidechain filtering). */
  total: number;
  /** True when the on-disk log exceeded the byte cap and we kept only its tail. */
  fileTruncated: boolean;
}

/**
 * The fs seam. Real implementations live beside each adapter; tests inject a fake so no temp files
 * are needed (the repo convention — see sessions.test.ts / state-engine.test.ts).
 */
export interface TranscriptSource {
  /** Absolute path of the log this ref names, or null when it isn't on disk / isn't ours to read. */
  resolve(ref: AgentSessionRef): Promise<string | null>;
  /**
   * Size + mtime of a log, WITHOUT reading it — the store's cache-validity check.
   *
   * Split out from `load` on purpose: a journal can be 32 MB, and paging back through a long
   * conversation asks for the same file over and over. Reading it to discover the cache was already
   * valid made every "load older" tap a full re-read.
   */
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** Tail-read a log. `complete` is false when the byte cap clipped the head. */
  load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }>;
  /**
   * What is new since `cursor` — the LIVE read, beside `load`'s whole-window one.
   *
   * The two are not alternatives. `load` answers "show me this conversation", pays a bounded
   * whole-window read, and is what a History tap drives. `readSince` answers "what changed since I
   * last looked", and a session that gained one row must cost one row: the reason this method
   * exists at all is that `load` + `parse` on every mtime move costs a 32 MB read and a full
   * re-parse per new turn.
   *
   * EACH SOURCE ANSWERS IN ITS OWN LANGUAGE. A file harness counts bytes; opencode counts
   * `max(time_updated)`, because it mutates a row in place while a reply streams; hermes counts
   * `max(id)`. The {@link Cursor} that carries the number is OPAQUE above this seam — nothing over
   * it may read a byte offset, or know there is one — so a harness can change how it counts without
   * a caller changing at all.
   *
   * `lines` are complete rows, never a fragment, and `reset` says the answer REPLACES what the
   * caller holds rather than extending it (see {@link ReadSince}). `stat` stays the cheap
   * pre-check: a tick where size and mtime did not move needs no call here at all.
   */
  readSince(key: string, cursor: Cursor): Promise<ReadSince>;
}

/**
 * One harness's journal support: how to find its log, and how to read its grammar.
 *
 * `agent` is matched against the Herdr snapshot's `agent` string, and it is also the registry key —
 * the map is built FROM this field so the two can never drift (journal/registry.ts). An agent with
 * no adapter simply has no journal, which the route reports as an ordinary "no-session".
 *
 * `parse` is PURE — no fs, no clock — so every harness's grammar is table-testable under `bun test`.
 */
export interface JournalAdapter {
  readonly agent: string;
  readonly source: TranscriptSource;
  parse(text: string): TranscriptEntry[];
  /**
   * A fresh folder for ONE session, fed a row at a time (journal/reduce.ts).
   *
   * `parse` and this are the same grammar seen from two ends, not two implementations: every adapter
   * builds a reducer and `parse` is `parseWith(reducer, text)` over it, so a row cannot be read one
   * way by a History page and another way by a live window.
   *
   * REQUIRED, not optional, and that is the point. Spec 02 built the six reducers and deliberately
   * left this seam out, because a seam with no caller is a guess at what a caller needs; the live
   * window (journal/live.ts) is the caller, and it needs exactly this. Optional would have meant
   * every call site writing `adapter.reducer?.()` with a fallback nothing can reach.
   *
   * A reducer is STATEFUL and single-use: it remembers the tool calls it is still waiting on. One per
   * window, never shared, and never reused after a reset — a reset means the rows before it are not
   * this window's any more, and a call waiting from before them will never be answered.
   */
  reducer(): RowReducer;
  /**
   * Find the session running in `cwd` without a reported ref — or null when none matches.
   *
   * OPTIONAL, and absent everywhere but the harness whose panes carry no `agentSession`:
   * custom-source session reports never surface in the pane record, and Muse has no integration
   * of its own (see journal/muse.ts). The history and chat routes call this when the
   * pane names no session, and `toPaneWire` offers the History affordance on its presence, so a
   * discoverable pane reads exactly like a reporting one.
   *
   * The returned ref is an ordinary id ref: it goes through the same `resolve`, containment and
   * caching as a reported one, so discovery widens WHICH panes answer, never how an answer is
   * read. It must be cheap enough to run per tap — bounded walk, early exit — because the chat
   * route calls it on every poll that finds no ref.
   */
  discover?(cwd: string): Promise<AgentSessionRef | null>;
  /**
   * The prompt-cache reading for one session, off the same log `parse` reads — or null when there is
   * nothing to read yet.
   *
   * OPTIONAL ON PURPOSE. grok and hermes publish no cache TTL Collie could quote, so they ship no rule
   * and need no probe, and they stay exactly as they are. Nothing in the history path calls this: it is
   * driven only by `bridge/cache/tracker.ts` on the state engine's own poll (ADR 0041).
   *
   * Unlike `parse` this one IS impure — it reads a 128 KB tail, or one indexed query. It must never
   * throw: a missing file, a malformed line or a locked database all mean `null`, which the tracker
   * turns into "no reading", which renders as nothing. Every path it opens goes through
   * `containedRealpath` like every other journal read.
   */
  cacheProbe?(ref: AgentSessionRef): Promise<CacheProbe | null>;
  /**
   * The keys that make this harness take its queued messages NOW instead of at its next turn
   * boundary, in the neutral spelling (`bridge/mux/keys.ts`) — or absent when it has no such key.
   *
   * OPTIONAL, and absent everywhere but Claude Code: it prints "ctrl+enter to send now" under a
   * queued message, and Ctrl+Enter hands the whole queue to the running turn at its next tool
   * boundary. The list rides the live window's answer beside `queued` (journal/live.ts), so the phone
   * learns it as DATA from the bridge and its code names no harness. It sits on this adapter because
   * this is where a harness already declares what its queue is; nothing here sends a key.
   *
   * The harness names the key; the MULTIPLEXER decides whether it can be pressed. The chat route drops
   * the list where the pane's multiplexer declares one of its keys unsupported (`keysDeliverable`,
   * mux/capabilities.ts), because tmux and zellij deliver `ctrl+Enter` as a plain Enter.
   */
  readonly sendQueuedNow?: readonly string[];
}
