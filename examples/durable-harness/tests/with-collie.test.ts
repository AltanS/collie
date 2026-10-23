// withCollie's opener (M66 spec 03): each session gets a registry of its own that follows the program's and ends with
// the guard, and an opener that does not open the Harness with it fails closed. The guard itself is tested through the
// route in route.test.ts (askThroughJournal) and on a real Harness in real-harness.test.ts.
import { describe, expect, test } from "bun:test";
import { createRegistry, defineExtension, type Harness, type Registry } from "@earendil-works/pi-durable";
import { api } from "../../durable-member/tests/client.ts";
import { paneIdOfRun } from "../../../packages/durable-sdk/src/durable-harness/pi-source.ts";
import { askThroughJournal, GUARD, withCollie } from "../../../packages/durable-sdk/src/durable-harness/with-collie.ts";
import type { WorldStorage } from "../../../packages/durable-sdk/src/durable-harness/world-port.ts";
import { assistantEntry, FakeWorld, userEntry } from "./fake-world.ts";
import { FakeSession, rig, until } from "./rig.ts";

const world = new FakeWorld();
// SAFETY: the opener reads `sessionId`, `isFenced` and `signal`; the journal comes from the `journal` option, not `world`.
const storage = (id: string) => new FakeSession(id) as unknown as WorldStorage;
let closed = 0;
// SAFETY: withCollie calls `close` on a Harness it refuses, and nothing else.
const harness = { close: async () => void closed++ } as unknown as Harness;
const names = (r: Registry) => r.snapshot().installed().map((e) => e.name);

describe("withCollie", () => {
  test("a session's registry is the program's extensions, then the guard, and follows the program's registry", async () => {
    const base = createRegistry();
    base.install(defineExtension({ name: "tools" }));
    let seen: Registry | undefined;
    const open = withCollie(async (_s, registry) => ((seen = registry), names(registry), harness), { registry: base, risky: new Set(["refund"]), journal: () => world.port() });
    await open(storage("wrun_01A"));
    expect(names(seen!)).toEqual(["tools", GUARD]);
    base.install(defineExtension({ name: "more" }));
    expect(names(seen!)).toEqual(["tools", "more", GUARD]);
    base.uninstall({ name: "tools" } as never);
    expect(names(seen!)).toEqual(["more", GUARD]);
  });

  test("an opener that never reads the registry it was given fails closed: no Harness without the guard", async () => {
    const before = closed;
    const open = withCollie(async () => harness, { registry: createRegistry(), risky: new Set(["refund"]), journal: () => world.port() });
    expect(open(storage("wrun_01B"))).rejects.toThrow(/did not open the Harness with the registry withCollie gave it/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(before + 1);
  });
});

describe("the guard's poll", () => {
  const FAST = { pollMs: { first: 5, max: 20 } };
  const idle = { eventCount: 4, entries: [userEntry(1, "refund 5521"), assistantEntry(3, "On it.")] };
  const reads = (w: FakeWorld) => w.calls.filter((c) => c === "streams.getChunks").length;
  const guardOn = (w: FakeWorld, run: string, session: FakeSession, errors: number[] = []) =>
    askThroughJournal({ id: "call-1", name: "refund", arguments: { order: "5521" } }, session, w.port(), { ...FAST, onReadError: (_e, n) => errors.push(n) });

  test("a read that fails twice inside the wait is retried: the answer that follows still allows", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    const errors: number[] = [];
    const decided = guardOn(r.world, run, new FakeSession(run), errors);
    await until("the ask in the journal", () => (r.world.chunks.size > 0 ? true : undefined));
    const ask = await until("the ask on the phone", async () => (await api.snapshot(r.dial())).body.panes.find((p) => p.id === paneIdOfRun(run))?.openAsks[0]);
    r.world.down = true; // the World is unreachable for the guard's next reads
    await until("two failed reads", () => (errors.length >= 2 ? true : undefined));
    r.world.down = false;
    expect((await api.answer(r.dial(), paneIdOfRun(run), ask.id, "allow")).body).toEqual({ result: "taken" });
    expect(await decided).toBeUndefined();
    expect(errors.slice(0, 2)).toEqual([1, 2]);
  });

  test("a read that fails for ever is never a verdict: it ends only with the session, as the lost-session block", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    const session = new FakeSession(run);
    const errors: number[] = [];
    const decided = guardOn(r.world, run, session, errors);
    await until("the ask in the journal", () => (r.world.chunks.size > 0 ? true : undefined));
    r.world.down = true;
    await until("five failed reads", () => (errors.length >= 5 ? true : undefined));
    const before = reads(r.world);
    session.fence();
    expect(await decided).toEqual({ block: "this process lost the session" });
    expect(reads(r.world)).toBe(before);
  });

  test("the first read, before the wait, still throws when the World is down: nothing is written", async () => {
    const r = rig();
    const run = r.world.addRun({ session: idle });
    r.world.down = true;
    expect(guardOn(r.world, run, new FakeSession(run))).rejects.toThrow(/unreachable/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.world.chunks.size).toBe(0);
  });
});
