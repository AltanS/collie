// The Crew page's half of the wave-4 stub bridge: a handler for `installRoutesApi` (routes-api.ts)
// answering `/api/crew`, and the snapshot's `servers` roster the formation reads its health from.
// `crewStub("solo")` answers 404 (a solo collie or a peer opened directly) and `"error"` a 500.
// Payloads are shaped like web/src/lib/types.
import type { CrewStatusResponse, SnapshotResponse } from "@web/lib/types";

import { SNAPSHOT, type StubHandler } from "./routes-api";

const TS = SNAPSHOT.ts;

export const CREW: CrewStatusResponse = {
  crew: { id: "crew-1", name: "home", secretGeneration: 3, rotatedAt: TS - 3 * 3_600_000 },
  self: { id: "lead", name: "bluefin", version: "1.17.0" },
  deputy: { id: "peer", warrantGeneration: 2 },
  members: [
    { id: "lead", name: "bluefin", isLead: true, health: "reachable", lastSeenAt: TS, version: "1.17.0", secretBehind: false, provisional: false },
    {
      id: "peer",
      name: "minibuch",
      isLead: false,
      address: "100.64.0.9:8788",
      enrolledAt: TS - 86_400_000,
      health: "reachable",
      lastSeenAt: TS - 4_000,
      version: "1.16.0",
      secretBehind: true,
      provisional: false,
    },
    {
      id: "far",
      name: "attic",
      isLead: false,
      address: "100.64.0.12:8788",
      health: "unreachable",
      reason: "connect ETIMEDOUT",
      lastSeenAt: TS - 600_000,
      secretBehind: false,
      provisional: false,
      linkState: "reconnecting",
    },
  ],
  ts: TS,
};

/** The snapshot with the roster the formation reads its per-member health from. */
export function crewSnapshot(): SnapshotResponse {
  return {
    ...SNAPSHOT,
    servers: [
      { id: "lead", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: TS },
      { id: "peer", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: TS - 4_000 },
      { id: "far", name: "attic", isLead: false, reachable: false, protocol: "ok", lastSeenAt: TS - 600_000 },
    ],
  };
}

export type CrewMode = "crew" | "solo" | "error";

export function crewStub(mode: CrewMode = "crew"): StubHandler {
  return async (ctx) => {
    const key = `${ctx.method} ${ctx.url.pathname}`;
    if (key === "GET /api/snapshot") {
      await ctx.json(200, crewSnapshot());
      return true;
    }
    if (key !== "GET /api/crew") return false;
    if (mode === "solo") await ctx.json(404, { error: "not a crew" });
    else if (mode === "error") await ctx.json(500, { error: "boom" });
    else await ctx.json(200, CREW);
    return true;
  };
}
