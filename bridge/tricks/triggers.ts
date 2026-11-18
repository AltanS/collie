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
// `wait` (it is running or has a tap waiting), or `drop` (a gate is closed: this machine does not
// schedule, tricks are gated, the trick is stopped or backing off after a failure, or it has not had its
// start run). No phone has to be watching: an event or a file change runs with nobody there, which is the
// point (a Decision on the Hill while the person is away). Only the timer waits for a phone. A dropped
// request is never held. A request that waits goes into the trick's
// ONE slot per kind and is folded into by every later one (the newest is named, the counts add up). When
// the running one ends the runner takes the waiting request, behind any tap and any Hill answer, which is
// why a reaction can never starve either.
//
// THE FLOOR. Because no phone gates them, two runs of one trick that an event or a file change started
// are at least {@link REACT_FLOOR_MS} apart, counted from START to START. A request inside the floor is
// the trick's one waiting run (or folds into it), and a timer starts it when the floor ends. Taps, Hill
// answers and timer runs neither count toward the floor nor wait for it. The floor timer is cleared
// when the trick is switched off, when the runner stops or closes, and when nothing waits any more.
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
  /** The floor ended for a trick that has a waiting request: start it if the trick is idle (taps first). */
  due(id: string): void;
  /** The trick's file watch fell back to a poll (`why`: the system's error code, for the log), or null: it is cleared. */
  note(id: string, why: string | null): void;
  warn(line: string): void;
}

/** At least this long between the STARTS of two event or watch runs of one trick. */
export const REACT_FLOOR_MS = 10_000;

/** The one timer the floor needs. `set` answers a number that `clear` takes back. Default: `setTimeout`, unref'd. A test hands its own. */
export interface FloorTimers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

/** The default {@link FloorTimers}: `setTimeout`, unref'd, so a timer never holds the process open. */
export function systemTimers(): FloorTimers {
  const open = new Map<number, ReturnType<typeof setTimeout>>();
  let next = 1;
  return {
    set: (fn, ms) => {
      const handle = next;
      next += 1;
      const timer = setTimeout(() => {
        open.delete(handle);
        fn();
      }, ms);
      timer.unref?.();
      open.set(handle, timer);
      return handle;
    },
    clear: (handle) => {
      const timer = open.get(handle);
      if (timer !== undefined) clearTimeout(timer);
      open.delete(handle);
    },
  };
}

export interface ReactionOptions {
  bus?: EventBus;
  watch?: WatchOptions;
  /** The clock the floor is counted on. Default: `Date.now`. */
  now?: () => number;
  timers?: FloorTimers;
  floorMs?: number;
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
  /** Open watch timers and floor timers. */
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
  /** When an event or watch run of the trick last started, on the floor's clock. */
  private readonly lastStart = new Map<string, number>();
  private readonly floorTimers = new Map<string, number>();
  private readonly clock: FloorTimers;
  private sub: Subscription | null = null;
  private scheduled = false;
  private seq = 0;

  constructor(
    private readonly host: ReactionHost,
    private readonly opts: ReactionOptions = {},
  ) {
    this.clock = opts.timers ?? systemTimers();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** How long until the trick's floor ends, in ms; 0 when it has ended. */
  private floorLeft(id: string): number {
    const last = this.lastStart.get(id);
    if (last === undefined) return 0;
    return Math.max(0, (this.opts.floorMs ?? REACT_FLOOR_MS) - (this.now() - last));
  }

  /** Start the timer that ends the floor, if one is not set. */
  private armFloor(id: string, ms: number): void {
    if (this.floorTimers.has(id)) return;
    const handle = this.clock.set(() => {
      this.floorTimers.delete(id);
      this.floorEnded(id);
    }, Math.max(1, ms));
    this.floorTimers.set(id, handle);
  }

  private clearFloor(id: string): void {
    const handle = this.floorTimers.get(id);
    if (handle === undefined) return;
    this.clock.clear(handle);
    this.floorTimers.delete(id);
  }

  private floorEnded(id: string): void {
    try {
      if (this.hasWaiting(id)) this.host.due(id);
    } catch (err) {
      this.host.warn(`a trigger of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private hasWaiting(id: string): boolean {
    const slots = this.slots.get(id);
    return slots !== undefined && (slots.event !== undefined || slots.watch !== undefined);
  }

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
    // A trick that no longer reacts forgets its floor and its timer; one that still does keeps both.
    for (const id of this.floorTimers.keys()) if (!this.hasWaiting(id)) this.clearFloor(id);
    for (const id of this.lastStart.keys()) if (!byId.has(id)) this.lastStart.delete(id);
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
        (why) => {
          this.noted.add(target.id);
          this.host.note(target.id, why);
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

  /** One request to run: now, folded into the waiting one (a run, or the floor, is ahead), or dropped. Never throws. */
  private request(id: string, trigger: ReactTrigger): void {
    try {
      const verdict = this.host.admit(id);
      if (verdict === "drop") return;
      if (verdict === "now") {
        const left = this.floorLeft(id);
        // A request that already waits (it outlived a backoff: service.ts `pumpReaction` asks admit
        // before it takes) folds with this one into ONE run, which names the newest.
        if (left === 0 && this.hasWaiting(id)) {
          this.fold(id, trigger);
          const folded = this.takeWaiting(id);
          if (folded !== null) this.host.start(id, folded);
          return;
        }
        if (left === 0) {
          this.lastStart.set(id, this.now());
          this.host.start(id, trigger);
          return;
        }
        this.fold(id, trigger);
        this.armFloor(id, left);
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
   * counts of both added. Both slots are emptied. Taken when the running run ends, after taps, and when the
   * floor ends. Inside the floor it takes nothing: the request stays and the floor timer starts it.
   */
  takeWaiting(id: string): ReactTrigger | null {
    const slots = this.slots.get(id);
    if (slots === undefined) return null;
    const left = this.floorLeft(id);
    if (left > 0) {
      this.armFloor(id, left);
      return null;
    }
    this.slots.delete(id);
    const { event, watch } = slots;
    if (event === undefined && watch === undefined) return null;
    this.lastStart.set(id, this.now());
    this.clearFloor(id);
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
    if (!this.hasWaiting(id)) this.clearFloor(id);
  }

  /** What is open and what waits, for a test. */
  counts(): ReactionCounts {
    let handles = 0;
    let timers = this.floorTimers.size;
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
    this.lastStart.clear();
    for (const id of this.floorTimers.keys()) this.clearFloor(id);
    for (const id of this.noted) this.clearNote(id);
  }
}
