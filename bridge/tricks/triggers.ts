import type { FactsTrigger, TrickEvent } from "../../web/src/lib/tricks/schema.ts";
import { TRIGGER_COUNT_MAX } from "../../web/src/lib/tricks/schema.ts";
import type { EventBus, LiveEvent, Subscription } from "../events/bus.ts";
import { decodeSessionId } from "../events/session-id.ts";
import { TrickWatch, type WatchOptions } from "./watch.ts";

// THE REACTING TRIGGERS OF THE TRICK RUNNER (M105 spec 03, decisions 9 to 11). A trick that lists `on` runs
// when an event of the bus reaches it, and a trick that lists `watch` runs when one of its files changes
// (bridge/tricks/watch.ts). This file is the one listener of the bus for the whole runner and the place
// where a request to run is folded, so service.ts holds only the gates and the run itself.
//
// THE BUS SEAM. This file imports the bus and nothing from the API (bridge/events/seam.test.ts holds it).
// The trigger a program gets is its own wire, built here from a bus event, and has its own contract test
// (triggers.test.ts): `{ kind: "event", event, session, count }`, with `session` the facts scope id
// (`<memberId>:<paneId>`, as `facts.sessions[].id`) decoded from the event's opaque id.
//
// ONE SUBSCRIPTION, DRAINED OUTSIDE PUBLISH. The runner holds ONE subscription while some trick lists `on`
// (none otherwise) and drains it with `take()` in a microtask, never inside `publish`. Events that arrive in
// the same turn are one batch: for each trick, the matching ones fold into ONE request that names the
// NEWEST event, with `count` the number folded. The bus's `dropped` count (events its bounded queue lost,
// types unknown) is added to the count of every trick that lists `on`: held back for a trick with no
// matching event in the batch, and added to its next request. It is noted once in the log per drain.
//
// ADMIT, WAIT, DROP. For each request the runner (the host) says: `now` (the trick is idle and may run),
// `wait` (it is running or has a tap waiting), or `drop` (a gate is closed: nobody is watching, this
// machine does not schedule, tricks are gated, the trick is stopped or backing off after a failure, or it
// has not had its start run). A dropped request is never held. A request that waits goes into the trick's
// ONE slot per kind and is folded into by every later one (the newest is named, the counts add up). When
// the running one ends the runner takes the waiting request, behind any tap and any Hill answer, which is
// why a reaction can never starve either.
//
// AT LEAST ONCE, NO ORDER ACROSS SESSIONS (bus decision 6): written into docs/tricks-reference.md; a
// program must be safe against a repeated event.

/** The trigger a bus event or a watched file makes. */
export type ReactTrigger = Extract<FactsTrigger, { kind: "event" | "watch" }>;
type EventTrigger = Extract<ReactTrigger, { kind: "event" }>;
type WatchTrigger = Extract<ReactTrigger, { kind: "watch" }>;

/** What the runner asks for a trick, as the manifest of the version that runs says it. */
export interface ReactionTarget {
  id: string;
  /** Changes when the trick's approved version or config changes: the watch is set up again. */
  key: string;
  /** The manifest's `on`. */
  events: readonly TrickEvent[];
  /** The manifest's `watch`, as written. */
  watch: readonly string[];
}

/** Whether a request may run now, must wait for the running one, or is dropped. */
export type Admit = "now" | "wait" | "drop";

/** The runner, as this file needs it. */
export interface ReactionHost {
  admit(id: string): Admit;
  /** Start a run for the trigger. Only after `admit` said `now`. */
  start(id: string, trigger: ReactTrigger): void;
  /** The one-line note for the trick's row, or null to clear it. */
  note(id: string, note: string | null): void;
  warn(line: string): void;
}

export interface ReactionOptions {
  bus?: EventBus;
  watch?: WatchOptions;
}

interface Slots {
  event?: { trigger: EventTrigger; seq: number };
  watch?: { trigger: WatchTrigger; seq: number };
}

/** What a test reads: what is open and what waits. */
export interface ReactionCounts {
  subscribed: boolean;
  watchers: number;
  handles: number;
  timers: number;
  waiting: number;
}

function clampCount(count: number): number {
  return Math.min(Math.max(1, count), TRIGGER_COUNT_MAX);
}

/** The facts scope id of a bus event's session, or null for an id this codec does not read. */
function scopeOf(session: string): string | null {
  const parts = decodeSessionId(session);
  return parts === null ? null : `${parts.machine}:${parts.paneId}`;
}

export class TrickReactions {
  private readonly interests = new Map<string, ReadonlySet<TrickEvent>>();
  private readonly watches = new Map<string, { key: string; watch: TrickWatch }>();
  private readonly slots = new Map<string, Slots>();
  private readonly lost = new Map<string, number>();
  private readonly noted = new Set<string>();
  private sub: Subscription | null = null;
  private scheduled = false;
  private seq = 0;

  constructor(
    private readonly host: ReactionHost,
    private readonly opts: ReactionOptions = {},
  ) {}

  /**
   * Make the interests, the bus subscription and the watches the ones these tricks need: the tricks that are
   * on, runnable, and list `on` or `watch`. Everything of a trick not listed is closed, and a request of
   * its that waits is dropped. Called after every scan and every run; cheap when nothing moved.
   */
  sync(targets: readonly ReactionTarget[]): void {
    const byId = new Map(targets.map((target) => [target.id, target]));
    this.syncEvents(byId);
    this.syncWatches(byId);
    for (const id of this.slots.keys()) {
      const target = byId.get(id);
      const slots = this.slots.get(id);
      if (target === undefined || slots === undefined) {
        this.slots.delete(id);
        continue;
      }
      if (target.events.length === 0) delete slots.event;
      if (target.watch.length === 0) delete slots.watch;
    }
    for (const id of this.lost.keys()) if (!this.interests.has(id)) this.lost.delete(id);
  }

  private syncEvents(byId: ReadonlyMap<string, ReactionTarget>): void {
    this.interests.clear();
    for (const target of byId.values()) if (target.events.length > 0) this.interests.set(target.id, new Set(target.events));
    const bus = this.opts.bus;
    if (bus === undefined) return;
    if (this.interests.size > 0 && this.sub === null) this.sub = bus.subscribe({ onReady: () => this.schedule() });
    if (this.interests.size === 0 && this.sub !== null) {
      this.sub.unsubscribe();
      this.sub = null;
    }
  }

  private syncWatches(byId: ReadonlyMap<string, ReactionTarget>): void {
    for (const [id, held] of this.watches) {
      const target = byId.get(id);
      if (target !== undefined && target.watch.length > 0 && target.key === held.key) continue;
      held.watch.close();
      this.watches.delete(id);
      this.clearNote(id);
    }
    for (const target of byId.values()) {
      if (target.watch.length === 0 || this.watches.has(target.id)) continue;
      const watch = new TrickWatch(
        target.watch,
        (fire) => this.request(target.id, { kind: "watch", path: fire.path, count: clampCount(fire.count) }),
        (note) => {
          this.noted.add(target.id);
          this.host.note(target.id, note);
        },
        this.opts.watch,
      );
      this.watches.set(target.id, { key: target.key, watch });
      watch.start();
    }
  }

  private clearNote(id: string): void {
    if (!this.noted.delete(id)) return;
    this.host.note(id, null);
  }

  /** The bus has something: drain it after the publisher's turn, never inside `publish`. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    const sub = this.sub;
    if (sub === null) return;
    const batch = sub.take();
    if (batch.dropped > 0) {
      this.host.warn(`the event bus dropped ${String(batch.dropped)} event(s) for the trick runner; every trick that reacts to events counts them`);
      for (const id of this.interests.keys()) this.lost.set(id, (this.lost.get(id) ?? 0) + batch.dropped);
    }
    for (const [id, wanted] of this.interests) {
      const matching = batch.events.filter((event) => wanted.has(event.type));
      const newest = matching.at(-1);
      if (newest === undefined) continue;
      this.requestEvent(id, newest, matching.length);
    }
  }

  private requestEvent(id: string, newest: LiveEvent, matched: number): void {
    const session = scopeOf(newest.session);
    if (session === null) return;
    const carried = this.lost.get(id) ?? 0;
    this.lost.delete(id);
    this.request(id, { kind: "event", event: newest.type, session, count: clampCount(matched + carried) });
  }

  /** One request to run: now, folded into the waiting one, or dropped. Never throws. */
  private request(id: string, trigger: ReactTrigger): void {
    try {
      const verdict = this.host.admit(id);
      if (verdict === "drop") return;
      if (verdict === "now") {
        this.host.start(id, trigger);
        return;
      }
      this.fold(id, trigger);
    } catch (err) {
      this.host.warn(`a trigger of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Put the request in the trick's one slot of its kind: the newest is named, the counts add up. */
  private fold(id: string, trigger: ReactTrigger): void {
    const slots = this.slots.get(id) ?? {};
    this.slots.set(id, slots);
    this.seq += 1;
    if (trigger.kind === "event") {
      slots.event = { trigger: { ...trigger, count: clampCount(trigger.count + (slots.event?.trigger.count ?? 0)) }, seq: this.seq };
      return;
    }
    slots.watch = { trigger: { ...trigger, count: clampCount(trigger.count + (slots.watch?.trigger.count ?? 0)) }, seq: this.seq };
  }

  /**
   * The ONE waiting run of a trick, or null: the newest request of either kind, naming its own trigger, the
   * counts of both added. Both slots are emptied. Taken when the running run ends, after taps.
   */
  takeWaiting(id: string): ReactTrigger | null {
    const slots = this.slots.get(id);
    if (slots === undefined) return null;
    this.slots.delete(id);
    const { event, watch } = slots;
    if (event === undefined && watch === undefined) return null;
    if (event !== undefined && (watch === undefined || event.seq > watch.seq)) return { ...event.trigger, count: clampCount(event.trigger.count + (watch?.trigger.count ?? 0)) };
    if (watch === undefined) return null;
    return { ...watch.trigger, count: clampCount(watch.trigger.count + (event?.trigger.count ?? 0)) };
  }

  /**
   * A run of the trick ended (any trigger): the files it watches are recorded as they are now, so what the run
   * wrote is absorbed, and a waiting file request is dropped with them. An event request keeps waiting.
   */
  ended(id: string): void {
    this.watches.get(id)?.watch.recordOwn();
    const slots = this.slots.get(id);
    if (slots !== undefined) delete slots.watch;
  }

  /** What is open and what waits, for a test. */
  counts(): ReactionCounts {
    let handles = 0;
    let timers = 0;
    for (const held of this.watches.values()) {
      const open = held.watch.open();
      handles += open.handles;
      timers += open.timers;
    }
    let waiting = 0;
    for (const slots of this.slots.values()) waiting += (slots.event === undefined ? 0 : 1) + (slots.watch === undefined ? 0 : 1);
    return { subscribed: this.sub !== null, watchers: this.watches.size, handles, timers, waiting };
  }

  /** Close every watch, the subscription and every waiting request. A later `sync` opens what is needed again. */
  close(): void {
    for (const held of this.watches.values()) held.watch.close();
    this.watches.clear();
    this.sub?.unsubscribe();
    this.sub = null;
    this.interests.clear();
    this.slots.clear();
    this.lost.clear();
    for (const id of this.noted) this.clearNote(id);
  }
}
