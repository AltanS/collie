// The thin Pi Durable adapter. It is the only place that imports Pi Durable. It uses the SDK's
// handles and nothing else: a conversation becomes a pane, `watchEvents` becomes events and state,
// a `beforeTool` hook becomes an ask, send and stop become `submit` and `abort`.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  type Harness,
  hook,
  type MessageChange,
  type SnapshotEvent,
  type SubmissionRecord,
  ToolTask,
  watchEvents,
} from "@earendil-works/pi-durable";
import { type Item, type PaneHandle, type Progress, type ProgressStep, safeId, type TabHandle } from "../sdk/core/index.ts";

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
  private stops = new Map<ConversationId, () => Promise<unknown>>();
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
  set(id: ConversationId, pane: PaneHandle, stop: () => Promise<unknown>) {
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
  reRaised(risky: ReadonlySet<string>, ms = RE_RAISE_MS, log: (line: string) => void = (line) => console.warn(line)): Promise<void> {
    const ids = [...this.running].filter(([, name]) => risky.has(name)).map(([id]) => id);
    if (ids.length === 0) return Promise.resolve();
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
    return Promise.race([Promise.all(each).then(() => "all" as const), late])
      .then((how) => {
        if (how === "all") return;
        log(
          `collie: ${missing.size} of ${ids.length} waiting asks were not raised again within ${ms} ms of the start; ` +
            `the layout is ready without them, and each is listed under its old id once its hook runs (${[...missing].join(", ")})`,
        );
      })
      .finally(() => {
        clearTimeout(timer);
        for (const id of ids) this.waits.delete(id);
      });
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
}

/** The line under a pane's title: what the ticket is about, or which ticket the helper helps. */
export const subtitleFor = (owner: ConversationId | undefined): string => (owner === undefined ? "a customer cannot log in" : `helping ticket ${owner}`);

/** The one belt action of a ticket. */
const ESCALATE = { id: "escalate", label: "Escalate", icon: "flag" } as const;

const paneIdOf = (id: ConversationId) => safeId(`conv-${id}`);
const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}...` : s);

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : (content as Block[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");

const NEXT_STEPS = "**What to do next**\n\n- Ask the customer to sign in again.\n- Check that the reset mail went out.\n- Close the ticket when they confirm.";
const REVOKE_COMMAND = "# clear the stale session\nsession-cli revoke --user 412";
const DOCS_URL = "https://colliepwa.dev/docs/";

/** The least time between two writes of a growing reply (WIRE.md 7.15). */
export const PARTIAL_MS = 250;

/** A text or thinking block of the answer being written, as far as it has come. */
type LiveBlock = Block;

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
const messageId = (timestamp: unknown) => safeId(`m${String(timestamp)}`);

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
  constructor(
    private pane: PaneHandle,
    private registry: PaneRegistry,
    private withProgress: boolean,
    private readonly now: () => number = Date.now,
  ) {}

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
   * What a finished ticket adds under its reply: a markdown note with a list, a code block and a link (WIRE.md 7.13).
   * The ids come from the reply's, so a replay after a restart writes the same three items again, not three more.
   */
  private summary(replyId: string, ts: string) {
    this.item({ id: safeId(`${replyId}:todo`), ts, kind: "markdown", text: NEXT_STEPS });
    this.item({ id: safeId(`${replyId}:cmd`), ts, kind: "code", lang: "sh", text: REVOKE_COMMAND });
    this.item({ id: safeId(`${replyId}:docs`), ts, kind: "link", href: DOCS_URL, label: "Collie docs" });
  }

  /** The three steps of a ticket as the first run reaches them: read it, write a note, reply. */
  private steps(): Progress {
    const { user, note, noted, reply } = this.seen;
    const state = (done: boolean, running: boolean): ProgressStep["state"] => (done ? "done" : running ? "running" : "todo");
    return {
      kind: "steps",
      steps: [
        { label: "read the ticket", state: state(user && (note || reply), !user || !note) },
        { label: "write a note", state: state(noted || reply, note || user) },
        { label: "reply", state: state(reply, noted) },
      ],
    };
  }

  /** Steps while the first run works. After its reply, or when the pane is idle, none: the program clears them. */
  private mark(working: boolean) {
    if (!this.withProgress) return;
    this.pane.progress(working ? this.steps() : null);
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
        return this.pane.event({
          type: "settled",
          inputId: safeId(e.record.id),
          ...(e.record.requestId === undefined ? {} : { requestId: safeId(e.record.requestId) }),
          status: e.record.status === "done" ? "answered" : "unanswered",
          ...(e.record.status === "unanswered" ? { reason: e.record.reason } : {}),
        });
      case "task_failed":
        return this.item({ id: safeId(`fail:${e.taskId}`), kind: "notice", text: `${e.kind} failed: ${e.message}` });
      case "auto_retry_start":
        return this.item({ id: safeId(`retry:${e.at}`), kind: "notice", text: `retrying: ${e.errorMessage}` });
    }
  }

  /** An answer begins. The start of one that is already whole is followed by its end, and draws nothing in between. */
  private start(message: { role: string; timestamp: number; content: unknown }) {
    this.live = undefined;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const blocks = (message.content as Block[]).map((b) => ({ ...b }));
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
          live.blocks[c.contentIndex] = { ...c.block };
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
          live.blocks = (c.message.content as Block[]).map((b) => ({ ...b }));
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
      return this.item({ id, ts, kind: "user", text: textOf(m.content), ...(requestId === undefined ? {} : { requestId }) });
    }
    if (m.role === "assistant") {
      (m.content as Block[]).forEach((b, i) => {
        if (b.type === "text") {
          this.item({ id: safeId(`${id}:${i}`), ts, kind: "reply", text: b.text ?? "" });
          if (this.withProgress && (b.text ?? "").startsWith("Triage done")) this.summary(safeId(`${id}:${i}`), ts);
        }
        else if (b.type === "thinking") this.item({ id: safeId(`${id}:${i}`), ts, kind: "thinking", text: b.thinking ?? "" });
        else if (b.type === "toolCall") {
          const tool: Extract<Item, { kind: "tool" }> = {
            id: safeId(b.id),
            ts,
            kind: "tool",
            status: "running",
            tool: { kind: "other", name: b.name!, summary: clip(JSON.stringify(b.arguments)) },
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
      const diagnostics = (e.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
      const denied = diagnostics.some((d) => d.code === "blocked");
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
 * own: the Cloudflare example's PiHarness schedules the session's wake job in its `submit`.
 */
export type Submit = (conversation: Conversation, input: { content: string; whenBusy: "steer" | "followUp"; requestId?: string }) => Promise<unknown>;

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
  const pane = loc.tab.pane(loc.paneId ?? paneIdOf(conversation.id), { title: loc.title, harness: "pi", ...(loc.cwd ? { cwd: loc.cwd } : {}) });
  if (loc.subtitle) pane.subtitle(loc.subtitle);
  const mapper = new Mapper(pane, opts.panes, loc.progress === true);

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
    // The phone taps Escalate: write one notice into the thread, dim the button and mark the badge "esc". The request id keys the
    // notice, so the same tap never writes it twice. This is a program's own act and needs no Pi Durable call.
    pane.onAction(({ actionId, requestId }) => {
      if (actionId !== ESCALATE.id) return false;
      pane.event({ type: "item", item: { id: safeId(`escalated:${requestId}`), ts: new Date().toISOString(), kind: "notice", text: "Escalated to the on-call lead." } });
      pane.actions([{ ...ESCALATE, disabled: true }]);
      escalated.add(pane);
      markAsks(pane);
    });
  }

  const stream = await watchEvents(harness, conversation.id, ctx);
  opts.panes.set(conversation.id, pane, () => stream.stop());
  mapper.snapshot(stream.snapshot, true);
  stream.start(async (events) => {
    mapper.applyAll(events);
  });
  return pane;
}

/** The panes whose ticket was escalated: their badge reads "esc" while no question waits. */
const escalated = new WeakSet<PaneHandle>();

/** The pane's badge counts its open asks. At zero it reads "esc" on an escalated ticket, and shows nothing otherwise. */
const markAsks = (pane: PaneHandle) => {
  const open = pane.openAsks.length;
  pane.badge(open > 0 ? { count: open } : escalated.has(pane) ? { text: "esc" } : null);
};

export interface Risky {
  panes: PaneRegistry;
  /** Tool names that need the phone's yes. */
  risky: ReadonlySet<string>;
}

/** The notification words for a risky call. The note tool says what it will do; any other says its summary. */
function pushFor(tool: string, summary: string): { title: string; line: string } {
  if (tool === "write_note") return { title: "Ticket needs a yes", line: "write_note wants to add one line to the notes" };
  return { title: `${tool} needs a yes`, line: summary };
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
          const summary = clip(JSON.stringify(call.arguments));
          const answer = pane.ask(
            {
              kind: "permission",
              toolCallId: safeId(call.id),
              itemId: safeId(call.id), // the tool item of this call, which the mapper keys the same way
              title: `${call.name} wants to run: ${summary}`,
              tool: { kind: "other", name: call.name, summary },
              reason: `${call.name} is marked risky`,
              // The words of the notification (WIRE.md section 6). The pane's name goes in front of the title.
              push: pushFor(call.name, summary),
              options: [
                { id: "allow", label: "Allow", effect: "allow" },
                { id: "deny", label: "Deny", effect: "deny" },
              ],
            },
            { signal: ctx.abortSignal },
          );
          markAsks(pane); // the badge counts the asks that wait for the phone
          o.panes.asked(safeId(call.id)); // the ask is open now: a start waiting for it may go on
          try {
            return (await answer).optionId === "allow" ? undefined : { block: "denied from the phone" };
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

export const QUEUES = [
  { id: "billing", label: "Billing" },
  { id: "access", label: "Access" },
  { id: "other", label: "Other" },
];

/**
 * `ask_queue` (a choice) and `ask_customer` (a text ask): tools whose whole job is a question for the person on the
 * phone (WIRE.md 7.14). The ask sits under the tool's own item, and `replay: "safe"` means a rerun after a crash asks
 * again under the same id. The scripted ticket that starts with `ASK:` calls them after its note.
 */
export function askTools(o: { panes: PaneRegistry }) {
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
  const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
  const queue = defineTool({
    name: "ask_queue",
    description: "Ask the person which queue the ticket goes to.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const answer = await ask(api, (pane, id) => pane.ask({ kind: "choice", toolCallId: id, itemId: id, title: "Which queue?", options: QUEUES }));
      return reply(`queue: ${answer.optionIds.join(", ")}`);
    },
  });
  const customer = defineTool({
    name: "ask_customer",
    description: "Ask the person for one line to send to the customer.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api) => {
      const answer = await ask(api, (pane, id) =>
        pane.ask({ kind: "text", toolCallId: id, itemId: id, title: "One line for the customer", placeholder: "We are looking into it", maxLength: 280 }),
      );
      return reply(`customer line: ${clip(answer.text)}`);
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
        await configure(tx, created.id, { ...(o.model ? { model: o.model } : {}), extensions: { remove: o.without() } });
        return created.id;
      }, ctx);
      const harness = o.harness();
      const conversation = (await harness.conversation(child, ctx))!;
      await showConversation({ tab: o.tab, title: `Helper #${child}`, subtitle: subtitleFor(api.conversationId) }, harness, conversation, {
        panes: o.panes,
        ctx,
      });
      await api.details({ conversationId: child }, ctx);
      const handle = (await api.conversation(child, ctx))!;
      const request = { type: "input", content: args.task, requestId: `helper:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, ctx)).wait(ctx);
      if (settled.status !== "done" || settled.type !== "input") throw new Error(`helper failed: ${settled.status}`);
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      const text = textOf((entry?.model?.[0] as { content?: unknown } | undefined)?.content ?? "");
      return { content: [{ type: "text", text }], details: { conversationId: child } };
    },
  });
}
