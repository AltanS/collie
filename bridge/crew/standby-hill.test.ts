import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import type { HillDecision, HillMedia } from "../../web/src/lib/hill/wire.ts";
import { decision } from "../hill/fixtures.ts";
import { makeGroup } from "../hill/group.ts";
import { hillMovedAway } from "./deposed.ts";
import { leadStore, peerStore } from "./fixtures.ts";
import { HillMediaStore } from "../hill/media.ts";
import { HillPush } from "../hill/push.ts";
import { memoryHillReceipts } from "../hill/receipts.ts";
import { HILL_DEPOSED, HillService } from "../hill/service.ts";
import { hillDir, HillStore } from "../hill/store.ts";
import { hillSwitchPath } from "../hill/switch.ts";
import { HillCrewStateFile, readHillCrewState, writeHillCrewState } from "../hill/crew-state.ts";
import { TRICKS_MAP_FILE } from "../tricks/hill.ts";
import { hillCarryRoutes } from "./carry-surface.ts";
import type { CarryCall } from "./carry-sync.ts";
import { machine, PNG, removeCarryDirs } from "./carry-fixtures.ts";
import { adoptCarriedHill, pictureStayed, TRICK_NOT_STARTED } from "./hill-adopt.ts";
import { HillCopySync, type HillCopyClient } from "./hill-copy-sync.ts";
import type { CrewLink } from "./peer-client.ts";
import { CREW_HILL_COPY_MEDIA_PATH, CREW_HILL_COPY_PATH } from "./router.ts";
import { CARRY_MEDIA_TOTAL_MAX, hillCopyDigest, mediaPlan, parseHillList, parseMediaPush, readCarriedRecord, StandbyHillStore } from "./standby-hill.ts";

afterAll(removeCarryDirs);

const T0 = 1_762_000_000_000;
const LINK: CrewLink = { memberId: "laptop", address: "127.0.0.1:1" };
const ROLE = { crewId: "crew-1", leads: false, leadMemberId: "desk", deputy: true };
const HASH = "c".repeat(64);
const MEDIA: HillMedia = { id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: PNG.length, width: null, height: null };

const agent = (n: number, over: Partial<HillDecision> = {}) => decision(`dc_agent${String(n).padStart(7, "0")}`, { at: T0 + n, ...over });
const trickCard = (trickId: string, n: number) =>
  decision(`dc_trick${String(n).padStart(7, "0")}`, {
    at: T0 + n,
    from: { kind: "trick", address: null, trickId, trickKey: "k", memberId: "desk", harness: null, label: trickId, host: "desk", trickHost: "desk" },
  });
const collieCard = (type: "version" | "proposal" | "carried", n: number, options = [{ intent: "ok", label: "OK" }]) =>
  decision(`dc_collie${String(n).padStart(6, "0")}`, {
    at: T0 + n,
    options,
    from: { kind: "collie", address: null, trickId: null, trickKey: null, memberId: "desk", harness: null, label: "Collie", host: "desk", trickHost: null, ref: { type, id: "legs", hash: HASH } },
  });

/** A Hill with a disk for its pictures, and every push it would send. */
async function hillOn(label: string, opts: { deposed?: () => boolean; mode?: "lead" | "peer" } = {}) {
  const m = await machine(label);
  const store = new HillStore(hillDir(m.stateDir), () => T0);
  const media = new HillMediaStore(hillDir(m.stateDir), []);
  const pushes: unknown[] = [];
  let n = 0;
  const hill = new HillService({
    store,
    media,
    receipts: memoryHillReceipts(),
    place: () => null,
    send: async () => "typed",
    crewMode: () => opts.mode ?? "lead",
    deposed: opts.deposed ?? (() => false),
    walkyOn: () => true,
    memberId: label,
    machine: label,
    now: () => T0,
    mintId: () => `dc_new${String((n += 1)).padStart(9, "0")}`,
    hillSwitch: { on: () => true },
    push: new HillPush({ ready: () => true, send: (message) => void pushes.push(message) }),
  });
  return { m, store, media, hill, pushes };
}

/** A sync from `lead` to a deputy store through the deputy's own routes. */
function wire(lead: HillService, deputy: StandbyHillStore) {
  const routes = hillCarryRoutes(deputy);
  const calls: string[] = [];
  const via = (path: string) => async (_link: CrewLink, body: JsonObject): Promise<CarryCall> => {
    calls.push(path);
    // SAFETY: `JSON.parse` of `JSON.stringify` output is a JsonValue by construction.
    const crossed = JSON.parse(JSON.stringify(body)) as JsonValue;
    const answer = await routes.handle(path, { from: "desk", crewId: "crew-1" }, crossed);
    return answer === null ? { kind: "answer", status: 404, body: null } : { kind: "answer", status: answer.status, body: answer.body };
  };
  const client: HillCopyClient = { list: via(CREW_HILL_COPY_PATH), media: via(CREW_HILL_COPY_MEDIA_PATH) };
  const sync = new HillCopySync({ source: { view: (max) => lead.carryView(max), media: (id, m) => lead.carryMedia(id, m), tricks: () => ({}) }, client, now: () => T0 });
  return { sync, calls, report: () => routes.report() };
}

function listBody(seq: number, decisions: HillDecision[], closed: string[] = []): JsonValue {
  // SAFETY: as above, a JSON round trip.
  return { seq, on: true, decisions: JSON.parse(JSON.stringify(decisions)) as JsonValue, closed, tricks: {} };
}

describe("the lead's open Decisions reach its deputy (§25)", () => {
  test("one sync carries the open Decisions and their pictures, newest first; the next sends nothing", async () => {
    const lead = await hillOn("desk");
    lead.store.put(agent(1, { media: [MEDIA] }), agent(2), agent(3, { state: "answered", closedAt: T0 }));
    lead.media.save(agent(1).id, [{ id: MEDIA.id, bytes: PNG }]);
    const deputy = new StandbyHillStore((await machine("deputy")).stateDir);
    const w = wire(lead.hill, deputy);
    expect(await w.sync.run(LINK, w.report())).toBe("done");
    expect(w.calls).toEqual([CREW_HILL_COPY_PATH, CREW_HILL_COPY_MEDIA_PATH]);
    const held = await deputy.load();
    expect(held?.decisions.map((d) => d.id)).toEqual([agent(2).id, agent(1).id]);
    expect(held?.closed).toEqual([agent(3).id]);
    expect(await deputy.mediaBytes(agent(1).id, MEDIA)).toEqual(PNG);
    expect(await w.sync.run(LINK, w.report())).toBe("idle");
    expect(w.calls).toHaveLength(2);
    expect(w.sync.deputyFact()).toEqual({ member: "laptop", state: "current", open: 2 });
  });

  test("the copy is invisible to the deputy's own Hill, before and after a restart", async () => {
    const lead = await hillOn("desk");
    lead.store.put(agent(1));
    const deputyMachine = await machine("deputy");
    const w = wire(lead.hill, new StandbyHillStore(deputyMachine.stateDir));
    await w.sync.run(LINK, w.report());
    for (let i = 0; i < 2; i += 1) {
      expect(new HillStore(hillDir(deputyMachine.stateDir)).all()).toEqual([]);
      expect(await new StandbyHillStore(deputyMachine.stateDir).openCount()).toBe(1);
    }
  });

  test("an older list is refused, and an id the lead closed never comes back as open", async () => {
    const deputy = new StandbyHillStore((await machine("deputy")).stateDir);
    const apply = (seq: number, decisions: HillDecision[], closed: string[] = []) => {
      const list = parseHillList(listBody(seq, decisions, closed));
      if (list === null) throw new Error("bad list");
      return deputy.applyList({ from: "desk", crewId: "crew-1", list });
    };
    expect((await apply(5, [agent(1)])).ok).toBe(true);
    expect(await apply(5, [])).toEqual({ ok: false, code: "stale" });
    expect(await apply(4, [agent(9)])).toEqual({ ok: false, code: "stale" });
    await apply(6, [], [agent(1).id]);
    // Replayed, or re-sent by a confused lead: the id is closed here for good.
    await apply(7, [agent(1), agent(2)]);
    expect((await deputy.load())?.decisions.map((d) => d.id)).toEqual([agent(2).id]);
    expect(await new StandbyHillStore(deputy.dir.replace(/\/standby-hill$/u, "")).load().then((i) => i?.closed)).toEqual([agent(1).id]);
  });

  test("a picture is taken only as the type and size its record says, read from its bytes", async () => {
    const deputy = new StandbyHillStore((await machine("deputy")).stateDir);
    const jpegClaim: HillMedia = { ...MEDIA, mime: "image/jpeg" };
    const list = parseHillList(listBody(1, [agent(1, { media: [jpegClaim] }), agent(2, { media: [{ ...MEDIA, id: "im_bbbbbbbbbbbbbbbb" }] })]));
    if (list === null) throw new Error("bad list");
    expect((await deputy.applyList({ from: "desk", crewId: "crew-1", list })).ok).toBe(true);
    // The lead says JPEG; the bytes say PNG: refused, and settled so it is not asked again.
    expect(await deputy.applyMedia({ decisionId: agent(1).id, mediaId: MEDIA.id, bytes: PNG })).toMatchObject({ ok: false, code: "mismatch" });
    expect(await deputy.applyMedia({ decisionId: agent(2).id, mediaId: "im_bbbbbbbbbbbbbbbb", bytes: PNG.subarray(1) })).toMatchObject({ ok: false, code: "mismatch" });
    expect(await deputy.applyMedia({ decisionId: agent(3).id, mediaId: MEDIA.id, bytes: PNG })).toMatchObject({ ok: false, code: "unknown" });
    expect(deputy.report()?.need).toBe(0);
    expect(existsSync(join(deputy.dir, "media", agent(1).id))).toBe(false);
  });

  test("a picture's names are ids, never paths: traversal and look-alikes are refused before a path is built", () => {
    const b64 = Buffer.from(PNG).toString("base64");
    expect(parseMediaPush({ decisionId: agent(1).id, mediaId: MEDIA.id, b64 })).not.toBeNull();
    for (const bent of [
      { decisionId: "../../etc", mediaId: MEDIA.id, b64 },
      { decisionId: agent(1).id, mediaId: "../im_aaaaaaaaaaaaaaaa", b64 },
      { decisionId: agent(1).id, mediaId: "IM_AAAAAAAAAAAAAAAA", b64 },
      { decisionId: agent(1).id, mediaId: "im_aaaaaaaaaaaaaaaa/x", b64 },
      { decisionId: agent(1).id, mediaId: MEDIA.id, b64: "not base64!" },
    ]) {
      expect(parseMediaPush(bent)).toBeNull();
    }
  });

  test("pictures are carried newest Decision first within 32 MiB; the rest stay on the lead", () => {
    const big = (n: number): HillDecision => agent(n, { media: [{ ...MEDIA, id: `im_${String(n).padStart(16, "0")}`, bytes: 2 * 1024 * 1024 }] });
    const decisions = Array.from({ length: 20 }, (_, i) => big(i));
    const plan = mediaPlan(decisions);
    expect(plan.length).toBe(CARRY_MEDIA_TOTAL_MAX / (2 * 1024 * 1024));
    expect(plan[0]?.decisionId).toBe(decisions[0]?.id);
  });

  test("the digest the deputy keeps is the one the lead sent, so a left-out record cannot loop the sync", () => {
    const body = listBody(1, [agent(1)]);
    const list = parseHillList(body);
    expect(list?.digest).toBe(hillCopyDigest(true, JSON.parse(JSON.stringify([agent(1)])), [], {}));
  });

  test("a demotion removes the copy, pictures included", async () => {
    const lead = await hillOn("desk");
    lead.store.put(agent(1, { media: [MEDIA] }));
    lead.media.save(agent(1).id, [{ id: MEDIA.id, bytes: PNG }]);
    const deputyMachine = await machine("deputy");
    const deputy = new StandbyHillStore(deputyMachine.stateDir);
    await wire(lead.hill, deputy).sync.run(LINK, {});
    expect(await deputy.reconcile(ROLE)).toBe(false);
    expect(await deputy.reconcile({ ...ROLE, deputy: false })).toBe(true);
    expect(await readdir(deputyMachine.stateDir)).not.toContain("standby-hill");
  });
});

describe("the takeover tap brings the open Decisions along (§25)", () => {
  async function carried(decisions: HillDecision[], opts: { tricks?: JsonObject } = {}) {
    const lead = await hillOn("desk");
    lead.store.put(...decisions);
    for (const d of decisions) if (d.media.length > 0) lead.media.save(d.id, [{ id: MEDIA.id, bytes: PNG }]);
    const deputy = await hillOn("laptop");
    const copy = new StandbyHillStore(deputy.m.stateDir);
    const routes = hillCarryRoutes(copy);
    const view = lead.hill.carryView(500);
    // SAFETY: a JSON round trip.
    const body = { seq: 1, on: view.on, decisions: JSON.parse(JSON.stringify(view.open)) as JsonValue, closed: view.closed, tricks: opts.tricks ?? {} };
    await routes.handle(CREW_HILL_COPY_PATH, { from: "desk", crewId: "crew-1" }, body);
    for (const d of view.open) for (const m of d.media) await routes.handle(CREW_HILL_COPY_MEDIA_PATH, { from: "desk", crewId: "crew-1" }, { decisionId: d.id, mediaId: m.id, b64: Buffer.from(PNG).toString("base64") });
    return { lead, deputy, copy };
  }

  test("an agent's Decision keeps its id and its picture, and no push goes out", async () => {
    const { deputy, copy } = await carried([agent(1, { media: [MEDIA] })]);
    const result = await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 });
    expect(result).toEqual({ open: 1, closed: 0, dropped: 0 });
    const held = deputy.store.get(agent(1).id);
    expect(held?.state).toBe("open");
    expect(deputy.media.bytesOf(agent(1).id, MEDIA)).toEqual(PNG);
    expect(deputy.pushes).toEqual([]);
    expect(held?.pushTag).toBeUndefined();
    // Read back as the next boot reads it.
    expect(new HillStore(hillDir(deputy.m.stateDir)).get(agent(1).id)?.id).toBe(agent(1).id);
  });

  test("a picture that did not come along leaves a line on the card", async () => {
    const { deputy, copy } = await carried([agent(1, { media: [MEDIA], body: "Look at this." })]);
    await writeFile(join(copy.dir, "media", agent(1).id, MEDIA.id), new Uint8Array([1, 2, 3]));
    await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 });
    const held = deputy.store.get(agent(1).id);
    expect(held?.media).toEqual([]);
    expect(held?.body).toBe(`Look at this.\n\n${pictureStayed("desk")}`);
  });

  test("a trick that did not start closes with its reason; a started trick's Decision moves here; only the carried notice of Collie's own comes", async () => {
    const tricks: JsonObject = { legs: { gen: 0, keys: { k: { decisionId: trickCard("legs", 3).id, hash: "abc", state: "open", seq: 0 } } } };
    const { deputy, copy } = await carried([collieCard("version", 1), collieCard("proposal", 2), trickCard("legs", 3), trickCard("gone", 4), collieCard("carried", 5)], { tricks });
    const result = await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(["legs"]), stateDir: deputy.m.stateDir, now: () => T0 });
    expect(result).toEqual({ open: 2, closed: 1, dropped: 2 });
    const reason = (id: string) => [deputy.store.get(id)?.state, deputy.store.get(id)?.closedReason];
    // A new version card and a proposal card never cross: their files stay on the lead.
    expect(deputy.store.get(collieCard("version", 1).id)).toBeUndefined();
    expect(deputy.store.get(collieCard("proposal", 2).id)).toBeUndefined();
    expect(reason(trickCard("gone", 4).id)).toEqual(["withdrawn", TRICK_NOT_STARTED]);
    expect(deputy.store.get(trickCard("legs", 3).id)?.from).toMatchObject({ memberId: "laptop", trickHost: "laptop", host: "laptop" });
    expect(deputy.store.get(collieCard("carried", 5).id)?.state).toBe("open");
    const map = JSON.parse(await readFile(join(hillDir(deputy.m.stateDir), TRICKS_MAP_FILE), "utf8"));
    expect(map.tricks.legs.keys.k.decisionId).toBe(trickCard("legs", 3).id);
    expect(existsSync(hillSwitchPath(deputy.m.stateDir))).toBe(true);
  });

  test("an id this Hill already holds is left as it is here", async () => {
    const { deputy, copy } = await carried([agent(1, { title: "From the lead" })]);
    deputy.store.put(agent(1, { title: "Mine", state: "answered", closedAt: T0 }));
    await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 });
    expect(deputy.store.get(agent(1).id)).toMatchObject({ title: "Mine", state: "answered" });
  });

  test("a copy from another lead brings nothing", async () => {
    const { deputy, copy } = await carried([agent(1)]);
    expect(await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "attic", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 })).toEqual({ open: 0, closed: 0, dropped: 0 });
  });

  test("a forged Collie card with an acting answer never lands: only the carried notice with its one OK is a Collie card from the wire", async () => {
    const approve = [{ intent: "approve", label: "Approve" }];
    const { deputy, copy } = await carried([collieCard("version", 7, approve), collieCard("carried", 8, approve), collieCard("carried", 9, [...approve, { intent: "ok", label: "OK" }]), collieCard("carried", 10)]);
    expect((await copy.load())?.dropped).toBe(3);
    const result = await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 });
    expect(result).toEqual({ open: 1, closed: 0, dropped: 3 });
    for (const n of [7, 8, 9]) expect(deputy.store.get(collieCard("carried", n).id)).toBeUndefined();
    expect(deputy.store.get(collieCard("carried", 10).id)?.state).toBe("open");
    expect(existsSync(join(deputy.m.configDir, "tricks"))).toBe(false);
  });

  test("a record with a group of cards never lands: only postCollie mints a group, and the carried notice has none", () => {
    const notice = collieCard("carried", 11);
    if (notice.from.kind !== "collie" || notice.from.ref === undefined) throw new Error("a carried notice has a ref");
    const made = makeGroup({ decline: "ok", parts: [[{ kind: "para", text: "card 1" }], [{ kind: "para", text: "card 2" }]] }, notice.from.ref, notice.options);
    if (!made.ok) throw new Error(made.error);
    // SAFETY: a JSON round trip, as the record crosses the wire.
    const wired = (d: HillDecision) => JSON.parse(JSON.stringify(d)) as JsonValue;
    // A well-formed group with a matching digest on the carried notice: a Collie card that acts on the lead's files.
    expect(readCarriedRecord(wired({ ...notice, group: made.group }))).toBe("dropped");
    // A session's record with a group is no Decision at all.
    expect(readCarriedRecord(wired({ ...agent(12), group: made.group }))).toBeNull();
    // The same notice without the group still lands.
    expect(readCarriedRecord(wired(notice))).toMatchObject({ id: notice.id, state: "open" });
  });
});

describe("the old lead after the takeover (§25)", () => {
  test("a deposed lead refuses an answer: the second answer to a carried Decision is never typed", async () => {
    const old = await hillOn("desk", { deposed: () => true });
    old.store.put(agent(1));
    const outcome = await old.hill.answer({ rid: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e70", node: `hill/${agent(1).id}`, intent: "yes", value: { text: null } }, agent(1).id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "denied", reason: HILL_DEPOSED, state: "open" } });
    expect(old.store.get(agent(1).id)?.state).toBe("open");
  });

  const answerOne = (hill: HillService) => hill.answer({ rid: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e71", node: `hill/${agent(1).id}`, intent: "yes", value: { text: null } }, agent(1).id, "Pixel 9");

  test("after approve-promote the old lead still runs as a lead, but its store names the new lead: answers are refused", async () => {
    // The handover rewrote the trust store in this process; the process restarts as a peer only later.
    let held = leadStore();
    const old = await hillOn("desk", { deposed: () => hillMovedAway(null, held) });
    old.store.put(agent(1));
    held = peerStore();
    expect(await answerOne(old.hill)).toMatchObject({ kind: "receipt", receipt: { code: "denied", reason: HILL_DEPOSED } });
    expect(old.store.get(agent(1).id)?.state).toBe("open");
    expect(hillMovedAway(null, leadStore())).toBe(false);
    expect(hillMovedAway(null, null)).toBe(false);
  });

  test("an old lead that booted again as a peer, its Decisions still on disk, refuses an answer", async () => {
    const old = await hillOn("desk", { mode: "peer" });
    old.store.put(agent(1));
    expect(await answerOne(old.hill)).toMatchObject({ kind: "receipt", receipt: { code: "denied", reason: HILL_DEPOSED } });
    expect(old.store.get(agent(1).id)?.state).toBe("open");
  });
});

describe("the crew state crosses with the Hill copy (1.29.0)", () => {
  test("a lead that never set one sends the body and digest it always sent; a set one rides and moves the digest", async () => {
    const lead = await hillOn("desk");
    lead.store.put(agent(1));
    const plain = lead.hill.carryView(500);
    expect(plain.crewState).toBeNull();
    // SAFETY: a JSON round trip.
    const decisions = JSON.parse(JSON.stringify(plain.open)) as JsonValue[];
    expect(hillCopyDigest(true, decisions, plain.closed, {})).toBe(hillCopyDigest(true, decisions, plain.closed, {}, null));
    const carried = { state: "away" as const, at: T0, by: "Pixel 9" };
    expect(hillCopyDigest(true, decisions, plain.closed, {}, carried)).not.toBe(hillCopyDigest(true, decisions, plain.closed, {}));
    const read = parseHillList({ seq: 1, on: true, decisions, closed: [], tricks: {}, crewState: carried });
    expect(read?.crewState).toEqual(carried);
    expect(read?.digest).toBe(hillCopyDigest(true, decisions, [], {}, carried));
    // A value this reader does not know is no crew state, never a guess.
    expect(parseHillList({ seq: 1, on: true, decisions, closed: [], tricks: {}, crewState: { state: "asleep", at: T0, by: "x" } })?.crewState).toBeNull();
  });

  test("the takeover keeps the newer crew state: a deputy's stale own file gives way to the lead's (C-N2)", async () => {
    const deputy = await hillOn("laptop-stale");
    const copy = new StandbyHillStore(deputy.m.stateDir);
    const routes = hillCarryRoutes(copy);
    writeHillCrewState(deputy.m.stateDir, { state: "here", by: "terminal" }, T0 - 50_000);
    await routes.handle(CREW_HILL_COPY_PATH, { from: "desk", crewId: "crew-1" }, { seq: 1, on: true, decisions: [], closed: [], tricks: {}, crewState: { state: "away", at: T0 - 9, by: "Pixel 9" } });
    await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 });
    expect(readHillCrewState(deputy.m.stateDir).view).toEqual({ state: "away", at: T0 - 9, by: "Pixel 9", told: null });
  });

  test("the takeover writes the lead's crew state on a deputy that holds none, and keeps the deputy's own when newer", async () => {
    for (const own of [false, true]) {
      const deputy = await hillOn(own ? "laptop-own" : "laptop");
      const copy = new StandbyHillStore(deputy.m.stateDir);
      const routes = hillCarryRoutes(copy);
      if (own) writeHillCrewState(deputy.m.stateDir, { state: "quiet", by: "terminal" }, T0 - 5);
      await routes.handle(CREW_HILL_COPY_PATH, { from: "desk", crewId: "crew-1" }, { seq: 1, on: true, decisions: [], closed: [], tricks: {}, crewState: { state: "away", at: T0 - 9, by: "Pixel 9" } });
      expect((await copy.load())?.crewState).toEqual({ state: "away", at: T0 - 9, by: "Pixel 9" });
      await adoptCarriedHill({ store: copy, hill: deputy.hill, lead: "desk", self: "laptop", machine: "laptop", started: new Set(), stateDir: deputy.m.stateDir, now: () => T0 });
      expect(readHillCrewState(deputy.m.stateDir).view).toEqual(own ? { state: "quiet", at: T0 - 5, by: "terminal", told: null } : { state: "away", at: T0 - 9, by: "Pixel 9", told: null });
    }
  });
});

describe("an older deputy and a lead that set a crew state (C-S2, review 8)", () => {
  /** A lead with one open Decision and the crew state set, and a client that counts the lists it sends. */
  async function leadWithState() {
    const lead = await hillOn("desk");
    lead.store.put(agent(1));
    writeHillCrewState(lead.m.stateDir, { state: "away", by: "Pixel 9" }, T0);
    const hill = new HillService({
      store: lead.store,
      receipts: memoryHillReceipts(),
      place: () => null,
      send: async () => "typed",
      crewMode: () => "lead",
      walkyOn: () => true,
      memberId: "desk",
      machine: "desk",
      now: () => T0,
      crewState: new HillCrewStateFile(lead.m.stateDir, () => undefined, () => T0),
    });
    const lists: JsonObject[] = [];
    const client: HillCopyClient = {
      list: async (_link, body) => {
        lists.push(body);
        return { kind: "answer", status: 200, body: { applied: true, need: { media: [] } } };
      },
      media: async () => ({ kind: "answer", status: 200, body: {} }),
    };
    const sync = new HillCopySync({ source: { view: (max) => hill.carryView(max), media: () => null, tricks: () => ({}) }, client, now: () => T0 });
    return { hill, sync, lists };
  }

  test("a 1.28.1-shaped report (digest of the four old fields, no word of the crew state) reads current, and no list goes", async () => {
    const { hill, sync, lists } = await leadWithState();
    const view = hill.carryView(500);
    expect(view.crewState).not.toBeNull();
    // SAFETY: a JSON round trip.
    const decisions = JSON.parse(JSON.stringify(view.open)) as JsonValue[];
    const old = { hillDigest: hillCopyDigest(view.on, decisions, view.closed, {}), hillSeq: 7, hillNeed: 0 };
    expect(await sync.run(LINK, old)).toBe("idle");
    expect(lists).toEqual([]);
    expect(sync.deputyFact()).toEqual({ member: "laptop", state: "current", open: 1 });
  });

  test("a deputy that says it reads the crew state gets it, and is current once its digest has it", async () => {
    const { hill, lists } = await leadWithState();
    const deputy = new StandbyHillStore((await machine("deputy-new")).stateDir);
    const routes = hillCarryRoutes(deputy);
    const report = () => routes.report();
    expect(report()).toMatchObject({ hillCopyKnows: ["crewState"] });
    const send = async (_link: CrewLink, body: JsonObject): Promise<CarryCall> => {
      lists.push(body);
      // SAFETY: a JSON round trip.
      const answer = await routes.handle(CREW_HILL_COPY_PATH, { from: "desk", crewId: "crew-1" }, JSON.parse(JSON.stringify(body)) as JsonValue);
      return answer === null ? { kind: "answer", status: 404, body: null } : { kind: "answer", status: answer.status, body: answer.body };
    };
    const live = new HillCopySync({ source: { view: (max) => hill.carryView(max), media: () => null, tricks: () => ({}) }, client: { list: send, media: async () => ({ kind: "answer", status: 200, body: {} }) }, now: () => T0 });
    expect(await live.run(LINK, report())).toBe("done");
    expect(lists.at(-1)?.crewState).toEqual({ state: "away", at: T0, by: "Pixel 9" });
    expect(await live.run(LINK, report())).toBe("idle");
    expect(live.deputyFact()?.state).toBe("current");
  });
});
