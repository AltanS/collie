// The journal's shared vocabulary — the shape every harness adapter must produce, and the seams the
// store drives them through. Nothing agent-specific lives here.
//
// WHY A JOURNAL EXISTS AT ALL. A pane running an agent usually sits on the terminal's ALTERNATE
// SCREEN, which has no scrollback ring — Herdr's terminal core keeps nothing behind the viewport, so
// `pane.read` can never return more than one screenful (see journal/claude.ts for the measurements).
// The history does exist, though: every harness writes its own session log. This module's job is to
// make "read that log" a per-harness decision behind one interface, so a new harness is an adapter
// rather than a fork of the reader.

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
  /** A tool call. `result` is filled in from the result row that answers it, when one exists. */
  | {
      kind: "tool";
      name: string;
      /** One-line gist of the call's input (the file read, the command run) — never the whole input. */
      summary: string;
      result?: { text: string; truncated?: boolean; isError?: boolean };
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
}
