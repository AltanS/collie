// THE API'S WORLD (M105 spec 03, decision 15; security read 1, item 7). The ONE interface through which
// the local API's operations see the bridge: every getter `hello`, `events` and the six reads use, and
// nothing else. Reads only: no member types, answers an ask, presses a key, starts, stops or closes a
// session, changes a setting, answers a Hill card or marks one seen.
//
// WHY ONE TYPE. The claim "no operation can reach code that answers an ask" rests on two things, both held
// by ask-reach.test.ts:
//  (a) this narrow type, which {@link buildApiWorld} builds an object of exactly (`satisfies ApiWorld`,
//      then {@link narrowWorld}, which copies exactly {@link API_WORLD_KEYS} and wraps the bus down to its
//      two reads, so not even a method the object carried at run time reaches an operation), and a key
//      test that the key list and the interface agree both ways. bridge/index.ts passes the real services
//      to that builder by narrow types (security read 2, item 5), so a test runs the very same literal
//      against a real HillService and a real WalkyInstances;
//  (b) a behaviour test that runs every operation of the table against a world whose write methods, on the
//      world and on the objects it hands out, all throw, and asserts none was called.
// The walk over the imports stays beside them: it holds that no module of bridge/api/ imports a writer.

import type { Accounts } from "../accounts-routes.ts";
import type { EventBus } from "../events/bus.ts";
import type { HillService } from "../hill/service.ts";
import type { InsideHub } from "../inside/hub.ts";
import type { MachineWatch } from "../machines.ts";
import type { AccountsBody, AgentView, CrewStatusResponse, MachineRow, PaneAccount } from "../types.ts";
import type { WalkyInstances } from "../walky/instances.ts";
import type { HillDecision } from "../../web/src/lib/hill/wire.ts";
import { buildTable, type OperationTable } from "./operations.ts";
import { buildReads, type MachineSource, type PaneSource, type ScreenRead } from "./reads.ts";

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
  /**
   * The machines as the phone's Machines page knows them, from memory: each row of `GET /api/machines`
   * with the crew overview's row of the same machine (`GET /api/crew`) on a lead. No call to a member.
   */
  machines(): readonly MachineSource[];
  /** The lines a `read` takes when the caller names none (`COLLIE_READ_LINES`). */
  readonly defaultLines: number;
}

/** The keys of {@link ApiWorld}, every one and no other (the two checks below fail the build otherwise). */
export const API_WORLD_KEYS = ["version", "machine", "panes", "instanceOf", "bus", "paneAccount", "accountsBody", "draftState", "readScreen", "hillOpen", "machines", "defaultLines"] as const;

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
    machines: () => world.machines(),
    defaultLines: world.defaultLines,
  };
}

/** The operation table over one world: `hello`, `events` and the six reads. */
export function apiTable(world: ApiWorld): OperationTable {
  return buildTable({ version: () => world.version(), bus: world.bus, reads: buildReads(world) });
}

/**
 * The machines of {@link ApiWorld.machines}: each row of the watch joined with the crew overview's row of
 * the same id. A bridge with no watch (a crew peer) answers its own row alone.
 */
export function machineSourcesOf(rows: readonly MachineRow[], crew: CrewStatusResponse | null): MachineSource[] {
  const members = crew?.members ?? [];
  return rows.map((row) => ({ row, member: members.find((member) => member.id === row.id) }));
}

/**
 * The real services the world reads, each by the narrowest type its getter needs (security read 2, item
 * 5). Type-only imports: the walk over the imports (ask-reach.test.ts) does not follow them, so naming a
 * writer's class here puts none of its code on an operation's path. The object passed may carry every write it has;
 * {@link buildApiWorld} calls the members named here and nothing else.
 */
export interface ApiWorldDeps {
  /** The Collie version (bridge/version.ts). */
  readonly version: () => string;
  /** This bridge's stable id (bridge/bridge-id.ts). */
  readonly machine: () => string;
  /** Every real pane of every multiplexer session now, trick sessions left out (`realAgentPanes`, bridge/tricks/panes.ts). */
  readonly panes: () => readonly PaneSource[];
  /** The instance tokens: peeked, never minted. */
  readonly instances: Pick<WalkyInstances, "peek">;
  /** The event bus: its two reads. */
  readonly bus: Pick<EventBus, "since" | "waitFor">;
  /** The accounts: a pane's added account, and the machine's list (only its `accounts` is read). */
  readonly accounts: Pick<Accounts, "paneAccount"> & { body(): Promise<Pick<AccountsBody, "accounts"> | null> };
  /** The inside hub, when this bridge has one: a pane's draft word. */
  readonly inside: Pick<InsideHub, "draftOf"> | null;
  /** One pane's screen (the phone's own read, built in bridge/index.ts over the multiplexer). */
  readonly readScreen: ApiWorld["readScreen"];
  /** The Hill: its list. */
  readonly hill: Pick<HillService, "list">;
  /** The machine watch of a lead or a solo bridge: its quiet read, which moves no sample rate. Null on a crew peer. */
  readonly machineWatch: Pick<MachineWatch, "census"> | null;
  /** `GET /api/crew`'s body from memory, on a lead; null elsewhere. Dials nobody. */
  readonly crewStatus: () => CrewStatusResponse | null;
  /** This machine's own row, for a bridge with no watch: its id, its name and its last sample. */
  readonly selfMachine: () => MachineRow;
  /** `COLLIE_READ_LINES`. */
  readonly defaultLines: number;
}

/** The API's world over the real services: the one literal, narrowed. bridge/index.ts builds the table from it. */
export function buildApiWorld(deps: ApiWorldDeps): ApiWorld {
  return narrowWorld({
    version: () => deps.version(),
    machine: () => deps.machine(),
    // The one filter for real panes (review row 30) is applied by the caller: no trick session reaches an operation.
    panes: () => deps.panes(),
    // Peek, never mint: a pane with no token is left out of `sessions`.
    instanceOf: (muxSession, paneId) => deps.instances.peek(muxSession, paneId),
    bus: { since: (cursor) => deps.bus.since(cursor), waitFor: (after, ms, signal) => deps.bus.waitFor(after, ms, signal) },
    paneAccount: (muxSession, pane) => deps.accounts.paneAccount(muxSession, pane),
    accountsBody: () => deps.accounts.body(),
    draftState: (muxSession, paneId) => deps.inside?.draftOf({ session: muxSession, paneId }) ?? null,
    readScreen: (muxSession, paneId, lines) => deps.readScreen(muxSession, paneId, lines),
    // The Hill's list: an agent card's sender label is NOT read from it (reads.ts builds it with `labelOf`
    // from the pane), so its `named()` rename never reaches an answer.
    hillOpen: () => deps.hill.list().open,
    machines: () => machineSourcesOf(deps.machineWatch?.census().machines ?? [deps.selfMachine()], deps.crewStatus()),
    defaultLines: deps.defaultLines,
  } satisfies ApiWorld);
}
