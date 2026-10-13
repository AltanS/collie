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
  type SnapshotEvent,
  ToolTask,
  watchEvents,
} from "@earendil-works/pi-durable";
import { type Item, type PaneHandle, safeId, type TabHandle } from "../sdk/core/index.ts";

const ctx0 = BACKGROUND_CONTEXT;

/** How long a start waits for the asks it expects to be raised again, before it shows the layout anyway. */
export const RE_RAISE_MS = 5000;

/**
 * Which pane shows which conversation. The guard hook looks panes up here. It also knows which tool calls
 * have no result yet, so a start can wait for their asks before it calls itself ready (`reRaised`).
 */
export class PaneRegistry {
  private panes = new Map<ConversationId, PaneHandle>();
  private stops: (() => Promise<unknown>)[] = [];
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
    this.stops.push(stop);
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
    await Promise.all(this.stops.splice(0).map((stop) => stop().catch(() => {})));
  }
}

export interface PaneLocation {
  tab: TabHandle;
  title: string;
  paneId?: string;
  /** Absolute. Optional: the pane falls back to its workspace's folder. */
  cwd?: string;
}

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

/** Pi entries and agent events to the session stream. Whole blocks only: message_update is ignored. */
class Mapper {
  private tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  constructor(
    private pane: PaneHandle,
    private registry: PaneRegistry,
  ) {}

  private item(item: Item) {
    this.pane.event({ type: "item", item });
    if (item.kind === "tool") this.registry.toolStatus(item.id, item.tool.name, item.status);
  }

  snapshot(s: SnapshotEvent, first: boolean) {
    if (!first) this.pane.event({ type: "reset" });
    this.tools.clear();
    for (const entry of s.entries) this.entry(entry);
    this.pane.event({ type: "synced" });
    this.pane.state(s.run ? "working" : "idle");
  }

  apply(e: AgentEvent) {
    switch (e.type) {
      case "snapshot": // the consumer fell behind: start over from the newest view
        return this.snapshot(e, false);
      case "run_start":
      case "turn_start":
        return this.pane.state("working");
      case "run_end":
        return this.pane.state("idle");
      case "message_end":
        return this.entry(e.entry);
      case "submission":
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

  private entry(e: EntryRecord) {
    const m = e.model?.[0];
    if (!m) return;
    const ts = new Date(m.timestamp).toISOString();
    const id = safeId(`e${e.id}`);
    if (m.role === "user") {
      return this.item({ id, ts, kind: "user", text: textOf(m.content) });
    }
    if (m.role === "assistant") {
      (m.content as Block[]).forEach((b, i) => {
        if (b.type === "text") this.item({ id: safeId(`${id}:${i}`), ts, kind: "reply", text: b.text ?? "" });
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
 * Show a conversation as a pane. Safe to call twice for one conversation: the second call returns
 * the pane that exists. History is sent first (then `synced`), after that events are live.
 */
export async function showConversation(
  loc: PaneLocation,
  harness: Harness,
  conversation: Conversation,
  opts: { panes: PaneRegistry; ctx?: Context },
): Promise<PaneHandle> {
  const have = opts.panes.get(conversation.id);
  if (have) return have;
  const ctx = opts.ctx ?? ctx0;
  const pane = loc.tab.pane(loc.paneId ?? paneIdOf(conversation.id), { title: loc.title, harness: "pi", ...(loc.cwd ? { cwd: loc.cwd } : {}) });
  const mapper = new Mapper(pane, opts.panes);

  // The wire's request id goes to Pi Durable as the submission's own dedupe key, so a repeat that
  // reaches Pi after a restart still admits the input once.
  pane.onSend(async (text, { steer, requestId }) => {
    await conversation.submit({ type: "input", content: text, whenBusy: steer ? "steer" : "followUp", requestId }, ctx);
  });
  pane.onAbort(() => conversation.abort(ctx));

  const stream = await watchEvents(harness, conversation.id, ctx);
  opts.panes.set(conversation.id, pane, () => stream.stop());
  mapper.snapshot(stream.snapshot, true);
  stream.start(async (events) => {
    for (const e of events) mapper.apply(e);
  });
  return pane;
}

export interface Risky {
  panes: PaneRegistry;
  /** Tool names that need the phone's yes. */
  risky: ReadonlySet<string>;
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
              options: [
                { id: "allow", label: "Allow", effect: "allow" },
                { id: "deny", label: "Deny", effect: "deny" },
              ],
            },
            { signal: ctx.abortSignal },
          );
          o.panes.asked(safeId(call.id)); // the ask is open now: a start waiting for it may go on
          return (await answer).optionId === "allow" ? undefined : { block: "denied from the phone" };
        },
      }),
    ],
  });
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
      await showConversation({ tab: o.tab, title: `Helper #${child}` }, harness, conversation, { panes: o.panes, ctx });
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
