// withCollie's opener (M66 spec 03): each session gets a registry of its own that follows the program's and ends with
// the guard, and an opener that does not open the Harness with it fails closed. The guard itself is tested through the
// route in route.test.ts (askThroughJournal) and on a real Harness in real-harness.test.ts.
import { describe, expect, test } from "bun:test";
import { createRegistry, defineExtension, type Harness, type Registry } from "@earendil-works/pi-durable";
import { GUARD, withCollie } from "../../../packages/durable-sdk/src/durable-harness/with-collie.ts";
import type { WorldStorage } from "../../../packages/durable-sdk/src/durable-harness/world-port.ts";
import { FakeWorld } from "./fake-world.ts";
import { FakeSession } from "./rig.ts";

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
