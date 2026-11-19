// The slow cases of data-send.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, expect, test } from "bun:test";
import { DATA_PANE, dataDescribe, dataId, dataRig, type DataRig } from "../inside/data-rig.ts";

const rigs: DataRig[] = [];

afterEach(() => {
  for (const made of rigs.splice(0)) made.stop();
});

async function rig(options: Partial<Parameters<typeof dataRig>[0]> = {}): Promise<DataRig> {
  const made = await dataRig({ harness: "claude", version: "2.1.200", ...options });
  rigs.push(made);
  return made;
}

dataDescribe("a send by data", () => {
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

  test("the kill switch off: the screen road, no hand-over", async () => {
    const r = await rig({ enabled: false });
    const part = await r.part();
    const id = dataId();
    await r.send(id, "hi");
    expect(r.mux.calls.length).toBeGreaterThan(0);
    expect(r.hub.stateOf(id)).toBeNull();
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });
});

dataDescribe("never twice", () => {
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
    // The receipt the data road opened closed again (M102 spec 13): at most one open receipt answers to the id.
    const hash = r.store.hashText("nobody polls");
    const first = r.protocol.promptEdge("w1:p1", hash, Date.now());
    expect(r.protocol.promptEdge("w1:p1", hash, Date.now())).toBeNull();
    if (first !== null) expect(first).toBe(id);
  });

  test("taken and dropped (the agent said it entered nothing): the screen road runs it once, the record says screen", async () => {
    const r = await rig();
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce({ failReason: "dropped", failDetail: "a settings hook blocked it" });
    const answer = await r.send(id, "dropped by the agent");
    expect((await served)?.id).toBe(id);
    expect(r.hub.stateOf(id)).toBe("failed");
    expect(r.store.get(id)?.path).toBe("screen");
    expect(r.protocol.pathOf(id)).toBe("screen");
    // The screen road ran: it read the pane and settled the send itself.
    expect(r.mux.calls.filter((call) => call === "readGrid").length).toBeGreaterThan(0);
    expect(answer.receipt?.requestId).toBe(id);
    expect(answer.receipt?.outcome).not.toBe("unknown");
    // Nothing more for the part: one id, one road.
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });
});

dataDescribe("a turn the bridge does not know (M99 review item 6)", () => {
  test("a part that reported no turn since it bound: the screen road runs the send, the part never sees it", async () => {
    const r = await rig();
    const part = await r.part({}, { idle: false });
    const id = dataId();
    await r.send(id, "hi");
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.mux.calls.length).toBeGreaterThan(0);
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });
});

dataDescribe("a part shadowed by another agent process (the background job, 2026-11-16)", () => {
  // The rig's part is bound with this test process's pid; another live process of the pane writes the hooks.
  const OTHER = process.pid + 1;

  test("another process's hook edge on the pane: the send takes the screen road, the part never sees it", async () => {
    const r = await rig();
    const part = await r.part();
    r.hub.noteForeignEdge(DATA_PANE, OTHER, false);
    expect(r.hub.shadowed(DATA_PANE)).toBe(true);
    const id = dataId();
    await r.send(id, "goes by the screen");
    expect(r.hub.stateOf(id)).toBeNull();
    expect(r.store.get(id)?.path).toBeUndefined();
    expect(r.mux.calls.length).toBeGreaterThan(0);
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
  });
});
