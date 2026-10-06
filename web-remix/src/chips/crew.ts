// The crew facts a chip needs, derived from the snapshot (web/src/components/crew-provider.tsx
// without React context): the roster, the session registry, whether there is a crew at all, the lead,
// and the lead↔peer health per member (web/'s pure `hostHealthMap`, reused read-only). Derived once
// per snapshot body and cached by identity, so forty chips on one render ask one map.
import { departedHealth, healthFor, hostHealthMap, writeRefusal, type HostHealth } from "@web/lib/host-health";
import { isMultiHost, leadHost } from "@web/lib/hosts";
import type { ServerSummary, SessionSummary, SnapshotResponse } from "@web/lib/types";

import { snapshot } from "../lib/data";
import { IDLE_MS } from "../lib/polling";

export interface Crew {
  servers: readonly ServerSummary[];
  sessions: readonly SessionSummary[];
  multi: boolean;
  lead: string | undefined;
  health: ReadonlyMap<string, HostHealth>;
}

const NO_SERVERS: readonly ServerSummary[] = [];
const NO_SESSIONS: readonly SessionSummary[] = [];
const SOLO: Crew = { servers: NO_SERVERS, sessions: NO_SESSIONS, multi: false, lead: undefined, health: new Map() };

let seen: SnapshotResponse | undefined;
let derived: Crew = SOLO;

/** The crew as the snapshot body states it. */
export function crewOf(body: SnapshotResponse | undefined): Crew {
  if (body === seen) return derived;
  seen = body;
  const servers = body?.servers ?? NO_SERVERS;
  derived =
    servers.length === 0
      ? { ...SOLO, sessions: body?.sessions ?? NO_SESSIONS }
      : {
          servers,
          sessions: body?.sessions ?? NO_SESSIONS,
          multi: isMultiHost(servers),
          lead: leadHost(servers),
          // The lead's own clock and the slow beat: web/ passes the cadence in force, and the idle
          // gap is the widest, so a peer is never called stale sooner than web/ would call it.
          health: hostHealthMap(servers, { at: body?.ts ?? 0, pollMs: IDLE_MS }),
        };
  return derived;
}

/** The crew right now. */
export function currentCrew(): Crew {
  return crewOf(snapshot.get().data);
}

/** Tier-2 health for one host, or undefined when there is nothing to say (solo, or no host). */
export function hostHealthOf(crew: Crew, host: string | undefined): HostHealth | undefined {
  if (!crew.multi || host === undefined) return undefined;
  return healthFor(crew.health, host) ?? departedHealth(host);
}

/** Why a write to `host` must be refused before it is tried, or undefined (always, when solo). */
export function hostWriteBlock(crew: Crew, host: string | undefined): string | undefined {
  return writeRefusal(hostHealthOf(crew, host));
}
