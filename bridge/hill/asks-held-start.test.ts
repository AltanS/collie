import { describe, expect, test } from "bun:test";

import type { BeaconMatcher } from "../beacon/decorate.ts";
import type { BeaconLiveness } from "../beacon/reader.ts";
import { EDGE_SCHEMA_VERSION, type EdgeRecord } from "../beacon/types.ts";
import type { EdgeSpool } from "../beacon-io.ts";
import { parseJsonObject } from "../../web/src/lib/json.ts";
import { EdgeRouter, type EdgeTarget } from "../surface/edges.ts";
import { askInput, askRig, ONE, posted, type AskRig } from "./ask-rig.ts";
import { AskRemindBook, type AskPane } from "./remind.ts";

// The reminder of open asks after a resume on a multiplexer whose foreground trails (2026-11-24, herdr-core):
// `claude --resume` typed into the pane's shell sends its start edge before the snapshot names the new process.
// The edge router holds that edge until the foreground names it, so the pane's agent session is known again
// and the first prompt after the resume gets the list (.adr/0178). Before, the edge was dropped and the
// first prompt's `ask.remind` answered none.

const FIRST = 4242;
const RESUMED = 5151;
const SHELL = 3030;
const START = 777;
const SOCKET = "/run/mux.sock";
const MUX_PANE = "w1:p1";
const P1: AskPane = { session: "main", paneId: "%1" };
const T0 = 1_000_000;

const matcher: BeaconMatcher = {
  namespace: "mux",
  scope: () => Promise.resolve(SOCKET),
  matches: (pane, m, s) => m.scope === s && m.pane === pane.paneId,
  notesWithoutHooks: { agentDetection: "-", agentSessionRef: "-" },
};

function edge(over: Partial<EdgeRecord>): EdgeRecord {
  return { schemaVersion: EDGE_SCHEMA_VERSION, harness: "claude", event: "SessionStart", detail: null, pid: FIRST, pidStartTime: START, markers: [{ namespace: "mux", scope: SOCKET, pane: MUX_PANE }], at: T0, promptHash: null, ...over };
}

class FakeSpool implements EdgeSpool {
  files: string[] = [];
  take(): Promise<readonly string[]> {
    const out = this.files;
    this.files = [];
    return Promise.resolve(out);
  }
}

interface Rig {
  readonly asks: AskRig;
  readonly fg: number[];
  readonly alive: Set<number>;
  push(record: EdgeRecord): void;
  tick(ms?: number): Promise<void>;
}

/** An edge router whose pane foreground a test moves by hand, wired into the ask service as the bridge wires it. */
function rig(lag: number | undefined): Rig {
  const spool = new FakeSpool();
  const clock = { now: T0 + 100 };
  const fg: number[] = [SHELL];
  const alive = new Set([FIRST, RESUMED, SHELL]);
  const liveness: BeaconLiveness = { startTimeOf: (pid) => Promise.resolve(alive.has(pid) ? START : null) };
  const target: EdgeTarget = {
    session: "main",
    matcher,
    paneIds: () => [MUX_PANE],
    foreground: () => Promise.resolve({ ok: true as const, value: fg.map((pid) => ({ argv: ["x"], pid })) }),
    foregroundLagMs: lag ?? 0,
    deliver: () => undefined,
  };
  const router = new EdgeRouter({ spool, liveness, targets: () => [target], log: () => undefined, now: () => clock.now });
  const asks = askRig(undefined, (askClock) => ({
    reminders: new AskRemindBook(askClock),
    paneAddress: (session, paneId) => (session === "main" && paneId === "%1" ? ONE.address : null),
    paneAgentSession: (session, paneId) => (session === "main" && paneId === "%1" ? (router.agentSessionOf("main", MUX_PANE) ?? null) : null),
  }));
  return {
    asks,
    fg,
    alive,
    push: (record) => void spool.files.push(JSON.stringify(record)),
    tick: async (ms = 200) => {
      clock.now += ms;
      await router.tick();
    },
  };
}

/** Claude started from the shell, an ask posted from it, Claude quit, `claude --resume s1` typed into the same shell. */
async function resumeAfterAsk(r: Rig): Promise<string> {
  r.push(edge({ event: "SessionStart", detail: "startup", source: "startup", session: "s1" }));
  await r.tick();
  r.fg.splice(0, r.fg.length, FIRST);
  await r.tick();
  const fields = parseJsonObject(JSON.stringify(askInput(1)));
  if (fields === undefined) throw new Error("the ask input is not an object");
  r.asks.clock += 1000;
  const ask = posted(await r.asks.hill.askPost(ONE, fields, P1));
  // Claude quits: the shell is the foreground again, and the router closes the gone pid's source.
  r.alive.delete(FIRST);
  r.fg.splice(0, r.fg.length, SHELL);
  await r.tick(2000);
  // `claude --resume s1`: its start edge comes before the snapshot names it.
  r.push(edge({ pid: RESUMED, event: "SessionStart", detail: "resume", source: "resume", session: "s1", at: T0 + 3000 }));
  await r.tick();
  r.fg.splice(0, r.fg.length, RESUMED);
  await r.tick();
  await r.tick();
  return ask.id;
}

describe("the first prompt after a resume on a trailing foreground", () => {
  test("gets the list of the resumed session's open asks", async () => {
    const r = rig(3000);
    const id = await resumeAfterAsk(r);
    r.asks.clock += 1000;
    expect(r.asks.hill.askRemind(ONE, P1, { kind: "prompt", hash: "h", at: r.asks.clock, sessionId: "s1" })).toMatchObject({ kind: "list", asks: [{ id }] });
  });

  test("with no lag declared the start edge drops, as before, and the bridge knows no session", async () => {
    const r = rig(undefined);
    r.fg.splice(0, r.fg.length, FIRST);
    await resumeAfterAsk(r);
    r.asks.clock += 1000;
    expect(r.asks.hill.askRemind(ONE, P1, { kind: "prompt", hash: "h", at: r.asks.clock, sessionId: "s1" })).toEqual({ kind: "none" });
  });
});
