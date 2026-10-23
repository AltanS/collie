// The protocol suite against the durable-harness route (M66 spec 03). The suite drives a program through the SDK's
// handles (`pane.ask`, `pane.onSend`, ...), and the route has no program in its process: it derives the wire from a
// World on every request. So the program here is the core's memory store, and a mirror stands between it and the
// World: before each request it writes the program's facts where the route reads them (the layout, the items, an `ask`
// record for each open ask, an `expire` for each ask the program closed), and after each request it carries what the
// route wrote back to the program (an answer that won, a stop). The route serves through its own seams, journal and
// receipts, with no access to the memory store's asks, receipts or cursor.
import { createHash } from "node:crypto";
import { type Caps, type CoreState, foldJournal, handle, type JournalAsk, type ProgramHooks, Store } from "../../../packages/durable-sdk/src/core/index.ts";
import type { Pane } from "../../../packages/durable-sdk/src/core/layout.ts";
import { HttpError } from "../../../packages/durable-sdk/src/core/receipts.ts";
import type { Item } from "../../../packages/durable-sdk/src/core/types.ts";
import { type Controls, createRoute, type JournalPort, type PaneFacts, type WireSource } from "../../../packages/durable-sdk/src/durable-harness/route.ts";
import type { Opened, Transport } from "../../durable-member/tests/protocol-suite.ts";
import { FakeWorld } from "./fake-world.ts";
import { TOKEN, withToken } from "./rig.ts";

const ALL: Required<Omit<Caps, "terminal">> = { asks: true, starters: true, send: true, steer: true, abort: true, rename: true, close: true, actions: true, history: true, reopen: true };

let epochs = 0;

class Mirror implements WireSource {
  readonly caps = { asks: true, history: true };
  readonly store = new Store();
  readonly program: CoreState;
  readonly journal: JournalPort;
  /** The asks already written to the journal, by pane. */
  private readonly written = new Map<string, Set<string>>();
  /** The answers already carried back to the program. */
  private readonly carried = new Set<string>();

  constructor(hostName: string, hooks: ProgramHooks, journal: JournalPort) {
    this.store.hooks = hooks;
    this.program = { store: this.store, hostName, caps: { ...ALL, terminal: false }, hooks, warn: () => {} };
    this.journal = journal;
  }

  identity() {
    return "mirror";
  }
  async ready() {
    if (!this.store.ready) throw new Error("the program is not ready");
  }

  private facts(pane: Pane): PaneFacts {
    const info = pane.info();
    const facts: PaneFacts = {
      id: pane.id,
      journal: pane.id,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId.slice(pane.workspaceId.length + 1),
      title: pane.title,
      harness: pane.harness,
      state: pane.base === "working" ? "working" : "idle",
      turnId: pane.turnId,
      rev: pane.eventsAfter(0, true).next,
      lastActiveAt: pane.lastActiveAt,
    };
    if (pane.cwd !== undefined) facts.cwd = pane.cwd;
    if (info.subtitle !== undefined) facts.subtitle = info.subtitle;
    if (info.badge !== undefined) facts.badge = info.badge;
    if (info.progress !== undefined) facts.progress = info.progress;
    if (typeof info.sessionId === "string") facts.sessionId = info.sessionId;
    return facts;
  }

  async layout() {
    await this.ready();
    return {
      workspaces: [...this.store.workspaces.values()].map((w) => ({ id: w.id, title: w.title, ...(w.cwd === undefined ? {} : { cwd: w.cwd }) })),
      tabs: [...this.store.tabs.values()].map((t) => ({ id: t.id.slice(t.workspaceId.length + 1), workspaceId: t.workspaceId, title: t.title })),
      panes: [...this.store.panes.values()].map((p) => this.facts(p)),
      rev: this.store.rev,
    };
  }

  async pane(id: string, withItems: boolean) {
    await this.ready();
    const pane = this.store.panes.get(id);
    if (pane === undefined) return undefined;
    const facts = this.facts(pane);
    if (!withItems) return facts;
    const items = new Map<string, Item>();
    for (const e of pane.eventsAfter(0, true).events) if (e.type === "item") items.set(e.item.id, e.item);
    return { ...facts, items: [...items.values()] };
  }

  get history() {
    return this.store.history;
  }

  /** Program to World: an `ask` for each ask the program opened, an `expire` for each one it closed itself. */
  async before() {
    for (const pane of this.store.panes.values()) {
      const written = this.written.get(pane.id) ?? new Set<string>();
      this.written.set(pane.id, written);
      const folded = foldJournal(await this.journal.readJournal(pane.id));
      for (const ask of pane.openAsks) {
        if (written.has(ask.id)) continue;
        written.add(ask.id);
        const record: JournalAsk = { t: "ask", askId: ask.id, toolCallId: ask.toolCallId, argsHash: createHash("sha256").update(ask.toolCallId).digest("hex"), ask, openedAt: new Date().toISOString() };
        if (ask.expiresAt !== undefined) record.expiresAt = ask.expiresAt;
        await this.journal.appendJournal(pane.id, record);
      }
      const open = new Set(pane.openAskIds);
      for (const askId of written) {
        if (open.has(askId) || folded.winners.has(askId)) continue;
        const outcome = pane.outcomeOf(askId);
        if (outcome === undefined || outcome.decidedBy === "phone") continue;
        await this.journal.appendJournal(pane.id, { t: "expire", askId, at: outcome.decidedAt, decidedBy: outcome.decidedBy === "timeout" ? "timeout" : "program" });
      }
    }
  }

  /** World to program: an answer that won reaches the waiting `ask()`, a stop closes it. */
  async after() {
    for (const pane of this.store.panes.values()) {
      const folded = foldJournal(await this.journal.readJournal(pane.id));
      for (const [askId, winner] of folded.winners) {
        if (this.carried.has(`${pane.id}/${askId}`) || !pane.openAskIds.includes(askId)) continue;
        this.carried.add(`${pane.id}/${askId}`);
        if (winner.t === "answer") await pane.answer(askId, winner.answer, winner.requestId);
        else if (winner.decidedBy === "program") pane.decideAsk(askId);
      }
    }
  }

  /** The program's own handlers, reached through its own core, so its checks and hooks run as they would. */
  controls(): Controls {
    const act = async (path: string, body: object) => {
      const reply = await handle(new Request(`http://program/session/v1${path}`, { method: "POST", headers: { "x-collie-session": "1", "content-type": "application/json" }, body: JSON.stringify(body) }), this.program);
      if (reply.status >= 300) {
        const problem = (await reply.json()) as { code: string };
        throw new HttpError(reply.status, problem.code);
      }
    };
    return {
      send: (c) => act(`/pane/${encodeURIComponent(c.paneId)}/send`, { requestId: c.requestId, turnId: c.turnId, text: c.text, steer: c.steer }),
      abort: (c) => act(`/pane/${encodeURIComponent(c.paneId)}/abort`, { requestId: c.requestId, turnId: c.turnId }),
    };
  }
}

/** The suite's transport: one World, `instances` route instances that take turns on every request. */
export function mirrorTransport(name: string, instances: number, skip: Record<string, string>): Transport {
  return {
    name,
    skip,
    async open({ hostName, caps, hooks, onRename }) {
      const world = new FakeWorld();
      const allHooks: ProgramHooks = { ...(onRename ? { onRename: (t) => onRename(t) } : {}), ...hooks };
      const mirror = new Mirror(hostName, allHooks, world.port());
      const epoch = createHash("sha256").update(`mirror-${++epochs}`).digest("hex").slice(0, 32);
      const routes = Array.from({ length: instances }, () =>
        createRoute({ source: mirror, journal: mirror.journal, token: TOKEN, hostName, name: "mirror", epoch, controls: mirror.controls(), warn: () => {}, ...(caps === undefined ? {} : { caps }) }),
      );
      let turn = 0;
      // One request at a time, as the suite's own concurrency tests allow: the mirror's two steps must not interleave.
      let queue: Promise<unknown> = Promise.resolve();
      const handler = withToken(async (request) => {
        const run = async () => {
          await mirror.before();
          const response = await routes[turn++ % routes.length]!(request);
          await mirror.after();
          return response;
        };
        const next = queue.then(run, run);
        queue = next.catch(() => {});
        return next;
      });
      const store = mirror.store;
      const collie: Opened = {
        epoch,
        workspace: (id, w) => store.workspace(id, w),
        starters: (list) => store.setStarters(list),
        history(provider) {
          store.history = provider;
          store.rev++;
        },
        ready() {
          store.ready = true;
          store.rev++;
        },
        close: async () => {},
      };
      return { collie, dial: { version: 1, handler } };
    },
  };
}
