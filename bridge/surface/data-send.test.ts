import { afterEach, describe, expect, test } from "bun:test";

import { dataId, dataRig, type DataRig } from "../inside/data-rig.ts";

const rigs: DataRig[] = [];
afterEach(() => {
  for (const made of rigs.splice(0)) made.stop();
});
async function rig(options: Partial<Parameters<typeof dataRig>[0]> = {}): Promise<DataRig> {
  const made = await dataRig({ harness: "claude", version: "2.1.200", ...options });
  rigs.push(made);
  return made;
}

describe("a send by data", () => {
  test("the part takes it and says sent: receipt sent, its request id, no call to the mux", async () => {
    const r = await rig();
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce();
    const answer = await r.send(id, "Reply with pong.");
    expect(await served).toEqual({ id, kind: "prompt", text: "Reply with pong." });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(answer.receipt?.requestId).toBe(id);
    expect(answer.receipt?.keys).toEqual([]);
    expect(r.mux.calls).toEqual([]);
    expect(r.store.get(id)?.path).toBe("data");
    expect(r.protocol.pathOf(id)).toBe("data");
    // The receipt is the same record the phone reads.
    expect(r.protocol.recent("w1:p1", 10).find((row) => row.requestId === id)?.outcome).toBe("sent");
  });

  test("the same id again is a replay of the stored receipt, never a second hand-over", async () => {
    const r = await rig();
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce();
    await r.send(id, "once");
    await served;
    const again = await r.send(id, "once");
    expect(again.replayed).toBe(true);
    expect(again.receipt?.outcome).toBe("sent");
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });

  test("a part that declares no send: the screen road, the data road never tried", async () => {
    const r = await rig();
    await r.part({ capabilities: ["wake"] });
    const id = dataId();
    await r.send(id, "hi");
    expect(r.mux.calls.length).toBeGreaterThan(0);
    expect(r.store.get(id)?.path).toBeUndefined();
  });

  test("the kill switch off: the screen road, no hand-over", async () => {
    const r = await rig({ enabled: false });
    const part = await r.part();
    const id = dataId();
    await r.send(id, "hi");
    expect(r.mux.calls.length).toBeGreaterThan(0);
    expect(r.hub.stateOf(id)).toBeNull();
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });

  test("a slash command keeps the screen road", async () => {
    const r = await rig();
    await r.part();
    const id = dataId();
    await r.send(id, "/compact", { mode: "command" });
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.mux.calls.length).toBeGreaterThan(0);
  });
});

describe("never twice", () => {
  test("not taken in time: withdrawn, and the screen road runs it once; the part never sees it", async () => {
    const r = await rig({ takeMs: 300 });
    const part = await r.part();
    const id = dataId();
    await r.send(id, "nobody polls");
    expect(r.hub.stateOf(id)).toBe("withdrawn");
    expect(r.store.get(id)?.path).toBe("screen");
    expect(r.mux.calls.filter((call) => call === "readGrid").length).toBeGreaterThan(0);
    // The part polls afterwards: nothing for it.
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });

  test("taken with no word: may have arrived, and nothing sends it again", async () => {
    const r = await rig({ wordMs: 500 });
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce({ silent: true });
    const answer = await r.send(id, "taken, no word");
    await served;
    expect(answer.receipt?.outcome).toBe("unknown");
    expect(answer.receipt?.reason).toBe("no_evidence");
    expect(r.mux.calls).toEqual([]);
    expect(r.hub.stateOf(id)).toBe("taken");
    expect(r.hub.withdraw(id)).toBe(false);
  });

  test("taken and failed: may have arrived, no key, nothing sent again", async () => {
    const r = await rig();
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce({ failReason: "submit" });
    const answer = await r.send(id, "fails");
    await served;
    expect(answer.receipt?.outcome).toBe("unknown");
    expect(answer.receipt?.reason).toBe("no_evidence");
    expect(r.mux.calls).toEqual([]);
  });
});

describe("a session with no bound part", () => {
  test("the screen road exactly as before: the data road is never tried, the record carries no road", async () => {
    const r = await rig();
    const id = dataId();
    await r.send(id, "hi");
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.store.get(id)?.path).toBeUndefined();
    expect(r.protocol.pathOf(id)).toBeNull();
    expect(r.mux.calls.length).toBeGreaterThan(0);
  });
});

describe("a turn the bridge does not know (M99 review item 6)", () => {
  test("a part that reported no turn since it bound: the screen road runs the send, the part never sees it", async () => {
    const r = await rig();
    const part = await r.part({}, { idle: false });
    const id = dataId();
    await r.send(id, "hi");
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.mux.calls.length).toBeGreaterThan(0);
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });

  test("its first turn event makes the turn known, and the next send goes by data", async () => {
    const r = await rig();
    const part = await r.part({}, { idle: false });
    await part.event("turn.end", { turn: "t0" });
    const id = dataId();
    const served = part.serveOnce();
    const answer = await r.send(id, "hi");
    expect((await served)?.id).toBe(id);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(r.mux.calls).toEqual([]);
  });
});
