// The slow cases of deliver.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { HoldStore } from "../surface/holds.ts";
import { KeyGate } from "../surface/key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "../surface/protocol.ts";
import { SurfaceShadow } from "../surface/shadow.ts";
import type { AgentView } from "../types.ts";
import { RequestStore } from "../surface/requests.ts";
import { DATA_PANE, dataDescribe, dataRig } from "../inside/data-rig.ts";
import { releasesHeld } from "../inside/wake.ts";
import { sendIdOf, type SendResult, type WalkyHost } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { WalkyService } from "./service.ts";
import { roots, pane, operator, send, PROBE, TEST_RANGE, BoxPane, DeskState } from "./deliver.rig.ts";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a draft holds the message, through the Send Protocol (M62 spec 02)", () => {
  interface Wired {
    readonly box: BoxPane;
    readonly service: WalkyService;
    readonly protocol: SendProtocol;
    readonly holds: HoldStore;
    readonly clock: { now: number };
    /** The Surface polls the bridge ran, one per walky poll. */
    readonly polls: Surface[];
    /** What the walky host's list says the pane is: a new instance stands for a pane that was replaced. */
    instance: string;
    /** Runs before each poll: the person at the desk. */
    desk: (poll: number) => void;
    /** Set by the desk: the walky poll waits for it, so a send the test makes there finishes first. */
    hold: Promise<unknown> | null;
  }

  /**
   * One pane, the real Send Protocol with its request store and hold queue, and walky talky over it as
   * the bridge wires them (index.ts): the send is marked, a held one reads what holds it from its hold
   * file, and the release asks walky first. Each walky poll is one Surface poll of the pane.
   */
  function wired(options: { readonly realSurface?: boolean; readonly version?: string } = {}): Wired {
    const root = mkdtempSync(join(tmpdir(), "walky-protocol-"));
    roots.push(root);
    const clock = { now: 1_786_000_000_000 };
    const now = (): number => clock.now;
    const box = new BoxPane();
    const holds = new HoldStore(join(root, "held"), now);
    const store = new RequestStore(join(root, "sends"), now);
    const base = loadProfiles().get("claude")!;
    let check: (id: string, session: string, paneId: string) => boolean = () => true;
    const protocol = new SendProtocol({
      mux: { readGrid: box.readGrid, typeText: box.typeText, pasteText: box.pasteText },
      gate: new KeyGate(box, now),
      store,
      locks: new SessionLocks(),
      ring: new RowRing(),
      profile: () => Promise.resolve(profileFor("claude", options.version ?? "2.1.200", { log: () => undefined, profiles: new Map([["claude", { ...base, versions: TEST_RANGE }]]) })),
      generation: () => "claude:s1",
      holds,
      releaseCheck: (id, session, paneId) => check(id, session, paneId),
      now,
      sleep: (ms) => Promise.resolve(void (clock.now += ms)),
    });
    const result = (sendId: string, outcome: string, reason: string | undefined): SendResult => {
      const why = outcome === "held" ? (holds.get(sendId)?.cause ?? reason) : reason;
      return why === undefined ? { outcome } : { outcome, reason: why };
    };
    const state: DeskState = { instance: "aaaa", desk: () => undefined, hold: null };
    const host: WalkyHost = {
      panes: () => [pane("%1", { harness: "claude", instance: state.instance })],
      send: async (target, sendId, text, hold) => {
        const answer = await protocol.handle(hold === undefined ? { id: sendId, text, mode: "send" } : { id: sendId, text, mode: "send", draftHolds: true, holdUntil: hold.holdUntil, walky: hold.walky }, { session: target.session, paneId: target.paneId, harness: "claude" });
        return answer.receipt === undefined ? { outcome: "unknown" } : result(sendId, answer.receipt.outcome, answer.receipt.reason);
      },
      sendState: (sendId) => {
        const receipt = store.get(sendId)?.receipt;
        return receipt === undefined ? null : result(sendId, receipt.outcome, receipt.reason);
      },
      cancelHeld: (session, paneId, sendId) => void protocol.cancelHeld(session, paneId, sendId),
    };
    const polls: Surface[] = [];
    // With `realSurface` each poll reads the pane through the bridge's own Surface poll (shadow.ts over
    // fold.ts and the Claude profile), as index.ts wires it, instead of the box's own word.
    const shadow = options.realSurface === true ? new SurfaceShadow({ mux: { readGrid: box.readGrid }, pollMs: 1000, log: () => undefined, now, version: () => Promise.resolve("2.1.200"), compare: false }) : null;
    const view: AgentView = { paneId: "%1", workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd: "/x", focused: false };
    const pollSurface = async (): Promise<Surface> => {
      if (shadow === null) return box.surface();
      await shadow.observe([view]);
      return shadow.surfaceOf("%1")!;
    };
    const log = new WalkyLog(join(root, "walky"), now);
    const service = new WalkyService({
      log,
      host,
      memberId: null,
      enabled: () => true,
      machine: "desk",
      keyPem: () => null,
      now,
      // A walky poll is one Surface poll: the hold rides it, no poller of its own.
      sleep: async (ms) => {
        clock.now += ms;
        wiredRig.desk(polls.length);
        await state.hold;
        const surface = await pollSurface();
        polls.push(surface);
        await Promise.all(
          protocol.tickHolds(
            "main",
            () => surface,
            shadow === null ? undefined : (paneId) => shadow.boxOf(paneId)?.box ?? null,
            shadow === null ? undefined : (paneId) => shadow.boxOf(paneId)?.plain === true,
          ),
        );
      },
    });
    check = (id, session, paneId) => service.deliverer.stillMeant(id, session, paneId);
    const wiredRig: Wired = {
      box,
      service,
      protocol,
      holds,
      clock,
      polls,
      get instance() {
        return state.instance;
      },
      set instance(value) {
        state.instance = value;
      },
      get desk() {
        return state.desk;
      },
      set desk(value) {
        state.desk = value;
      },
      get hold() {
        return state.hold;
      },
      set hold(value) {
        state.hold = value;
      },
    };
    return wiredRig;
  }

  /**
   * Each case reads a real clock for about 1.2 s on Linux and 2 s on the Windows VM alone, and ran past
   * Bun's default 5 s there inside the full bridge run (the stage/next run, 2026-11-20).
   */
  const LOADED_GUEST_MS = 20_000;

  describe("a held message and Claude Code's suggestion on a plain-text read (M78 spec 06)", () => {
    const GHOST_ID = "wt_ghostghost01";

    const ghostHeader = `[walky-talky ${GHOST_ID}] from operator "cli"`;

    // Live 2026-10-30, Claude Code 2.1.314 on herdr-core: after a turn the empty box showed this suggestion,
    // plain, and the bridge read it as a draft.
    const SUGGESTION = "Tell me what you'd like to work on";

    /** The probe characters typed into the box so far. */
    const probes = (r: { readonly box: BoxPane }): number => r.box.calls.filter((call) => call === `type:${PROBE}`).length;

    test("a typed draft on a plain-text read stays held: one probe proves it, the same text is never probed again", async () => {
      const r = wired({ realSurface: true });
      r.box.plain = true;
      r.box.suggestion = SUGGESTION;
      r.box.box = "a long thought";
      await r.service.send(send(GHOST_ID, "local/%1"), operator);
      await r.service.deliverer.settled();
      expect(r.service.status(GHOST_ID).receipts[0]).toMatchObject({ state: "inbox-only", reason: "held past 60 minutes" });
      expect(r.polls.length).toBeGreaterThan(100);
      expect(probes(r)).toBe(1);
      expect(r.box.keysSeen).toEqual(["Backspace"]);
      expect(r.box.box).toBe("a long thought");
      expect(r.box.calls.some((call) => call.includes(ghostHeader))).toBe(false);
    }, LOADED_GUEST_MS);

    test("a styled read behaves as today: the faint suggestion is the empty box, and a typed draft is held with no extra write", async () => {
      const free = wired({ realSurface: true });
      free.box.suggestion = SUGGESTION;
      await free.service.send(send(GHOST_ID, "local/%1"), operator);
      await free.service.deliverer.settled();
      expect(free.service.status(GHOST_ID).receipts[0]).toMatchObject({ state: "delivered" });
      expect(probes(free)).toBe(0);
      expect(free.box.keysSeen).not.toContain("Backspace");
      const held = wired({ realSurface: true });
      held.box.suggestion = SUGGESTION;
      held.box.box = "a long thought";
      await held.service.send(send(GHOST_ID, "local/%1"), operator);
      await held.service.deliverer.settled();
      expect(held.service.status(GHOST_ID).receipts[0]).toMatchObject({ state: "inbox-only", reason: "held past 60 minutes" });
      expect(held.box.calls).toEqual([]);
      expect(held.box.keysSeen).toEqual([]);
    }, LOADED_GUEST_MS);
  });
});

dataDescribe("WalkyTalky by data (M99 spec 05)", () => {
  async function linked(options: { readonly capabilities?: string[]; readonly wordMs?: number; readonly draft?: boolean | null; readonly hubNow?: () => number } = {}) {
    const data = await dataRig({ harness: "claude", version: "2.1.200", wordMs: options.wordMs ?? 800, now: options.hubNow ?? Date.now });
    roots.push(join(data.socket, "..", ".."));
    // The part says its box once after hello, as the Claude mod does: no draft unless the test says. `null`: it says nothing.
    const draft = options.draft === undefined ? false : options.draft === null ? undefined : options.draft;
    const part = await data.part(options.capabilities === undefined ? {} : { capabilities: options.capabilities }, draft === undefined ? {} : { draft });
    const host: WalkyHost = {
      panes: () => [pane(DATA_PANE.paneId, { harness: "claude" })],
      send: async (target, sendId, text, hold) => {
        const answer = await data.protocol.handle(hold === undefined ? { id: sendId, text, mode: "send", fromPhone: false } : { id: sendId, text, mode: "send", fromPhone: false, draftHolds: true, holdUntil: hold.holdUntil }, {
          session: target.session,
          paneId: target.paneId,
          harness: "claude",
        });
        return answer.receipt === undefined ? { outcome: "unknown" } : answer.receipt.reason === undefined ? { outcome: answer.receipt.outcome } : { outcome: answer.receipt.outcome, reason: answer.receipt.reason };
      },
      sendState: (sendId) => {
        const receipt = data.store.get(sendId)?.receipt;
        if (receipt === undefined) return null;
        const why = receipt.outcome === "held" ? (data.holds.get(sendId)?.cause ?? receipt.reason) : receipt.reason;
        return why === undefined ? { outcome: receipt.outcome } : { outcome: receipt.outcome, reason: why };
      },
      cancelHeld: (session, paneId, sendId) => void data.protocol.cancelHeld(session, paneId, sendId),
      deliverOverDraft: async (session, paneId, sendId) => (await data.protocol.deliverOverDraft(session, paneId, sendId)).result,
    };
    const root = mkdtempSync(join(tmpdir(), "walky-data-"));
    roots.push(root);
    const clock = { now: Date.now() };
    const log = new WalkyLog(join(root, "walky"), () => clock.now);
    const service = new WalkyService({
      log,
      host,
      memberId: null,
      enabled: () => true,
      machine: "desk",
      keyPem: () => null,
      now: () => clock.now,
      // A walky poll waits a real moment, so the part's events land between polls.
      sleep: async (ms) => {
        clock.now += ms;
        await Bun.sleep(5);
      },
    });
    return { data, part, service, log, clock };
  }

  /** The pane's oldest held send goes at the part's turn end or its "no draft any more", as index.ts wires it. */
  function releaseLikeIndex(r: Awaited<ReturnType<typeof linked>>): void {
    r.data.hub.listen({
      event: (bound, event) => {
        if (releasesHeld(event, r.data.hub.turnOf(bound.address))) void r.data.protocol.releaseOnTurnEnd(bound.address.session, bound.address.paneId);
      },
    });
  }

  async function receiptReason(r: Awaited<ReturnType<typeof linked>>, id: string, reason: string): Promise<void> {
    for (let i = 0; i < 200 && r.service.status(id).receipts[0]?.reason !== reason; i++) await Bun.sleep(5);
  }

  test("held by data: a draft in the box holds the message; nothing goes to the part while it stands", async () => {
    // Decision of 2026-11-13: another agent's words never go in over the person's draft.
    const r = await linked({ draft: true });
    try {
      await r.service.send(send("wt_aaaaaaaaaaa4", `local/${DATA_PANE.paneId}`), operator);
      const sendId = sendIdOf("wt_aaaaaaaaaaa4", `local/${DATA_PANE.paneId}`);
      await receiptReason(r, "wt_aaaaaaaaaaa4", "draft present");
      expect(r.service.status("wt_aaaaaaaaaaa4").receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
      // Held by the bridge: nothing queued for the part, and no key typed.
      expect(r.data.hub.stateOf(sendId)).toBeNull();
      expect((await r.part.next({ waitMs: 1000 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
      expect(r.data.holds.get(sendId)?.cause).toBe("draft_present");
      // A turn end with the draft still there does not let it go.
      releaseLikeIndex(r);
      await r.part.event("turn.end", { turn: "t9" });
      expect((await r.part.next({ waitMs: 1000 })).status).toBe(204);
    } finally {
      r.data.stop();
    }
  });

  test("held by data: the draft clears and the message goes once, as mail, with no key typed", async () => {
    const r = await linked({ draft: true });
    try {
      releaseLikeIndex(r);
      await r.service.send(send("wt_aaaaaaaaaa41", `local/${DATA_PANE.paneId}`), operator);
      const sendId = sendIdOf("wt_aaaaaaaaaa41", `local/${DATA_PANE.paneId}`);
      await receiptReason(r, "wt_aaaaaaaaaa41", "draft present");
      const served = r.part.serveOnce({ waitMs: 3000 });
      await r.part.event("draft.state", { present: false });
      expect(await served).toEqual({ id: sendId, kind: "mail", text: "[walky-talky wt_aaaaaaaaaa41] from operator \"cli\"\nhello" });
      await r.service.deliverer.settled();
      expect(r.service.status("wt_aaaaaaaaaa41").receipts[0]?.state).toBe("delivered");
      // Exactly once: more "no draft" words and a turn end hand out nothing more.
      await r.part.event("draft.state", { present: false });
      await r.part.event("turn.end", { turn: "t10" });
      expect((await r.part.next({ waitMs: 1000 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("held by data: the part finds a draft as it submits, submits nothing, and the message waits, then goes once under a new id", async () => {
    // The race: the person starts typing after the bridge read "no draft" and before the part submits.
    // The part reads the box right before its submit and answers `failed` with reason `draft`.
    const r = await linked();
    try {
      releaseLikeIndex(r);
      const first = r.part.serveOnce({ failReason: "draft" });
      await r.service.send(send("wt_aaaaaaaaaa42", `local/${DATA_PANE.paneId}`), operator);
      const sendId = sendIdOf("wt_aaaaaaaaaa42", `local/${DATA_PANE.paneId}`);
      expect((await first)?.id).toBe(sendId);
      await r.part.event("draft.state", { present: true });
      await receiptReason(r, "wt_aaaaaaaaaa42", "draft present");
      expect(r.service.status("wt_aaaaaaaaaa42").receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
      const second = r.part.serveOnce({ waitMs: 3000 });
      await r.part.event("draft.state", { present: false });
      const again = await second;
      expect(again?.kind).toBe("mail");
      expect(again?.id).not.toBe(sendId);
      await r.service.deliverer.settled();
      expect(r.service.status("wt_aaaaaaaaaa42").receipts[0]?.state).toBe("delivered");
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("held by data: the part is replaced while the message waits; the new part's word releases it once", async () => {
    const r = await linked({ draft: true });
    try {
      releaseLikeIndex(r);
      await r.service.send(send("wt_aaaaaaaaaa44", `local/${DATA_PANE.paneId}`), operator);
      const sendId = sendIdOf("wt_aaaaaaaaaa44", `local/${DATA_PANE.paneId}`);
      await receiptReason(r, "wt_aaaaaaaaaa44", "draft present");
      // A reload: a new part for the same pane. It has not said its box yet, and the message stays held.
      const fresh = await r.data.part({}, { idle: false });
      expect((await r.part.next({ waitMs: 1000 })).status).toBe(410);
      expect(r.data.hub.draftOf(DATA_PANE)).toBeNull();
      expect(r.service.status("wt_aaaaaaaaaa44").receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
      // The new part says its box, then its turn, as the Claude mod does after a hello: the turn word releases it.
      await fresh.event("draft.state", { present: false });
      expect(r.data.holds.get(sendId)?.state).toBe("held");
      const served = fresh.serveOnce({ waitMs: 3000 });
      await fresh.event("turn.end", { turn: null });
      expect((await served)?.id).toBe(sendId);
      await r.service.deliverer.settled();
      expect(r.service.status("wt_aaaaaaaaaa44").receipts[0]?.state).toBe("delivered");
      expect((await fresh.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("a mail the part answers dropped keeps its rule: unknown, never typed on the screen after (only a phone prompt takes the screen)", async () => {
    const r = await linked();
    try {
      const served = r.part.serveOnce({ failReason: "dropped", failDetail: "blocked by a hook" });
      await r.service.send(send("wt_aaaaaaaaaaa7", `local/${DATA_PANE.paneId}`), operator);
      await served;
      await r.service.deliverer.settled();
      expect(r.service.status("wt_aaaaaaaaaaa7").receipts[0]).toMatchObject({ state: "unknown", reason: "no evidence" });
      expect(r.data.mux.calls).toEqual([]);
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
    } finally {
      r.data.stop();
    }
  });

  // ── Deliver now (spec 05, decision of 2026-11-13): the person hands one held message over their draft ──

  /** The pane as the owner's route names it. */
  function owner(r: Awaited<ReturnType<typeof linked>>) {
    const instance = r.service.instanceOf(DATA_PANE.session, DATA_PANE.paneId);
    if (instance === null) throw new Error("no instance for the data pane");
    return { session: DATA_PANE.session, paneId: DATA_PANE.paneId, instance };
  }

  /** One message from the operator, held for the draft. */
  async function heldForDraft(r: Awaited<ReturnType<typeof linked>>, id: string): Promise<string> {
    await r.service.send(send(id, `local/${DATA_PANE.paneId}`), operator);
    await receiptReason(r, id, "draft present");
    expect(r.service.status(id).receipts[0]).toMatchObject({ state: "accepted", reason: "draft present" });
    return sendIdOf(id, `local/${DATA_PANE.paneId}`);
  }

  async function deliverNow(r: Awaited<ReturnType<typeof linked>>, id: string) {
    const answer = await r.service.deliverNow(id, owner(r));
    if (!answer.ok) throw new Error(answer.error);
    return answer.result;
  }

  test("deliver now: the message goes once, as mail marked overDraft, the draft not asked; a repeat sends nothing", async () => {
    const r = await linked({ draft: true });
    try {
      releaseLikeIndex(r);
      const sendId = await heldForDraft(r, "wt_aaaaaaaaaa61");
      const served = r.part.serveOnce({ waitMs: 3000 });
      const result = await deliverNow(r, "wt_aaaaaaaaaa61");
      expect(await served).toEqual({ id: sendId, kind: "mail", text: "[walky-talky wt_aaaaaaaaaa61] from operator \"cli\"\nhello", overDraft: true });
      expect(result).toMatchObject({ result: "delivered", receipt: { state: "delivered", overDraft: true, sendId } });
      await r.service.deliverer.settled();
      expect(r.service.status("wt_aaaaaaaaaa61").receipts[0]).toMatchObject({ state: "delivered", overDraft: true });
      // The draft still stands as the part said; the bridge never asked for its text.
      expect(r.data.hub.draftOf(DATA_PANE)).toBe(true);
      // Exactly once: a second tap, a retry after a lost answer, the draft clearing and a turn end hand out nothing more.
      expect((await deliverNow(r, "wt_aaaaaaaaaa61")).result).toBe("repeat");
      await r.part.event("draft.state", { present: false });
      await r.part.event("turn.end", { turn: "t61" });
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("deliver now races the draft clearing by itself: one command reaches the part, never two", async () => {
    const r = await linked({ draft: true });
    try {
      releaseLikeIndex(r);
      await heldForDraft(r, "wt_aaaaaaaaaa62");
      const served = r.part.serveOnce({ waitMs: 3000 });
      // The tap and the part's "no draft" in the same moment: the hold queue's release takes it once.
      const [tap] = await Promise.all([deliverNow(r, "wt_aaaaaaaaaa62"), r.part.event("draft.state", { present: false })]);
      expect((await served)?.kind).toBe("mail");
      // Whichever run took it, the tap answers the delivery; the one that ran first decides overDraft.
      expect(tap.result).toBe("delivered");
      await r.service.deliverer.settled();
      expect(r.service.status("wt_aaaaaaaaaa62").receipts[0]?.state).toBe("delivered");
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("deliver now: two asks at once (a lost answer, a second device) deliver once, and both answers say it went", async () => {
    const r = await linked({ draft: true });
    try {
      const sendId = await heldForDraft(r, "wt_aaaaaaaaaa68");
      const served = r.part.serveOnce({ waitMs: 3000 });
      const [one, two] = await Promise.all([deliverNow(r, "wt_aaaaaaaaaa68"), deliverNow(r, "wt_aaaaaaaaaa68")]);
      expect((await served)?.id).toBe(sendId);
      expect(one).toMatchObject({ result: "delivered", receipt: { state: "delivered", overDraft: true } });
      expect(two).toMatchObject({ result: "repeat", receipt: { state: "delivered", overDraft: true } });
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("deliver now that the part took with no word may have arrived: unknown, marked, and never sent again", async () => {
    const r = await linked({ draft: true, wordMs: 300 });
    try {
      const sendId = await heldForDraft(r, "wt_aaaaaaaaaa66");
      const served = r.part.serveOnce({ waitMs: 3000, silent: true });
      const tap = deliverNow(r, "wt_aaaaaaaaaa66");
      await served;
      await r.part.event("taken", { cmd: sendId });
      expect(await tap).toMatchObject({ result: "may have arrived", receipt: { state: "unknown", reason: "no evidence", overDraft: true } });
      expect((await deliverNow(r, "wt_aaaaaaaaaa66")).result).toBe("repeat");
      await r.part.event("draft.state", { present: false });
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });

  test("deliver now that the part answers dropped stays off the screen: unknown, and never sent again", async () => {
    const r = await linked({ draft: true });
    try {
      const sendId = await heldForDraft(r, "wt_aaaaaaaaaa67");
      const served = r.part.serveOnce({ waitMs: 3000, failReason: "dropped" });
      const tap = deliverNow(r, "wt_aaaaaaaaaa67");
      expect((await served)?.id).toBe(sendId);
      expect(await tap).toMatchObject({ receipt: { state: "unknown", reason: "no evidence", overDraft: true } });
      expect((await r.part.next({ waitMs: 800 })).status).toBe(204);
      expect(r.data.mux.calls).toEqual([]);
    } finally {
      r.data.stop();
    }
  });
});
