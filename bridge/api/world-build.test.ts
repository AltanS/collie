import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryHillReceipts } from "../hill/receipts.ts";
import { HillService, type HillAgentSender } from "../hill/service.ts";
import { HillStore } from "../hill/store.ts";
import { MachineAlertStore } from "../machine-alerts.ts";
import { MachineHistory } from "../machine-history.ts";
import { SAMPLE_IDLE_MS } from "../machine-stats.ts";
import { MachineWatch } from "../machines.ts";
import type { JsonObject } from "../json.ts";
import { WalkyInstances } from "../walky/instances.ts";
import { idOf } from "./ids.ts";
import { OPERATION_NAMES, type OperationContext, type OperationName } from "./operations.ts";
import { apiTable, buildApiWorld, type ApiWorldDeps } from "./world.ts";
import { depsOf, keyOf, MACHINE, machineBodies, world } from "./fixtures/reads-world.ts";

// SECURITY READ 2, ITEM 5: the API's world is built by ONE function, `buildApiWorld` (world.ts), the very
// builder bridge/index.ts calls (ask-reach.test.ts pins that). Here it runs over a REAL HillService (a
// memory store, as the Hill's own tests build it), a REAL WalkyInstances (a temp state folder) and a REAL
// MachineWatch (spec 04, `machines`). Every write method of the three is a spy that throws; every
// operation runs; none is called, `instances.json` is not written, and the watch's sample rate does not
// move (`machines` reads `census`, never the phone's `rows`).

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The write methods of the two services, each hung on the instance as a spy that throws. */
const HILL_WRITES = ["post", "postDecision", "postCollie", "postFields", "answer", "withdraw", "withdrawCollie", "askWithdraw", "clear", "clearSpoken", "switchTo", "setCrewState", "tellAll", "sweep", "pruneMedia", "adoptCarried", "noteSpoke"] as const;
const WALKY_WRITES = ["observe", "stamp", "tokenOf"] as const;
/** The watch's writes, and `rows`, the phone's read, which holds the fast sample rate. */
const WATCH_WRITES = ["observe", "forget", "tick", "flush", "setAlerts", "rows"] as const;

function spies(owner: string, names: readonly string[], writes: string[]): Record<string, () => never> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      (): never => {
        writes.push(`${owner}.${name}`);
        throw new Error(`a write was called: ${owner}.${name}`);
      },
    ]),
  );
}

function ctx(): OperationContext {
  return { signal: new AbortController().signal, offered: [...OPERATION_NAMES], standing: () => true, claimWait: () => () => undefined };
}

async function realRig() {
  const stateDir = mkdtempSync(join(tmpdir(), "collie-api-world-"));
  dirs.push(stateDir);
  const writes: string[] = [];
  const reads: string[] = [];
  const w = world();
  // A real WalkyInstances: it mints the fixture panes' tokens once (and writes instances.json), before the API runs.
  const instances = new WalkyInstances(join(stateDir, "walky"), () => 1000);
  instances.observe(w.panes.map((source) => ({ session: source.muxSession, paneId: source.pane.paneId })));
  const file = join(stateDir, "walky", "instances.json");
  const before = { bytes: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
  const token = instances.peek("main", "w1:p1");
  if (token === null) throw new Error("no token minted");
  w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "$ ls\nREADME.md", truncated: false });
  // A real HillService with one open agent card.
  const hill = new HillService({
    store: new HillStore(null, () => 1000),
    receipts: memoryHillReceipts(),
    // The posting pane is live for walky, as a card's poster must be.
    place: (address) => (address === `local/w1:p1#${token}` ? { address, label: "lodge#main", host: "workshop", unattended: false } : null),
    send: async () => "typed",
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: MACHINE,
    machine: "workshop",
    now: () => 1000,
    mintId: () => "dc_world00000001",
  });
  const sender: HillAgentSender = { kind: "agent", address: `local/w1:p1#${token}`, memberId: MACHINE, harness: "claude", label: "lodge", host: "workshop" };
  const posted = hill.post(sender, { requestId: "00000000-0000-4000-8000-000000000001", title: "Deploy window", summary: "a card", options: [{ intent: "go", label: "Go" }] });
  if (!posted.ok) throw new Error(posted.error);
  const hillSpies = spies("hill", HILL_WRITES, writes);
  const walkySpies = spies("instances", WALKY_WRITES, writes);
  const realList = hill.list.bind(hill);
  Object.assign(hill, hillSpies, {
    list: () => {
      reads.push("hill.list");
      return realList();
    },
  });
  const realPeek = instances.peek.bind(instances);
  Object.assign(instances, walkySpies, {
    peek: (session: string, paneId: string) => {
      reads.push("instances.peek");
      return realPeek(session, paneId);
    },
  });
  // A real MachineWatch over the fixture's crew: its roster is the crew overview, its samples observed before the API runs.
  const bodies = machineBodies();
  const watch = new MachineWatch({
    // Long past the start, so no phone's ask is within the fast window.
    now: () => 10_000_000,
    roster: () => bodies.crew.members.map((member) => ({ id: member.id, name: member.name, isLead: member.isLead, health: member.health })),
    history: new MachineHistory(),
    alerts: await MachineAlertStore.load(stateDir),
    saveHistory: async () => {},
    muted: () => false,
    enabled: () => true,
    send: () => {},
  });
  for (const row of bodies.rows) if (row.sample !== undefined) watch.observe(row.id, row.sample, 1000);
  const realCensus = watch.census.bind(watch);
  const watchSpies = spies("watch", WATCH_WRITES, writes);
  Object.assign(watch, watchSpies, {
    census: () => {
      reads.push("watch.census");
      return realCensus();
    },
  });
  const base = depsOf(w);
  const bus = Object.assign(w.bus, spies("bus", ["publish", "subscribe"], writes));
  const accounts = Object.assign({ paneAccount: base.paneAccount, body: base.accountsBody }, spies("accounts", ["add", "remove", "rename"], writes));
  const inside = Object.assign({ draftOf: (address: { session: string; paneId: string }) => base.draftState(address.session, address.paneId) }, spies("inside", ["enqueue"], writes));
  const deps: ApiWorldDeps = { version: () => "9.9.9-test", machine: () => MACHINE, panes: base.panes, instances, bus, accounts, inside, readScreen: base.readScreen,
    hill,
    machineWatch: watch,
    crewStatus: () => {
      reads.push("crewStatus");
      return bodies.crew;
    },
    selfMachine: () => {
      throw new Error("a bridge with a watch reads its census, not its own row");
    },
    defaultLines: 200,
  };
  return { deps, writes, reads, token, file, before, hill, instances, watch, hillSpies, walkySpies, watchSpies };
}

describe("buildApiWorld over a real HillService and a real WalkyInstances", () => {
  test("every operation runs; no write of either service is called; instances.json is not written", async () => {
    const r = await realRig();
    const rate = r.watch.sampleEveryMs();
    const table = apiTable(buildApiWorld(r.deps));
    const session = idOf(MACHINE, "w1:p1", r.token);
    const args = { hello: { token: "A".repeat(43) }, sessions: {}, brief: { session }, read: { session, lines: 10 }, accounts: {}, "hill.list": {}, machines: {}, events: { after: "-", wait: 0 } } satisfies Record<OperationName, JsonObject>;
    const answers: JsonObject[] = [];
    for (const name of OPERATION_NAMES) {
      const result = await table.get(name)!.run(args[name], ctx());
      expect({ name, ok: result.ok }).toEqual({ name, ok: true });
      if (result.ok) answers.push(result.answer);
    }
    expect(r.writes).toEqual([]);
    // Not vacuous: the real services were read, and their answers came through.
    expect(r.reads).toContain("hill.list");
    expect(r.reads).toContain("instances.peek");
    expect(r.reads).toContain("watch.census");
    expect(r.reads).toContain("crewStatus");
    const machines = answers.find((answer) => "machines" in answer)?.machines;
    expect(JSON.parse(JSON.stringify(machines))).toMatchObject([
      { id: MACHINE, label: "workshop", load: { cpu: 0.12, sessions: 2 } },
      { id: "lodge", version: "1.29.0", load: { cpu: 0.5, sessions: 3 } },
      { id: "attic", reachable: false },
      { id: "barn" },
    ]);
    // The phone's rate is not held by a program's read.
    expect(r.watch.sampleEveryMs()).toBe(rate);
    expect(rate).toBe(SAMPLE_IDLE_MS);
    const cards = answers.find((answer) => "cards" in answer)?.cards;
    expect(Array.isArray(cards) ? cards.length : -1).toBe(1);
    const sessions = answers.find((answer) => "sessions" in answer)?.sessions;
    expect(Array.isArray(sessions) ? sessions.length : -1).toBe(2);
    // The token file is as the mint left it: no read of the API touched it.
    expect(readFileSync(r.file, "utf8")).toBe(r.before.bytes);
    expect(statSync(r.file).mtimeMs).toBe(r.before.mtime);
  });

  // Review 3, item 5: a crew member's row is the watch's memory and the crew overview's, never a dial.
  test("a crew member's machines row makes no network call: it comes from the census", async () => {
    const r = await realRig();
    const dials: string[] = [];
    const realFetch = globalThis.fetch;
    const realConnect = Bun.connect;
    globalThis.fetch = Object.assign(
      (): never => {
        dials.push("fetch");
        throw new Error("machines dialed with fetch");
      },
      { preconnect: () => dials.push("fetch.preconnect") },
    );
    Bun.connect = (): never => {
      dials.push("Bun.connect");
      throw new Error("machines dialed with Bun.connect");
    };
    try {
      const result = await apiTable(buildApiWorld(r.deps)).get("machines")!.run({}, ctx());
      expect(result.ok).toBe(true);
      const rows = result.ok ? JSON.parse(JSON.stringify(result.answer)).machines : [];
      // The member's load is the sample the watch observed before the call, and its version the overview's.
      expect(rows.find((row: { id: string }) => row.id === "lodge")).toEqual({ id: "lodge", label: "lodge", reachable: true, version: "1.29.0", load: { cpu: 0.5, memory: 0.75, sessions: 3 } });
    } finally {
      globalThis.fetch = realFetch;
      Bun.connect = realConnect;
    }
    expect(dials).toEqual([]);
    // The only sources read: the watch's census, the crew overview from memory, and this machine's own panes (peeked).
    expect([...new Set(r.reads)].toSorted()).toEqual(["crewStatus", "instances.peek", "watch.census"]);
    expect(r.writes).toEqual([]);
  });

  test("a bridge with no watch (a crew peer) answers its own row, from the sampler", async () => {
    const r = await realRig();
    const row = machineBodies().rows[1]!;
    const deps: ApiWorldDeps = { ...r.deps, machineWatch: null, crewStatus: () => null, selfMachine: () => ({ ...row, isLead: true }) };
    const result = await apiTable(buildApiWorld(deps)).get("machines")!.run({}, ctx());
    expect(result.ok && JSON.parse(JSON.stringify(result.answer))).toEqual({ machines: [{ id: MACHINE, label: "lodge", reachable: true, version: "9.9.9-test", load: { cpu: 0.5, memory: 0.75, sessions: 2 } }] });
  });

  test("the spies are armed: a write on any real service throws and is recorded", async () => {
    const r = await realRig();
    // The spies sit on the very instances the builder was given.
    expect(r.hill.answer).toBe(r.hillSpies.answer!);
    expect(r.instances.tokenOf).toBe(r.walkySpies.tokenOf!);
    expect(() => r.hillSpies.answer?.()).toThrow("hill.answer");
    expect(() => r.walkySpies.tokenOf?.()).toThrow("instances.tokenOf");
    expect(r.watch.rows).toBe(r.watchSpies.rows!);
    expect(() => r.watchSpies.rows?.()).toThrow("watch.rows");
    expect(r.writes).toEqual(["hill.answer", "instances.tokenOf", "watch.rows"]);
  });
});
