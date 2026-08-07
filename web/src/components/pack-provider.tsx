import { createContext, useContext, useMemo, type ReactNode } from "react";

import { ambientHost, hostName, isMultiHost, leadHost } from "@/lib/hosts";
import {
  departedHealth,
  healthFor,
  hostHealthMap,
  writeRefusal,
  type HostHealth,
} from "@/lib/host-health";
import type { ServerSummary } from "@/lib/types";

// Who is in the pack, made available to every write surface without threading `servers` through
// four layers of props.
//
// ── WHY A CONTEXT AND NOT A PROP ─────────────────────────────────────────────
// The hide rule ("no host chrome unless the snapshot lists more than one machine") has to live in
// ONE place, or the day a new sheet forgets it is the day a solo install grows a stray chip — and
// the day a pack install drops one is worse. `HostChip` owns the rule, which means `HostChip` needs
// the roster wherever it is mounted: inside the composer, inside a bottom sheet portalled to
// document.body, inside a long-press action list. A prop chain reaching all of those is a prop chain
// someone will break.
//
// ── WHY NOT `useRouteLoaderData(ROOT_ROUTE_ID)` ──────────────────────────────
// The roster IS on the root loader's data, so reading it there is tempting and would need no
// provider. But half the components that render a chip are unit-tested WITHOUT a router (the action
// sheets mount bare), and that hook throws outside a RouterProvider. A context with an empty default
// degrades the other way: no provider ⇒ no pack ⇒ no chrome, which is exactly the solo answer.

interface PackValue {
  servers: ServerSummary[];
  /** More than one machine — the single condition under which any host chrome renders. */
  multi: boolean;
  /** The machine the phone is connected to; undefined when there is no pack. */
  lead: string | undefined;
  /**
   * TIER 2 (lead↔peer) health per member id — see lib/host-health.ts. Empty when solo, which is what
   * keeps every consumer's answer "nothing to say" without a mode flag.
   *
   * **This is where per-host state lives, and the reason it lives here rather than in
   * lib/connection-health.ts** is that tier 1 is one global clock by construction and must stay that
   * way. The value below holds no clock at all: it is recomputed from the snapshot the poll just
   * delivered, so recovery is the ordinary next poll and there is no timer to fire, retry or reset.
   */
  health: Map<string, HostHealth>;
}

const NO_HEALTH: Map<string, HostHealth> = new Map();
const SOLO: PackValue = { servers: [], multi: false, lead: undefined, health: NO_HEALTH };

const PackContext = createContext<PackValue>(SOLO);

/**
 * Publishes the snapshot's `servers` — and the tier-2 health derived from them — to the tree.
 * Mounted once, at the data root.
 */
export function PackProvider({
  servers,
  ts = 0,
  pollMs = 0,
  children,
}: {
  servers: ServerSummary[] | undefined;
  /**
   * `SnapshotResponse.ts` — the LEAD's clock, which is the clock `lastSeenAt` is stamped on. Never
   * `Date.now()`; lib/host-health.ts's header has the argument.
   */
  ts?: number;
  /** The cadence polling is currently running at, for §10.2's `3 × pollMs` tolerance. */
  pollMs?: number;
  children: ReactNode;
}) {
  // Memoised on the array identity the loader hands us — the root re-renders on every poll, and a
  // fresh context value each time would re-render every consumer for nothing. `ts` advances with each
  // fresh body, so a poll that changes nothing else still re-dates the health it publishes; a
  // keep-previous-data render (a failed refresh) reuses the cached snapshot, whose `ts` is frozen —
  // which is right, because "how stale is what I'm holding" is tier 1's question, not this one's.
  const value = useMemo<PackValue>(
    () =>
      servers === undefined || servers.length === 0
        ? SOLO
        : {
            servers,
            multi: isMultiHost(servers),
            lead: leadHost(servers),
            health: hostHealthMap(servers, { at: ts, pollMs }),
          },
    [servers, ts, pollMs],
  );
  return <PackContext.Provider value={value}>{children}</PackContext.Provider>;
}

/** The pack roster and its derived facts. The SOLO value when there is no pack. */
export function usePack(): PackValue {
  return useContext(PackContext);
}

/**
 * Tier-2 health for one host, or `undefined` when there is nothing to say — a solo install, or a
 * caller with no host in hand. On a pack, a host the roster does NOT list still gets an answer
 * ({@link departedHealth}): a member that departed mid-look is unknown, not fine, and the surfaces
 * that type into terminals must not read the absence of a fact as a good one.
 */
export function useHostHealth(host: string | undefined): HostHealth | undefined {
  const { multi, health } = usePack();
  if (!multi || host === undefined) return undefined;
  return healthFor(health, host) ?? departedHealth(host);
}

/**
 * The reason a write to `host` must be refused before it is attempted (PACK_PROTOCOL.md §10.3), or
 * `undefined` when it may proceed — which is ALWAYS the answer on a solo install, so every write
 * surface below keeps its exact current behaviour without asking whether there is a pack.
 *
 * Callers use it two ways at once, and both matter: as a disabled state (so the affordance doesn't
 * invite a write that can't land) and as a guard inside the handler (so a keyboard shortcut or a
 * stale closure can't route around the disabled state). Same posture as session-switcher.tsx.
 */
export function useHostWriteBlock(host: string | undefined): string | undefined {
  return writeRefusal(useHostHealth(host));
}

/**
 * The host an ambient-scoped write lands on, named for the UI: the scope's `?h=`, or the lead when
 * it is absent. Undefined on a solo install, so a caller passing it to `HostChip` renders nothing.
 */
export function useAmbientHost(host: string | undefined): string | undefined {
  const { servers } = usePack();
  return ambientHost(servers, host);
}

/**
 * The same host, as a NAME to interpolate into copy — and `undefined` whenever there is no host
 * dimension to speak of, so every confirm string on a single-host install stays byte-identical.
 * Callers interpolate it only when set, which is the copy-level twin of HostChip's hide rule.
 */
export function useHostLabel(host: string | undefined): string | undefined {
  const { servers, multi } = usePack();
  if (!multi) return undefined;
  const id = ambientHost(servers, host);
  return id === undefined ? undefined : hostName(servers, id) ?? id;
}
