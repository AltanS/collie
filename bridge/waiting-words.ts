// ── WHAT A BLOCKED PANE WAITS ON, IN THE AGENT'S OWN WORDS (opt-in: `push_words`, ADR 0141) ──────
//
// A push for a pane that needs you says "<agent> needs you" and where the pane sits, by rule: the
// words of the call it stopped on are the agent's, and can carry a path, a command or a secret onto a
// lock screen and through a third-party push service (notifications.ts, docs/security.md). With
// `push_words` on, the operator has chosen to see them anyway, so a push can say what the agent needs
// ("api: Run the database migrations", and the command as its line) instead of only that it needs you.
//
// The words are the ones a durable program may choose for its own ask (ADR 0100): a title of 60
// characters and a line of 120, one line each, cleaned here and again by the coordinator, and masked
// with the rest of the push under COLLIE_REDACT. They are the agent's own and nothing of Collie's, so
// there is nothing to translate: a question's text and its options, a command's description and the
// command, or the tool's name and the journal's one-line gist of its input.
//
// READ ON THE POLL, NEVER ON THE PUSH'S PATH. Like the todo list (todos.ts), each poll reads the tail of
// a blocked pane's journal, gated by a stat so an unchanged log costs nothing; the coordinator asks
// for what was last found when its alert fires, after the debounce. A pane that is not blocked, a
// harness with no journal adapter, a pane whose session is not known, or a call this cannot word,
// leaves the push generic. It never throws.

import { probeTail, type ProbeTail } from "./journal/cache-probe.ts";
import { adapterFor } from "./journal/registry.ts";
import type { ToolCall } from "./journal/tool-call.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry, TranscriptPart, TranscriptSource } from "./journal/types.ts";
import { PUSH_LINE_MAX, PUSH_TITLE_MAX, pushPartOf } from "./mux/durable/clean.ts";
import { journalAgentOf, type AgentView, type AskPushText } from "./types.ts";

/** How much of a journal's end is read for the open call. The call is the newest row, so a tail is enough. */
export const WAITING_TAIL_BYTES = 64 * 1024;

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

const said = (entry: TranscriptEntry): boolean => entry.parts.some((p) => p.kind === "text" && p.text.trim() !== "");

/**
 * The tool call the conversation is stopped on: in the newest turn the agent took, its newest call with
 * no result yet. Undefined when that turn has none, or when the person spoke after it.
 */
export function openCall(entries: readonly TranscriptEntry[]): ToolPart | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.abandoned === true) continue;
    // A prompt after the call: the pane waits on something else. A result row carries no text.
    if (entry.role === "user") {
      if (said(entry)) return undefined;
      continue;
    }
    if (entry.role !== "assistant") continue;
    const tools = entry.parts.filter((p): p is ToolPart => p.kind === "tool");
    // A row of thinking alone says nothing either way; the turn's call or speech is further back.
    if (tools.length === 0 && !said(entry)) continue;
    return tools.findLast((t) => t.result === undefined);
  }
  return undefined;
}

/** A call, worded for a push: the agent's own words and nothing of Collie's. Undefined when nothing is left. */
export function callWords(part: ToolPart): AskPushText | undefined {
  const call: ToolCall | undefined = part.call;
  let title: string | undefined;
  let line: string | undefined;
  if (call?.kind === "question") {
    const q = call.questions[0];
    title = q?.question;
    const options = q?.options.map((o) => o.label).join(", ");
    line = options === "" ? undefined : options;
  } else if (call?.kind === "execute") {
    title = call.description ?? call.command;
    line = call.description === undefined ? undefined : call.command;
  } else {
    title = part.summary.trim() === "" ? part.name : `${part.name}: ${part.summary}`;
  }
  const words: AskPushText = {};
  const t = title === undefined ? "" : pushPartOf(title, PUSH_TITLE_MAX);
  const l = line === undefined ? "" : pushPartOf(line, PUSH_LINE_MAX);
  if (t !== "") words.title = t;
  if (l !== "") words.line = l;
  return words.title === undefined && words.line === undefined ? undefined : words;
}

interface Reading {
  /** The session the words were read from, so a pane that moved to another session reads afresh. */
  session: string;
  /** The log's size and mtime when it was read: an unchanged log is not read again. */
  seen: string;
  words?: AskPushText;
}

export interface WaitingWordsOptions {
  /** The journal's tail. A seam for tests; the default reads the file. */
  tail?: (source: TranscriptSource, ref: AgentSessionRef, bytes: number) => Promise<ProbeTail | null>;
}

/** What each blocked pane waits on, read from its journal on the poll. */
export class WaitingWords {
  private readonly byPane = new Map<string, Reading>();

  private readonly tail: NonNullable<WaitingWordsOptions["tail"]>;

  private pendingRefresh: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    options: WaitingWordsOptions = {},
  ) {
    this.tail = options.tail ?? probeTail;
  }

  /** The words last read for this pane while it was blocked, or undefined. */
  get(paneId: string): AskPushText | undefined {
    return this.byPane.get(paneId)?.words;
  }

  /** Bring every blocked pane's words up to date and forget the rest. Serialised and NEVER THROWS. */
  refresh(panes: readonly AgentView[]): Promise<void> {
    const run = this.pendingRefresh.then(() => this.runRefresh(panes));
    this.pendingRefresh = run.catch(() => {});
    return run;
  }

  private async runRefresh(panes: readonly AgentView[]): Promise<void> {
    const blocked = new Set<string>();
    for (const pane of panes) {
      if (pane.status !== "blocked" || pane.agentSession === undefined) continue;
      const adapter = adapterFor(this.registry, journalAgentOf(pane));
      if (adapter === undefined) continue;
      blocked.add(pane.paneId);
      try {
        await this.read(pane.paneId, adapter, pane.agentSession);
      } catch {
        // A read or a parse that failed: keep what was there, try again on the next poll.
      }
    }
    for (const paneId of this.byPane.keys()) if (!blocked.has(paneId)) this.byPane.delete(paneId);
  }

  private async read(paneId: string, adapter: JournalAdapter, ref: AgentSessionRef): Promise<void> {
    const path = await adapter.source.resolve(ref);
    const stat = path === null ? null : await adapter.source.stat(path);
    if (stat === null) {
      this.byPane.delete(paneId);
      return;
    }
    const seen = `${String(stat.size)}:${String(stat.mtimeMs)}`;
    const last = this.byPane.get(paneId);
    if (last !== undefined && last.session === ref.value && last.seen === seen) return;
    const tail = await this.tail(adapter.source, ref, WAITING_TAIL_BYTES);
    if (tail === null) return;
    const open = openCall(adapter.parse(tail.lines.join("\n")));
    const reading: Reading = { session: ref.value, seen };
    const words = open === undefined ? undefined : callWords(open);
    if (words !== undefined) reading.words = words;
    this.byPane.set(paneId, reading);
  }
}
