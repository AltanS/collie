// The invariant a host with no process of its own stands on (M66 spec 02): the state it serves is a function of the
// facts it keeps. This file runs the whole protocol suite against the memory store, and after EVERY request it builds a
// second store from nothing but the first one's facts (layout, items, and a journal of its asks and their outcomes) through
// the seams, and requires the two to say the same thing: the same snapshot, the same reset view of every pane, the same
// first outcome for every decided ask.
//
// What the second store is given: the epoch, a rev that reads the first store's (a host derives its rev from its log, so
// here it is the same number by construction), each pane's fixed turn id and `lastActiveAt` (a host reads that from its
// log), the items, and the journal records `foldJournal` turns into `seedAsk` and `seedDecided`. Nothing else crosses.
//
// The journal is written the way the host would write it: an `ask` record the first time an ask is seen open (its latest
// text, since a journal host never changes an ask in place), and an `answer` or `expire` record when it is seen closed,
// from the outcome the memory store recorded. An ask id raised again after it was decided is a case the journal cannot
// say (the first terminal record wins), so the mirror forgets the old decision, as the memory pane's open ask does.
import { afterAll, describe, expect, test } from "bun:test";
import {
  ALL_CAPS,
  type Ask,
  type AskSink,
  type Caps,
  type CoreOptions,
  type CoreState,
  foldJournal,
  handle,
  type JournalAsk,
  type JournalRecord,
  type ProgramHooks,
  type RenameTarget,
  Store,
} from "../../../packages/durable-sdk/src/core/index.ts";
import type { Pane } from "../../../packages/durable-sdk/src/core/layout.ts";
import { protocolSuite } from "./protocol-suite.ts";

/** An ask the second store may never answer: every answer in the suite goes to the first store. */
const noSink: AskSink = {
  answer: () => {
    throw new Error("the seeded store is read, not answered");
  },
};

/** What the mirror knows of one pane: the asks seen open, the latest text of each, and the terminal record of each decided one. */
interface Mirror {
  order: string[];
  latest: Map<string, Ask>;
  openedAt: Map<string, string>;
  terminals: Map<string, JournalRecord>;
}

const NO_CAPS: Required<Omit<Caps, "terminal">> = {
  asks: false,
  starters: false,
  send: false,
  steer: false,
  abort: false,
  rename: false,
  close: false,
  actions: false,
  history: false,
  reopen: false,
};

class Rig {
  readonly store: Store;
  readonly state: CoreState;
  private readonly mirrors = new WeakMap<Pane, Mirror>();
  checks = 0;
  readonly divergences: string[] = [];

  constructor(hostName: string, caps: Caps | undefined, given: ProgramHooks, onRename: CoreOptions["onRename"]) {
    // createCore's alias rule: the old `onRename` fills the hook only when the hooks do not set it.
    const hooks: ProgramHooks = { ...(onRename ? { onRename: (target: RenameTarget) => onRename(target) } : {}), ...given };
    this.store = new Store();
    this.store.hooks = hooks;
    this.state = {
      store: this.store,
      hostName,
      caps: caps === undefined ? { ...ALL_CAPS, history: false, terminal: false } : { ...NO_CAPS, ...caps, terminal: false },
      hooks,
      warn: () => {},
    };
  }

  /** Watch a pane: which asks opened, which closed and how. Called after every request, so it sees every transition the suite makes. */
  private watch(pane: Pane): Mirror {
    const mirror: Mirror = this.mirrors.get(pane) ?? { order: [], latest: new Map(), openedAt: new Map(), terminals: new Map() };
    this.mirrors.set(pane, mirror);
    const open = new Set<string>();
    for (const ask of pane.openAsks) {
      open.add(ask.id);
      if (mirror.terminals.has(ask.id)) mirror.terminals.delete(ask.id); // raised again: the new ask replaces the old decision
      if (!mirror.latest.has(ask.id)) {
        mirror.order.push(ask.id);
        mirror.openedAt.set(ask.id, new Date().toISOString());
      }
      mirror.latest.set(ask.id, structuredClone(ask));
    }
    for (const id of mirror.order) {
      if (open.has(id) || mirror.terminals.has(id)) continue;
      const outcome = pane.outcomeOf(id);
      if (outcome === undefined) continue; // closed before it was ever seen, and forgotten: nothing to write
      const ask = mirror.latest.get(id)!;
      mirror.terminals.set(
        id,
        outcome.decidedBy === "phone"
          ? { t: "answer", askId: id, revision: ask.revision, answer: outcome.optionId === undefined ? { text: "x" } : { optionId: outcome.optionId }, requestId: `req-${id}`, nonce: `n-${id}`, at: outcome.decidedAt }
          : { t: "expire", askId: id, at: outcome.decidedAt, decidedBy: outcome.decidedBy },
      );
    }
    return mirror;
  }

  private journalOf(mirror: Mirror): JournalRecord[] {
    const records: JournalRecord[] = [];
    for (const id of mirror.order) {
      const ask = mirror.latest.get(id)!;
      const record: JournalAsk = { t: "ask", askId: id, toolCallId: ask.toolCallId, argsHash: "h", ask, openedAt: mirror.openedAt.get(id)! };
      if (ask.expiresAt !== undefined) record.expiresAt = ask.expiresAt;
      records.push(record);
    }
    // The terminal records follow in the order the mirror saw them close, which is the order the Map keeps.
    for (const t of mirror.terminals.values()) records.push(t);
    return records;
  }

  /** A second store from the first one's facts, through the seams. */
  private rebuild(): Store {
    const live = this.store;
    const fresh = new Store(live.tailLimit, undefined, live.allowAlways, { epoch: live.epoch, rev: () => live.rev });
    fresh.hooks = live.hooks;
    fresh.history = live.history;
    fresh.ready = live.ready;
    const workspaces = new Map<string, ReturnType<Store["workspace"]>>();
    for (const ws of live.workspaces.values()) workspaces.set(ws.id, fresh.workspace(ws.id, ws.cwd === undefined ? { title: ws.title } : { title: ws.title, cwd: ws.cwd }));
    const tabs = new Map<string, ReturnType<ReturnType<Store["workspace"]>["tab"]>>();
    for (const tab of live.tabs.values()) tabs.set(tab.id, workspaces.get(tab.workspaceId)!.tab(tab.id.slice(tab.workspaceId.length + 1), { title: tab.title }));
    for (const pane of live.panes.values()) {
      const mirror = this.watch(pane);
      const info = pane.info();
      const made = tabs.get(pane.tabId)!.pane(pane.id, {
        title: pane.title,
        harness: pane.harness,
        ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }),
        sessionId: pane.sessionId,
        turnId: pane.turnId,
      }) as Pane;
      made.state(pane.base);
      made.actions(info.actions ?? null);
      made.subtitle(info.subtitle ?? null);
      made.badge(info.badge ?? null);
      made.progress(info.progress ?? null);
      for (const event of pane.eventsAfter(0, true).events) if (event.type === "item") made.event(event);
      const folded = foldJournal(this.journalOf(mirror));
      made.seedDecided(folded.decided);
      for (const record of folded.open) made.seedAsk(record, noSink);
      made.lastActiveAt = pane.lastActiveAt;
    }
    fresh.setStarters([...live.starters.values()]);
    return fresh;
  }

  /** Compare the two stores. A request can expire an ask between the two reads, so the first store is read twice and must hold still. */
  check(what: string) {
    this.checks++;
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = JSON.stringify(this.store.snapshot());
      const fresh = this.rebuild();
      const seeded = fresh.snapshot();
      const after = this.store.snapshot();
      if (JSON.stringify(after) !== before) continue;
      try {
        expect(seeded).toEqual(after);
        for (const pane of this.store.panes.values()) {
          const twin = fresh.panes.get(pane.id)!;
          expect(twin.eventsAfter(0, true).events).toEqual(pane.eventsAfter(0, true).events);
          for (const id of this.watch(pane).terminals.keys()) expect([pane.id, id, twin.outcomeOf(id)]).toEqual([pane.id, id, pane.outcomeOf(id)]);
        }
      } catch (e) {
        if (this.divergences.length < 5) this.divergences.push(`after ${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
  }
}

const rigs: Rig[] = [];

afterAll(() => {
  rigs.length = 0;
});

protocolSuite({
  name: "the memory store, checked against a store seeded from its facts after every request",
  async open({ hostName, caps, hooks, onRename }) {
    const rig = new Rig(hostName, caps, hooks ?? {}, onRename);
    rigs.push(rig);
    const { store, state } = rig;
    return {
      collie: {
        epoch: store.epoch,
        workspace: (id, w) => store.workspace(id, w),
        starters: (list) => store.setStarters(list),
        history(provider) {
          store.history = provider;
          state.caps.history = caps === undefined || caps.history === true;
          store.rev++;
        },
        ready() {
          store.ready = true;
          store.rev++;
        },
        close: async () => {},
      },
      dial: {
        version: 1,
        handler: async (request) => {
          const response = await handle(request, state);
          rig.check(`${request.method} ${new URL(request.url).pathname}`);
          return response;
        },
      },
    };
  },
});

describe("the invariant", () => {
  test("it was checked after many requests, and the two stores never said different things", () => {
    const checks = rigs.reduce((n, r) => n + r.checks, 0);
    expect(checks).toBeGreaterThan(300);
    expect(rigs.flatMap((r) => r.divergences)).toEqual([]);
  });
});
