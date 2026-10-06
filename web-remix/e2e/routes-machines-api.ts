// The Machines pages' half of the wave-4 stub bridge: `/api/machines` (the census, with a spark),
// `/api/machines/:id/history` (one answer sliced client-side) and the alerts write, with state that
// behaves as the bridge does: a POST to `/alerts` replaces that machine's rules from the body, and the
// next census carries them. Payloads are shaped like web/src/lib/types.
import type { MachineAlerts, MachineHistoryPoint, MachineRow, MachinesResponse } from "@web/lib/types";

import { SNAPSHOT, type StubHandler } from "./routes-api";

const TS = SNAPSHOT.ts;
const GIB = 1024 ** 3;

export interface MachinesStubState {
  alerts: Record<string, MachineAlerts>;
  /** When true the census is a 404: a collie that serves none. */
  unavailable: boolean;
  /** Fail the first history read, to show the retry words. */
  failHistory: boolean;
}

/** `minutes` readings, one per minute, ending at `TS`, a gentle wave on a flat floor. */
export function historyPoints(minutes: number): MachineHistoryPoint[] {
  const out: MachineHistoryPoint[] = [];
  for (let i = minutes - 1; i >= 0; i--) {
    const wave = 0.25 + 0.1 * Math.sin(i / 7);
    out.push([TS - i * 60_000, wave, wave + 0.1, 0.5, 1000 + i, 500 + i, 0.6]);
  }
  return out;
}

function spark(): number[] {
  return Array.from({ length: 30 }, (_, i) => 0.2 + 0.1 * Math.sin(i / 4));
}

export interface MachinesStub {
  handler: StubHandler;
  state: MachinesStubState;
}

export function machinesStub(over: Partial<MachinesStubState> = {}): MachinesStub {
  const state: MachinesStubState = { alerts: { lead: { cpu: { above: 0.9, forMin: 10 } } }, unavailable: false, failHistory: false, ...over };
  const rows = (): MachineRow[] => [
    {
      id: "lead",
      name: "bluefin",
      isLead: true,
      health: "reachable",
      sampledAt: TS - 5_000,
      sample: {
        cpu: 0.42,
        cores: 8,
        memUsed: 6 * GIB,
        memTotal: 16 * GIB,
        load1: 1.25,
        rxBps: 120_000,
        txBps: 40_000,
        disks: [
          { mount: "/", used: 80 * GIB, total: 100 * GIB },
          { mount: "/home", used: 10 * GIB, total: 200 * GIB },
        ],
      },
      alerts: state.alerts.lead ?? {},
      firing: ["cpu"],
      spark: { stepMs: 60_000, cpu: spark(), mem: spark() },
    },
    {
      id: "peer",
      name: "minibuch",
      isLead: false,
      health: "reachable",
      sampledAt: TS - 5_000,
      sample: { cpu: 0.1, cores: 4, memUsed: 2 * GIB, memTotal: 8 * GIB },
      alerts: state.alerts.peer ?? {},
      firing: [],
      spark: { stepMs: 60_000, cpu: spark(), mem: spark() },
    },
    { id: "far", name: "attic", isLead: false, health: "unreachable", sampledAt: TS - 900_000, alerts: {}, firing: [] },
  ];

  const handler: StubHandler = async (ctx) => {
    const { pathname } = ctx.url;
    if (ctx.method === "GET" && pathname === "/api/machines") {
      if (state.unavailable) await ctx.json(404, { error: "no census" });
      else await ctx.json(200, { ts: TS, machines: rows() } satisfies MachinesResponse);
      return true;
    }
    const history = /^\/api\/machines\/([^/]+)\/history$/u.exec(pathname);
    if (ctx.method === "GET" && history !== null) {
      if (state.failHistory) {
        state.failHistory = false;
        await ctx.json(500, { error: "boom" });
      } else {
        await ctx.json(200, { ts: TS, stepMs: 60_000, points: historyPoints(120) });
      }
      return true;
    }
    const alerts = /^\/api\/machines\/([^/]+)\/alerts$/u.exec(pathname);
    if (ctx.method === "POST" && alerts !== null) {
      const id = decodeURIComponent(alerts[1] ?? "");
      // SAFETY: the app posts a MachineAlerts object; the stub stores what the bridge would.
      const next = (ctx.body ?? {}) as MachineAlerts;
      state.alerts[id] = next;
      await ctx.json(200, { alerts: next });
      return true;
    }
    return false;
  };
  return { handler, state };
}
