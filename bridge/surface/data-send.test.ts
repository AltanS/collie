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
    // The same hash receipt as the screen road (M102 spec 13): the agent's prompt event settles it.
    expect(answer.receipt?.awaitingEventUntil).toBeGreaterThan(Date.now());
    expect(r.protocol.promptEdge("w1:p1", r.store.hashText("another text"), Date.now())).toBeNull();
    expect(r.protocol.promptEdge("w1:p1", r.store.hashText("taken, no word"), Date.now())).toBe(id);
    expect(r.store.get(id)?.receipt?.outcome).toBe("effective");
    expect(r.store.get(id)?.receipt?.awaitingEventUntil).toBeUndefined();
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
    // The part's word reaches the receipt, the stored record and the phone's answer, in plain words.
    expect(answer.receipt?.detail).toContain("reported a failure (submit)");
    expect(answer.detail).toBe(answer.receipt?.detail);
    expect(r.store.get(id)?.receipt?.detail).toBe(answer.receipt?.detail);
    expect(r.protocol.recent("w1:p1", 10).find((row) => row.requestId === id)?.detail).toBe(answer.receipt?.detail);
  });

  test("taken and failed with the part's own words: the detail names its reason and its words, never the text", async () => {
    const r = await rig();
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce({ failReason: "submit", failDetail: "TypeError: the session is not idle" });
    const answer = await r.send(id, "the secret words of the message");
    await served;
    expect(answer.receipt?.outcome).toBe("unknown");
    expect(answer.receipt?.reason).toBe("no_evidence");
    expect(answer.receipt?.detail).toContain("(submit: TypeError: the session is not idle)");
    expect(answer.receipt?.detail).not.toContain("secret words");
    expect(r.store.get(id)?.path).toBe("data");
    expect(r.mux.calls).toEqual([]);
  });

  test("taken with no word: the receipt carries no detail, as before", async () => {
    const r = await rig({ wordMs: 500 });
    const part = await r.part();
    const id = dataId();
    const served = part.serveOnce({ silent: true });
    const answer = await r.send(id, "taken, no word");
    await served;
    expect(answer.receipt?.outcome).toBe("unknown");
    expect(answer.receipt?.detail).toBeUndefined();
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

  test("a second tap of the same text after an unknown is a new request, on the data road again", async () => {
    const r = await rig();
    const part = await r.part();
    const first = dataId();
    const servedFirst = part.serveOnce({ failReason: "submit" });
    const one = await r.send(first, "same text");
    await servedFirst;
    expect(one.receipt?.outcome).toBe("unknown");
    const second = dataId();
    const servedSecond = part.serveOnce();
    const two = await r.send(second, "same text");
    expect((await servedSecond)?.id).toBe(second);
    expect(two.receipt?.outcome).toBe("sent");
    expect(r.mux.calls).toEqual([]);
  });
});

dataDescribe("a session with no bound part", () => {
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

  test("an edge of the part's own pid shadows nothing; the other process's end lifts the shadow", async () => {
    const r = await rig();
    const part = await r.part();
    r.hub.noteForeignEdge(DATA_PANE, process.pid, false);
    expect(r.hub.shadowed(DATA_PANE)).toBe(false);
    r.hub.noteForeignEdge(DATA_PANE, OTHER, false);
    r.hub.noteForeignEdge(DATA_PANE, OTHER + 1, true);
    expect(r.hub.shadowed(DATA_PANE)).toBe(true);
    r.hub.noteForeignEdge(DATA_PANE, OTHER, true);
    expect(r.hub.shadowed(DATA_PANE)).toBe(false);
    const id = dataId();
    const served = part.serveOnce();
    const answer = await r.send(id, "by data again");
    expect((await served)?.id).toBe(id);
    expect(answer.receipt?.outcome).toBe("sent");
    expect(r.mux.calls).toEqual([]);
  });

  test("a new hello is a new part with no shadow; a pane with no part is never shadowed", async () => {
    const r = await rig();
    r.hub.noteForeignEdge(DATA_PANE, OTHER, false);
    expect(r.hub.shadowed(DATA_PANE)).toBe(false);
    await r.part();
    r.hub.noteForeignEdge(DATA_PANE, OTHER, false);
    expect(r.hub.shadowed(DATA_PANE)).toBe(true);
    await r.part();
    expect(r.hub.shadowed(DATA_PANE)).toBe(false);
  });
});
