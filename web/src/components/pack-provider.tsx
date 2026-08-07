import { createContext, useContext, useMemo, type ReactNode } from "react";

import { ambientHost, hostName, isMultiHost, leadHost } from "@/lib/hosts";
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
}

const SOLO: PackValue = { servers: [], multi: false, lead: undefined };

const PackContext = createContext<PackValue>(SOLO);

/** Publishes the snapshot's `servers` to the tree. Mounted once, at the data root. */
export function PackProvider({
  servers,
  children,
}: {
  servers: ServerSummary[] | undefined;
  children: ReactNode;
}) {
  // Memoised on the array identity the loader hands us — the root re-renders on every poll, and a
  // fresh context value each time would re-render every consumer for nothing.
  const value = useMemo<PackValue>(
    () =>
      servers === undefined || servers.length === 0
        ? SOLO
        : { servers, multi: isMultiHost(servers), lead: leadHost(servers) },
    [servers],
  );
  return <PackContext.Provider value={value}>{children}</PackContext.Provider>;
}

/** The pack roster and its two derived facts. `{servers: [], multi: false}` when there is no pack. */
export function usePack(): PackValue {
  return useContext(PackContext);
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
