// The Pi variant of durable-harness as a {@link WireSource} (M66): every open run of the program's workflow is one
// pane, and everything the pane shows is derived from the run's log on each read. Items come from the same `Mapper`
// the Pi entry uses on a live pane, replayed over the reader's entries, plus Pi's live partial as the growing reply.
// Nothing is kept between two reads; a second instance reading the same log derives the same pane.
// Erasable TypeScript only, so Node runs it as it is.

import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { safeId } from "../core/rules.ts";
import { sha256Hex } from "../core/hash.ts";
import type { ConversationRow, HistoryProvider, Item, ProgramEvent } from "../core/types.ts";
import { Mapper, type MapperTarget, PaneRegistry } from "../pi/index.ts";
import type { PaneFacts, SourceLayout, WireSource } from "./route.ts";
import { harnessNameOf, type RunInfo, runEnded, type SessionView, type WorldPort } from "./world-port.ts";

/** The pane id of a run, which is also its id in the history (WIRE.md 7.16). */
export const paneIdOfRun = (runId: string) => safeId(`conv-${runId}`);

/** The run a pane id names, the inverse of {@link paneIdOfRun}, or undefined for any other id. */
export function runOfPaneId(paneId: string): string | undefined {
  const match = /^conv-(wrun_[0-9A-Za-z]{1,64})$/.exec(paneId);
  return match === null ? undefined : match[1];
}

/** What one finished run adds to the snapshot's rev: more than a pane's cursor can reach. 2^21 finished runs fit in 2^53. */
const FINISHED_WEIGHT = 2 ** 32;

/** The version of the mapping from a log to items and cursors. Part of the epoch: change it when a cursor changes meaning. */
export const MAPPER_SCHEMA_VERSION = 1;

export interface PiSourceOptions {
  port: WorldPort;
  /** The opener's name (`resumeWith(open, { name })`). Default `pi-durable`. */
  name?: string;
  /** The one workspace every pane sits in. Default: the name. */
  workspaceTitle?: string;
  /** The title of a pane from its first message. Default: that message, or `Session <short id>`. */
  title?: (first: string | undefined, runId: string) => string;
}

/** The items a mapper writes, in their latest version, in the order each first came. */
class ItemCollector implements MapperTarget {
  readonly items = new Map<string, Item>();
  event(e: ProgramEvent) {
    if (e.type === "item") this.items.set(e.item.id, e.item);
  }
  progress() {}
  state() {}
}

/** The items of a session, as the live pane would show them at this point of its log. */
export function itemsOf(view: SessionView, withLive: boolean): Item[] {
  const list = new ItemCollector();
  const mapper = new Mapper(list, new PaneRegistry(), false);
  const entries: readonly unknown[] = view.entries;
  // SAFETY: the reader's entries are Pi's own entry records, as `durable-harness` reads them from the log: the id, the
  // model messages and the data the mapper reads are Pi's, and the id is printed, never compared as a number.
  mapper.replay(entries as readonly EntryRecord[]);
  const message = view.live?.generation?.message;
  if (withLive && message !== undefined && message !== null) {
    // Pi's committed partial, through the same two events a watched pane gets, so it carries the mapper's own ids.
    // SAFETY: `pi.live` holds the assistant message Pi is generating, the message `message_start` and a whole-message change carry.
    const events: readonly unknown[] = [
      { type: "message_start", message },
      { type: "message_update", changes: [{ type: "message", message }] },
    ];
    // SAFETY: `message` is Pi's own assistant message from `pi.live`; these are the two events a watched pane gets for it.
    for (const e of events as readonly AgentEvent[]) mapper.apply(e);
  }
  return [...list.items.values()];
}

/** Is the session at work: a task not yet terminal, or Pi's live run present? */
export const busyOf = (view: SessionView) => view.unfinished || view.live?.run !== undefined;

/**
 * The turn of a session, a fact of its log (WIRE.md A.1): the slot of the user entry that started the work under way,
 * or, when idle, of the newest user entry. The same on every instance. A follow-up taken in the middle of a run starts
 * a new turn once its entry lands.
 */
export function turnIdOf(view: SessionView): string {
  const users = view.entries.filter((e) => e.kind === "pi.user");
  let slot = users.at(-1)?.slot ?? 0;
  if (busyOf(view)) {
    const live = view.tasks.filter((t) => t.status !== "terminal" && t.starts.length > 0);
    const from = Math.min(...live.map((t) => t.starts[0]!.slot));
    if (Number.isFinite(from)) slot = users.findLast((u) => u.slot < from)?.slot ?? slot;
  }
  return safeId(sha256Hex(`${view.sessionId}\n${String(slot)}`).slice(0, 32));
}

const firstUser = (items: readonly Item[]) => items.find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user")?.text;

export function piSource(o: PiSourceOptions): WireSource {
  const name = o.name ?? "pi-durable";
  const workspaceId = safeId(name);
  const title = o.title ?? ((first: string | undefined, runId: string) => (first !== undefined && first.trim() !== "" ? first : `Session ${runId.slice(-6)}`));
  const tabId = "sessions";

  /** The facts of an open run. `items` are its mapped items; left out, only its first user entry is mapped, for the title. */
  function factsOf(run: RunInfo, view: SessionView, items?: Item[]): PaneFacts {
    const first = firstUser(items ?? itemsOf({ ...view, entries: view.entries.filter((e) => e.kind === "pi.user").slice(0, 1) }, false));
    const lastActive = Date.parse(view.entries.at(-1)?.at ?? run.updatedAt ?? run.createdAt);
    return {
      id: paneIdOfRun(run.runId),
      journal: run.runId,
      workspaceId,
      tabId,
      title: title(first, run.runId),
      harness: "pi",
      state: busyOf(view) ? "working" : "idle",
      turnId: turnIdOf(view),
      rev: view.eventCount,
      lastActiveAt: Number.isNaN(lastActive) ? 0 : lastActive,
    };
  }

  /** The run a pane id names, when it is one of this program's. */
  async function runOf(paneId: string): Promise<RunInfo | undefined> {
    const runId = runOfPaneId(paneId);
    if (runId === undefined) return undefined;
    const run = await o.port.getRun(runId);
    return run !== undefined && harnessNameOf(run.workflowName) === name ? run : undefined;
  }

  const history: HistoryProvider = {
    async list(after, limit) {
      const runs = (await o.port.listRuns(name)).toReversed(); // newest first
      const from = after === undefined ? 0 : /^\d{1,9}$/.test(after) ? Number(after) : runs.length;
      const page = runs.slice(from, from + limit);
      const rows: ConversationRow[] = [];
      for (const run of page) {
        const items = itemsOf(await o.port.readSession(run.runId), false);
        const row: ConversationRow = {
          id: paneIdOfRun(run.runId),
          title: title(firstUser(items), run.runId),
          startedAt: run.createdAt,
          state: runEnded(run.status) ? "closed" : "open",
          items: items.length,
          workspaceId,
          tabId: `${workspaceId}:${tabId}`,
        };
        if (runEnded(run.status) && run.completedAt !== undefined) row.endedAt = run.completedAt;
        rows.push(row);
      }
      const end = from + page.length;
      return end < runs.length ? { items: rows, next: String(end) } : { items: rows };
    },
    async items(id, after, limit) {
      const run = await runOf(id);
      if (run === undefined) return undefined;
      const all = itemsOf(await o.port.readSession(run.runId), false);
      // The cursor is a place in the mapped list: Pi appends, and an item that changes keeps its place.
      const from = after === undefined ? 0 : /^\d{1,9}$/.test(after) ? Number(after) : all.length;
      const end = Math.min(all.length, from + limit);
      return end < all.length ? { items: all.slice(from, end), next: String(end) } : { items: all.slice(from, end) };
    },
  };

  return {
    caps: { asks: true, history: true },
    identity: () => `${o.port.worldIdentity()}\npi-source/${String(MAPPER_SCHEMA_VERSION)}`,
    async ready() {
      await o.port.checkVersions();
      await o.port.listRuns(name);
    },
    async layout(): Promise<SourceLayout> {
      const runs = await o.port.listRuns(name);
      const open = runs.filter((r) => !runEnded(r.status));
      const panes = await Promise.all(open.map(async (run) => factsOf(run, await o.port.readSession(run.runId))));
      return {
        workspaces: [{ id: workspaceId, title: o.workspaceTitle ?? name }],
        tabs: [{ id: tabId, workspaceId, title: "Sessions" }],
        panes,
        // A run that finishes takes its pane's cursor out of the snapshot's sum. Each finished run adds 2^32 instead,
        // more than any one pane's cursor, so the snapshot's rev never goes down when a run ends (WIRE.md A.1).
        rev: (runs.length - open.length) * FINISHED_WEIGHT + runs.length,
      };
    },
    async pane(id, withItems) {
      const run = await runOf(id);
      if (run === undefined || runEnded(run.status)) return undefined;
      const view = await o.port.readSession(run.runId);
      const items = itemsOf(view, true);
      const facts = factsOf(run, view, items);
      return withItems ? { ...facts, items } : facts;
    },
    history,
  };
}
