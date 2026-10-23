// The Pi Durable entry of the SDK (`@colliepwa/durable-sdk/pi`). It is the only place in src/ that imports Pi
// Durable, and it imports nothing from the example around it: the words a program shows (questions, notes) come in as
// options. It uses the SDK's handles and nothing else: a conversation becomes a pane, `watchEvents` becomes events and
// state, a `beforeTool` hook becomes an ask, send and stop become `submit` and `abort`.
//
// It is written for @earendil-works/pi-durable 1.1.0 and 1.2.0, and the tests run on both. Two calls need 1.1.0:
// `entries({ order })` and `scanConversations`; on 1.0.x they do not type-check, so pin 1.1.0 or later. Where 1.2.0 broke
// a shape (a tool result's `content` became `output`), the code writes both. A session that fails (1.2.0) is reported. The three Pi packages it imports are
// optional peer dependencies of the package: a program that never imports `./pi` installs none of them.
// Erasable TypeScript only (no parameter properties, no enums), so Node runs it as it is.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  configure,
  type Cursor,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  type Harness,
  hook,
  type MessageChange,
  type SnapshotEvent,
  type SubmissionRecord,
  type ToolExecutionResult,
  ToolTask,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  AskClosed,
  type ConversationRow,
  type HistoryProvider,
  type Item,
  type PaneHandle,
  type PlainOption,
  type ProgramEvent,
  type Progress,
  type ProgressStep,
  type RiskWords,
  safeId,
  summaryOf,
  type TabHandle,
  type TextAskInput,
  toAskSpec,
} from "../core/index.ts";
import { clip } from "../core/ask-policy.ts";
import { isList, isRecord, isText } from "../core/rules.ts";
import type { Json, PermissionAskInput } from "../core/types.ts";

/** An item without its id and stamp: the shape a {@link ReplyExtras} hands back. */
type ItemBody = Item extends infer T ? (T extends Item ? Omit<T, "id" | "ts"> : never) : never;

/**
 * Items a program adds under a finished reply, from the reply's text: for example a note, a command and a link once a
 * ticket is solved. Each has a `key`, which with the reply's id names the item, so a replay writes the same items
 * again, not more. Empty: nothing is added.
 */
export type ReplyExtras = (replyText: string) => readonly { key: string; item: ItemBody }[];

const ctx0 = BACKGROUND_CONTEXT;

/** How long a start waits for the asks it expects to be raised again, before it shows the layout anyway. */
export const RE_RAISE_MS = 5000;

/**
 * Which pane shows which conversation. The guard hook looks panes up here. It also knows which tool calls
 * have no result yet, so a start can wait for their asks before it calls itself ready (`reRaised`).
 */
export class PaneRegistry {
  private panes = new Map<ConversationId, PaneHandle>();
  /** The stop of each conversation's event stream. */
  private stops = new Map<ConversationId, () => Promise<void>>();
  /** Tool calls shown as running, by item id, with the tool's name. */
  private readonly running = new Map<string, string>();
  /** A start waiting for these call ids: each settles when the call asks or ends. */
  private readonly waits = new Map<string, () => void>();
  get(id: ConversationId) {
    return this.panes.get(id);
  }
  has(id: ConversationId) {
    return this.panes.has(id);
  }
  set(id: ConversationId, pane: PaneHandle, stop: () => Promise<void>) {
    this.panes.set(id, pane);
    this.stops.set(id, stop);
  }
  /** The conversation a pane shows, by the pane's id on the wire, or undefined. */
  conversationOf(paneId: string): ConversationId | undefined {
    for (const [id, pane] of this.panes) if (pane.id === paneId) return id;
    return undefined;
  }
  /**
   * Stop showing a conversation: its event stream stops and the registry forgets it, so showing it again makes a
   * new pane. The pane itself leaves the layout through the SDK (a close from the phone does that after its hook).
   */
  async forget(id: ConversationId) {
    const stop = this.stops.get(id);
    this.panes.delete(id);
    this.stops.delete(id);
    await stop?.().catch(() => {});
  }
  /** The mapper saw a tool call's status. A call that ends no longer holds a start back. */
  toolStatus(callId: string, name: string, status: string) {
    if (status === "running") {
      this.running.set(callId, name);
      return;
    }
    this.running.delete(callId);
    this.settle(callId);
  }

  /** The guard raised the ask for this call. */
  asked(callId: string) {
    this.settle(callId);
  }

  private settle(callId: string) {
    const done = this.waits.get(callId);
    if (!done) return;
    this.waits.delete(callId);
    done();
  }

  /**
   * Call AFTER every conversation is shown and BEFORE `harness.resume()`: it reads which risky calls have no
   * result yet, and each of those raises its ask again once Pi re-runs its hook. The promise resolves when
   * every one has asked or ended, or after `ms`, so a call that does neither does not hold the layout back
   * for good. Await it after `resume()` and before `ready()`: the first snapshot after a start then carries
   * the asks by contract, not by timing (WIRE.md section 8.2).
   *
   * When the window ends first, `log` gets one line naming the calls that did not ask, and the start goes on.
   * Such an ask is not lost: when its hook runs later it is raised under the same id, and the next read lists it.
   */
  async reRaised(risky: ReadonlySet<string>, ms = RE_RAISE_MS, log: (line: string) => void = (line) => console.warn(line)): Promise<void> {
    // Everything up to the first `await` runs in the call, so the risky calls are read before `resume()`.
    const ids = [...this.running].filter(([, name]) => risky.has(name)).map(([id]) => id);
    if (ids.length === 0) return;
    const missing = new Set(ids);
    const each = ids.map(
      (id) =>
        new Promise<void>((resolve) =>
          this.waits.set(id, () => {
            missing.delete(id);
            resolve();
          }),
        ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
    try {
      const how = await Promise.race([Promise.all(each).then(() => "all" as const), late]);
      if (how === "all") return;
      log(
        `collie: ${missing.size} of ${ids.length} waiting asks were not raised again within ${ms} ms of the start; ` +
          `the layout is ready without them, and each is listed under its old id once its hook runs (${[...missing].join(", ")})`,
      );
    } finally {
      clearTimeout(timer);
      for (const id of ids) this.waits.delete(id);
    }
  }

  /** Stop every event stream. Call before `harness.close()`. */
  async close() {
    const stops = [...this.stops.values()];
    this.stops.clear();
    await Promise.all(stops.map((stop) => stop().catch(() => {})));
  }
}

export interface PaneLocation {
  tab: TabHandle;
  title: string;
  paneId?: string;
  /** Absolute. Optional: the pane falls back to its workspace's folder. */
  cwd?: string;
  /** One line under the title. Set when the pane is first shown. */
  subtitle?: string;
  /** Show the three steps of a ticket while its first run works. */
  progress?: boolean;
  /** Give the pane the belt action "Escalate" (WIRE.md 7.10). The tickets have it; the helpers do not. */
  escalate?: boolean;
  /** Items to add under a finished reply (WIRE.md 7.13). See {@link ReplyExtras}. */
  extras?: ReplyExtras;
}

/** The one belt action of a ticket. */
const ESCALATE = { id: "escalate", label: "Escalate", icon: "flag" } as const;
/** What Escalate writes into the thread and under the title. */
export const ESCALATED = "Escalated to the on-call lead.";

/** The pane id of a conversation, and the id its history is served under (WIRE.md 7.16). */
export const paneIdOf = (id: ConversationId) => safeId(`conv-${id}`);

/** The Pi conversation a pane id names, the inverse of {@link paneIdOf}, or undefined for any other id. */
export function conversationOfPaneId(paneId: string): ConversationId | undefined {
  const match = /^conv-(\d{1,15})$/.exec(paneId);
  // SAFETY: a ConversationId is Pi's brand on its own conversation number, and these digits are one paneIdOf wrote; a number Pi does not know finds no conversation.
  return match === null ? undefined : (Number(match[1]) as ConversationId);
}
// `summaryOf` and `clip` moved to core/ask-policy.ts, so a host with no Pi can raise the same card. The export stays.
export { summaryOf };

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Json };
const textOf = (content: string | readonly Block[]): string =>
  isText(content)
    ? content
    : content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");


/** The least time between two writes of a growing reply (WIRE.md 7.15). */
export const PARTIAL_MS = 250;

/** A text or thinking block of the answer being written, as far as it has come. */
type LiveBlock = Block;

/** A block for the live answer: a copy, because the deltas grow it in place and Pi's own message stays as Pi wrote it. */
const liveCopy = (block: Block): LiveBlock => ({ ...block });

/** A step's state from whether it is done and whether it runs now. */
const stepState = (done: boolean, running: boolean): ProgressStep["state"] => (done ? "done" : running ? "running" : "todo");

/** The assistant message Pi is generating now, and which of its blocks the wire has seen. */
interface LiveMessage {
  /** The id every item of this message gets, the one the finished message gets too: its timestamp. */
  id: string;
  ts: string;
  blocks: LiveBlock[];
  /** Item ids written with `partial: true`, so a message cut off can be written once more without it. */
  shown: Set<string>;
  /** When a partial was last written. */
  lastWrite: number;
}

/** The item id of an assistant message's block. The timestamp is known when generation starts, the entry id is not. */
const messageId = (timestamp: number) => safeId(`m${String(timestamp)}`);

/** What the mapper writes to: a pane, or a list of items when it reads a conversation's history back (`piHistory`). */
export type MapperTarget = Pick<PaneHandle, "event" | "progress" | "state">;

/**
 * Pi entries and agent events to the session stream. A reply grows: `message_update` rewrites its item under one id
 * (at most every {@link PARTIAL_MS}), and the finished entry writes it once more without `partial` (WIRE.md 7.15).
 */
export class Mapper {
  private tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  // What the first run has done so far, for the progress steps. A ticket only: a helper just answers.
  private seen = { user: false, note: false, noted: false, reply: false };
  /** The answer being generated. Absent between answers. */
  private live: LiveMessage | undefined;
  /** The send each user entry came from, by item id, as the submissions say. */
  private readonly requests = new Map<string, string>();
  /** The user items written so far, so a request id that arrives late can be added to one. */
  private readonly users = new Map<string, Extract<Item, { kind: "user" }>>();
  private readonly pane: MapperTarget;
  private readonly registry: PaneRegistry;
  private readonly withProgress: boolean;
  private readonly now: () => number;
  private readonly extras: ReplyExtras | undefined;
  constructor(pane: MapperTarget, registry: PaneRegistry, withProgress: boolean, now: () => number = Date.now, extras?: ReplyExtras) {
    this.pane = pane;
    this.registry = registry;
    this.withProgress = withProgress;
    this.now = now;
    this.extras = extras;
  }

  private item(item: Item) {
    this.pane.event({ type: "item", item });
    if (item.kind === "tool") this.registry.toolStatus(item.id, item.tool.name, item.status);
    if (item.kind === "user") {
      this.seen.user = true;
      this.users.set(item.id, item);
    }
    // A reply that is still growing is not yet the reply the steps wait for.
    if (item.kind === "reply" && item.partial !== true) this.seen.reply = true;
    if (item.kind === "tool" && item.tool.name === "write_note") {
      this.seen.note = true;
      if (item.status !== "running") this.seen.noted = true;
    }
  }

  /**
   * What the program adds under a finished reply (WIRE.md 7.13), from {@link ReplyExtras}. The ids come from the
   * reply's and each extra's key, so a replay after a restart writes the same items again, not more.
   */
  private summary(replyId: string, ts: string, text: string) {
    for (const { key, item } of this.extras?.(text) ?? []) {
      // SAFETY: `item` is an Item of one kind without its id and stamp (ItemBody), so with both back it is an Item of that kind.
      this.item({ ...item, id: safeId(`${replyId}:${key}`), ts } as Item);
    }
  }

  /** The three steps of a ticket as the first run reaches them: read it, save a note, reply. */
  private steps(): Progress {
    const { user, note, noted, reply } = this.seen;
    return {
      kind: "steps",
      steps: [
        { label: "Read the ticket", state: stepState(user && (note || reply), !user || !note) },
        { label: "Save a note", state: stepState(noted || reply, note || user) },
        { label: "Reply", state: stepState(reply, noted) },
      ],
    };
  }

  /** Steps while the first run works. After its reply, or when the pane is idle, none: the program clears them. */
  private mark(working: boolean) {
    if (!this.withProgress) return;
    this.pane.progress(working ? this.steps() : null);
  }

  /**
   * Every entry of a conversation, in order, as items. The history reads it back this way (`piHistory`), from all of
   * Pi's entries: a reset or a compaction hides older entries from the model, never from the record.
   */
  replay(entries: readonly EntryRecord[]) {
    for (const entry of entries) this.entry(entry);
    this.finish();
  }

  snapshot(s: SnapshotEvent, first: boolean) {
    if (!first) this.pane.event({ type: "reset" });
    this.live = undefined;
    this.tools.clear();
    this.seen = { user: false, note: false, noted: false, reply: false };
    for (const entry of s.entries) this.entry(entry);
    this.pane.event({ type: "synced" });
    this.pane.state(s.run ? "working" : "idle");
    this.mark(s.run ? !this.seen.reply : false);
  }

  /**
   * One batch of events, as Pi delivers them. The submissions of the batch are read first: the record that names a
   * user entry's request id comes after the entry in the batch, and the item should carry it from its first write.
   */
  applyAll(events: readonly AgentEvent[]) {
    for (const e of events) {
      if (e.type !== "submission" || e.record.type !== "input" || e.record.entry === undefined || e.record.requestId === undefined) continue;
      this.requests.set(safeId(`e${e.record.entry}`), safeId(e.record.requestId));
    }
    for (const e of events) this.apply(e);
  }

  apply(e: AgentEvent) {
    switch (e.type) {
      case "snapshot": // the consumer fell behind: start over from the newest view
        return this.snapshot(e, false);
      case "run_start":
      case "turn_start":
        this.pane.state("working");
        return this.mark(!this.seen.reply);
      case "turn_end":
        return this.finish();
      case "run_end":
        // A stop can end the run with no entry for what was written so far. Nothing is left growing.
        this.finish();
        this.pane.state("idle");
        return this.mark(false);
      case "message_start":
        return this.start(e.message);
      case "message_update":
        return this.update(e.changes);
      case "message_end":
        this.live = undefined;
        this.entry(e.entry);
        return this.mark(!this.seen.reply);
      case "submission":
        this.requested(e.record);
        // An abort appends no entry and no item. The input settles, and the wire says so with `settled`.
        if (e.record.type !== "input" || (e.record.status !== "done" && e.record.status !== "unanswered")) return;
        return this.pane.event(this.settled(e.record));
      case "task_failed":
        return this.item({ id: safeId(`fail:${e.taskId}`), kind: "notice", text: `${e.kind} failed: ${e.message}` });
      case "auto_retry_start":
        return this.item({ id: safeId(`retry:${e.at}`), kind: "notice", text: `retrying: ${e.errorMessage}` });
    }
  }

  /** The `settled` event of an input that was answered or left unanswered. The pane cleans it and fixes its order. */
  private settled(record: Extract<SubmissionRecord, { type: "input" }>): Extract<ProgramEvent, { type: "settled" }> {
    const event: Extract<ProgramEvent, { type: "settled" }> = {
      type: "settled",
      inputId: safeId(record.id),
      status: record.status === "done" ? "answered" : "unanswered",
    };
    if (record.requestId !== undefined) event.requestId = safeId(record.requestId);
    if (record.status === "unanswered") event.reason = record.reason;
    return event;
  }

  /** An answer begins. The start of one that is already whole is followed by its end, and draws nothing in between. */
  private start(message: { role: string; timestamp: number; content: string | readonly Block[] }) {
    this.live = undefined;
    const content = message.content;
    if (message.role !== "assistant" || !Array.isArray(content)) return;
    const blocks = content.map(liveCopy);
    this.live = { id: messageId(message.timestamp), ts: new Date(message.timestamp).toISOString(), blocks, shown: new Set(), lastWrite: 0 };
  }

  /** The answer grew: take the change, and write it when the last write is old enough. */
  private update(changes: readonly MessageChange[]) {
    const live = this.live;
    if (!live) return;
    for (const c of changes) {
      switch (c.type) {
        case "text_start":
        case "thinking_start":
        case "toolcall_start":
        case "block":
          live.blocks[c.contentIndex] = liveCopy(c.block);
          break;
        case "text_delta": {
          const b = live.blocks[c.contentIndex];
          if (b?.type === "text") b.text = (b.text ?? "") + c.delta;
          break;
        }
        case "thinking_delta": {
          const b = live.blocks[c.contentIndex];
          if (b?.type === "thinking") b.thinking = (b.thinking ?? "") + c.delta;
          break;
        }
        case "message":
          live.blocks = c.message.content.map(liveCopy);
          break;
        case "toolcall_delta":
          break; // a tool call is shown whole, when its message ends
      }
    }
    if (this.now() - live.lastWrite < PARTIAL_MS) return;
    live.lastWrite = this.now();
    live.blocks.forEach((b, i) => {
      const id = safeId(`${live.id}:${i}`);
      if (b.type === "text" && (b.text ?? "").trim() !== "") this.grow({ id, ts: live.ts, kind: "reply", text: b.text ?? "", partial: true }, live);
      else if (b.type === "thinking" && (b.thinking ?? "").trim() !== "") this.grow({ id, ts: live.ts, kind: "thinking", text: b.thinking ?? "", partial: true }, live);
    });
  }

  private grow(item: Item, live: LiveMessage) {
    live.shown.add(item.id);
    this.item(item);
  }

  /**
   * The answer being written is over. Its entry normally follows and writes the final version. Where none does (a
   * stop that left nothing to keep), what was shown is written once more as it stood, without `partial`, so no
   * cursor is left blinking on a reply that will not grow (WIRE.md 7.5 and 7.15).
   */
  private finish() {
    const live = this.live;
    this.live = undefined;
    if (!live || live.shown.size === 0) return;
    live.blocks.forEach((b, i) => {
      const id = safeId(`${live.id}:${i}`);
      if (!live.shown.has(id)) return;
      if (b.type === "text") this.item({ id, ts: live.ts, kind: "reply", text: b.text ?? "" });
      else if (b.type === "thinking") this.item({ id, ts: live.ts, kind: "thinking", text: b.thinking ?? "" });
    });
  }

  /** A submission that names its user entry gives that item the request id of the send, even when the item is already written. */
  private requested(record: SubmissionRecord) {
    if (record.type !== "input" || record.entry === undefined || record.requestId === undefined) return;
    const id = safeId(`e${record.entry}`);
    const requestId = safeId(record.requestId);
    this.requests.set(id, requestId);
    const have = this.users.get(id);
    if (have && have.requestId !== requestId) this.item({ ...have, requestId });
  }

  private entry(e: EntryRecord) {
    const m = e.model?.[0];
    if (!m) return;
    const ts = new Date(m.timestamp).toISOString();
    // An answer is named by its timestamp, which is known before it is finished (see `messageId`).
    const id = m.role === "assistant" ? messageId(m.timestamp) : safeId(`e${e.id}`);
    if (m.role === "user") {
      const requestId = this.requests.get(id);
      const user: Extract<Item, { kind: "user" }> = { id, ts, kind: "user", text: textOf(m.content) };
      if (requestId !== undefined) user.requestId = requestId;
      return this.item(user);
    }
    if (m.role === "assistant") {
      m.content.forEach((b, i) => {
        if (b.type === "text") {
          this.item({ id: safeId(`${id}:${i}`), ts, kind: "reply", text: b.text ?? "" });
          this.summary(safeId(`${id}:${i}`), ts, b.text ?? "");
        }
        else if (b.type === "thinking") this.item({ id: safeId(`${id}:${i}`), ts, kind: "thinking", text: b.thinking ?? "" });
        else if (b.type === "toolCall") {
          const tool: Extract<Item, { kind: "tool" }> = {
            id: safeId(b.id),
            ts,
            kind: "tool",
            status: "running",
            tool: { kind: "other", name: b.name!, summary: summaryOf(b.arguments, b.name) },
          };
          this.tools.set(safeId(b.id), tool);
          this.item(tool);
        }
      });
      // A stop writes no item (WIRE.md 7.5): only a failed turn gets a notice.
      if (m.stopReason === "error") this.item({ id: safeId(`${id}:end`), ts, kind: "notice", text: `turn ${m.stopReason}` });
      return;
    }
    if (m.role === "toolResult") {
      const data = e.data;
      const diagnostics = isRecord(data) && isList(data.diagnostics) ? data.diagnostics : [];
      const denied = diagnostics.some((d) => isRecord(d) && d.code === "blocked");
      const callId = safeId(m.toolCallId);
      const have = this.tools.get(callId);
      const tool: Extract<Item, { kind: "tool" }> = {
        id: callId,
        ts,
        kind: "tool",
        status: denied ? "denied" : m.isError ? "failed" : "done",
        tool: { ...(have?.tool ?? { kind: "other", name: m.toolName, summary: "" }), output: clip(textOf(m.content), 2000) },
      };
      this.tools.set(callId, tool);
      this.item(tool);
    }
  }
}

/**
 * How a pane's send reaches Pi. Left out, it is `conversation.submit`. A host that must see every input passes its
 * own: the Cloudflare example's PiHarness schedules the session's wake job in its `submit`. The SDK waits for it and
 * reads nothing from what it resolves to, which for Pi's own `submit` is its `Submission`.
 */
export type Submit = (conversation: Conversation, input: { content: string; whenBusy: "steer" | "followUp"; requestId?: string }) => Promise<object | void>;

/**
 * Show a conversation as a pane. Safe to call twice for one conversation: the second call returns
 * the pane that exists. History is sent first (then `synced`), after that events are live.
 */
export async function showConversation(
  loc: PaneLocation,
  harness: Harness,
  conversation: Conversation,
  opts: { panes: PaneRegistry; ctx?: Context; submit?: Submit },
): Promise<PaneHandle> {
  const have = opts.panes.get(conversation.id);
  if (have) return have;
  const ctx = opts.ctx ?? ctx0;
  // The SDK reads `cwd` through its path rule only, which takes an empty or absent one alike.
  const pane = loc.tab.pane(loc.paneId ?? paneIdOf(conversation.id), { title: loc.title, harness: "pi", cwd: loc.cwd });
  if (loc.subtitle) pane.subtitle(loc.subtitle);
  const mapper = new Mapper(pane, opts.panes, loc.progress === true, Date.now, loc.extras);

  // The wire's request id goes to Pi Durable as the submission's own dedupe key, so a repeat that
  // reaches Pi after a restart still admits the input once.
  pane.onSend(async (text, { steer, requestId }) => {
    const input = { content: text, whenBusy: steer ? "steer" : "followUp", requestId } as const;
    if (opts.submit) await opts.submit(conversation, input);
    else await conversation.submit({ type: "input", ...input }, ctx);
  });
  pane.onAbort(() => conversation.abort(ctx));
  if (loc.escalate === true) {
    pane.actions([ESCALATE]);
    // The phone taps Escalate: write one notice into the thread, dim the button and say so in the line under the title,
    // which the conversation list shows too. The request id keys the notice, so the same tap never writes it twice. This
    // is a program's own act and needs no Pi Durable call.
    pane.onAction(({ actionId, requestId }) => {
      if (actionId !== ESCALATE.id) return false;
      pane.event({ type: "item", item: { id: safeId(`escalated:${requestId}`), ts: new Date().toISOString(), kind: "notice", text: ESCALATED } });
      pane.actions([{ ...ESCALATE, disabled: true }]);
      pane.subtitle(ESCALATED);
    });
  }

  const stream = await watchEvents(harness, conversation.id, ctx);
  opts.panes.set(conversation.id, pane, async () => {
    await stream.stop();
  });
  mapper.snapshot(stream.snapshot, true);
  stream.start(async (events) => {
    mapper.applyAll(events);
  });
  // Pi Durable 1.2.0 closes the Session on any storage error, and every watch then ends with "session_failed". The pane
  // would stop moving with no word, so the end is reported: a notice on the pane, and the error on the host's log.
  void stream.closed.then((end) => reportWatchEnd(pane, conversation.id, end));
  return pane;
}

/**
 * A watch that ended by failure shows as a notice and goes to `console.error`. A stop or a close ends it with no word:
 * the host asked for those. `listener_error` exists in 1.1.0 too; `session_failed` only from 1.2.0 on, so the reason
 * is read as text, which both versions' types accept.
 */
export function reportWatchEnd(pane: PaneHandle, id: ConversationId, end: { reason: string; error?: unknown }): void {
  if (end.reason !== "session_failed" && end.reason !== "listener_error") return;
  const what = end.error instanceof Error ? end.error.message : String(end.error);
  console.error(`pi-durable: the watch of conversation ${id} ended, ${end.reason}:`, end.error);
  const text = end.reason === "session_failed" ? `the session failed: ${what}` : `the pane stopped updating: ${what}`;
  pane.event({ type: "item", item: { id: safeId(`watch-end:${id}`), ts: new Date().toISOString(), kind: "notice", text } });
}

/** The text of a conversation's first message, or undefined before it has one. A start names a pane from it. */
export async function firstMessageOf(conversation: Conversation, ctx: Context = ctx0): Promise<string | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, ENTRY_PAGE, cursor, ctx);
    for (const entry of page.items) {
      const m = entry.model?.[0];
      if (m?.role === "user") return textOf(m.content);
    }
    cursor = page.next;
  } while (cursor);
  return undefined;
}

// ── History (WIRE.md 7.16) ────────────────────────────────────────────────────────────────────────────────────────────

/** How many Pi entries one read asks for while a conversation's history is mapped. */
const ENTRY_PAGE = 256;

/** The items of a conversation, as the mapper makes them, each in its latest version, in order of first appearance. */
class ItemList implements MapperTarget {
  readonly items = new Map<string, Item>();
  event(e: ProgramEvent) {
    if (e.type === "item") this.items.set(e.item.id, e.item);
  }
  progress() {}
  state() {}
}

/** What the program says about one conversation in its list. The history fills in the rest from Pi's store. */
export interface ConversationLook {
  title: string;
  subtitle?: string;
  workspaceId?: string;
  tabId?: string;
  /** A ticket's reply carries its summary items (markdown, code, link), as on the live pane. */
  progress?: boolean;
  /** The items the live pane adds under a finished reply, so the history shows them too. See {@link ReplyExtras}. */
  extras?: ReplyExtras;
}

export interface PiHistoryOptions {
  harness: () => Harness;
  panes: PaneRegistry;
  /**
   * The title, subtitle and place of a conversation, from its Pi record (its owner says a helper from a ticket) and
   * the text of its first message, the way the program named it when it showed it.
   */
  describe: (record: ConversationRecord, first: string | undefined) => ConversationLook;
  ctx?: Context;
}

/** A Pi scan cursor as the wire's printable cursor: its JSON, as base64url. */
function cursorText(cursor: Cursor): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The inverse of {@link cursorText}, or undefined for a text that is not one. */
function cursorFrom(text: string): Cursor | undefined {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed: Json = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
    // SAFETY: JSON.parse writes no undefined value, so a JSON object is a record of JSON values, which is Pi's Cursor. Pi reads its fields.
    return isRecord(parsed) ? (parsed as Cursor) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The history provider for a Pi Durable program (WIRE.md 7.16). Pi keeps every entry of every conversation, so the
 * record is Pi's own: the list scans Pi's conversations newest first, open and closed, and the items of one are ALL
 * its entries, mapped by the same {@link Mapper} as the live pane, not only the transcript the model sees now.
 *
 * The history id of a conversation is its pane id (`conv-<id>`), which is also the pane's `sessionId`. A conversation
 * is open while a pane shows it. Each read maps the whole conversation again: simple, and enough for an example. A
 * program with long conversations keeps the mapped items, or a count, beside its own store.
 */
export function piHistory(o: PiHistoryOptions): HistoryProvider {
  const ctx = o.ctx ?? ctx0;
  const record = (id: ConversationId) => o.harness().commit((tx) => tx.conversation(id), ctx);

  async function itemsOf(rec: ConversationRecord): Promise<Item[] | undefined> {
    const conversation = await o.harness().conversation(rec.id, ctx);
    if (conversation === undefined) return undefined;
    const list = new ItemList();
    // A helper's record has an owner and never carries a ticket's summary; the first message does not change that.
    const look = o.describe(rec, undefined);
    const mapper = new Mapper(list, new PaneRegistry(), look.progress === true, Date.now, look.extras);
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, ENTRY_PAGE, cursor, ctx);
      mapper.replay(page.items);
      cursor = page.next;
    } while (cursor);
    return [...list.items.values()];
  }

  return {
    async list(after, limit) {
      const at = after === undefined ? undefined : cursorFrom(after);
      if (after !== undefined && at === undefined) return { items: [] };
      const page = await o.harness().commit((tx) => tx.scanConversations({ order: "descending" }, limit, at), ctx);
      const rows: ConversationRow[] = [];
      for (const rec of page.items) {
        const items = (await itemsOf(rec)) ?? [];
        const first = items.find((item): item is Extract<Item, { kind: "user" }> => item.kind === "user")?.text;
        const look = o.describe(rec, first);
        const open = o.panes.has(rec.id);
        const firstTs = items.find((item) => item.ts !== undefined)?.ts;
        const lastTs = items.findLast((item) => item.ts !== undefined)?.ts;
        const row: ConversationRow = {
          id: paneIdOf(rec.id),
          title: look.title,
          startedAt: firstTs ?? new Date().toISOString(),
          state: open ? "open" : "closed",
          items: items.length,
        };
        if (look.subtitle !== undefined) row.subtitle = look.subtitle;
        if (look.workspaceId !== undefined) row.workspaceId = look.workspaceId;
        if (look.tabId !== undefined) row.tabId = look.tabId;
        if (!open && lastTs !== undefined) row.endedAt = lastTs;
        rows.push(row);
      }
      return page.next === undefined ? { items: rows } : { items: rows, next: cursorText(page.next) };
    },
    async items(id, after, limit) {
      const conversationId = conversationOfPaneId(id);
      if (conversationId === undefined) return undefined;
      const rec = await record(conversationId);
      if (rec === undefined) return undefined;
      const all = await itemsOf(rec);
      if (all === undefined) return undefined;
      // The cursor is a position in the mapped list: Pi appends, and an item that changes keeps its place.
      const from = after === undefined ? 0 : /^\d{1,9}$/.test(after) ? Number(after) : all.length;
      const end = Math.min(all.length, from + limit);
      return end < all.length ? { items: all.slice(from, end), next: String(end) } : { items: all.slice(from, end) };
    },
  };
}

/** The pane's badge counts its open asks, and shows nothing at zero. */
const markAsks = (pane: PaneHandle) => {
  const open = pane.openAsks.length;
  pane.badge(open > 0 ? { count: open } : null);
};

export type { RiskWords };

export interface Risky {
  panes: PaneRegistry;
  /** Tool names that need the phone's yes. */
  risky: ReadonlySet<string>;
  /**
   * The words for a call, from its summary (the call's one text, see {@link summaryOf}). Left out, or undefined for a
   * tool, the question names the tool: "write_note wants to run", with Allow and Deny.
   */
  words?: (tool: string, summary: string) => RiskWords | undefined;
  /** How long the phone has to answer, in milliseconds. Past it the ask closes as decided by `timeout` and the call is blocked. Default: no expiry. */
  timeoutMs?: number;
  /** Called when a question timed out, with the call's tool name and the question's title, so the program can log it. The call is blocked and the run goes on. */
  onTimeout?: (tool: string, title: string) => void;
}

/** An extension whose `beforeTool` hook turns a risky call into an ask and waits for the answer. */
export function riskGuard(o: Risky): Extension {
  return defineExtension({
    name: "collie-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (!o.risky.has(call.name)) return undefined;
          const pane = o.panes.get(api.conversationId);
          if (!pane) return { block: "no pane to ask on" }; // fail closed
          // The question comes from the shared ask policy, so a host with no Pi raises the same card for the same call.
          const spec = toAskSpec({ toolName: call.name, args: call.arguments, words: o.words });
          const input: PermissionAskInput = {
            kind: spec.kind,
            toolCallId: safeId(call.id),
            itemId: safeId(call.id), // the tool item of this call, which the mapper keys the same way
            title: spec.title,
            tool: spec.tool,
            push: spec.push,
            options: spec.options,
          };
          if (o.timeoutMs !== undefined) input.expiresAt = new Date(Date.now() + o.timeoutMs);
          const answer = pane.ask(input, { signal: ctx.abortSignal });
          markAsks(pane); // the badge counts the asks that wait for the phone
          o.panes.asked(safeId(call.id)); // the ask is open now: a start waiting for it may go on
          try {
            return (await answer).optionId === "allow" ? undefined : { block: "denied from the phone" };
          } catch (e) {
            // The clock closed the ask: a deny, and the run goes on. Any other close (a stop, an abort) still ends the call.
            if (!(e instanceof AskClosed) || e.decidedBy !== "timeout") throw e;
            o.onTimeout?.(call.name, spec.title);
            return { block: "timed out" };
          } finally {
            markAsks(pane);
          }
        },
      }),
    ],
  });
}

/** The names of the tools that ask the phone a question of their own, so a restart waits for their asks too. */
export const ASKING_TOOLS: ReadonlySet<string> = new Set(["ask_queue", "ask_customer"]);

/** The words of the two asking tools: the choice of a team, and the line for the customer. The program's own. */
export interface AskToolWords {
  team: { question: string; options: PlainOption[] };
  reply: { question: string; placeholder?: string };
}

/** A rejected ask the clock closed reads as no answer; any other close (a stop, an abort) still throws. */
const timeoutOf = (e: Error): undefined => {
  if (e instanceof AskClosed && e.decidedBy === "timeout") return undefined;
  throw e;
};

/**
 * A tool's answer to the model, in both shapes Pi Durable has used: 1.1.0 reads `content`, 1.2.0 renamed it `output`
 * and ignores `content`. Each version ignores the other's field at run time. The result is returned from a variable, not
 * a literal, so neither version's type check rejects the field it does not know.
 */
export function toolResult(text: string, extra: { isError?: true; details?: ToolExecutionResult["details"] } = {}) {
  const content = [{ type: "text" as const, text }];
  const result = { content, output: content, ...extra };
  return result;
}

/** A tool's answer to the model: one text block. */
const toolReply = (text: string) => toolResult(text);

/**
 * `ask_queue` (a choice: which team takes the ticket) and `ask_customer` (a text ask: the line for the customer):
 * tools whose whole job is a question for the person on the phone (WIRE.md 7.14). The ask sits under the tool's own
 * item, and `replay: "safe"` means a rerun after a crash asks again under the same id. Each answers the model with the
 * person's words: the team's name, or the line. The scripted double-charge ticket calls them after its note.
 */
export function askTools(o: {
  panes: PaneRegistry;
  words: AskToolWords;
  /** How long the phone has to answer, in milliseconds. Past it the tool returns an error result "timed out" and the run goes on. Default: no expiry. */
  timeoutMs?: number;
  /** Called when a question timed out, with the tool name and the question's title, so the program can log it. */
  onTimeout?: (tool: string, title: string) => void;
}) {
  const { team, reply: line } = o.words;
  const expires = (): { expiresAt?: Date } => (o.timeoutMs === undefined ? {} : { expiresAt: new Date(Date.now() + o.timeoutMs) });
  const timedOut = (tool: string, title: string) => {
    o.onTimeout?.(tool, title);
    return toolResult("timed out", { isError: true });
  };
  const ask = async <A>(api: { conversationId: ConversationId; callId: string }, raise: (pane: PaneHandle, id: string) => Promise<A>): Promise<A> => {
    const pane = o.panes.get(api.conversationId);
    if (!pane) throw new Error("no pane to ask on");
    const id = safeId(api.callId);
    const pending = raise(pane, id);
    markAsks(pane);
    o.panes.asked(id);
    try {
      return await pending;
    } finally {
      markAsks(pane);
    }
  };
  const queue = defineTool({
    name: "ask_queue",
    description: "Ask the person which team takes the ticket.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const answer = await ask(api, (pane, id) => pane.ask({ kind: "choice", toolCallId: id, itemId: id, title: team.question, options: team.options, ...expires() })).catch((e: Error) => timeoutOf(e));
      if (answer === undefined) return timedOut("ask_queue", team.question);
      return toolReply(answer.optionIds.map((picked) => team.options.find((option) => option.id === picked)?.label ?? picked).join(", "));
    },
  });
  const customer = defineTool({
    name: "ask_customer",
    description: "Ask the person for one line to send to the customer.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const answer = await ask(api, (pane, id) => {
        const input: TextAskInput = { kind: "text", toolCallId: id, itemId: id, title: line.question, maxLength: 280 };
        if (line.placeholder !== undefined) input.placeholder = line.placeholder;
        return pane.ask({ ...input, ...expires() });
      }).catch((e: Error) => timeoutOf(e));
      if (answer === undefined) return timedOut("ask_customer", line.question);
      return toolReply(clip(answer.text));
    },
  });
  return [queue, customer];
}

export interface HelperOptions {
  panes: PaneRegistry;
  harness: () => Harness;
  /** Where helper panes appear (tab "helpers"). */
  tab: TabHandle;
  /** The helper's model. Left out, it follows the host. */
  model?: { provider: string; modelId: string };
  /** Extensions the helper must not get, so it cannot spawn helpers of its own. */
  without: () => Extension[];
  /** The helper's title and the line under it, from its task. */
  look: (task: string) => { title: string; subtitle?: string };
  /**
   * The helper answered: the program takes its pane out of the layout, so the conversation list keeps the tickets in
   * sight and the look-up goes under Closed, where it can still be read. Left out, the pane stays.
   */
  done?: (child: ConversationId, pane: PaneHandle) => Promise<void> | void;
}

/** `spawn_helper`: a child conversation owned by the call, shown as a new pane. Returns the helper's answer. */
export function spawnHelperTool(o: HelperOptions) {
  return defineTool({
    name: "spawn_helper",
    description: "Hand a small self-contained task to a helper agent and get its answer back.",
    parameters: Type.Object({ task: Type.String() }),
    replay: "safe", // a rerun after a crash finds the same child and the same submission
    execute: async (args, api, ctx) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        const extensions = { remove: o.without() };
        await configure(tx, created.id, o.model ? { model: o.model, extensions } : { extensions });
        return created.id;
      }, ctx);
      const harness = o.harness();
      const conversation = (await harness.conversation(child, ctx))!;
      const look = o.look(args.task);
      const loc: PaneLocation = { tab: o.tab, title: look.title };
      if (look.subtitle !== undefined) loc.subtitle = look.subtitle;
      const pane = await showConversation(loc, harness, conversation, { panes: o.panes, ctx });
      await api.details({ conversationId: child }, ctx);
      const handle = (await api.conversation(child, ctx))!;
      const request = { type: "input", content: args.task, requestId: `helper:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, ctx)).wait(ctx);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`helper failed: ${settled.status}`);
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      const text = textOf(entry?.model?.[0]?.content ?? "");
      await o.done?.(child, pane);
      return toolResult(text, { details: { conversationId: child } });
    },
  });
}
