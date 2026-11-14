// A part's word on the data road that never arrived (M100 spec 05).
//
// The part posts `turn.end` and `draft.state` over the inside socket, and any one post can be lost: a
// time-out, a 429 past the burst, a bridge that was busy. These tests drop such a post and show what the
// next phone send and the next WalkyTalky message to that pane do. A word the bridge took holds for
// WORD_FRESH_MS; an older "running" or "draft present" reads as unknown, and unknown takes the screen
// road, which reads the turn and the box itself. Each word carries the part's count (`seq`), so a late
// word never undoes a newer one.

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_PANE, dataDescribe, dataId, dataRig, type DataRig } from "./data-rig.ts";
import { WORD_FRESH_MS } from "./hub.ts";
import { PART_RATE_BURST } from "./server.ts";
import { paneLinkedReader } from "../surface/path.ts";

/** A captured Claude Code screen whose box holds the person's draft: the screen road reads `composer: draft`. */
const DRAFT_SCREEN = readFileSync(join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", "claude--draft-footer-single.txt"), "utf8");

const rigs: DataRig[] = [];
afterEach(() => {
  for (const made of rigs.splice(0)) made.stop();
});

/** A rig whose hub reads a clock the test moves. */
async function rig(): Promise<{ r: DataRig; clock: { at: number } }> {
  const clock = { at: 1_000_000 };
  const r = await dataRig({ harness: "claude", version: "2.1.200", now: () => clock.at });
  rigs.push(r);
  return { r, clock };
}

/** A WalkyTalky delivery, as walky hands it to the Send Protocol. */
const mail = (r: DataRig, id: string, text: string) => r.send(id, text, { fromPhone: false, draftHolds: true });

dataDescribe("a lost turn.end", () => {
  test("a phone send after the running word grew old takes the screen road, which reads the turn itself", async () => {
    const { r, clock } = await rig();
    const part = await r.part();
    await part.event("turn.start", { turn: "t1", seq: 1 });
    // The turn ends at the desk; its `turn.end` (seq 2) never reaches the bridge.
    clock.at += WORD_FRESH_MS + 1;
    const id = dataId();
    await r.send(id, "after the turn");
    expect(r.hub.stateOf(id)).toBeNull();
    // The rig's screen answers nothing; the point is that the screen road ran, not the data road's hold.
    expect(r.mux.calls).toContain("readGrid");
    expect(r.protocol.heldOf(DATA_PANE.session, DATA_PANE.paneId)).toEqual([]);
  });

  test("a phone send held on the fresh word is not stuck: its next release takes the screen road", async () => {
    const { r, clock } = await rig();
    const part = await r.part();
    await part.event("turn.start", { turn: "t1", seq: 1 });
    const held = dataId();
    expect((await r.send(held, "after the turn")).receipt?.outcome).toBe("held");
    // While the word is fresh a release (the poll's, or any other) puts it back: the turn runs.
    await r.protocol.releaseOnTurnEnd(DATA_PANE.session, DATA_PANE.paneId);
    expect(r.protocol.heldOf(DATA_PANE.session, DATA_PANE.paneId).map((row) => row.requestId)).toEqual([held]);
    expect(r.mux.calls).toEqual([]);
    clock.at += WORD_FRESH_MS + 1;
    await r.protocol.releaseOnTurnEnd(DATA_PANE.session, DATA_PANE.paneId);
    expect(r.mux.calls).toContain("readGrid");
    expect(r.hub.stateOf(held)).toBeNull();
  });

  test("a WalkyTalky message held on the fresh word takes the screen road once the word is old", async () => {
    const { r, clock } = await rig();
    const part = await r.part({}, { draft: false });
    await part.event("turn.start", { turn: "t1", seq: 1 });
    const first = dataId();
    expect((await mail(r, first, "[walky-talky wt_x] hello")).receipt?.outcome).toBe("held");
    expect(r.holds.get(first)?.cause).toBe("turn_running");
    expect(r.mux.calls).toEqual([]);
    clock.at += WORD_FRESH_MS + 1;
    await r.protocol.releaseOnTurnEnd(DATA_PANE.session, DATA_PANE.paneId);
    expect(r.hub.stateOf(first)).toBeNull();
    expect(r.mux.calls).toContain("readGrid");
  });

  test("the word said again goes by data at once: the next send is handed to the part", async () => {
    const { r } = await rig();
    const part = await r.part();
    await part.event("turn.start", { turn: "t1", seq: 1 });
    // The part's retry of its lost word, with the count it had.
    await part.event("turn.end", { turn: "t1", reason: "answer", seq: 2 });
    const id = dataId();
    const served = part.serveOnce();
    expect((await r.send(id, "now")).receipt?.outcome).toBe("sent");
    expect((await served)?.id).toBe(id);
    expect(r.mux.calls).toEqual([]);
  });

  test("a turn.end refused 429 past the burst is a real loss; its retry a second later lands", async () => {
    const { r } = await rig();
    const part = await r.part();
    await part.event("turn.start", { turn: "t1", seq: 1 });
    // A burst of rows spends the part's bucket, so the turn end right after it is refused.
    for (let i = 0; i < PART_RATE_BURST; i += 1) await part.event("row", { door: "response" });
    expect((await part.event("turn.end", { turn: "t1", seq: 2 })).status).toBe(429);
    expect(r.hub.turnOf(DATA_PANE)).toBe("running");
    await Bun.sleep(1100);
    expect((await part.event("turn.end", { turn: "t1", seq: 2 })).status).toBe(204);
    expect(r.hub.turnOf(DATA_PANE)).toBe("idle");
  });
});

dataDescribe("a lost draft cleared", () => {
  test("a WalkyTalky message is held over the draft while the word is fresh, then the screen road reads the box", async () => {
    const { r, clock } = await rig();
    const part = await r.part({}, { idle: true });
    await part.event("draft.state", { present: true, seq: 1 });
    // The person sends their draft; the box is empty, but the "no draft" word (seq 2) is lost.
    const first = dataId();
    expect((await mail(r, first, "[walky-talky wt_x] hello")).receipt?.outcome).toBe("held");
    expect(r.holds.get(first)?.cause).toBe("draft_present");
    expect(r.hub.stateOf(first)).toBeNull();
    expect(r.mux.calls).toEqual([]);
    // The release on the screen's own "draft left" rule puts it back while the word is fresh.
    await r.protocol.releaseOnTurnEnd(DATA_PANE.session, DATA_PANE.paneId);
    expect(r.mux.calls).toEqual([]);
    clock.at += WORD_FRESH_MS + 1;
    await r.protocol.releaseOnTurnEnd(DATA_PANE.session, DATA_PANE.paneId);
    expect(r.hub.stateOf(first)).toBeNull();
    expect(r.mux.calls).toContain("readGrid");
  });

  test("the word said again lets the next message go to the part as mail", async () => {
    const { r } = await rig();
    const part = await r.part({}, { idle: true });
    await part.event("draft.state", { present: true, seq: 1 });
    await part.event("draft.state", { present: false, seq: 2 });
    const id = dataId();
    const served = part.serveOnce();
    expect((await mail(r, id, "[walky-talky wt_z] hello")).receipt?.outcome).toBe("sent");
    expect((await served)?.kind).toBe("mail");
    expect(r.mux.calls).toEqual([]);
  });
});

dataDescribe("a draft that stays in the box past the word's age", () => {
  test("a message sent then is held by the screen's read of the box; the pane stays linked, and Deliver now still goes by data", async () => {
    const { r, clock } = await rig();
    r.mux.screen = DRAFT_SCREEN;
    const part = await r.part({}, { idle: true });
    await part.event("draft.state", { present: true, seq: 1 });
    clock.at += WORD_FRESH_MS + 1;
    // (c) The age picks a road; it never unlinks the pane.
    expect(paneLinkedReader({ enabled: () => true, hub: r.hub })(DATA_PANE.session, DATA_PANE.paneId)).toBe(true);
    const id = dataId();
    expect((await mail(r, id, "[walky-talky wt_x] hello")).receipt?.outcome).toBe("held");
    expect(r.holds.get(id)).toMatchObject({ state: "held", draftHolds: true, cause: "draft_present" });
    expect(r.mux.calls.every((call) => call === "readGrid")).toBe(true);
    const served = part.serveOnce({ waitMs: 3000 });
    expect((await r.protocol.deliverOverDraft(DATA_PANE.session, DATA_PANE.paneId, id)).result).toBe("sent");
    expect(await served).toMatchObject({ id, kind: "mail", overDraft: true });
    expect(r.mux.calls.every((call) => call === "readGrid")).toBe(true);
  });
});

dataDescribe("the order and the age of a part's word", () => {
  test("a late word never undoes a newer one; a part with no count is taken in arrival order", async () => {
    const { r } = await rig();
    const part = await r.part({}, { idle: false });
    await part.event("turn.start", { turn: "t1", seq: 1 });
    await part.event("turn.end", { turn: "t1", seq: 2 });
    // The retry of the start arrives after the end.
    await part.event("turn.start", { turn: "t1", seq: 1 });
    expect(r.hub.turnOf(DATA_PANE)).toBe("idle");
    await part.event("draft.state", { present: true, seq: 3 });
    await part.event("draft.state", { present: false, seq: 4 });
    await part.event("draft.state", { present: true, seq: 3 });
    expect(r.hub.draftOf(DATA_PANE)).toBe(false);
    // An older part: no `seq`, so the last to arrive is the word.
    const old = await r.part({}, { idle: false });
    await old.event("turn.end", { turn: "t2" });
    await old.event("turn.start", { turn: "t2" });
    expect(r.hub.turnOf(DATA_PANE)).toBe("running");
  });

  test("a stored row keeps a running word fresh; 'idle' and 'no draft' never grow old", async () => {
    const { r, clock } = await rig();
    const part = await r.part({}, { idle: false, draft: false });
    await part.event("turn.start", { turn: "t1", seq: 1 });
    clock.at += WORD_FRESH_MS - 1000;
    await part.event("row", { door: "tool-result" });
    clock.at += WORD_FRESH_MS - 1000;
    expect(r.hub.turnOf(DATA_PANE)).toBe("running");
    clock.at += 2000;
    expect(r.hub.turnOf(DATA_PANE)).toBeNull();
    // Read for a caller that never sends on it (Deliver now, the release on "no draft"): still running.
    expect(r.hub.turnOf(DATA_PANE, { anyAge: true })).toBe("running");
    await part.event("turn.end", { turn: "t1", seq: 2 });
    clock.at += 10 * WORD_FRESH_MS;
    expect(r.hub.turnOf(DATA_PANE)).toBe("idle");
    expect(r.hub.draftOf(DATA_PANE)).toBe(false);
  });
});
