// The Send Protocol against the scripted fake multiplexer: part queued. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, profileFor, type Profile, type PopupRule } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer, RETURNED_CARD_DROPPED } from "../../web/src/lib/surface/send.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { type SurfaceTurn } from "../../web/src/lib/surface/surface.ts";
import { KeyGate } from "./key-gate.ts";
import { BOX_CHANGED, STALE_SCREEN, type SendDeps } from "./protocol.ts";
import { HoldStore } from "./holds.ts";
import { StopService } from "./stop.ts";
import { AuditLog } from "../audit.ts";
import { heldCancelRoute, sendRoute, type SendRouteRuntime } from "../server.ts";
import { QUEUED_SEND_MS, type BoxReading } from "./queued.ts";
import { OFFERED, FakePane, OmpPane, QueueingOmpPane, type Rig, dir, fixture, neverEscape, omp, rig, useScratchDir, words } from "./protocol.rig.ts";

useScratchDir();

describe("a queued send that comes back to the box (ADR 0122)", () => {
  /** The OMP pane as the poll's Surface read reads it: the box ("" when empty, null with none) and the turn. */
  function look(pane: FakePane, at: number, poll = true): BoxReading {
    const match = profileFor("omp", "18.6.1", { log: () => undefined })!;
    const rows = splitLines(parseAnsi(pane.render()));
    const read = surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 0, rows, ask: null }, match.profile.idle);
    const box = read.frame === null ? null : read.frame.placeholder ? "" : read.frame.interior.text;
    return { box, at, turn: read.surface.turn, poll };
  }
  /** A read stated by hand: an idle poll over this box at this time, unless told otherwise. */
  const reading = (box: string | null, at: number, turn: SurfaceTurn = "idle", poll = true): BoxReading => ({ box, at, turn, poll });

  /** OMP's Escape on a turn with a queue: the turn ends and the queued texts go back into the box. */
  function stopGivesBack(pane: OmpPane): void {
    pane.inTurn = false;
    pane.box = pane.queued.join("\n");
    pane.queued = [];
    pane.revision++;
  }

  /** A runtime for `sendRoute` and `heldCancelRoute` over the rig's own protocol. */
  interface RouteRig {
    rt: SendRouteRuntime;
    context: { audit: AuditLog; device: string; redact: boolean; acceptEncoding: null };
    lines: string[];
  }
  function routeOf(r: Rig): RouteRig {
    const rt: SendRouteRuntime = {
      send: r.protocol,
      name: "main",
      herdr: {},
      engine: { current: () => ({ agents: [{ paneId: "%1", agent: "omp" }], shellPanes: [] }), noteInput: () => undefined, pokeNow: () => undefined },
    };
    const lines: string[] = [];
    return { rt, context: { audit: new AuditLog((line) => void lines.push(line)), device: "phone", redact: true, acceptEncoding: null }, lines };
  }

  /** One queued send, then OMP's Stop gives it back, then a poll reads the box: a returned card. */
  async function returnedCard(id: string, text = "second message"): Promise<Rig & { pane: OmpPane }> {
    const r = omp();
    r.pane.inTurn = true;
    await r.send(text, { id });
    stopGivesBack(r.pane);
    r.clock.now += 1_500;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual([id]);
    return r;
  }

  test("a send into a running turn is a queued card with its text, and a running read keeps it queued", async () => {
    const r = omp();
    r.pane.inTurn = true;
    const answer = await r.send("second message", { id: "queued-back-0001" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(r.protocol.queuedOf("main", "%1")).toEqual([{ requestId: "queued-back-0001", text: "second message", at: r.clock.now, state: "queued" }]);
    r.clock.now += 2_000;
    const busy = look(r.pane, r.clock.now);
    expect(busy).toMatchObject({ box: "", turn: "running" });
    expect(r.protocol.boxRead("main", "%1", busy)).toEqual([]);
    expect(r.protocol.queuedOf("main", "%1")[0]?.state).toBe("queued");
  });

  test("after Stop, a read whose box holds the queued text marks the card returned and the receipt late, once", async () => {
    const r = await returnedCard("queued-back-0002");
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-back-0002", state: "returned" }]);
    // The receipt is revised, not rewritten: `sent` and `queued` were true when it settled.
    expect(r.deps.store.get("queued-back-0002")?.receipt).toMatchObject({ outcome: "sent", queued: true, late: "returned" });
    expect(r.protocol.recent("%1")[0]).toMatchObject({ requestId: "queued-back-0002", outcome: "sent", queued: true, late: "returned" });
    r.clock.now += 1_000;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual(["queued-back-0002"]);
    expect(r.protocol.returnedSource("main", "%1", "queued-back-0002")).toBe("second message");
    expect(r.protocol.returnedSource("main", "%2", "queued-back-0002")).toBeNull();
  });

  test("Send on the card: the box holds one copy, so only the profile's submit key goes in, no retype, and it lands once", async () => {
    const r = await returnedCard("queued-back-0003");
    const { rt, context } = routeOf(r);
    const calls = r.pane.calls.length;
    const keys = r.pane.keysSeen.length;
    const res = await sendRoute(rt, { id: "queued-back-0004", pane: "%1", text: "", mode: "submit", resendOf: "queued-back-0003" }, context);
    // OMP's profile names Ctrl+Q as the submit key of an idle box (its Enter steers a turn).
    // The returned row is proven first (2026-10-25): the probe and its Backspace, then the submit key.
    expect(await res.json()).toMatchObject({ receipt: { requestId: "queued-back-0004", outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] } });
    expect(r.pane.keysSeen.slice(keys)).toEqual(["Backspace", "ctrl+q"]);
    expect(r.pane.calls.slice(calls).filter((call) => call.startsWith("type:") || call.startsWith("paste:"))).toEqual(["type:⌁"]);
    expect(r.pane.transcript.filter((row) => row === " > second message")).toHaveLength(1);
    expect(r.pane.box).toBe("");
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
    expect(r.deps.store.get("queued-back-0003")?.receipt?.late).toBe("returned");
  });

  test("a stale card after a submit at the desk refuses and never sends twice", async () => {
    const r = await returnedCard("queued-back-0005");
    // The person sent it at the desk before the phone's next poll: the box is empty, the card still stands.
    await r.pane.writeKeys("%1", ["ctrl+q"]);
    expect(r.pane.transcript.filter((row) => row === " > second message")).toHaveLength(1);
    const { rt, context } = routeOf(r);
    const keys = r.pane.keysSeen.length;
    const res = await sendRoute(rt, { id: "queued-back-0006", pane: "%1", text: "", mode: "submit", resendOf: "queued-back-0005" }, context);
    expect(await res.json()).toMatchObject({ receipt: { outcome: "refused", reason: "not_free", detail: BOX_CHANGED } });
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.pane.transcript.filter((row) => row === " > second message")).toHaveLength(1);
    // The next poll sees the box without it, and the card ends.
    r.clock.now += 1_000;
    r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("Send on the card refuses while the turn runs again, and presses nothing", async () => {
    const r = await returnedCard("queued-back-0007");
    r.pane.inTurn = true;
    r.pane.revision++;
    const { rt, context } = routeOf(r);
    const keys = r.pane.keysSeen.length;
    const res = await sendRoute(rt, { id: "queued-back-0008", pane: "%1", text: "", mode: "submit", resendOf: "queued-back-0007" }, context);
    expect(await res.json()).toMatchObject({ receipt: { outcome: "refused", reason: "not_free" } });
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.pane.box).toBe("second message");
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ state: "returned" }]);
  });

  test("the bridge's own text goes, never the phone's masked copy; a plain resendOf of a card is a 404", async () => {
    const r = await returnedCard("queued-back-0020", "deploy with the real name");
    const { rt, context, lines } = routeOf(r);
    expect((await sendRoute(rt, { id: "queued-back-0021", pane: "%1", text: "", resendOf: "queued-back-0020" }, context)).status).toBe(404);
    const res = await sendRoute(rt, { id: "queued-back-0022", pane: "%1", text: "", mode: "submit", resendOf: "queued-back-0020" }, context);
    expect(await res.json()).toMatchObject({ receipt: { outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] } });
    expect(r.pane.transcript.at(-1)).toBe(" > deploy with the real name");
    expect(lines.join("\n")).not.toContain("real name");
  });

  test("Discard on the card: a fresh read shows the text, so the profile's clear key empties the box and nothing is sent", async () => {
    const r = await returnedCard("queued-back-0023");
    const { rt, context } = routeOf(r);
    const transcript = r.pane.transcript.length;
    const res = await sendRoute(rt, { id: "queued-back-0024", pane: "%1", text: "", mode: "discard", resendOf: "queued-back-0023" }, context);
    expect(await res.json()).toMatchObject({ receipt: { outcome: "discarded" } });
    expect(r.pane.box).toBe("");
    expect(r.pane.transcript).toHaveLength(transcript);
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("a returned row is a reading: on a frozen frame, Send and Discard are refused stale_screen, never sent or discarded", async () => {
    // Altan's OMP 18.6.1 pane, 2026-10-25: a bottom frame can stay drawn after the live editor moved
    // (a resize that never reached a background pane). The card's buttons prove the box first: a probe
    // that shows nowhere, and a second S0 read of the same rows, end the request before any other key.
    for (const mode of ["submit", "discard"] as const) {
      const r = await returnedCard(`queued-stale-${mode}-1`);
      // Every key and every text goes nowhere the screen shows.
      r.pane.beforeWrite = (p, what) => {
        p.calls.push(what);
        return Promise.resolve();
      };
      const { rt, context } = routeOf(r);
      const transcript = r.pane.transcript.length;
      const res = await sendRoute(rt, { id: `queued-stale-${mode}-2`, pane: "%1", text: "", mode, resendOf: `queued-stale-${mode}-1` }, context);
      // SAFETY: the send route answers a SendAnswer body; only its receipt, detail and offers are read.
      const answer = (await res.json()) as SendAnswer;
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
      expect(answer.receipt?.detail).toStartWith(STALE_SCREEN);
      expect(answer.offers).toEqual(["keys"]);
      expect(r.pane.transcript).toHaveLength(transcript);
      expect(r.pane.box).toBe("second message");
    }
  });

  test("Discard on a card whose box changed presses nothing, drops only the card, and the answer says so", async () => {
    const r = await returnedCard("queued-back-0025");
    // The person edited the text at the desk.
    r.pane.box = "second message, and more";
    r.pane.revision++;
    const { rt, context } = routeOf(r);
    const keys = r.pane.keysSeen.length;
    const calls = r.pane.calls.length;
    const res = await sendRoute(rt, { id: "queued-back-0026", pane: "%1", text: "", mode: "discard", resendOf: "queued-back-0025" }, context);
    expect(await res.json()).toMatchObject({ receipt: { outcome: "refused", reason: "not_free", detail: RETURNED_CARD_DROPPED } });
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.pane.calls.slice(calls)).toEqual([]);
    expect(r.pane.box).toBe("second message, and more");
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("two texts given back together are ONE card with the joined text; its Send submits the box once", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("alpha one", { id: "queued-back-0030" });
    r.clock.now += 3_000;
    await r.send("beta two", { id: "queued-back-0031" });
    stopGivesBack(r.pane);
    r.clock.now += 1_000;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual(["queued-back-0030", "queued-back-0031"]);
    const cards = r.protocol.queuedOf("main", "%1");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ requestId: "queued-back-0030", text: "alpha one\nbeta two", state: "returned" });
    // Only the card's own id acts.
    expect(r.protocol.returnedSource("main", "%1", "queued-back-0031")).toBeNull();
    const { rt, context } = routeOf(r);
    const res = await sendRoute(rt, { id: "queued-back-0032", pane: "%1", text: "", mode: "submit", resendOf: "queued-back-0030" }, context);
    expect(await res.json()).toMatchObject({ receipt: { outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] } });
    expect(r.pane.transcript.at(-1)).toBe(" > alpha one beta two");
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
    expect(r.deps.store.get("queued-back-0031")?.receipt?.late).toBe("returned");
  });

  test("a box with other text returns none", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("alpha one", { id: "queued-back-0033" });
    r.clock.now += 1_000;
    expect(r.protocol.boxRead("main", "%1", reading("alpha one and more I typed", r.clock.now))).toEqual([]);
    expect(r.deps.store.get("queued-back-0033")?.receipt?.late).toBeUndefined();
  });

  test("a read taken before the send settled, or while a send holds the pane, or with no box, changes nothing", async () => {
    const r = omp();
    r.pane.inTurn = true;
    const before = r.clock.now;
    await r.send("second message", { id: "queued-back-0034" });
    // The poll read the box while S1 had the text in it: an older read than the settle.
    expect(r.protocol.boxRead("main", "%1", reading("second message", before))).toEqual([]);
    r.deps.locks.acquire("main\u0000%1", "another-request", r.clock.now + 5_000, r.clock.now);
    r.clock.now += 1_000;
    expect(r.protocol.boxRead("main", "%1", reading("second message", r.clock.now))).toEqual([]);
    r.deps.locks.release("main\u0000%1", "another-request");
    expect(r.protocol.boxRead("main", "%1", reading(null, r.clock.now))).toEqual([]);
    expect(r.protocol.queuedOf("main", "%1")[0]?.state).toBe("queued");
    expect(r.protocol.boxRead("main", "%1", reading("second message", r.clock.now))).toEqual(["queued-back-0034"]);
  });

  test("a prompt edge that confirms the send closes its card; a pane that holds another agent lists none", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("second message", { id: "queued-back-0035" });
    const hash = r.deps.store.hashText("second message");
    expect(r.protocol.promptEdge("%1", hash, r.clock.now + 1_000)).toBe("queued-back-0035");
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
    let generation = "gen-1";
    const otherPane = new OmpPane();
    const other = rig({ pane: otherPane, harness: "omp", version: "18.6.1", generation: () => generation });
    otherPane.inTurn = true;
    await other.send("second message", { id: "queued-back-0036" });
    expect(other.protocol.queuedOf("main", "%1")).toHaveLength(1);
    generation = "codex:other-session";
    expect(other.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("the clock counts from the last busy read: a long turn keeps its card; past the bound it turns unconfirmed, never gone", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("second message", { id: "queued-back-0037" });
    // Fifty minutes of a running turn, read every ten minutes.
    for (let i = 0; i < 5; i++) {
      r.clock.now += 10 * 60_000;
      r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    }
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ state: "queued" }]);
    // No busy read for the bound: Collie can no longer tell.
    r.clock.now += QUEUED_SEND_MS + 1;
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-back-0037", state: "unconfirmed" }]);
    // An unconfirmed card ends one more bound later.
    r.clock.now += QUEUED_SEND_MS;
    expect(r.protocol.queuedOf("main", "%1")).toHaveLength(1);
    r.clock.now += 1;
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("two polls of an idle turn over an empty box turn a queued card unconfirmed; a Stop's read-backs do not count", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("second message", { id: "queued-back-0038" });
    // The text went somewhere Collie did not see (the harness dropped it): idle, and an empty box.
    r.pane.inTurn = false;
    r.pane.queued = [];
    r.pane.revision++;
    for (const at of [500, 1_400, 2_400]) expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now + at, false))).toEqual([]);
    expect(r.protocol.queuedOf("main", "%1")[0]?.state).toBe("queued");
    r.clock.now += 3_000;
    r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    expect(r.protocol.queuedOf("main", "%1")[0]?.state).toBe("queued");
    // A running poll in between starts the count again.
    r.clock.now += 1_000;
    r.protocol.boxRead("main", "%1", reading("", r.clock.now, "running"));
    r.clock.now += 1_000;
    r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    expect(r.protocol.queuedOf("main", "%1")[0]?.state).toBe("queued");
    r.clock.now += 1_000;
    r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-back-0038", state: "unconfirmed" }]);
    // The text showing in the box after all makes it returned.
    r.clock.now += 1_000;
    expect(r.protocol.boxRead("main", "%1", reading("second message", r.clock.now))).toEqual(["queued-back-0038"]);
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ state: "returned" }]);
  });

  test("Discard on an unconfirmed card drops it through the held-cancel route and presses nothing; a queued card is not dropped", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("second message", { id: "queued-back-0039" });
    const { rt, context } = routeOf(r);
    // Still queued: the old answer stands (the send went out, its receipt says so), and the card stays.
    expect(await heldCancelRoute(rt, "queued-back-0039", "%1", context).json()).toMatchObject({ result: "refused", reason: "busy" });
    expect(r.protocol.queuedOf("main", "%1")).toHaveLength(1);
    r.clock.now += QUEUED_SEND_MS + 1;
    expect(r.protocol.queuedOf("main", "%1")[0]?.state).toBe("unconfirmed");
    const keys = r.pane.keysSeen.length;
    expect(await heldCancelRoute(rt, "queued-back-0039", "%1", context).json()).toEqual({ result: "dismissed" });
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("Stop's read-back sees the text back in the box: the receipt lists it, and the card and the receipt say returned", async () => {
    const r = omp();
    r.pane.inTurn = true;
    await r.send("second message", { id: "queued-back-0040" });
    const keys = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, pressed) => {
      if (pressed.includes("Escape") && r.pane instanceof OmpPane) stopGivesBack(r.pane);
      return keys(paneId, pressed.filter((key) => key !== "Escape"));
    };
    const stop = new StopService({
      mux: r.pane,
      gate: new KeyGate(r.pane, () => r.clock.now),
      profile: (harness) => Promise.resolve(profileFor(harness, "18.6.1", { log: () => undefined })),
      sleep: (ms) => {
        r.clock.now += ms;
        return Promise.resolve();
      },
      now: () => r.clock.now,
      returned: (paneId, read) => r.protocol.boxRead("main", paneId, { ...read, poll: false }),
    });
    const answer = await stop.handle("queued-stop-0001", "%1", "omp");
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "stopped", keys: ["Escape"], returned: ["queued-back-0040"] } });
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-back-0040", state: "returned" }]);
    expect(r.deps.store.get("queued-back-0040")?.receipt?.late).toBe("returned");
  });

  // Tester 14, case s1 (omp 18.12.6, 2026-10-25): a steer and a queued send pending, then Stop. OMP puts
  // both back, steers first, a blank row between: `S-steer text`, ``, `Q-queued text`. The run matcher
  // saw only receipt-queued sends, so no row turned returned and the phone drew no card.
  /** A steer, then a queued send, in a running turn on a pane that draws OMP's `Steering · N` block. */
  async function steerThenQueued(steerId: string, queuedId: string): Promise<Rig & { pane: OmpPane }> {
    const r = omp();
    r.pane.drawsSteers = true;
    r.pane.inTurn = true;
    const steer = await r.send("S-steer text", { id: steerId, when: "steer", fromPhone: true });
    expect(steer.receipt).toMatchObject({ requestId: steerId, outcome: "steered" });
    r.clock.now += 3_000;
    const queued = await r.send("Q-queued text", { id: queuedId });
    expect(queued.receipt).toMatchObject({ requestId: queuedId, outcome: "sent", queued: true });
    return r;
  }
  /** OMP's Escape with a steer and a queue pending: both texts go back, steers first, one blank row between. */
  function stopGivesBackSteers(pane: OmpPane): void {
    pane.inTurn = false;
    pane.box = [...pane.steered, ...pane.queued].join("\n\n");
    pane.steered = [];
    pane.queued = [];
    pane.revision++;
  }

  test("a steer pending beside a queued send draws no card of its own: the queued one alone", async () => {
    const r = await steerThenQueued("queued-steer-0001", "queued-steer-0002");
    expect(r.protocol.queuedOf("main", "%1")).toEqual([{ requestId: "queued-steer-0002", text: "Q-queued text", at: r.clock.now, state: "queued" }]);
  });

  test("Stop gives a steer and a queued send back together: one run, one card, both receipts late", async () => {
    const r = await steerThenQueued("queued-steer-0003", "queued-steer-0004");
    stopGivesBackSteers(r.pane);
    r.clock.now += 1_500;
    const read = look(r.pane, r.clock.now);
    // The box read folds the blank row between the two texts to a space (omp gang tester 14).
    expect(read.box).toBe("S-steer text Q-queued text");
    expect(r.protocol.boxRead("main", "%1", read)).toEqual(["queued-steer-0003", "queued-steer-0004"]);
    const cards = r.protocol.queuedOf("main", "%1");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ requestId: "queued-steer-0003", text: "S-steer text\nQ-queued text", state: "returned" });
    expect(r.deps.store.get("queued-steer-0003")?.receipt).toMatchObject({ outcome: "steered", late: "returned" });
    expect(r.deps.store.get("queued-steer-0004")?.receipt).toMatchObject({ outcome: "sent", queued: true, late: "returned" });
    // The card's own id acts, and the older rows keep the outcome they settled with.
    expect(r.protocol.returnedSource("main", "%1", "queued-steer-0003")).toBe("S-steer text\nQ-queued text");
    expect(r.protocol.returnedSource("main", "%1", "queued-steer-0004")).toBeNull();
    expect(r.protocol.recent("%1").find((row) => row.requestId === "queued-steer-0003")).toMatchObject({ outcome: "steered", late: "returned" });
  });

  test("the run is matched steers first, whatever order they were sent in: the queue first, then the steer, still one card", async () => {
    const r = omp();
    r.pane.drawsSteers = true;
    r.pane.inTurn = true;
    await r.send("Q-queued text", { id: "queued-steer-0005" });
    r.clock.now += 3_000;
    await r.send("S-steer text", { id: "queued-steer-0006", when: "steer", fromPhone: true });
    stopGivesBackSteers(r.pane);
    r.clock.now += 1_500;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual(["queued-steer-0006", "queued-steer-0005"]);
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-steer-0006", text: "S-steer text\nQ-queued text", state: "returned" }]);
  });

  test("a steer returned alone after Stop is marked returned and draws the card", async () => {
    const r = omp();
    r.pane.drawsSteers = true;
    r.pane.inTurn = true;
    await r.send("S-steer text", { id: "queued-steer-0007", when: "steer", fromPhone: true });
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
    stopGivesBackSteers(r.pane);
    r.clock.now += 1_500;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual(["queued-steer-0007"]);
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-steer-0007", text: "S-steer text", state: "returned" }]);
    expect(r.deps.store.get("queued-steer-0007")?.receipt).toMatchObject({ outcome: "steered", late: "returned" });
    // Once: a second read marks nothing again.
    r.clock.now += 1_000;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual(["queued-steer-0007"]);
  });

  test("a steer that landed never matches: the queued text alone comes back, and the steer is gone after idle polls", async () => {
    const r = await steerThenQueued("queued-steer-0008", "queued-steer-0009");
    // The steer reached the turn (the Steering block is gone); the queue stays until the turn yields.
    r.pane.steered = [];
    r.clock.now += 2_000;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual([]);
    stopGivesBackSteers(r.pane);
    r.clock.now += 1_500;
    expect(r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now))).toEqual(["queued-steer-0009"]);
    expect(r.deps.store.get("queued-steer-0008")?.receipt?.late).toBeUndefined();
    expect(r.deps.store.get("queued-steer-0009")?.receipt?.late).toBe("returned");
    // Idle polls pass; the steer is gone. The text typed again at the desk later reads as a draft.
    for (let i = 0; i < 2; i++) {
      r.clock.now += 1_000;
      r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    }
    r.pane.box = "S-steer text";
    for (let i = 0; i < 3; i++) {
      r.clock.now += 1_000;
      r.protocol.boxRead("main", "%1", look(r.pane, r.clock.now));
    }
    expect(r.deps.store.get("queued-steer-0008")?.receipt?.late).toBeUndefined();
  });

  test("Stop's read-back lists a steer and a queued send that came back together", async () => {
    const r = await steerThenQueued("queued-steer-0010", "queued-steer-0011");
    const keys = r.pane.writeKeys;
    r.pane.writeKeys = (paneId, pressed) => {
      if (pressed.includes("Escape") && r.pane instanceof OmpPane) stopGivesBackSteers(r.pane);
      return keys(paneId, pressed.filter((key) => key !== "Escape"));
    };
    const stop = new StopService({
      mux: r.pane,
      gate: new KeyGate(r.pane, () => r.clock.now),
      profile: (harness) => Promise.resolve(profileFor(harness, "18.6.1", { log: () => undefined })),
      sleep: (ms) => {
        r.clock.now += ms;
        return Promise.resolve();
      },
      now: () => r.clock.now,
      returned: (paneId, read) => r.protocol.boxRead("main", paneId, { ...read, poll: false }),
    });
    const answer = await stop.handle("queued-stop-0002", "%1", "omp");
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "stopped", keys: ["Escape"], returned: ["queued-steer-0010", "queued-steer-0011"] } });
    expect(r.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-steer-0010", state: "returned" }]);
  });

  test("after a restart the open queued sends come back from their kept lines, and a returned one does not", async () => {
    const clock = { now: 1_000_000 };
    const storeDir = join(dir, "sends-restart");
    const firstPane = new OmpPane();
    const first = rig({ pane: firstPane, harness: "omp", version: "18.6.1", clock, storeDir });
    firstPane.inTurn = true;
    await first.send("still waiting", { id: "queued-back-0041" });
    await first.send("came back", { id: "queued-back-0042" });
    clock.now += 1_000;
    first.protocol.boxRead("main", "%1", reading("came back", clock.now));
    const second = rig({ pane: new OmpPane(), harness: "omp", version: "18.6.1", clock, storeDir });
    expect(second.protocol.queuedOf("main", "%1")).toMatchObject([{ requestId: "queued-back-0041", text: "still waiting", state: "queued" }]);
    expect(second.protocol.queuedOf("other", "%1")).toEqual([]);
  });
});

// omp-gang three, tester 5 (2026-10-26, W4): a draft typed at the desk with omp's queue prefix (`-> text`, `=> text`)
// shows the `Queueing ➤` label over the body, and the tester's view said `empty` for several seconds before a send
// ended `draft_present` (probe typed, then removed). The screens read `draft` as they stand (fold.pi-omp.test.ts), so
// the Surface is right and a send is refused `draft_present` with the person's draft untouched. The probe stays: a
// draft read is a reading until a probe proves it (the header of protocol.ts, 2026-10-25), and a stale image of
// an earlier layout can show such a box as well as a live one. The view's lag is the idle poll (12 s).
describe("OMP: a draft the person typed with the queue prefix reads as a draft and is refused draft_present (gang three, W4)", () => {
  for (const version of ["18.6.1", "18.12.6"]) {
    for (const [prefix, key] of [["->", "arrow"], ["=>", "fat"]] as const) {
      test(`${version}, ${prefix}: the Surface reads a draft, a send is refused draft_present after the probe, and the draft stands`, async () => {
        const pane = new QueueingOmpPane();
        pane.box = `${prefix}\n hello queue draft`;
        const { send, protocol } = omp({ version, pane });
        const prepared = await protocol.handle({ id: `qd-prep-${version}-${key}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
        expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
        expect(pane.render()).toContain("Queueing ➤");
        const answer = await send("next message");
        expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
        expect(answer.offers).toEqual(["append", "replace", "cancel"]);
        // Only the probe was typed, and its Backspace was the only key: the message and every submit key stayed out.
        expect(pane.calls).toEqual(["type:⌁"]);
        expect(pane.keysSeen).toEqual(["Backspace"]);
        expect(pane.box).toBe(`${prefix}\n hello queue draft`);
        neverEscape(pane);
      });
    }
  }
});

describe("OMP: a text that starts with its queue prefix is refused before any key (gang 13-drafts, 3.5)", () => {
  const DETAIL = "OMP reads a leading -> as its queue prefix and rewrites the box, so this text cannot be typed as written. Start the text with a word.";

  test("the leads are data: -> and => are reserved beside / and !, each with its own note", () => {
    const profile = loadProfiles().get("omp")!;
    expect(profile.reservedLeads).toEqual(["/", "!", "->", "=>"]);
    expect(Object.keys(profile.reservedLeadNotes ?? {})).toEqual(["->", "=>"]);
    expect(profile.keys.clearAll).toEqual({ key: "ctrl+c" });
  });

  test("a plain send of -> and => texts is refused reserved_lead with the true detail, nothing typed, on both versions", async () => {
    for (const version of ["18.6.1", "18.12.6"]) {
      const { pane, send } = omp({ version, pane: new QueueingOmpPane() });
      for (const text of ["-> then do this", "=> second", "->no space", "  -> padded"]) {
        const answer = await send(text);
        expect(answer.receipt, `${version} ${text}`).toMatchObject({ outcome: "refused", reason: "reserved_lead", keys: [] });
        expect(answer.receipt?.detail, `${version} ${text}`).toBe(text.includes("=>") ? DETAIL.replace("->", "=>") : DETAIL);
      }
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
      expect(pane.box).toBe("");
    }
  });

  test("no writing mode types it: a command and a Replace are refused the same way", async () => {
    for (const mode of ["command", "replace", "append"] as const) {
      const { pane, send } = omp({ pane: new QueueingOmpPane() });
      const answer = await send("-> then do this", { mode });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "reserved_lead", keys: [] });
      expect(pane.calls, mode).toEqual([]);
    }
  });

  test("an arrow that does not lead the text is plain text and goes", async () => {
    const { pane, send } = omp({ pane: new QueueingOmpPane() });
    const answer = await send("go from a -> b and then c => d");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe(" > go from a -> b and then c => d");
  });

  test("another profile keeps its leads: Claude has no note and sends -> as text", async () => {
    const { pane, send } = rig({ harness: "claude", version: "2.1.200" });
    const answer = await send("-> then do this");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> -> then do this");
  });

  test("Discard on the Queueing screen empties the box with ONE clearAll press, after Backspace left it unchanged", async () => {
    for (const version of ["18.6.1", "18.12.6"]) {
      const pane = new QueueingOmpPane();
      pane.box = "->\n then do this";
      const { send, protocol } = omp({ version, pane });
      const prepared = await protocol.handle({ id: `queueing-prep-${version}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
      const answer = await send("-> then do this", { mode: "discard", rowsHash: prepared.rowsHash! });
      expect(answer.receipt, version).toMatchObject({ outcome: "discarded" });
      expect(pane.box).toBe("");
      expect(pane.keysSeen.filter((key) => key === "ctrl+c")).toHaveLength(1);
      expect(pane.clears).toBe(1);
      expect(pane.emptyPresses).toBe(0);
      // The Backspace batches went first and the stroke key went last.
      expect(pane.keysSeen.indexOf("ctrl+c")).toBe(pane.keysSeen.length - 1);
      expect(pane.keysSeen.slice(0, -1).every((key) => key === "Backspace")).toBe(true);
    }
  });

  test("Replace over a person's -> draft clears it the same way and sends the new text once", async () => {
    const pane = new QueueingOmpPane();
    pane.box = "->\n half a thought";
    const { send } = omp({ pane, version: "18.12.6" });
    const answer = await send("start with a word", { mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.filter((key) => key === "ctrl+c")).toHaveLength(1);
    expect(pane.emptyPresses).toBe(0);
    expect(pane.transcript.at(-1)).toBe(" > start with a word");
  });

  test("an ordinary draft never meets the stroke key: Backspace empties it, and an empty box is never pressed", async () => {
    const pane = new QueueingOmpPane();
    const { send } = omp({ pane });
    pane.box = "an ordinary draft";
    expect((await send("an ordinary draft", { mode: "discard" })).receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.keysSeen).not.toContain("ctrl+c");
    const sent = await send("a fresh message", { mode: "replace", rowsHash: OFFERED });
    expect(sent.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen).not.toContain("ctrl+c");
    expect(pane.emptyPresses).toBe(0);
  });

  test("a redraw that lags behind the Backspace batch by one or two reads is no cause for the stroke key", async () => {
    const pane = new QueueingOmpPane();
    pane.box = "an ordinary draft to throw away";
    const { send, protocol } = omp({ pane });
    const prepared = await protocol.handle({ id: "queueing-prep-lag", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    // After the first batch the screen still shows the old draft for two reads, then the empty box.
    const stale = pane.render();
    let lagReads = 0;
    pane.afterInput = (p, what) => {
      if (what.startsWith("keys:Backspace") && p.fixed === null) p.fixed = stale;
    };
    pane.beforeRead = (p) => {
      if (p.fixed !== null && ++lagReads > 2) p.fixed = null;
    };
    const answer = await send("an ordinary draft to throw away", { mode: "discard", rowsHash: prepared.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "discarded" });
    expect(pane.keysSeen).not.toContain("ctrl+c");
    expect(pane.emptyPresses).toBe(0);
  });

  test("a stroke key that does not empty the box is pressed once and the Discard ends unknown, never twice", async () => {
    const pane = new QueueingOmpPane();
    pane.box = "->\n then do this";
    pane.deafCtrlC = true;
    const { send, protocol } = omp({ pane });
    const prepared = await protocol.handle({ id: "queueing-prep-deaf", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    const answer = await send("-> then do this", { mode: "discard", rowsHash: prepared.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
    expect(pane.keysSeen.filter((key) => key === "ctrl+c")).toHaveLength(1);
    expect(pane.emptyPresses).toBe(0);
  });
});

describe("OMP: a text that holds a paste chip's label is refused before any key (gang 13-drafts, stale chip)", () => {
  test("the check is data on the profile: only OMP opts in", () => {
    expect(loadProfiles().get("omp")?.collapse.refuseLiteral).toBe(true);
    for (const [id, profile] of loadProfiles()) if (id !== "omp") expect(profile.collapse.refuseLiteral, id).toBeUndefined();
  });

  test("chip labels in the text are refused reserved_lead with a detail that says the label expands to pasted text", async () => {
    for (const version of ["18.6.1", "18.12.6"]) {
      const { pane, send } = omp({ version });
      for (const text of ["see 📄 #1 here", "look at 🖼 #2", "📷 #3 first", "line one\nsee 📄 #12 here", "a ✦ chip label"]) {
        const answer = await send(text);
        expect(answer.receipt, `${version} ${text}`).toMatchObject({ outcome: "refused", reason: "reserved_lead", keys: [] });
        expect(answer.receipt?.detail, `${version} ${text}`).toContain("label of a paste chip");
        expect(answer.receipt?.detail, `${version} ${text}`).toContain("pasted earlier");
      }
      expect(pane.calls).toEqual([]);
      expect(pane.keysSeen).toEqual([]);
    }
  });

  test("a Replace and a command carry the same refusal", async () => {
    for (const mode of ["replace", "command", "append"] as const) {
      const { pane, send } = omp();
      const answer = await send("see 📄 #1 here", { mode });
      expect(answer.receipt, mode).toMatchObject({ outcome: "refused", reason: "reserved_lead", keys: [] });
      expect(pane.calls, mode).toEqual([]);
    }
  });

  test("texts that only look alike go: a literal paste marker, an issue number, a lone emoji, a hash", async () => {
    for (const text of ["see [Paste #1, +3 lines] here", "see #12 for details", "a 📄 page and the #1 spot", "plain words"]) {
      const { pane, send } = omp();
      const answer = await send(text);
      expect(answer.receipt, text).toMatchObject({ outcome: "sent" });
      expect(pane.transcript.at(-1)).toBe(` > ${text}`);
    }
  });

  test("Collie's own long paste keeps its road: the text carries no label, so it is not refused", async () => {
    const { pane, send } = omp();
    const text = words(400);
    const answer = await send(text);
    expect(answer.receipt?.reason).not.toBe("reserved_lead");
    expect(pane.calls.length).toBeGreaterThan(0);
  });

  test("another profile reads the same words as plain text", async () => {
    const { send } = rig({ harness: "claude", version: "2.1.200" });
    expect((await send("see 📄 #1 here")).receipt).toMatchObject({ outcome: "sent" });
  });
});

describe("issue 594: a pi pane with a ticking widget, a tall footer and a version Collie could not read", () => {
  // Live captures (rig, 2026-10-25): pi 1.3.0 under pi-powerline-footer 0.20.2 and pi-context-chart
  // 0.0.5, with a goal widget that ticks its seconds over the box, on a 254-column pane. The running
  // capture has five rows under the box. The welcome pair is a fresh pi before and after its first key.
  // eslint-disable-next-line no-control-regex
  const plain = (row: string): string => row.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
  const rowsOf = (name: string): string[] => fixture(name).split(/\r?\n/u);
  const IDLE = "pi--v130-powerline-goal-widget-idle--w254.txt";
  const RUNNING = "pi--v130-powerline-goal-widget-running--w254.txt";

  /**
   * A live pi screen: the box redrawn from the pane's text, the goal widget's seconds ticking once per
   * `tickMs` of the fake clock (100 ms: a new number on every read), and with `footerClock` one more
   * row under the box that ticks too (the reporter's `⏱ 29m 21s`). `after` is the screen once a key went in.
   */
  const livePi = (clock: { now: number }, name: string, options: { tickMs?: number; footerClock?: boolean; after?: string } = {}): FakePane => {
    const before = rowsOf(name);
    const later = options.after === undefined ? null : rowsOf(options.after);
    const pane = new FakePane();
    let typed = false;
    pane.afterInput = (p, what) => {
      typed = true;
      if (what.startsWith("keys:") && what.includes("alt+Enter")) p.box = "";
    };
    pane.render = () => {
      const tick = Math.floor(clock.now / (options.tickMs ?? 100));
      const rows = (typed && later !== null ? later : before).map((row) => {
        const text = plain(row);
        if (/^ >(?: |$)/u.test(text)) return ` > ${pane.box}`;
        if (text.includes("🎯 active")) return row.replace(/· \d+s/u, `· ${String(tick % 1000)}s`);
        return row;
      });
      if (options.footerClock === true) rows.push(` ⏱ 29m ${String(tick % 60)}s`);
      return rows.join("\r\n");
    };
    return pane;
  };
  const piRig = (name: string, version: string | null, options: Parameters<typeof livePi>[2] = {}, holds?: HoldStore): Rig => {
    const clock = { now: 1_000_000 };
    return rig({ pane: livePi(clock, name, options), harness: "pi", version, clock, holds });
  };

  test.each([["1.3.0"], [null]] as const)("an idle box under a widget that ticks on every read takes the send, version %p", async (version) => {
    const r = piRig(IDLE, version);
    const answer = await r.send("Reply with exactly OK-1");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "alt+Enter"] });
  });

  test("a running turn with five rows under the box takes the send into pi's queue", async () => {
    const answer = await piRig(RUNNING, "1.3.0").send("Reply with exactly OK-2");
    // The fake draws no Follow-up row, so the receipt says `sent` alone (live it said `queued` too).
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "alt+Enter"] });
  });

  test("a footer row that ticks under the box does not hold a send", async () => {
    const answer = await piRig(IDLE, "1.3.0", { tickMs: 60_000, footerClock: true }).send("Reply with exactly OK-3");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("both at once, in a running turn: the widget above and a footer row below tick on every read", async () => {
    const answer = await piRig(RUNNING, "1.3.0", { footerClock: true }).send("Reply with exactly OK-4");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
  });

  test("a real change still stops it: a dialog that opens at the first key gets no submit key", async () => {
    const r = piRig(IDLE, "1.3.0", { after: "pi--v0871-permission-gate.txt" });
    const answer = await r.send("Reply with exactly OK-5");
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(r.pane.keysSeen).not.toContain("alt+Enter");
  });

  test("an unread version holds a send in a running turn, and the receipt and the row say why", async () => {
    const holds = new HoldStore(join(dir, "held-594"), () => 1_000_000);
    const r = piRig(RUNNING, null, {}, holds);
    const answer = await r.send("Reply with exactly OK-6");
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.detail).toContain("could not read this agent's version");
    expect(r.protocol.heldOf("main", "%1")[0]).toMatchObject({ cause: "turn_running", versionUnread: true });
  });

  test("the first key of a fresh pi clears its welcome box above: the send goes on an unread version (idle.volatile.above.losesText)", async () => {
    const r = piRig("pi--v130-powerline-welcome-idle--w254.txt", null, { tickMs: 60_000, after: "pi--v130-powerline-welcome-gone--w254.txt" });
    expect((await r.send("Reply with exactly OK-7")).receipt).toMatchObject({ outcome: "sent" });
    // Without the profile's word the welcome box going reads as a moved screen, and the probe fails.
    const clock = { now: 1_000_000 };
    const pane = livePi(clock, "pi--v130-powerline-welcome-idle--w254.txt", { tickMs: 60_000, after: "pi--v130-powerline-welcome-gone--w254.txt" });
    const strict = rig({
      pane,
      harness: "pi",
      version: null,
      clock,
      edit: (profile) => ({ ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, above: { maxRows: profile.idle.volatile.above.maxRows } } } }),
    });
    expect((await strict.send("Reply with exactly OK-8")).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
  });

  test("the bound starts once the profile is known: a 9 s version read costs no send, and the receipt measures it", async () => {
    const r = piRig(IDLE, null);
    const inner = r.deps.profile;
    // SAFETY: `r.deps` is the very object the protocol reads its profile from; only this test swaps the reader.
    (r.deps as { profile: SendDeps["profile"] }).profile = async (harness) => {
      r.clock.now += 9_000;
      return inner(harness);
    };
    const answer = await r.send("Reply with exactly OK-9");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.gapsMs.profile).toBe(9_000);
  });

  test("a send that runs past its bound names the step it was in and the gaps before it", async () => {
    const r = piRig(IDLE, "1.3.0", { tickMs: 60_000 });
    let written = false;
    let late = false;
    r.pane.afterInput = (_p, what) => {
      if (what.startsWith("type:Reply") || what.startsWith("paste:Reply")) written = true;
    };
    r.pane.beforeRead = async () => {
      // The first read after the write comes back 8 s late: S1 passes on it, and the bound is gone before the submit key.
      await Promise.resolve();
      if (written && !late) {
        late = true;
        r.clock.now += 8_000;
      }
    };
    const answer = await r.send("Reply with exactly OK-10");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "bound" });
    expect(r.pane.keysSeen).not.toContain("alt+Enter");
    expect(answer.detail).toMatch(/^The send ran past its bound at the submit key \(s0 \d+ ms, probe \d+ ms, write \d+ ms, s1 \d+ ms, commit 0 ms so far\)\.$/u);
  });

  test("an S2 that runs out at the request's bound, its timer a hair late, ends with its own outcome", async () => {
    // Every wait wakes 1 ms late, as a real timer does.
    let t = 1_000_000;
    const clock = {
      get now(): number {
        return t;
      },
      set now(value: number) {
        t = value > t ? value + 1 : value;
      },
    };
    const r = rig({ pane: livePi(clock, IDLE, { tickMs: 60_000 }), harness: "pi", version: "1.3.0", clock });
    r.pane.afterInput = (_p, what) => {
      // A slow write leaves S2 less than its own bound, and the box never lets the text go.
      if (what.startsWith("type:Reply") || what.startsWith("paste:Reply")) r.clock.now += 5_000;
    };
    const answer = await r.send("Reply with exactly OK-11");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "no_evidence" });
  });
});

// omp's typeahead popups under the box (omp-gang tester 12, 2026-10-25). The `@` file popup and the `#` issue
// popup draw rows under a box whose last word opens them, and omp's submit key (Ctrl+Q) ignores them. A plain
// send used to end `typed_not_submitted (changed)` because the rows under the box appeared while it typed, or
// `modal_cue` because two of them read as a pointer list, and the rows left under an emptied box made the
// Surface read `modal: unknown`. The profile's `volatile.below.popups` names them, so they count as no cue and
// no moved row. A command commits with Enter, and Enter acts on a popup: that send keeps its refusal.
describe("omp's typeahead popups under the box (1.24.1)", () => {
  const PANES = join(import.meta.dir, "../../web/src/fixtures/panes");
  const POPUP_NOTICE = "A popup is open under the box, and Enter would act on it, so Enter was not pressed. Submit the text, or discard it.";

  interface SceneOptions {
    /** Whether the popup is drawn for this box text: omp draws it for the word the cursor ends on. Default: any `@` or `#` word. */
    readonly opens?: (box: string) => boolean;
    /** The popup shows on the empty box until the first key, as omp 18.6.1 leaves `PR #1` and `Issue #1`. */
    readonly stale?: boolean;
  }

  const scene = (pane: FakePane, name: string, options: SceneOptions = {}): void => {
    const rows = readFileSync(join(PANES, name), "utf8").split(/\r?\n/u);
    const boxAt = rows.findLastIndex((row) => row.startsWith("╰─"));
    expect(boxAt, name).toBeGreaterThan(0);
    const head = rows.slice(0, boxAt - 1);
    const top = rows[boxAt - 1]!;
    const under = rows.slice(boxAt + 1);
    const boxRow = (text: string): string => `╰─ ${text}`.padEnd(120);
    const above: string[] = [];
    let touched = false;
    let taken: string | null = null;
    pane.collapseOver = 100_000;
    pane.beforeWrite = (p, what) => {
      if ((what === "keys:Enter" || what === "keys:ctrl+q") && p.box !== "") taken = p.box;
    };
    pane.afterInput = (p, what) => {
      touched = true;
      if (taken === null || (what !== "keys:Enter" && what !== "keys:ctrl+q")) return;
      above.push(` ${taken}`, "");
      taken = null;
      p.box = "";
    };
    pane.beforeRead = (p) => {
      const shown = options.stale === true ? p.box === "" && !touched : (options.opens ?? ((box: string) => /(?:^|\s)[@#]\S*$/u.test(box)))(p.box);
      p.fixed = [...head.slice(above.length), ...above, top, boxRow(p.box), ...(shown ? under : [])].join("\n");
    };
  };

  const ompPane = (name: string, options: SceneOptions = {}, edit?: (profile: Profile) => Profile) => {
    const pane = new FakePane("generic");
    const made = edit === undefined ? rig({ pane, harness: "omp", version: "18.6.1" }) : rig({ pane, harness: "omp", version: "18.6.1", edit });
    scene(pane, name, options);
    return { ...made, pane };
  };
  const withoutPopups = (profile: Profile): Profile => {
    const { popups, ...below } = profile.idle.volatile.below;
    void popups;
    return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below } } };
  };

  const PLAIN = [
    ["omp--v18-6-1-at-popup--w120.txt", "please read @READ"],
    ["omp--v18-6-1-hash-popup--w120.txt", "fix item #1"],
    ["omp--v18-6-1-hash-popup-single--w120.txt", "see PR #12"],
  ] as const;

  for (const [name, text] of PLAIN) {
    test(`${name}: ${text} goes out with the submit key while the popup is open`, async () => {
      const { send, pane } = ompPane(name);
      const answer = await send(text, { mode: "send" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
      expect(pane.keysSeen).not.toContain("Enter");
      expect(pane.box).toBe("");
      neverEscape(pane);
    });

    test(`${name}: with ${text} in the box the pane reads a draft, and Submit goes out`, async () => {
      const looked = ompPane(name);
      looked.pane.box = text;
      const prepared = await looked.protocol.handle({ id: `popup-prep-${text.length}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const { send, pane } = ompPane(name);
      pane.box = text;
      const answer = await send(text, { id: `popup-submit-${text.length}`, mode: "submit" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
      expect(pane.box).toBe("");
    });
  }

  test("without the profile's popups the same send ends changed: the rows that came under the box while it typed", async () => {
    const [name, text] = PLAIN[0];
    const { send, pane } = ompPane(name, {}, withoutPopups);
    const answer = await send(text, { id: "popup-old-read", mode: "send" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted" });
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  test("without the profile's popups a two-row `#` popup reads a pointer list, and Submit is refused as unreadable", async () => {
    const [name, text] = PLAIN[1];
    const { send, pane } = ompPane(name, {}, withoutPopups);
    pane.box = text;
    const answer = await send(text, { id: "popup-old-submit", mode: "submit" });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  test("a message that starts with @ is a command to the web, and its Enter would act on the popup: typed, not submitted", async () => {
    const { send, pane, deps } = ompPane("omp--v18-6-1-at-popup-path--w120.txt");
    const answer = await send("@/tmp/x.png", { id: "popup-at-command", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(deps.store.get("popup-at-command")?.receipt?.detail).toBe(POPUP_NOTICE);
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(pane.box).toBe("@/tmp/x.png");
  });

  test("Send anyway onto the text an earlier send left under the popup: nothing typed a second time, textAlreadyTyped (M102 spec 12)", async () => {
    const { send, pane, protocol } = ompPane("omp--v18-6-1-at-popup-path--w120.txt");
    const first = await send("@/tmp/x.png", { id: "own-left-first-01", mode: "command" });
    expect(first.receipt).toMatchObject({ outcome: "typed_not_submitted" });
    expect(pane.box).toBe("@/tmp/x.png");
    const prep = await protocol.handle({ id: "own-left-prepare1", text: "", mode: "prepare", fromPhone: true }, { session: "main", paneId: "%1", harness: "omp" });
    const calls = pane.calls.length;
    // The phone's commit after the refusal: a new id, the override and the rows hash.
    const over = await send("@/tmp/x.png", { id: "own-left-override", mode: "command", fromPhone: true, override: true, rowsHash: prep.rowsHash });
    expect(over.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override", word: "override", keys: [], textAlreadyTyped: true });
    expect(pane.calls.slice(calls)).toEqual([]);
    expect(pane.box).toBe("@/tmp/x.png");
    expect(protocol.recent("%1", 1)[0]?.textAlreadyTyped).toBe(true);
  });

  test("Send anyway onto a draft that is not the text: typed after it, no textAlreadyTyped", async () => {
    const { send, pane, protocol } = ompPane("omp--v18-6-1-at-popup-path--w120.txt");
    await send("@/tmp/x.png", { id: "own-other-first-1", mode: "command" });
    const prep = await protocol.handle({ id: "own-other-prepare", text: "", mode: "prepare", fromPhone: true }, { session: "main", paneId: "%1", harness: "omp" });
    const over = await send("@/tmp/y.png", { id: "own-other-overrid", mode: "command", fromPhone: true, override: true, rowsHash: prep.rowsHash });
    expect(over.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "override" });
    expect(over.receipt?.textAlreadyTyped).toBeUndefined();
    expect(pane.box).toBe("@/tmp/x.png@/tmp/y.png");
  });

  test("the typed @ path goes out when the person taps Submit: the submit key ignores the popup", async () => {
    const { send, pane } = ompPane("omp--v18-6-1-at-popup-path--w120.txt");
    pane.box = "@/tmp/x.png";
    const answer = await send("@/tmp/x.png", { id: "popup-at-submit", mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(pane.box).toBe("");
  });

  test("the `#` rows left under an emptied box: the pane reads an empty box and a plain send goes out", async () => {
    const name = "omp--v18-6-1-hash-popup-stale--w120.txt";
    const looked = ompPane(name, { stale: true });
    const prepared = await looked.protocol.handle({ id: "popup-stale-prep", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const { send, pane } = ompPane(name, { stale: true });
    const answer = await send("hello there", { id: "popup-stale-send", mode: "send" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    neverEscape(pane);
  });

  test("without the profile's popups the stale rows read modal unknown and the send is refused, as the tester saw it", async () => {
    const { protocol } = ompPane("omp--v18-6-1-hash-popup-stale--w120.txt", { stale: true }, withoutPopups);
    const prepared = await protocol.handle({ id: "popup-stale-old", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface).toMatchObject({ modal: "unknown" });
  });

  // A long prompt that quotes a permission dialog (omp-gang tester 12, 2026-10-25). The nine-row draft is the
  // person's text: the Surface read it as a strong cue, so Submit was refused and the prose could not be sent
  // from the phone. The profile's `frame.draftIndent` says the indented rows under the prompt are the draft.
  describe("a prompt that quotes a dialog", () => {
    const QUOTED = "omp--v18-6-1-quoted-dialog-draft--w120.txt";
    const shown = readFileSync(join(PANES, QUOTED), "utf8");
    // The box's text as the pane reads it: the prompt row and the wrapped rows, borders cut, joined with a space.
    const draftOf = (): string =>
      'Follow these steps in order without commenting. Step 1: call the ask tool once with the question "First pick?" and the options Alpha, Beta, Gamma. Step 2: when I answer, call the ask tool once more with the question "Second pick?" and the options Red, Green, Blue. Step 3: print this block exactly, inside a code fence, with nothing else: ╭─ Allow tool: bash ───────────╮ │ ❯ Approve │   Deny │ ↑/↓ navigate  ⏎ select  ⎋ cancel ╰───────────────────────────── Step 4: write the numbers 1 to 200, one per line.my notes';
    const quotedPane = (edit?: (profile: Profile) => Profile) => {
      const pane = new FakePane("generic");
      const made = edit === undefined ? rig({ pane, harness: "omp", version: "18.6.1" }) : rig({ pane, harness: "omp", version: "18.6.1", edit });
      const rows = shown.split(/\r?\n/u);
      const at = rows.findIndex((row) => row.startsWith("╰─"));
      pane.fixed = shown;
      pane.afterInput = (p, what) => {
        if (what === "keys:ctrl+q" || what === "keys:Enter") p.fixed = [...rows.slice(0, at), "╰─ ".padEnd(120)].join("\n");
      };
      return { ...made, pane };
    };

    test("the pane reads a draft, and Submit goes out with the submit key", async () => {
      const { send, pane, protocol } = quotedPane();
      const prepared = await protocol.handle({ id: "quoted-prep", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const answer = await send(draftOf(), { id: "quoted-submit", mode: "submit" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
      neverEscape(pane);
    });

    test("without the profile's draftIndent the same pane reads an unreadable dialog, as the tester saw it", async () => {
      const { protocol } = quotedPane((profile) => {
        const { draftIndent, ...frame } = profile.idle.frame;
        void draftIndent;
        return { ...profile, idle: { ...profile.idle, frame } };
      });
      const prepared = await protocol.handle({ id: "quoted-old", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
      expect(prepared.surface).toMatchObject({ modal: "unreadable" });
    });
  });

  // omp-gang 04-readers (2026-10-26), omp 18.12.6 and 18.6.1: the first real captures of three more screens.
  const EMOJI = ["omp--v18-12-6-emoji-popup--w120.txt", "omp--v18-6-1-emoji-popup--w120.txt"] as const;
  const emojiOpens = (box: string): boolean => /(?:^|\s):[A-Za-z0-9_+-]+$/u.test(box);
  const withRules = (profile: Profile, edit: (rules: PopupRule[]) => PopupRule[]): Profile => {
    const popups = profile.idle.volatile.below.popups!;
    return { ...profile, idle: { ...profile.idle, volatile: { ...profile.idle.volatile, below: { ...profile.idle.volatile.below, popups: { ...popups, rules: edit([...popups.rules]) } } } } };
  };
  const twoSpaceEmoji = (profile: Profile): Profile => withRules(profile, (rules) => rules.map((rule) => (rule.name === "emoji" ? { ...rule, rows: rule.rows.replace(" {1,2}", " {2}") } : rule)));

  for (const name of EMOJI) {
    test(`${name}: hello :smi with the emoji popup open goes out with ctrl+q, and the pane reads the box`, async () => {
      const looked = ompPane(name, { opens: emojiOpens });
      looked.pane.box = "hello :smi";
      const prepared = await looked.protocol.handle({ id: `emoji-prep-${String(EMOJI.indexOf(name))}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
      expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const { send, pane } = ompPane(name, { opens: emojiOpens });
      const answer = await send("hello :smi", { id: `emoji-send-${String(EMOJI.indexOf(name))}`, mode: "send" });
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
      expect(pane.keysSeen).not.toContain("Enter");
      expect(pane.box).toBe("");
      neverEscape(pane);
    });
  }

  test("with the old two-space emoji row pattern the popup is no popup: the box reads unreadable and the send ends typed, not submitted, as the tester saw it", async () => {
    const looked = ompPane(EMOJI[0], { opens: emojiOpens }, twoSpaceEmoji);
    looked.pane.box = "hello :smi";
    const prepared = await looked.protocol.handle({ id: "emoji-old-prep", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface).toMatchObject({ modal: "unreadable" });
    const { send, pane } = ompPane(EMOJI[0], { opens: emojiOpens }, twoSpaceEmoji);
    const answer = await send("hello :smi", { id: "emoji-old", mode: "send" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("ctrl+q");
  });

  const PATH = "omp--v18-12-6-path-popup-partial--w120.txt";
  const PARTIAL = "~/.cache/collie-lab/omp-gang/gang3/04-readers/state/harness/omp/project/src/ma";
  const pathOpens = (box: string): boolean => box.startsWith("~/");

  test("a partial path in a command send: the one-row path popup refuses Enter, with the popup notice, and Enter is not pressed", async () => {
    const { send, pane, deps } = ompPane(PATH, { opens: pathOpens });
    const answer = await send(PARTIAL, { id: "path-command", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(deps.store.get("path-command")?.receipt?.detail).toBe(POPUP_NOTICE);
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.keysSeen).not.toContain("ctrl+q");
    expect(pane.box).toBe(PARTIAL);
  });

  test("the same partial path goes out with ctrl+q when the person taps Submit, and as a plain send", async () => {
    const submitted = ompPane(PATH, { opens: pathOpens });
    submitted.pane.box = PARTIAL;
    const answer = await submitted.send(PARTIAL, { id: "path-submit", mode: "submit" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(submitted.pane.box).toBe("");
    const plain = ompPane(PATH, { opens: pathOpens });
    const sent = await plain.send(PARTIAL, { id: "path-plain", mode: "send" });
    expect(sent.receipt).toMatchObject({ outcome: "sent" });
    expect(sent.receipt?.keys.at(-1)).toBe("ctrl+q");
    expect(plain.pane.keysSeen).not.toContain("Enter");
  });

  // The tester saw Enter pressed into omp's popup when the path rule was gone (the popup read was the only guard:
  // `commandList.notForText` hides the popup's row from the command-list read). Since the gang-three W1 fix the
  // check before Enter reads that list for any text, so the same screen is refused with the list notice even with
  // no popup rule: a pointer on a row that is no entry of the typed path is another command's row.
  test("without the path rule the command send is still refused before Enter: the list read, whatever the text, names another command", async () => {
    const { send, pane, deps } = ompPane(PATH, { opens: pathOpens }, (profile) => withRules(profile, (rules) => rules.filter((rule) => rule.name !== "path")));
    const answer = await send(PARTIAL, { id: "path-old", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(deps.store.get("path-old")?.receipt?.detail).toBe("The command list at the box pointed at another command, so Enter was not pressed.");
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(PARTIAL);
  });

  test("an @ popup whose rows also read as a command list: the command send names the popup, not another command", async () => {
    const name = "omp--v18-12-6-at-popup-two-files--w120.txt";
    const { send, pane, deps } = ompPane(name);
    const answer = await send("please read @READ", { id: "at-command-detail", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(deps.store.get("at-command-detail")?.receipt?.detail).toBe(POPUP_NOTICE);
    expect(pane.keysSeen).not.toContain("Enter");
    // The plain send of it goes out with ctrl+q.
    const plain = ompPane(name);
    const sent = await plain.send("please read @READ", { id: "at-plain", mode: "send" });
    expect(sent.receipt).toMatchObject({ outcome: "sent" });
    expect(sent.receipt?.keys.at(-1)).toBe("ctrl+q");
  });

  test("the @ rows left under an emptied box after Submit: the pane reads an empty box, and a plain send goes out", async () => {
    const name = "omp--v18-6-1-at-popup-stale--w120.txt";
    const looked = ompPane(name, { stale: true });
    const prepared = await looked.protocol.handle({ id: "at-stale-prep", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const { send, pane } = ompPane(name, { stale: true });
    const answer = await send("hello there", { id: "at-stale-send", mode: "send" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
    neverEscape(pane);
  });

  test("without the stale mark on the popup rules the same rows read modal unknown, and the plain send does not go out, as the tester saw it", async () => {
    const unmarked = (profile: Profile): Profile => withRules(profile, (rules) => rules.map((rule) => ({ name: rule.name, text: rule.text, rows: rule.rows })));
    const { protocol, send } = ompPane("omp--v18-6-1-at-popup-stale--w120.txt", { stale: true }, unmarked);
    const prepared = await protocol.handle({ id: "at-stale-old", text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
    expect(prepared.surface).toMatchObject({ modal: "unknown" });
    const answer = await send("hello there", { id: "at-stale-old-send", mode: "send" });
    expect(answer.receipt?.outcome).not.toBe("sent");
  });

  // omp-gang three, 01-regression W1 (2026-10-26): a draft that holds a pasted box drawing. omp's box here has no
  // right border, but the profile cut a trailing `│` or `╯` off every row, so the box read as the text without
  // the glyphs that closed the quoted rows, the receipt said `mismatch` and one more tap (Submit) was needed
  // although the box held the typed text exactly. A glyph with padding after it is the person's text.
  describe("a pasted box drawing in the draft", () => {
    const NAMES = ["omp--v18-6-1-quoted-box-draft--w120.txt", "omp--v18-12-6-quoted-box-draft--w120.txt"] as const;
    const TEXT = "Here is what omp showed me:\n╭─ Allow tool: bash ───────────╮\n│ ❯ Approve                    │\n│   Deny                       │\n╰──────────────────────────────╯\nwhy did it ask?";
    // The pane draws the box as omp does: a `╰─` row, the draft's other rows at three columns, every row padded to the width.
    const boxPane = (name: string, edit?: (profile: Profile) => Profile) => {
      const pane = new FakePane("generic");
      const made = edit === undefined ? rig({ pane, harness: "omp", version: "18.6.1" }) : rig({ pane, harness: "omp", version: "18.6.1", edit });
      const rows = readFileSync(join(PANES, "..", "surface", name), "utf8").split(/\r?\n/u);
      const boxAt = rows.findLastIndex((row) => row.startsWith("╰─"));
      const head = rows.slice(0, boxAt - 1);
      const status = rows[boxAt - 1]!;
      const above: string[] = [];
      let taken: string | null = null;
      pane.collapseOver = 100_000;
      pane.beforeWrite = (p, what) => {
        if ((what === "keys:Enter" || what === "keys:ctrl+q") && p.box !== "") taken = p.box;
      };
      pane.afterInput = (p, what) => {
        if (taken === null || (what !== "keys:Enter" && what !== "keys:ctrl+q")) return;
        above.push(` ${taken.split("\n")[0]!}`, "");
        taken = null;
        p.box = "";
      };
      pane.beforeRead = (p) => {
        const box = p.box.split("\n").map((line, i) => `${i === 0 ? "╰─ " : "   "}${line}`.padEnd(120));
        p.fixed = [...head.slice(Math.min(above.length, head.length)), ...above, status, ...box].join("\n");
      };
      return { ...made, pane };
    };

    for (const name of NAMES) {
      test(`${name}: the box reads as the typed text, and the plain send goes out first time with ctrl+q`, async () => {
        const looked = boxPane(name);
        looked.pane.box = TEXT;
        const prepared = await looked.protocol.handle({ id: `boxdraw-prep-${name.slice(10, 14)}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
        expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
        const { send, pane } = boxPane(name);
        const answer = await send(TEXT, { id: `boxdraw-send-${name.slice(10, 14)}`, mode: "send" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe("");
        neverEscape(pane);
      });
    }

    test("a read that cuts every trailing glyph, as the profile did, ends the same send mismatch, as the tester saw it", async () => {
      // The old patterns, with no named border: the glyph is always cut.
      const uncut = (profile: Profile): Profile => {
        const frame = { ...profile.idle.frame, prompt: { ...profile.idle.frame.prompt, pattern: profile.idle.frame.prompt.pattern.replace("(?<border>", "(?:") }, continuation: profile.idle.frame.continuation!.replace("(?<border>", "(?:") };
        return { ...profile, idle: { ...profile.idle, frame } };
      };
      const { send, pane } = boxPane(NAMES[0], uncut);
      const answer = await send(TEXT, { id: "boxdraw-old", mode: "send" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
      expect(pane.keysSeen).not.toContain("ctrl+q");
    });
  });

  // omp-gang three, 01-regression S1 (2026-10-26): a text that ends in a bare `#` makes omp draw its seven-row
  // editor-action list under the box (a label and a key-chord column). It read as a dialog: the plain send ended
  // `modal_cue`, and the offered Submit and Discard answered `not_free`. It is a popup the last word opens.
  describe("the editor-action list a trailing bare `#` opens", () => {
    const ACTIONS = ["omp--v18-6-1-hash-end-actions--w120.txt", "omp--v18-12-6-hash-end-actions--w120.txt"] as const;
    const TEXT = "ends with hash #";
    const hashEnds = (box: string): boolean => /(?:^|\s)#$/u.test(box);
    const withoutActions = (profile: Profile): Profile => withRules(profile, (rules) => rules.filter((rule) => rule.name !== "actions"));

    for (const name of ACTIONS) {
      test(`${name}: the pane reads a draft, and the plain send goes out with ctrl+q`, async () => {
        const looked = ompPane(name, { opens: hashEnds });
        looked.pane.box = TEXT;
        const prepared = await looked.protocol.handle({ id: `actions-prep-${name.slice(10, 14)}`, text: "", mode: "prepare" }, { session: "main", paneId: "%1", harness: "omp" });
        expect(prepared.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
        const { send, pane } = ompPane(name, { opens: hashEnds });
        const answer = await send(TEXT, { id: `actions-send-${name.slice(10, 14)}`, mode: "send" });
        expect(answer.receipt).toMatchObject({ outcome: "sent" });
        expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
        expect(pane.keysSeen).not.toContain("Enter");
        expect(pane.box).toBe("");
        neverEscape(pane);
      });

      test(`${name}: a command send is refused with the popup notice and Enter is not pressed; Submit and Discard are taken`, async () => {
        const command = ompPane(name, { opens: hashEnds });
        const refused = await command.send("/note #", { id: `actions-cmd-${name.slice(10, 14)}`, mode: "command" });
        expect(refused.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
        expect(command.deps.store.get(`actions-cmd-${name.slice(10, 14)}`)?.receipt?.detail).toBe(POPUP_NOTICE);
        expect(command.pane.keysSeen).not.toContain("Enter");
        expect(command.pane.box).toBe("/note #");
        expect(refused.offers).toEqual(["submit", "discard", "keys"]);
        const submitted = ompPane(name, { opens: hashEnds });
        submitted.pane.box = TEXT;
        const sent = await submitted.send(TEXT, { id: `actions-submit-${name.slice(10, 14)}`, mode: "submit" });
        expect(sent.receipt).toMatchObject({ outcome: "sent" });
        expect(sent.receipt?.keys.at(-1)).toBe("ctrl+q");
        expect(submitted.pane.box).toBe("");
        const discarded = ompPane(name, { opens: hashEnds });
        discarded.pane.box = TEXT;
        const gone = await discarded.send(TEXT, { id: `actions-discard-${name.slice(10, 14)}`, mode: "discard" });
        expect(gone.receipt).toMatchObject({ outcome: "discarded" });
        expect(discarded.pane.box).toBe("");
      });
    }

    test("without the actions rule the list reads as a dialog, and the answer offers only the keys, because Submit and Discard would be refused not_free", async () => {
      const name = ACTIONS[0];
      const { send, pane } = ompPane(name, { opens: hashEnds }, withoutActions);
      const answer = await send(TEXT, { id: "actions-old", mode: "send" });
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
      expect(pane.keysSeen).not.toContain("ctrl+q");
      expect(answer.offers).toEqual(["keys"]);
      // What the answer offers is what the routes accept: the verbs it left out do refuse.
      expect(answer.rowsHash).toBeDefined();
      const submit = await send(TEXT, { id: "actions-old-submit", mode: "submit", rowsHash: answer.rowsHash! });
      expect(submit.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
      expect(submit.offers).toEqual(["keys"]);
    });
  });
});
