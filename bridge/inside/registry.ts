// The part registry of the inside wire (M99 spec 01): which part sits in which pane, and what it can do.
//
// BINDING COMES FROM INSIDE THE PANE (M99 README, decision 3). A part's `hello` names its pid and the raw
// marker variables of its own environment; the caller places that on exactly one pane with the edge
// placement (`bridge/surface/edges.ts` placeEdge: one pane matches a marker, the pid is alive with the
// same start time, and the pane's foreground holds the pid where the multiplexer reports one). The
// registry stores the result. It never guesses a pane.
//
// ONE PART PER PANE. A newer hello for a pane replaces the older part: it passed the placement, so it is
// the pane's foreground process now (a reload of the same program, or a new program after the old one
// quit). The older part id is dead from then on, and its requests answer 410.
//
// CAPABILITIES FAIL CLOSED (decision 4). Only the words the part declared, and only while the part polls.
// A part that has not been seen for PART_IDLE_MS is dropped with its capabilities: the screen path is
// back for its pane.
//
// NOTHING ABOVE THE REGISTRY LEARNS THE HARNESS'S NAME. The name is kept for the log line and nothing
// else; {@link PartView}, what every caller reads, has no harness field.

import { randomBytes } from "node:crypto";

import type { PaneAddress } from "./queue.ts";
import { NEXT_WAIT_MS, type AskKind, type Capability, type Hello } from "./wire.ts";

/** A part that sent nothing for this long is gone. Two long polls and a margin. */
export const PART_IDLE_MS = 2 * NEXT_WAIT_MS + 10_000;
/** The most parts one bridge keeps. A machine runs a handful of agent sessions per bridge, never this many. */
export const PARTS_MAX = 256;

/** What a caller may read of a bound part. No harness name. */
export interface PartView {
  readonly partId: string;
  readonly address: PaneAddress;
  readonly capabilities: ReadonlySet<Capability>;
  readonly asks: ReadonlySet<AskKind>;
  readonly boundAt: number;
  /** The agent program's pid and start time, as the placement checked them. */
  readonly pid: number;
  readonly pidStartTime: number | null;
}

/** A bound part, as the registry keeps it. */
interface Bound extends PartView {
  readonly harness: string;
  readonly harnessVersion: string | null;
  readonly partVersion: string | null;
  seenAt: number;
  /** Open long polls: a part with one open is alive whatever its last request time says. */
  polls: number;
}

/** A change to the registry, for the hub's listeners. */
export type RegistryChange =
  | { readonly kind: "bound"; readonly part: PartView; readonly replaced: PartView | null }
  | { readonly kind: "gone"; readonly part: PartView; readonly reason: "bye" | "idle" | "replaced" | "full" };

export interface PartRegistryOptions {
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** A new part id. Defaults to 128 random bits, url-safe. */
  readonly mintId?: () => string;
}

const keyOf = (address: PaneAddress): string => `${address.session}\u0000${address.paneId}`;

/** A short form of a part id for a log line: enough to follow one part, never the whole id. */
const short = (partId: string): string => partId.slice(0, 6);

const view = (bound: Bound): PartView => ({
  partId: bound.partId,
  address: bound.address,
  capabilities: bound.capabilities,
  asks: bound.asks,
  boundAt: bound.boundAt,
  pid: bound.pid,
  pidStartTime: bound.pidStartTime,
});

export class PartRegistry {
  private readonly byId = new Map<string, Bound>();
  private readonly byPane = new Map<string, string>();
  private readonly listeners: ((change: RegistryChange) => void)[] = [];
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly mintId: () => string;

  constructor(options: PartRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.mintId = options.mintId ?? (() => randomBytes(16).toString("base64url"));
  }

  onChange(listener: (change: RegistryChange) => void): void {
    this.listeners.push(listener);
  }

  /** Bind a placed hello to its pane. `pidStartTime` is the one the placement checked. */
  bind(hello: Hello, address: PaneAddress, pidStartTime: number | null): PartView {
    const at = this.now();
    const oldId = this.byPane.get(keyOf(address));
    const old = oldId === undefined ? undefined : this.byId.get(oldId);
    if (old !== undefined) this.remove(old, "replaced");
    if (this.byId.size >= PARTS_MAX) {
      const oldest = Array.from(this.byId.values()).toSorted((a, b) => a.seenAt - b.seenAt)[0];
      if (oldest !== undefined) this.remove(oldest, "full");
    }
    const bound: Bound = {
      partId: this.mintId(),
      address,
      capabilities: new Set(hello.capabilities),
      asks: new Set(hello.asks),
      boundAt: at,
      harness: hello.harness,
      harnessVersion: hello.harnessVersion,
      partVersion: hello.partVersion,
      pid: hello.pid,
      pidStartTime,
      seenAt: at,
      polls: 0,
    };
    this.byId.set(bound.partId, bound);
    this.byPane.set(keyOf(address), bound.partId);
    const caps = [...bound.capabilities, ...[...bound.asks].map((kind) => `asks:${kind}`)].join(",") || "-";
    this.log(
      `[inside] bound part=${short(bound.partId)} session=${address.session} pane=${address.paneId} harness=${bound.harness} ` +
        `version=${bound.harnessVersion ?? "-"} part-version=${bound.partVersion ?? "-"} pid=${String(bound.pid)} caps=${caps}`,
    );
    // The same pid claiming its pane again is a reload, or another process of this user naming that
    // pid: the socket cannot tell them apart (no peer credentials), so each such replacement is logged.
    if (old !== undefined && old.pid === bound.pid && old.pidStartTime === bound.pidStartTime) {
      this.log(`[inside] replaced by the same pid part=${short(old.partId)} new=${short(bound.partId)} pane=${address.paneId} pid=${String(bound.pid)}`);
    }
    const part = view(bound);
    this.emit({ kind: "bound", part, replaced: old === undefined ? null : view(old) });
    return part;
  }

  /** The part behind an id, marked seen now. Null for an id that is not bound (never, or no more). */
  touch(partId: string): PartView | null {
    const bound = this.byId.get(partId);
    if (bound === undefined) return null;
    bound.seenAt = this.now();
    return view(bound);
  }

  /** A long poll of the part opens; `pollEnded` must follow. Keeps the part alive while it waits. */
  pollStarted(partId: string): void {
    const bound = this.byId.get(partId);
    if (bound === undefined) return;
    bound.polls += 1;
    bound.seenAt = this.now();
  }

  pollEnded(partId: string): void {
    const bound = this.byId.get(partId);
    if (bound === undefined) return;
    bound.polls = Math.max(0, bound.polls - 1);
    bound.seenAt = this.now();
  }

  /** The part bound to a pane, or null: the screen path holds for that pane. */
  partOf(address: PaneAddress): PartView | null {
    const id = this.byPane.get(keyOf(address));
    const bound = id === undefined ? undefined : this.byId.get(id);
    return bound === undefined ? null : view(bound);
  }

  /** The part behind an id, without marking it seen. */
  get(partId: string): PartView | null {
    const bound = this.byId.get(partId);
    return bound === undefined ? null : view(bound);
  }

  /** The part said bye. */
  drop(partId: string): boolean {
    const bound = this.byId.get(partId);
    if (bound === undefined) return false;
    this.remove(bound, "bye");
    return true;
  }

  /** Drop every part that has not been seen for PART_IDLE_MS and has no poll open. Returns them. */
  sweep(): PartView[] {
    const now = this.now();
    const gone: PartView[] = [];
    for (const bound of Array.from(this.byId.values())) {
      if (bound.polls > 0 || now - bound.seenAt < PART_IDLE_MS) continue;
      gone.push(view(bound));
      this.remove(bound, "idle");
    }
    return gone;
  }

  /** Every bound part. */
  all(): PartView[] {
    return Array.from(this.byId.values()).map(view);
  }

  private remove(bound: Bound, reason: "bye" | "idle" | "replaced" | "full"): void {
    this.byId.delete(bound.partId);
    if (this.byPane.get(keyOf(bound.address)) === bound.partId) this.byPane.delete(keyOf(bound.address));
    this.log(`[inside] gone part=${short(bound.partId)} session=${bound.address.session} pane=${bound.address.paneId} reason=${reason}`);
    this.emit({ kind: "gone", part: view(bound), reason });
  }

  private emit(change: RegistryChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A listener's fault is its own.
      }
    }
  }
}
