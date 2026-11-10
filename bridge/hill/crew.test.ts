import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { JsonObject } from "../json.ts";
import { asJsonObject, asJsonString, parseJson } from "../../web/src/lib/json.ts";
import type { CrewDialAnswer } from "../walky/crew.ts";
import { compareSemver } from "../update.ts";
import type { HillAnswerRequest } from "../../web/src/lib/hill/wire.ts";
import {
  CREW_HILL_MEDIA_ROUTE,
  CREW_HILL_OP_ROUTE,
  CREW_HILL_POST_ROUTE,
  HILL_HELD_MEMBER_BYTES,
  HILL_HELD_MS,
  HillCrewLead,
  HillHeldMedia,
  HillMemberForward,
  LEAD_UNREACHABLE_CODE,
  olderThanTricksCrew,
  ownAddress,
  sha256Hex,
  TRICKS_CREW_FIRST_VERSION,
  type HillCrewAnswer,
  type HillLeadLink,
} from "./crew.ts";
import { deniedFoldersSync, HillMediaStore } from "./media.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HILL_OPEN_MEMBER_MAX, HillService, NOT_ON_LEAD, notAnswering, type HillAgentSender, type HillCrewMode, type HillPlace } from "./service.ts";
import { hillDir, HillStore } from "./store.ts";

// The Hill across a crew (CREW_PROTOCOL §22): a member's agent posts on its lead's Hill, the lead holds
// the Decision, and an answer for a machine that is not answering is refused before anything closes.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** A PNG's signature and IHDR, enough for the sniff and the size. */
function png(width = 390, height = 240, padding = 64): Uint8Array {
  const ihdr = [..."IHDR"].map((ch) => ch.charCodeAt(0));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ihdr, ...be32(width), ...be32(height), 8, 2, 0, 0, 0, ...be32(0), ...Array.from({ length: padding }, (_, i) => i & 0xff)]);
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function fields(over: JsonObject = {}): JsonObject {
  return { v: 1, op: "hill.post", requestId: uuid(), title: "Ship it?", summary: "The leg is green.", options: [{ intent: "yes", label: "Yes" }], ...over };
}

/** The member's own session, as the member's bridge names its sender. */
const LAPTOP_PANE = "laptop/%3#cccc";
const SENDER: HillAgentSender = { kind: "agent", address: LAPTOP_PANE, memberId: "m_laptop0000", harness: "agent-x", label: "repo#main", host: "laptop" };

interface Bridge {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly audit: AuditEntry[];
  readonly sent: Array<{ to: string; body: string }>;
  readonly work: string;
  live: HillPlace[];
  offline: string | null;
  clock: number;
}

/** One bridge's hill, on disk under a fresh folder: a lead, or a member with a forward. */
function bridge(mode: HillCrewMode, opts: { forward?: HillMemberForward; memberId: string } = { memberId: "m_lead000000" }): Bridge {
  const state = folder("hill-crew-state-");
  const work = folder("hill-crew-work-");
  const media = new HillMediaStore(hillDir(state), deniedFoldersSync([state]), () => undefined);
  let n = 0;
  let m = 0;
  const b: Omit<Bridge, "hill"> = { store: new HillStore(hillDir(state), () => b.clock), audit: [], sent: [], work, live: [], offline: null, clock: 1000 };
  const hill = new HillService({
    store: b.store,
    receipts: memoryHillReceipts(),
    media,
    place: (address) => b.live.find((place) => place.address === address || place.address.split("#")[0] === address.split("#")[0]) ?? null,
    send: async (to, body) => {
      b.sent.push({ to, body });
      return "typed";
    },
    crewMode: () => mode,
    walkyOn: () => true,
    memberId: opts.memberId,
    machine: mode === "lead" ? "desk" : "laptop",
    now: () => b.clock,
    mintId: () => {
      n += 1;
      return `dc_crew${String(n).padStart(8, "0")}`;
    },
    mintMediaId: () => {
      m += 1;
      return `im_crew${String(m).padStart(12, "0")}`;
    },
    audit: (entry) => b.audit.push(entry),
    forward: opts.forward,
    offline: mode === "lead" ? () => b.offline : undefined,
  });
  return Object.assign(b, { hill });
}

/** The member's link straight into the lead's routes, as the router hands them a signed member. */
interface TestLink extends HillLeadLink {
  readonly calls: string[];
  down: boolean;
  status: number | null;
  older: boolean;
}

function wire(lead: HillCrewLead, memberId = "laptop"): TestLink {
  const link: TestLink = {
    calls: [],
    down: false,
    status: null,
    older: false,
    leadName: () => "desk",
    leadOlder: () => link.older,
    call: async (route: string, payload: string): Promise<CrewDialAnswer> => {
      link.calls.push(route);
      if (link.down) return { kind: "refused", reason: "transport" };
      if (link.status !== null) return { kind: "answer", status: link.status, body: { error: "not found" } };
      const body = parseJson(payload);
      const handle = route === CREW_HILL_MEDIA_ROUTE ? lead.media.bind(lead) : route === CREW_HILL_POST_ROUTE ? lead.post.bind(lead) : lead.op.bind(lead);
      const answer = handle(body, memberId);
      // The answer crosses the wire as JSON, as the router writes it.
      return { kind: "answer", status: answer.status, body: parseJson(JSON.stringify(answer.body)) ?? null };
    },
  };
  return link;
}

/** A lead and a member, in one process: the member's forward dials the lead's three routes. */
function crew() {
  const lead = bridge("lead");
  const held = new HillHeldMedia(() => lead.clock);
  const crewLead = new HillCrewLead({ hill: lead.hill, held, machineOf: (memberId) => memberId });
  const link = wire(crewLead);
  const member = bridge("peer", { forward: new HillMemberForward(link), memberId: "m_laptop0000" });
  // The lead's sweep lists the member's pane, as walky's `who` does.
  lead.live = [{ address: LAPTOP_PANE, label: "repo#main", host: "laptop", unattended: false }];
  return { lead, member, held, crewLead, link };
}

/** The id of the decision a post answer carries; throws when it carries none. */
function idOf(answer: HillCrewAnswer): string {
  const decision = asJsonObject(parseJson(JSON.stringify(answer.body)));
  const id = asJsonString(asJsonObject(decision?.decision)?.id);
  if (id === undefined) throw new Error(`no decision in ${JSON.stringify(answer.body)}`);
  return id;
}

describe("the floor", () => {
  test("a lead below 1.29.0 is older; one that names no release, or none, is not", () => {
    expect(TRICKS_CREW_FIRST_VERSION).toBe("1.29.0");
    expect(olderThanTricksCrew("1.28.3", "1.29.0", compareSemver)).toBe(true);
    expect(olderThanTricksCrew("1.29.0", "1.29.0", compareSemver)).toBe(false);
    expect(olderThanTricksCrew(null, "1.29.0", compareSemver)).toBe(false);
  });

  test("only a pane address of the signing member's own machine is its own", () => {
    expect(ownAddress("laptop/%3#cccc", "laptop")).toBe("laptop/%3#cccc");
    expect(ownAddress("desk/%3#cccc", "laptop")).toBeNull();
    expect(ownAddress("local/%3", "laptop")).toBeNull();
    expect(ownAddress("laptop/all", "laptop")).toBeNull();
    expect(ownAddress(" laptop/%3", "laptop")).toBeNull();
  });
});

describe("images held on the lead", () => {
  const image = { mime: "image/png" as const, bytes: png(), width: 390, height: 240 };

  test("held by member and hash for 15 minutes; the same hash again costs nothing; another member cannot read it", () => {
    let now = 0;
    const held = new HillHeldMedia(() => now);
    const sha = sha256Hex(image.bytes);
    expect(held.put("laptop", sha, image)).toBe(true);
    expect(held.put("laptop", sha, image)).toBe(true);
    expect(held.bytesOf("laptop")).toBe(image.bytes.length);
    expect(held.get("other", sha)).toBeNull();
    now = HILL_HELD_MS - 1;
    expect(held.get("laptop", sha)).not.toBeNull();
    now += HILL_HELD_MS;
    expect(held.get("laptop", sha)).toBeNull();
  });

  test("a member past 16 MB is refused; another member is not", () => {
    const held = new HillHeldMedia(() => 0);
    const big = { ...image, bytes: new Uint8Array(HILL_HELD_MEMBER_BYTES - 10) };
    expect(held.put("laptop", "a".repeat(64), big)).toBe(true);
    expect(held.put("laptop", "b".repeat(64), image)).toBe(false);
    expect(held.put("other", "b".repeat(64), image)).toBe(true);
  });
});

describe("the lead's routes", () => {
  test("media: sniffed, checked against its hash, held; idempotent by hash; junk refused", () => {
    const { crewLead, held } = crew();
    const bytes = png();
    const sha = sha256Hex(bytes);
    const first = crewLead.media({ sha256: sha, b64: b64(bytes) }, "laptop");
    expect(first).toEqual({ status: 200, body: { ok: true, sha256: sha, mime: "image/png", width: 390, height: 240 } });
    expect(crewLead.media({ sha256: sha, b64: b64(bytes) }, "laptop").status).toBe(200);
    expect(held.bytesOf("laptop")).toBe(bytes.length);
    // A hash that does not match, base64 that is not strict, and a shape that is not an image.
    expect(crewLead.media({ sha256: "0".repeat(64), b64: b64(bytes) }, "laptop").status).toBe(400);
    expect(crewLead.media({ sha256: sha, b64: `${b64(bytes)}\n` }, "laptop").status).toBe(400);
    expect(crewLead.media({ sha256: sha }, "laptop").status).toBe(400);
    const html = new TextEncoder().encode("<!doctype html><script>fetch('/api/pair')</script>");
    expect(crewLead.media({ sha256: sha256Hex(html), b64: b64(html) }, "laptop")).toEqual({ status: 200, body: { ok: false, code: "bad_image", error: expect.stringContaining("PNG, JPEG or WebP") } });
  });

  test("post: a session of another machine is the 401; a path in the fields is refused; the lead mints the id", () => {
    const { crewLead, lead } = crew();
    expect(crewLead.post({ from: { address: "desk/%1#aaaa" }, fields: fields() }, "laptop").status).toBe(401);
    expect(crewLead.post({ from: { address: LAPTOP_PANE }, fields: fields({ images: [{ path: "/etc/passwd" }] }) }, "laptop").status).toBe(400);
    const answer = crewLead.post({ from: { address: LAPTOP_PANE, harness: "agent-x", label: "repo#main", host: "laptop" }, fields: fields() }, "laptop");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, decision: { id: "dc_crew00000001", from: { kind: "agent", address: LAPTOP_PANE, memberId: "laptop", host: "laptop" }, target: { label: "repo#main", host: "laptop" } } });
    expect(lead.store.all()).toHaveLength(1);
  });

  test("post: a repeated request id is the same decision; an image not held is refused", () => {
    const { crewLead, lead } = crew();
    const row = fields();
    const body = { from: { address: LAPTOP_PANE, label: "repo#main" }, fields: row };
    const one = crewLead.post(body, "laptop");
    const two = crewLead.post(body, "laptop");
    expect(idOf(one)).toBe(idOf(two));
    expect(lead.store.all()).toHaveLength(1);
    const missing = crewLead.post({ from: { address: LAPTOP_PANE }, fields: fields(), images: [{ sha256: "f".repeat(64) }] }, "laptop");
    expect(missing.body).toMatchObject({ ok: false, code: "bad_image" });
  });

  test("op: status, withdraw and list for the member's own session only", () => {
    const { crewLead } = crew();
    const posted = crewLead.post({ from: { address: LAPTOP_PANE, label: "repo#main" }, fields: fields() }, "laptop");
    const id = idOf(posted);
    expect(crewLead.op({ op: "status", id, as: "desk/%1#aaaa" }, "laptop").status).toBe(401);
    expect(crewLead.op({ op: "status", id, as: LAPTOP_PANE }, "laptop").body).toMatchObject({ ok: true, decision: { id, state: "open" } });
    expect(crewLead.op({ op: "list", as: LAPTOP_PANE }, "laptop").body).toMatchObject({ ok: true, decisions: [{ id }] });
    // Another session of the same member does not see it.
    expect(crewLead.op({ op: "status", id, as: "laptop/%4#dddd" }, "laptop").body).toMatchObject({ ok: false, missing: true });
    expect(crewLead.op({ op: "withdraw", id, as: LAPTOP_PANE }, "laptop").body).toMatchObject({ ok: true, decision: { state: "withdrawn" } });
    expect(crewLead.op({ op: "nope", as: LAPTOP_PANE }, "laptop").status).toBe(400);
  });

  test("one member holds at most 40 open decisions; the lead's own sessions and other members do not count", () => {
    const { crewLead } = crew();
    for (let i = 0; i < HILL_OPEN_MEMBER_MAX; i += 1) {
      const pane = `laptop/%${String(10 + Math.floor(i / 20))}#p${String(Math.floor(i / 20)).padStart(3, "0")}`;
      expect(crewLead.post({ from: { address: pane, label: "repo" }, fields: fields() }, "laptop").body).toMatchObject({ ok: true });
    }
    expect(crewLead.post({ from: { address: "laptop/%20#zzzz", label: "repo" }, fields: fields() }, "laptop").body).toMatchObject({ ok: false, code: "too_many_open" });
    expect(crewLead.post({ from: { address: "mini/%1#aaaa", label: "repo" }, fields: fields() }, "mini").body).toMatchObject({ ok: true });
  });
});

describe("a member's forward", () => {
  test("happy path: images read on the member, uploaded, then the post; the lead holds one decision and the member none", async () => {
    const { lead, member, link } = crew();
    const file = join(member.work, "shot.png");
    writeFileSync(file, png());
    const answer = await member.hill.postFields(SENDER, fields({ images: [{ path: file, caption: "before" }] }));
    expect(answer).toMatchObject({ ok: true, decision: { id: "dc_crew00000001", media: [{ caption: "before", mime: "image/png" }] } });
    expect(link.calls).toEqual([CREW_HILL_MEDIA_ROUTE, CREW_HILL_POST_ROUTE]);
    expect(lead.store.all()).toHaveLength(1);
    expect(member.store.all()).toHaveLength(0);
    expect(member.audit.some((entry) => entry.action === "hill.forward")).toBe(true);
    // Status, list and withdraw go to the lead as well.
    expect(await member.hill.askStatus(SENDER, "dc_crew00000001")).toMatchObject({ ok: true, decision: { state: "open" } });
    expect(await member.hill.askList(SENDER)).toMatchObject({ ok: true, decisions: [{ id: "dc_crew00000001" }] });
    expect(await member.hill.askWithdraw(SENDER, "dc_crew00000001")).toMatchObject({ ok: true, decision: { state: "withdrawn" } });
    expect(link.calls.slice(2)).toEqual([CREW_HILL_OP_ROUTE, CREW_HILL_OP_ROUTE, CREW_HILL_OP_ROUTE]);
  });

  test("a retry with the same request id after a lost answer posts once", async () => {
    const { lead, member } = crew();
    const row = fields();
    expect((await member.hill.postFields(SENDER, row)).ok).toBe(true);
    expect((await member.hill.postFields(SENDER, row)).ok).toBe(true);
    expect(lead.store.all()).toHaveLength(1);
  });

  test("a lead known to be older is refused before any dial; a lead that answers 404 reads the same", async () => {
    const { member, link } = crew();
    link.older = true;
    const older = await member.hill.postFields(SENDER, fields());
    expect(older).toMatchObject({ ok: false, code: "not_on_lead", error: expect.stringContaining("older than 1.29.0") });
    expect(link.calls).toEqual([]);
    link.older = false;
    link.status = 404;
    expect(await member.hill.postFields(SENDER, fields())).toMatchObject({ ok: false, code: "not_on_lead" });
    expect(await member.hill.askList(SENDER)).toMatchObject({ ok: false, error: expect.stringContaining("older than 1.29.0") });
  });

  test("a lead that does not answer: lead_unreachable, nothing posted, the retry named with its request id", async () => {
    const { lead, member, link } = crew();
    link.down = true;
    const row = fields();
    const answer = await member.hill.postFields(SENDER, row);
    expect(answer).toEqual({ ok: false, code: LEAD_UNREACHABLE_CODE, error: `the lead (desk) is not answering; nothing was posted. Post again with --request-id ${String(row.requestId)}: it posts once` });
    expect(lead.store.all()).toHaveLength(0);
    expect(await member.hill.askStatus(SENDER, "dc_crew00000001")).toEqual({ ok: false, missing: false, error: "the lead (desk) is not answering; try again" });
  });

  test("a 401 from the lead is the signature, said plainly", async () => {
    const { member, link } = crew();
    link.status = 401;
    expect(await member.hill.postFields(SENDER, fields())).toEqual({ ok: false, code: null, error: "the lead refused this machine's signature" });
  });

  test("the member's own switches hold before any dial", async () => {
    const { member, link } = crew();
    const file = join(member.work, "page.html");
    writeFileSync(file, "<!doctype html>");
    expect(await member.hill.postFields(SENDER, fields({ images: [{ path: file }] }))).toMatchObject({ ok: false, code: "bad_image" });
    expect(link.calls).toEqual([]);
  });

  test("a member without a forward (before 1.29.0, or no lead link) still answers not_on_lead", async () => {
    const lone = bridge("peer", { memberId: "m_laptop0000" });
    expect(await lone.hill.postFields(SENDER, fields())).toEqual({ ok: false, code: "not_on_lead", error: NOT_ON_LEAD });
  });
});

describe("an answer for a machine that is not answering", () => {
  function answerOf(id: string): HillAnswerRequest {
    return { rid: uuid(), node: `hill/${id}`, intent: "yes", value: { text: null } };
  }

  test("refused before anything closes: the card stays open, nothing is sent, and the same tap goes once the machine is back", async () => {
    const { lead, crewLead } = crew();
    const posted = crewLead.post({ from: { address: LAPTOP_PANE, label: "repo#main" }, fields: fields() }, "laptop");
    const id = idOf(posted);
    lead.offline = "laptop";
    const request = answerOf(id);
    const refused = await lead.hill.answer(request, id, "Pixel 9");
    expect(refused).toMatchObject({ kind: "receipt", receipt: { code: "rejected", reason: notAnswering("laptop"), state: "open", machine: "laptop" } });
    expect(notAnswering("laptop")).toBe("laptop is not answering. Your answer was not sent.");
    expect(lead.store.get(id)?.state).toBe("open");
    expect(lead.sent).toEqual([]);
    // The sweep does not close it for the machine being away.
    lead.live = [];
    lead.hill.sweep(lead.clock);
    expect(lead.store.get(id)?.state).toBe("open");
    // Back: the same request goes, typed to the member's pane over walky.
    lead.offline = null;
    lead.live = [{ address: LAPTOP_PANE, label: "repo#main", host: "laptop", unattended: false }];
    const sent = await lead.hill.answer(request, id, "Pixel 9");
    expect(sent).toMatchObject({ kind: "receipt", receipt: { code: "ok", state: "answered" } });
    expect(lead.sent.map((s) => s.to)).toEqual([LAPTOP_PANE]);
  });

  test("a session the sweep lists as unreachable is refused the same way, by its place", async () => {
    const { lead, crewLead } = crew();
    const posted = crewLead.post({ from: { address: LAPTOP_PANE, label: "repo#main" }, fields: fields() }, "laptop");
    const id = idOf(posted);
    lead.live = [{ address: LAPTOP_PANE, label: "repo#main", host: "laptop", unattended: false, reachable: false }];
    expect(await lead.hill.answer(answerOf(id), id, "Pixel 9")).toMatchObject({ kind: "receipt", receipt: { code: "rejected", machine: "laptop" } });
    expect(lead.store.get(id)?.state).toBe("open");
  });
});
