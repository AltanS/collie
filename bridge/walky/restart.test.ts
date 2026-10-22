import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HELD_LIMIT_MS, sendIdOf, type SendResult, type WalkyHost, type WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { WalkySeen } from "./seen.ts";
import { WalkyService } from "./service.ts";
import type { WalkyReceipt } from "./types.ts";

// At most one typing per (id, target), across a restart (M62 hardening G). A fake Send Protocol
// whose store outlives the bridge, and a bridge that dies at one of three points: right after the
// log took the message, right after the `accepted` receipt with the send id, and right after the
// send. Then a new bridge on the same state dir recovers, the client may retry the same id, and every
// send id must have been handed to the protocol at most once, and typed at most once.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type CrashPoint = "none" | "after-record" | "after-accepted" | "after-send";
type Outcome = "sent" | "effective" | "held-released" | "held-stuck" | "held-cancels" | "refused" | "unknown";

/** A small seeded generator, so a failing case can be named by its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)]!;
}

/** What outlives a crash: the protocol's store, the typings it did, and the clock. */
interface World {
  clock: number;
  dead: boolean;
  crash: CrashPoint;
  outcome: Outcome;
  readonly calls: Map<string, number>;
  readonly typed: Map<string, number>;
  readonly store: Map<string, SendResult>;
}

class Died extends Error {}

/** The log, but a dead process writes nothing, and one point of the run can be the moment it dies. */
class CrashLog extends WalkyLog {
  constructor(
    dir: string,
    private readonly world: World,
  ) {
    super(dir, () => world.clock);
  }
  override record(...args: Parameters<WalkyLog["record"]>): ReturnType<WalkyLog["record"]> {
    if (this.world.dead) throw new Died("dead");
    return super.record(...args);
  }
  override update(receipt: WalkyReceipt): void {
    if (this.world.dead) throw new Died("dead");
    // The first write after the message line is the `accepted` receipt that names the send id.
    if (this.world.crash === "after-record" && receipt.state === "accepted" && receipt.sendId !== undefined) {
      this.world.dead = true;
      throw new Died("died after the log took the message");
    }
    super.update(receipt);
  }
}

const forever = new Promise<SendResult>(() => undefined);

class FakeProtocol implements WalkyHost {
  constructor(
    private readonly world: World,
    private readonly list: WalkyPane[],
    private readonly random: () => number,
  ) {}
  panes(): readonly WalkyPane[] {
    return this.list;
  }
  private type(sendId: string): void {
    this.world.typed.set(sendId, (this.world.typed.get(sendId) ?? 0) + 1);
  }
  async send(_pane: WalkyPane, sendId: string): Promise<SendResult> {
    if (this.world.dead) return forever;
    if (this.world.crash === "after-accepted") {
      this.world.dead = true;
      return forever;
    }
    this.world.calls.set(sendId, (this.world.calls.get(sendId) ?? 0) + 1);
    const outcome = this.world.outcome;
    let result: SendResult;
    if (outcome === "sent" || outcome === "effective") {
      this.type(sendId);
      result = { outcome };
    } else if (outcome === "unknown") {
      // It may or may not have gone in; count it as typed, the worse case.
      this.type(sendId);
      result = { outcome: "unknown", reason: "no_evidence" };
    } else if (outcome === "refused") {
      result = { outcome: "refused", reason: "not_free" };
    } else {
      result = { outcome: "held" };
    }
    this.world.store.set(sendId, result);
    if (this.world.crash === "after-send") {
      this.world.dead = true;
      return forever;
    }
    return result;
  }
  sendState(sendId: string): SendResult | null {
    const held = this.world.store.get(sendId) ?? null;
    // A held send the protocol releases on its own, once: that release is its one typing.
    if (held?.outcome === "held" && this.world.outcome === "held-released" && this.random() < 0.3) {
      this.type(sendId);
      this.world.store.set(sendId, { outcome: "sent" });
      return { outcome: "sent" };
    }
    return held;
  }
  cancelHeld(_session: string, _paneId: string, sendId: string): void {
    if (this.world.store.get(sendId)?.outcome !== "held") return;
    if (this.world.outcome === "held-stuck") return;
    this.world.store.set(sendId, { outcome: "cancelled" });
  }
}

function pane(paneId: string): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId}`, state: "working", instance: "aaaa", terminal: true };
}

function bridge(dir: string, world: World, panes: WalkyPane[], random: () => number): WalkyService {
  const log = new CrashLog(dir, world);
  return new WalkyService({
    log,
    seen: new WalkySeen(dir, () => world.clock),
    host: new FakeProtocol(world, panes, random),
    memberId: null,
    enabled: () => true,
    machine: "desk",
    keyPem: () => null,
    now: () => world.clock,
    sleep: async (ms) => {
      world.clock += ms;
    },
    warn: () => undefined,
  });
}

/** One case: send, maybe die, restart, recover, maybe retry. Answers the world for the checks. */
async function run(seed: number): Promise<{ world: World; targets: string[]; label: string }> {
  const random = rng(seed);
  const root = mkdtempSync(join(tmpdir(), "walky-restart-"));
  roots.push(root);
  const dir = join(root, "walky");
  const crash = pick(random, ["none", "after-record", "after-accepted", "after-send"] as const);
  const outcome = pick(random, ["sent", "effective", "held-released", "held-stuck", "held-cancels", "refused", "unknown"] as const);
  const size = 1 + Math.floor(random() * 3);
  const retry = random() < 0.6;
  const panes = Array.from({ length: size }, (_, n) => pane(`%${String(n + 1)}`));
  const to = size === 1 ? "local/%1" : "all";
  const world: World = { clock: 1_786_000_000_000, dead: false, crash, outcome, calls: new Map(), typed: new Map(), store: new Map() };
  const input = { id: "wt_restart00001", to, body: "hello", replyTo: null };
  const operator = { kind: "operator" as const, label: "phone" };

  const first = bridge(dir, world, panes, random);
  // A death inside the send rejects it with `Died`; anything else is a real failure and fails the case.
  const sent = await first.send(input, operator).then(
    () => "sent",
    (err: Error) => (err instanceof Died ? "died" : `failed: ${err.message}`),
  );
  expect([seed, sent.startsWith("failed")]).toEqual([seed, false]);
  // A process that did not die finishes on its own; one that died leaves its promises hanging.
  if (!world.dead) await first.deliverer.settled();

  // The restart: a new bridge on the same state dir, the same protocol store.
  world.dead = false;
  world.crash = "none";
  world.clock += 5000;
  const second = bridge(dir, world, panes, random);
  second.deliverer.recover();
  if (retry) await second.send(input, operator);
  await Promise.race([second.deliverer.settled(), new Promise((resolve) => setTimeout(resolve, 2000))]);

  const targets = panes.map((p) => sendIdOf(input.id, `local/${p.paneId}`));
  return { world, targets, label: `seed ${String(seed)}: crash ${crash}, outcome ${outcome}, ${String(size)} pane(s), retry ${String(retry)}` };
}

describe("at most one typing per (id, target), across a restart", () => {
  test("300 seeded runs over the three crash points, seven outcomes, fan-outs and retries", async () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { world, targets, label } = await run(seed);
      for (const sendId of targets) {
        expect([label, sendId, (world.calls.get(sendId) ?? 0) <= 1]).toEqual([label, sendId, true]);
        expect([label, sendId, (world.typed.get(sendId) ?? 0) <= 1]).toEqual([label, sendId, true]);
      }
    }
  }, 60_000);
});

describe("the end of a hold", () => {
  async function held(outcome: Outcome): Promise<WalkyReceipt | undefined> {
    const random = rng(7);
    const root = mkdtempSync(join(tmpdir(), "walky-hold-"));
    roots.push(root);
    const world: World = { clock: 1_786_000_000_000, dead: false, crash: "none", outcome, calls: new Map(), typed: new Map(), store: new Map() };
    const walky = bridge(join(root, "walky"), world, [pane("%1")], random);
    const start = world.clock;
    await walky.send({ id: "wt_holdholdhold", to: "local/%1", body: "x", replyTo: null }, { kind: "operator", label: "phone" });
    await walky.deliverer.settled();
    if (outcome !== "held-released") expect(world.clock - start).toBeGreaterThanOrEqual(HELD_LIMIT_MS);
    return walky.status("wt_holdholdhold").receipts[0];
  }

  test("a hold the cancel took is `inbox-only`; one still pending after it is `unknown`, never `inbox-only`", async () => {
    expect(await held("held-cancels")).toMatchObject({ state: "inbox-only", reason: "held past 60 minutes" });
    expect(await held("held-stuck")).toMatchObject({ state: "unknown", reason: "held past 60 minutes, still pending" });
    expect(await held("held-released")).toMatchObject({ state: "delivered" });
  });

  test("recovery reads the Send Protocol by the derived send id, not the stored field", async () => {
    const random = rng(11);
    const root = mkdtempSync(join(tmpdir(), "walky-derived-"));
    roots.push(root);
    const dir = join(root, "walky");
    // Died after the send: the receipt on disk is `accepted` WITH a send id, but the recovery must not need it.
    const world: World = { clock: 1_786_000_000_000, dead: false, crash: "after-record", outcome: "sent", calls: new Map(), typed: new Map(), store: new Map() };
    const first = bridge(dir, world, [pane("%1")], random);
    await first.send({ id: "wt_derived00001", to: "local/%1", body: "x", replyTo: null }, { kind: "operator", label: "phone" });
    // The protocol took a send under the derived id anyway (another path: the receipt never landed).
    world.store.set(sendIdOf("wt_derived00001", "local/%1"), { outcome: "effective" });
    world.dead = false;
    world.crash = "none";
    const second = bridge(dir, world, [pane("%1")], random);
    expect(second.deliverer.recover()).toBe(1);
    await second.deliverer.settled();
    expect(second.status("wt_derived00001").receipts[0]).toMatchObject({ state: "delivered" });
  });
});
