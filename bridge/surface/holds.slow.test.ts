// The slow cases of holds.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakePart } from "../inside/fake-part.ts";
import { dataDescribe, dataId, dataRig, type DataRig } from "../inside/data-rig.ts";

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "collie-holds-")), "held");
});

afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

// ── The data road holds as the screen road does (M99 spec 03) ──

dataDescribe("a data send while the part's turn runs", () => {
  const rigs: DataRig[] = [];

  afterEach(() => {
    for (const rig of rigs.splice(0)) rig.stop();
  });

  async function running(): Promise<{ r: DataRig; part: FakePart }> {
    const r = await dataRig({ harness: "claude", version: "2.1.200" });
    rigs.push(r);
    const part = await r.part();
    // The bridge's wiring: a part's turn end releases its pane's oldest held send (bridge/index.ts).
    r.hub.listen({ event: (bound, event) => void (event.kind === "turn.end" ? r.protocol.releaseOnTurnEnd(bound.address.session, bound.address.paneId) : null) });
    await part.event("turn.start", { turn: "t1" });
    return { r, part };
  }

  test("is held in the bridge's queue, with the held receipt and no hand-over, no key", async () => {
    const { r, part } = await running();
    const id = dataId();
    const answer = await r.send(id, "after the turn");
    expect(answer.receipt?.outcome).toBe("held");
    expect(r.protocol.heldOf("main", "w1:p1").map((row) => row.requestId)).toEqual([id]);
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.mux.calls).toEqual([]);
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });

  test("Cancel works while it is held, and the turn end then sends nothing", async () => {
    const { r, part } = await running();
    const id = dataId();
    await r.send(id, "never mind");
    expect(r.protocol.cancelHeld("main", "w1:p1", id)?.result).toBe("cancelled");
    await part.event("turn.end", { turn: "t1", reason: "answer" });
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.store.get(id)?.receipt?.outcome).toBe("cancelled");
  });
});
