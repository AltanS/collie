// THE API'S WORLD (M105 spec 03, decision 15; security read 1, item 7). The ONE interface through which
// the local API's operations see the bridge: every getter `hello`, `events` and the five reads use, and
// nothing else. Reads only: no member types, answers an ask, presses a key, starts, stops or closes a
// session, changes a setting, answers a Hill card or marks one seen.
//
// WHY ONE TYPE. The claim "no operation can reach code that answers an ask" rests on two things, both held
// by ask-reach.test.ts:
//  (a) this narrow type, which bridge/index.ts builds an object of exactly (`satisfies ApiWorld`, then
//      {@link narrowWorld}, which copies exactly {@link API_WORLD_KEYS} and wraps the bus down to its two
//      reads, so not even a method the object carried at run time reaches an operation), and a key test
//      that the key list and the interface agree both ways;
//  (b) a behaviour test that runs every operation of the table against a world whose write methods, on the
//      world and on the objects it hands out, all throw, and asserts none was called.
// The import walk stays beside them: it holds that no module of bridge/api/ imports a writer.

import type { EventBus } from "../events/bus.ts";
import type { AccountsBody, AgentView, PaneAccount } from "../types.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import { buildTable, type OperationTable } from "./operations.ts";
import { buildReads, type PaneSource, type ScreenRead } from "./reads.ts";

/** Everything the operations see of the bridge. Each getter is read at the moment of a call. */
export interface ApiWorld {
  /** The Collie version, as the bridge reports it (bridge/version.ts), for `hello`. */
  version(): string;
  /** This bridge's stable id (bridge/bridge-id.ts). */
  machine(): string;
  /**
   * Every real pane of every multiplexer session of this bridge now, agents and shells, with no trick
   * session: the bridge passes them through `realAgentPanes` (bridge/tricks/panes.ts). Agent panes are
   * picked in reads.ts.
   */
  panes(): readonly PaneSource[];
  /** The instance token a pane holds now, or null. Must mint nothing (`WalkyInstances.peek`). */
  instanceOf(muxSession: string, paneId: string): string | null;
  /** The event bus, its two reads only: `events` pages and waits, `brief` finds the newest turn end. */
  readonly bus: Pick<EventBus, "since" | "waitFor">;
  /** The added account a pane runs under, from memory (`Accounts.paneAccount`). */
  paneAccount(muxSession: string, pane: AgentView): PaneAccount | undefined;
  /** The accounts of this machine, as `GET /api/accounts` has them; null when this machine offers none. */
  accountsBody(): Promise<Pick<AccountsBody, "accounts"> | null>;
  /** Whether the pane's box holds a draft, when a data link knows; null when none does. */
  draftState(muxSession: string, paneId: string): boolean | null;
  /** The screen of one pane, `lines` rows (`MuxAdapter.readGrid`, the phone's own read). */
  readScreen(muxSession: string, paneId: string, lines: number): Promise<ScreenRead>;
  /** The Hill's open decisions, or null when this bridge has no Hill. */
  hillOpen(): readonly HillDecision[] | null;
  /** The lines a `read` takes when the caller names none (`COLLIE_READ_LINES`). */
  readonly defaultLines: number;
}

/** The keys of {@link ApiWorld}, every one and no other (the two checks below fail the build otherwise). */
export const API_WORLD_KEYS = ["version", "machine", "panes", "instanceOf", "bus", "paneAccount", "accountsBody", "draftState", "readScreen", "hillOpen", "defaultLines"] as const;

type ListedKey = (typeof API_WORLD_KEYS)[number];
/** True only while every key of the interface is listed. */
export const EVERY_KEY_LISTED: [Exclude<keyof ApiWorld, ListedKey>] extends [never] ? true : never = true;
/** True only while every listed key is a key of the interface. */
export const NO_KEY_EXTRA: [Exclude<ListedKey, keyof ApiWorld>] extends [never] ? true : never = true;

/**
 * A world of exactly the interface's keys, each a wrapper over `world`'s: what the operations hold. A
 * method the passed object carried beyond the interface (a write on the bus, say) is not copied, and the
 * bus keeps only its two reads.
 */
export function narrowWorld(world: ApiWorld): ApiWorld {
  return {
    version: () => world.version(),
    machine: () => world.machine(),
    panes: () => world.panes(),
    instanceOf: (muxSession, paneId) => world.instanceOf(muxSession, paneId),
    bus: {
      since: (cursor) => world.bus.since(cursor),
      waitFor: (after, ms, signal) => world.bus.waitFor(after, ms, signal),
    },
    paneAccount: (muxSession, pane) => world.paneAccount(muxSession, pane),
    accountsBody: () => world.accountsBody(),
    draftState: (muxSession, paneId) => world.draftState(muxSession, paneId),
    readScreen: (muxSession, paneId, lines) => world.readScreen(muxSession, paneId, lines),
    hillOpen: () => world.hillOpen(),
    defaultLines: world.defaultLines,
  };
}

/** The operation table over one world: `hello`, `events` and the five reads. */
export function apiTable(world: ApiWorld): OperationTable {
  return buildTable({ version: () => world.version(), bus: world.bus, reads: buildReads(world) });
}
