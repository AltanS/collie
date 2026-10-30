import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTrustStore, selfIdentity } from "../crew/enrollment.ts";
import { CREW, leadStore, material, member, peerStore, T0 } from "../crew/fixtures.ts";
import type { TrustStoreData } from "../crew/trust-store.ts";
import type { PaneWire } from "../types.ts";
import { compareSemver } from "../update.ts";
import { signMessage, attestationString } from "./canonical.ts";
import { verifyCanonical } from "../crew/signing.ts";
import {
  attestFor,
  checkFromLead,
  checkFromMember,
  checkCrewMessage,
  crewSkipped,
  crewTargets,
  leadRouteRemote,
  memberRouteRemote,
  mergeReport,
  olderThanWalky,
  receiptsOfAnswer,
  senderBlockFor,
  WalkyCrew,
  WalkyLeadSide,
  WalkyReport,
  WALKY_OUTBOX_MAX,
  WALKY_LEG_PANES_MAX,
  WALKY_REPORT_MAX,
  writeOutcomes,
  type CrewDialAnswer,
} from "./crew.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { readWalkyReport, readWalkyRequest } from "./parse.ts";
import { answerRequest, type PlaceTarget } from "./socket.ts";
import type { BeaconMatcher } from "../beacon/decorate.ts";
import { RateLimiter } from "./rate.ts";
import { OUT_OF_SCOPE, scopeEmpty, scopeIsMember } from "./refusals.ts";
import { WalkyService, type WalkyServiceDeps } from "./service.ts";
import type { JsonValue } from "../json.ts";
import { parseJson } from "../../web/src/lib/json.ts";
import { movesForward, type WalkyMessage, type WalkyReceipt, type WalkyTarget } from "./types.ts";

/** A value as it arrives off the wire: through JSON, so a test hands a handler exactly what a request would. */
function wire<T>(value: T): JsonValue {
  // SAFETY: `JSON.parse` output IS a JsonValue by construction.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const memberCheck = <T,>(value: T, signer: Parameters<typeof checkFromMember>[1]) => checkFromMember(wire(value), signer);
const leadCheck = <T,>(value: T, segment: string, ...rest: [Parameters<typeof checkFromLead>[2], string, string]) => checkFromLead(wire(value), segment, ...rest);
const fromMemberOf = <T,>(crew: WalkyCrew, value: T, from: Parameters<WalkyCrew["fromMember"]>[1]) => crew.fromMember(wire(value), from);
const fromLeadOf = <T,>(crew: WalkyCrew, segment: string, value: T, from: string) => crew.fromLead(segment, wire(value), from);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AT = 1_786_000_000_000;

function unsigned(id: string, from: string, to: string, over: Partial<WalkyMessage> = {}): WalkyMessage {
  return {
    v: 1,
    id,
    kind: "agent",
    from: { memberId: from, address: `${from}/w1:p1`, harness: "agent-x", label: "repo#main" },
    to,
    replyTo: null,
    at: AT,
    body: "Tests are green.",
    signer: null,
    signature: null,
    ...over,
  };
}

/** A message signed by `from` with its fixture key, as that member's bridge would build it. */
function signed(id: string, from: string, to: string, over: Partial<WalkyMessage> = {}): WalkyMessage {
  return signMessage(unsigned(id, from, to, over), material(from).keyPem, from);
}

/** The fields of an operator's message from a phone paired to `memberId`. */
function OPERATOR(memberId: string): Partial<WalkyMessage> {
  return { kind: "operator", from: { memberId, address: null, harness: null, label: "phone" } };
}

function pane(paneId: string, over: Partial<WalkyPane> = {}): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId}`, state: "idle", instance: "aaaa", terminal: true, ...over };
}

class FakeHost implements WalkyHost {
  readonly sends: string[] = [];
  constructor(private readonly list: WalkyPane[]) {}
  panes(): readonly WalkyPane[] {
    return this.list;
  }
  async send(target: WalkyPane): Promise<SendResult> {
    this.sends.push(target.paneId);
    return { outcome: "sent" };
  }
  sendState(): SendResult | null {
    return null;
  }
  cancelHeld(): void {}
}

interface Rig {
  readonly service: WalkyService;
  readonly host: FakeHost;
  readonly log: WalkyLog;
}

function service(memberId: string, panes: WalkyPane[], route?: Parameters<typeof leadRouteRemote>[0]["post"], over: Partial<WalkyServiceDeps> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "walky-crew-"));
  roots.push(root);
  const log = new WalkyLog(join(root, "walky"), () => AT);
  const host = new FakeHost(panes);
  const routeRemote =
    route === undefined
      ? undefined
      : leadRouteRemote({ self: memberId, members: () => ["laptop", "other"], signing: () => ({ keyPem: material(memberId).keyPem, crewId: CREW.crewId }), post: route, now: () => AT });
  const svc = new WalkyService({
    log,
    host,
    memberId,
    enabled: () => true,
    machine: memberId,
    keyPem: () => material(memberId).keyPem,
    now: () => AT,
    routeRemote,
    ...over,
  });
  return { service: svc, host, log };
}

describe("the lead's check of a member's message", () => {
  const laptop = member({ memberId: "laptop" });

  test("a message the dialling member signed, as itself, is taken", () => {
    const checked = memberCheck(signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1"), laptop);
    expect(checked.ok).toBe(true);
  });

  test("a bad signature, another signer, another sender or another sender's pane is the uniform 401", () => {
    const good = signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1");
    const cases: WalkyMessage[] = [
      { ...good, body: "Tests are red." },
      signed("wt_aaaaaaaaaaa1", "other", "desk/w1:p1"),
      signMessage(unsigned("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1", { from: { memberId: "other", address: "other/w1:p1", harness: "agent-x", label: "x" } }), material("laptop").keyPem, "laptop"),
      signMessage(unsigned("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1", { from: { memberId: "laptop", address: "other/w1:p1", harness: "agent-x", label: "x" } }), material("laptop").keyPem, "laptop"),
      unsigned("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1"),
    ];
    for (const message of cases) {
      const checked = memberCheck(message, laptop);
      expect(checked).toMatchObject({ ok: false, answer: { status: 401, body: { error: "unauthorized" } } });
    }
  });

  test("a body that is not a message, a dirty body or a solo address is a 400 that says why", () => {
    expect(memberCheck({ nope: true }, laptop)).toMatchObject({ ok: false, answer: { status: 400 } });
    expect(memberCheck(signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1", { body: "a\u0007b" }), laptop)).toMatchObject({ ok: false, answer: { status: 400 } });
    expect(memberCheck(signed("wt_aaaaaaaaaaa1", "laptop", "local/w1:p1"), laptop)).toMatchObject({ ok: false, answer: { status: 400 } });
  });

  test("a body over 4,000 characters is a 400 on both hops, never cut", () => {
    const long = signed("wt_aaaaaaaaaaa1", "laptop", "other/w1:p1", { body: "x".repeat(4001) });
    expect(memberCheck(long, laptop)).toMatchObject({ ok: false, answer: { status: 400 } });
    const attest = attestFor(long, material("desk").keyPem, CREW.crewId, "other");
    expect(leadCheck({ message: long, attest }, "w1:p1", member({ memberId: "desk", role: "lead" }), CREW.crewId, "other")).toMatchObject({ ok: false, answer: { status: 400 } });
  });
});

describe("the one shape check both crew hops share", () => {
  const good = signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1");
  const operator = signed("wt_aaaaaaaaaaa2", "laptop", "desk/w1:p1", { kind: "operator", from: { memberId: "laptop", address: null, harness: null, label: "phone-altan" } });

  /** Every signed string field, set to `value`, one at a time. */
  function eachField(base: WalkyMessage, value: string): Array<[string, WalkyMessage]> {
    return [
      ["id", { ...base, id: value }],
      // SAFETY: the kind is broken on purpose; `checkCrewMessage` reads every field as a string, as off the wire.
      ["kind", { ...base, kind: value as WalkyMessage["kind"] }],
      ["from.memberId", { ...base, from: { ...base.from, memberId: value } }],
      ["from.address", { ...base, from: { ...base.from, address: value } }],
      ["from.harness", { ...base, from: { ...base.from, harness: value } }],
      ["to", { ...base, to: value }],
      ["replyTo", { ...base, replyTo: value }],
      ["signer", { ...base, signer: value }],
    ];
  }

  test("a well-formed agent's and operator's message pass", () => {
    expect(checkCrewMessage(good)).toBeNull();
    expect(checkCrewMessage(operator)).toBeNull();
  });

  test("an LF, a CR or a bare `-` in any signed field is a 400", () => {
    for (const value of ["laptop\ndesk", "x\r", "-"]) {
      for (const [field, message] of eachField(good, value)) {
        expect([field, checkCrewMessage(message)]).toEqual([field, { status: 400, error: "a signed field holds a line break or a bare `-`" }]);
      }
    }
    // An LF inside a field that would otherwise parse: through the wire, at both hops.
    const split = { ...good, from: { ...good.from, memberId: "laptop\nlaptop" }, signer: "laptop\nlaptop" };
    expect(memberCheck(split, member({ memberId: "laptop" }))).toMatchObject({ ok: false, answer: { status: 400 } });
    const lead = member({ memberId: "desk", role: "lead" });
    const down = { ...good, to: "laptop/w1:p9", from: { ...good.from, memberId: "-" } };
    expect(leadCheck({ message: down, attest: attestFor(down, material("desk").keyPem, CREW.crewId, "laptop") }, "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({
      ok: false,
      answer: { status: 400 },
    });
  });

  test("label and harness: printable ASCII, no brackets or parentheses, at most 48 and 32", () => {
    const label = (text: string) => checkCrewMessage({ ...good, from: { ...good.from, label: text } });
    expect(label("a".repeat(48))).toBeNull();
    for (const bad of ["a".repeat(49), "x (y)", "[x]", "line\nbreak", "caf\u00e9"]) expect(label(bad)).toMatchObject({ status: 400 });
    const harness = (text: string) => checkCrewMessage({ ...good, from: { ...good.from, harness: text } });
    expect(harness("a".repeat(32))).toBeNull();
    for (const bad of ["a".repeat(33), "x(y)"]) expect(harness(bad)).toMatchObject({ status: 400 });
  });

  test("the sender is the signer, and an agent's pane is on the signer's machine: else the uniform 401", () => {
    expect(checkCrewMessage({ ...good, signer: "other" })).toEqual({ status: 401 });
    expect(checkCrewMessage({ ...good, signer: null })).toEqual({ status: 401 });
    expect(checkCrewMessage({ ...good, from: { ...good.from, address: "other/w1:p1" } })).toEqual({ status: 401 });
    expect(checkCrewMessage({ ...operator, from: { ...operator.from, memberId: "other" } })).toEqual({ status: 401 });
  });

  test("a message the lead signed but that names another sender never reads as `origin`", () => {
    const lead = member({ memberId: "desk", role: "lead" });
    const claimed = signMessage(unsigned("wt_aaaaaaaaaaa5", "other", "laptop/w1:p9"), material("desk").keyPem, "desk");
    const answer = leadCheck({ message: claimed, attest: attestFor(claimed, material("desk").keyPem, CREW.crewId, "laptop") }, "w1:p9", lead, CREW.crewId, "laptop");
    expect(answer).toMatchObject({ ok: false, answer: { status: 401 } });
  });
});

describe("a member's check of its lead's delivery", () => {
  const lead = member({ memberId: "desk", role: "lead" });
  const deliver = (message: WalkyMessage, receiver = "laptop", key = material("desk").keyPem) => ({ message, attest: attestFor(message, key, CREW.crewId, receiver) });

  test("an attested message the lead itself signed verifies to the origin", () => {
    const message = signed("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9");
    expect(leadCheck(deliver(message), "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true, verified: "origin" });
  });

  test("an attested message from another member verifies to the lead only", () => {
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9");
    expect(leadCheck(deliver(message), "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true, verified: "lead" });
  });

  test("an attestation for another receiver, another crew, another key or another message is the uniform 401", () => {
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9");
    const bad = [
      deliver(message, "other"),
      { message, attest: attestFor(message, material("desk").keyPem, "crew-2", "laptop") },
      deliver(message, "laptop", material("other").keyPem),
      { message: { ...message, body: "changed" }, attest: deliver(message).attest },
    ];
    for (const body of bad) expect(leadCheck(body, "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: false, answer: { status: 401 } });
  });

  /** A delivery from `other` with the lead's sender block for `other`'s certificate, parts overridable. */
  const vouched = (message: WalkyMessage, over: Partial<{ certPem: string; voucher: string }> = {}) => ({
    ...deliver(message),
    sender: { ...senderBlockFor("other", material("other").certPem, material("desk").keyPem, CREW.crewId)!, ...over },
  });

  test("a message from another member, with the lead's voucher for its certificate, verifies to the origin", () => {
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9");
    expect(leadCheck(vouched(message), "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true, verified: "origin" });
    // Absent or null, the block reads as none: the lead's word only, as before.
    expect(leadCheck({ ...deliver(message), sender: null }, "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true, verified: "lead" });
  });

  test("a sender block that does not hold is the uniform 401: another certificate, member, key, crew or signer", () => {
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9");
    const forOther = (certPem: string, key = material("desk").keyPem, crewId = CREW.crewId) => senderBlockFor("other", certPem, key, crewId)!;
    // The message signed with another machine's key, under `other`'s name: the vouched certificate does not verify it.
    const misSigned = signMessage(unsigned("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9"), material("laptop").keyPem, "other");
    const bad = [
      // A tampered certificate: the voucher names the fingerprint of the one the lead pinned.
      vouched(message, { certPem: material("laptop").certPem }),
      vouched(message, { certPem: "not a certificate" }),
      // A voucher for another member, by another key, for another crew.
      vouched(message, { voucher: senderBlockFor("laptop", material("other").certPem, material("desk").keyPem, CREW.crewId)!.voucher }),
      vouched(message, { voucher: forOther(material("other").certPem, material("other").keyPem).voucher }),
      vouched(message, { voucher: forOther(material("other").certPem, material("desk").keyPem, "crew-2").voucher }),
      { ...vouched(misSigned), message: misSigned, attest: deliver(misSigned).attest },
    ];
    for (const body of bad) expect(leadCheck(body, "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: false, answer: { status: 401 } });
  });

  test("a sender block past its caps, or half there, is a malformed body: a 400", () => {
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9");
    const bad = [
      vouched(message, { certPem: "x".repeat(4097) }),
      vouched(message, { voucher: "x".repeat(513) }),
      vouched(message, { voucher: "" }),
      { ...deliver(message), sender: { certPem: material("other").certPem } },
      { ...deliver(message), sender: "yes" },
    ];
    for (const body of bad) expect(leadCheck(body, "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: false, answer: { status: 400 } });
    expect(leadCheck(deliver(message), "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true });
  });

  test("the lead adds the block for another member's message, and never for its own", async () => {
    const bodies: JsonValue[] = [];
    const checked: string[] = [];
    const route = leadRouteRemote({
      self: "desk",
      members: () => ["laptop", "other"],
      signing: () => ({ keyPem: material("desk").keyPem, crewId: CREW.crewId }),
      senderCert: (memberId) => material(memberId).certPem,
      post: async (memberId, segment, payload) => {
        // SAFETY: the route posts the JSON it built itself.
        const body = JSON.parse(payload) as JsonValue;
        bodies.push(body);
        const check = checkFromLead(body, segment, lead, CREW.crewId, memberId);
        checked.push(check.ok ? check.verified : "refused");
        return { kind: "answer", status: 200, body: { receipts: [] } };
      },
      now: () => AT,
    });
    await route(signed("wt_aaaaaaaaaaa1", "other", "laptop/w1:p9"), "laptop");
    await route(signed("wt_aaaaaaaaaaa2", "desk", "laptop/w1:p9"), "laptop");
    expect(bodies[0]).toMatchObject({ sender: { certPem: material("other").certPem } });
    expect(bodies[1]).not.toHaveProperty("sender");
    expect(checked).toEqual(["origin", "origin"]);
  });

  test("the route names the message's pane, or `all` for a whole machine", () => {
    const one = signed("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9");
    expect(leadCheck(deliver(one), "w1:p1", lead, CREW.crewId, "laptop")).toMatchObject({ ok: false, answer: { status: 400 } });
    const machine = signed("wt_aaaaaaaaaaa2", "desk", "laptop/all");
    expect(leadCheck(deliver(machine), "all", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true });
    const crew = signed("wt_aaaaaaaaaaa3", "desk", "all");
    expect(leadCheck(deliver(crew), "all", lead, CREW.crewId, "laptop")).toMatchObject({ ok: true });
    const elsewhere = signed("wt_aaaaaaaaaaa4", "desk", "other/w1:p9");
    expect(leadCheck(deliver(elsewhere), "w1:p9", lead, CREW.crewId, "laptop")).toMatchObject({ ok: false, answer: { status: 400 } });
  });
});

describe("the lead takes a member's message", () => {
  test("delivers to its own pane as `origin`, and a replay returns the stored receipts and types nothing more", async () => {
    const lead = service("desk", [pane("w1:p1")]);
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const message = signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1");
    const first = await fromMemberOf(crew, message, member({ memberId: "laptop" }));
    expect(first).toMatchObject({ status: 200, body: { receipts: [{ state: "accepted", target: "desk/w1:p1", verified: "origin", by: "desk" }] } });
    await lead.service.deliverer.settled();
    const again = await fromMemberOf(crew, message, member({ memberId: "laptop" }));
    expect(again).toMatchObject({ status: 200, body: { receipts: [{ state: "delivered", target: "desk/w1:p1", verified: "origin" }] } });
    expect(lead.host.sends).toEqual(["w1:p1"]);
  });

  test("rate-limits per sender, as the local path does", async () => {
    const lead = service("desk", [pane("w1:p1")]);
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const laptop = member({ memberId: "laptop" });
    for (let n = 0; n < 30; n += 1) {
      const id = `wt_${n.toString().padStart(12, "a")}`;
      expect(await fromMemberOf(crew, signed(id, "laptop", "desk/w1:p1", { kind: "operator", from: { memberId: "laptop", address: null, harness: null, label: `phone-${String(n)}` } }), laptop)).toMatchObject({
        body: { receipts: [{ state: "accepted" }] },
      });
    }
    // The label is display data: another label is the same operator on the same machine.
    const over = signed("wt_zzzzzzzzzzzz", "laptop", "desk/w1:p1", { kind: "operator", from: { memberId: "laptop", address: null, harness: null, label: "other" } });
    expect(await fromMemberOf(crew, over, laptop)).toMatchObject({ body: { receipts: [{ state: "refused", reason: "rate limit" }] } });
  });

  test("two panes may trade 6 messages in 10 minutes, either direction; the 7th is `pair limit`", async () => {
    const lead = service("desk", [pane("w1:p1")]);
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const laptop = member({ memberId: "laptop" });
    for (let n = 0; n < 6; n += 1) {
      const id = `wt_${n.toString().padStart(12, "p")}`;
      expect(await fromMemberOf(crew, signed(id, "laptop", "desk/w1:p1"), laptop)).toMatchObject({ body: { receipts: [{ state: "accepted" }] } });
    }
    expect(await fromMemberOf(crew, signed("wt_pppppppppppz", "laptop", "desk/w1:p1"), laptop)).toMatchObject({ body: { receipts: [{ state: "refused", reason: "pair limit" }] } });
    // Another pane of the same machine is another pair.
    const other = signed("wt_qqqqqqqqqqq1", "laptop", "desk/w1:p1", { from: { memberId: "laptop", address: "laptop/w2:p2", harness: "agent-x", label: "repo#b" } });
    expect(await fromMemberOf(crew, other, laptop)).toMatchObject({ body: { receipts: [{ state: "accepted" }] } });
  });

  test("on a lead, one outer bucket per member: the member's panes together hit it", async () => {
    const lead = service("desk", [pane("w1:p1")], undefined, { members: new RateLimiter(3) });
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const laptop = member({ memberId: "laptop" });
    const from = (n: number) => ({ memberId: "laptop", address: `laptop/w${String(n)}:p1`, harness: "agent-x", label: "repo#x" });
    for (let n = 0; n < 3; n += 1) {
      expect(await fromMemberOf(crew, signed(`wt_${n.toString().padStart(12, "m")}`, "laptop", "desk/w1:p1", { from: from(n) }), laptop)).toMatchObject({ body: { receipts: [{ state: "accepted" }] } });
    }
    expect(await fromMemberOf(crew, signed("wt_mmmmmmmmmmmz", "laptop", "desk/w1:p1", { from: from(9) }), laptop)).toMatchObject({ body: { receipts: [{ state: "refused", reason: "rate limit" }] } });
  });

  test("a message whose clock is more than 10 minutes off, either way, is `stale` on both hops", async () => {
    const lead = service("desk", [pane("w1:p1")]);
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const laptop = member({ memberId: "laptop" });
    const tenMinutes = 10 * 60 * 1000;
    expect(await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1", { at: AT - tenMinutes }), laptop)).toMatchObject({ body: { receipts: [{ state: "accepted" }] } });
    for (const [id, at] of [["wt_aaaaaaaaaaa2", AT - tenMinutes - 1], ["wt_aaaaaaaaaaa3", AT + tenMinutes + 1]] as const) {
      expect(await fromMemberOf(crew, signed(id, "laptop", "desk/w1:p1", { at }), laptop)).toMatchObject({
        status: 200,
        body: { receipts: [{ state: "refused", reason: "stale" }] },
      });
    }
    const peer = service("laptop", [pane("w1:p9")]);
    const peerCrew = new WalkyCrew({ service: peer.service, trust: () => peerStore(), now: () => AT });
    const old = signed("wt_aaaaaaaaaaa4", "desk", "laptop/w1:p9", { at: AT - tenMinutes - 1 });
    expect(await fromLeadOf(peerCrew, "w1:p9", { message: old, attest: attestFor(old, material("desk").keyPem, CREW.crewId, "laptop") }, "desk")).toMatchObject({
      body: { receipts: [{ state: "refused", reason: "stale" }] },
    });
    await peer.service.deliverer.settled();
    expect(peer.host.sends).toEqual([]);
  });

  test("an agent's broadcast is refused at the lead too", async () => {
    const lead = service("desk", [pane("w1:p1")]);
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const answer = await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "all"), member({ memberId: "laptop" }));
    expect(answer).toMatchObject({ body: { receipts: [{ state: "refused", reason: "only the operator may broadcast" }] } });
    expect(lead.host.sends).toEqual([]);
  });

  test("routes a message for another member on, with this lead's attestation for that member", async () => {
    const posts: { memberId: string; segment: string; body: { message: WalkyMessage; attest: string } }[] = [];
    const lead = service("desk", [pane("w1:p1")], async (memberId, segment, payload) => {
      // SAFETY: the route posts the JSON it built itself.
      posts.push({ memberId, segment, body: JSON.parse(payload) as { message: WalkyMessage; attest: string } });
      return { kind: "answer", status: 200, body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "lead", at: AT, by: memberId }] } };
    });
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const answer = await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "other/w9:p9"), member({ memberId: "laptop" }));
    expect(answer).toMatchObject({ status: 200, body: { receipts: [{ state: "accepted", target: "other/w9:p9", by: "other" }] } });
    expect(posts.map((post) => `${post.memberId} ${post.segment}`)).toEqual(["other w9:p9"]);
    const { message, attest } = posts[0]!.body;
    expect(verifyCanonical(material("desk").certPem, attest, attestationString(message, CREW.crewId, "other"))).toBe(true);
    expect(lead.host.sends).toEqual([]);
  });

  test("an address with a pane instance token travels signed; the route and every receipt name the pane id only", async () => {
    const posts: { memberId: string; segment: string; body: { message: WalkyMessage } }[] = [];
    const lead = service("desk", [pane("w1:p1")], async (memberId, segment, payload) => {
      // SAFETY: the route posts the JSON it built itself.
      posts.push({ memberId, segment, body: JSON.parse(payload) as { message: WalkyMessage } });
      return { kind: "answer", status: 200, body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "lead", at: AT, by: memberId }] } };
    });
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const sent = signed("wt_aaaaaaaaaaa1", "laptop", "other/w9:p9#k3f9", { from: { memberId: "laptop", address: "laptop/w1:p1#aaaa", harness: "agent-x", label: "repo#main" } });
    const answer = await fromMemberOf(crew, sent, member({ memberId: "laptop" }));
    expect(answer).toMatchObject({ status: 200, body: { receipts: [{ state: "accepted", target: "other/w9:p9", by: "other" }] } });
    expect(posts.map((post) => `${post.memberId} ${post.segment} ${post.body.message.to}`)).toEqual(["other w9:p9 other/w9:p9#k3f9"]);
    expect(lead.log.get("wt_aaaaaaaaaaa1", "other/w9:p9")?.receipt).toMatchObject({ by: "other" });
    // The member's later report names the bare target too, and lands on the same record.
    expect(mergeReport(lead.log, "other", [{ id: "wt_aaaaaaaaaaa1", target: "other/w9:p9", state: "delivered", verified: "lead", at: AT + 1, by: "other" }])).toBe(1);
  });

  test("a member resolves the token its lead carried: another instance at that pane id is `pane replaced`", async () => {
    const peer = service("laptop", [pane("w1:p9", { instance: "zzzz" })]);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore(), now: () => AT });
    const message = signed("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9#k3f9");
    const answer = await fromLeadOf(crew, "w1:p9", { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "laptop") }, "desk");
    expect(answer).toMatchObject({ status: 200, body: { receipts: [{ state: "refused", reason: "pane replaced", target: "laptop/w1:p9" }] } });
    const kept = signed("wt_aaaaaaaaaaa2", "desk", "laptop/w1:p9#zzzz");
    expect(await fromLeadOf(crew, "w1:p9", { message: kept, attest: attestFor(kept, material("desk").keyPem, CREW.crewId, "laptop") }, "desk")).toMatchObject({
      body: { receipts: [{ state: "accepted", target: "laptop/w1:p9" }] },
    });
  });

  test("`all` from a member reaches the lead's panes and every other member, never the sender's machine", async () => {
    const posted: string[] = [];
    const lead = service("desk", [pane("w1:p1")], async (memberId, segment) => {
      posted.push(`${memberId} ${segment}`);
      return { kind: "answer", status: 200, body: { receipts: [] } };
    });
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const answer = await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "all", OPERATOR("laptop")), member({ memberId: "laptop" }));
    expect(posted).toEqual(["other all"]);
    expect(answer.body).toMatchObject({ receipts: [{ target: "desk/w1:p1" }, { target: "other/all", state: "accepted" }] });
  });
});

describe("a member's answer, as the lead believes it", () => {
  test("a member's refusal of a broadcast is that member's leg, never the whole broadcast", async () => {
    // A real member, with walky talky off: its refusal names the message's own `to`, `all`.
    const laptop = service("laptop", [pane("w1:p8")], undefined, { enabled: () => false });
    const laptopCrew = new WalkyCrew({ service: laptop.service, trust: () => peerStore(), now: () => AT });
    const lead = service("desk", [pane("w1:p1")], async (memberId, segment, payload) => {
      if (memberId === "laptop") {
        // SAFETY: the route posts the JSON it built itself.
        const answer = await laptopCrew.fromLead(segment, JSON.parse(payload) as JsonValue, "desk");
        return { kind: "answer", status: answer.status, body: wire(answer.body) };
      }
      return { kind: "answer", status: 200, body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: "other/w2:p1", state: "accepted", verified: "lead", at: AT, by: "other" }] } };
    });
    const answer = await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "all", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect(answer).toMatchObject({ ok: true });
    const receipts = answer.ok ? answer.receipts : [];
    expect(receipts.map((receipt) => `${receipt.target} ${receipt.state}`)).toEqual(["desk/w1:p1 accepted", "laptop/all refused", "other/w2:p1 accepted"]);
    expect(receipts.find((receipt) => receipt.target === "all")).toBeUndefined();
    // The lead's own `all` line is untouched, and `status` keeps the member's refusal.
    expect(lead.log.get("wt_aaaaaaaaaaa1", "all")?.receipt.state).toBe("accepted");
    await lead.service.deliverer.settled();
    expect(lead.service.status("wt_aaaaaaaaaaa1").receipts.map((receipt) => `${receipt.target} ${receipt.state} ${receipt.reason ?? "-"}`)).toEqual([
      "desk/w1:p1 delivered -",
      "laptop/all refused off",
      "other/w2:p1 accepted -",
    ]);
  });

  test("a receipt a member writes in another machine's name is dropped", async () => {
    const lead = service("desk", [], async () => ({
      kind: "answer",
      status: 200,
      body: {
        receipts: [
          { id: "wt_aaaaaaaaaaa1", target: "other/w2:p1", state: "delivered", verified: "lead", at: AT, by: "laptop" },
          { id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "delivered", verified: "lead", at: AT, by: "other" },
          // In the lead's own name: it would count as a refusal this lead wrote.
          { id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "refused", reason: "constructor", verified: "lead", at: AT, by: "desk" },
        ],
      },
    }));
    const answer = await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "laptop/w1:p9", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    // Neither forged line is believed: the leg reads as dialled and not yet answered.
    expect(answer).toMatchObject({ ok: true, receipts: [{ target: "laptop/w1:p9", state: "accepted", by: "desk" }] });
    expect(lead.log.get("wt_aaaaaaaaaaa1", "other/w2:p1")).toBeNull();
    expect(lead.service.refusals().counts).toEqual({});
  });
});

describe("a member takes its lead's delivery", () => {
  test("verifies the attestation, delivers as `lead`, and fans `<member>/all` out to its agent panes", async () => {
    const peer = service("laptop", [pane("w1:p8"), pane("w1:p9"), pane("w1:p7", { agent: false, harness: null })]);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore(), now: () => AT });
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/all", OPERATOR("other"));
    const body = { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "laptop") };
    const answer = await fromLeadOf(crew, "all", body, "desk");
    expect(answer).toMatchObject({ status: 200, body: { receipts: [{ target: "laptop/w1:p8", verified: "lead" }, { target: "laptop/w1:p9", verified: "lead" }] } });
    await peer.service.deliverer.settled();
    expect(peer.host.sends).toEqual(["w1:p8", "w1:p9"]);
  });

  test("refuses a caller that is not its lead, and a bad attestation, with the uniform 401", async () => {
    const peer = service("laptop", [pane("w1:p9")]);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore(), now: () => AT });
    const message = signed("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9");
    const good = { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "laptop") };
    expect(await fromLeadOf(crew, "w1:p9", good, "other")).toMatchObject({ status: 401 });
    const forged = { message, attest: attestFor(message, material("other").keyPem, CREW.crewId, "laptop") };
    expect(await fromLeadOf(crew, "w1:p9", forged, "desk")).toMatchObject({ status: 401 });
    expect(await fromLeadOf(crew, "w1:p9", good, "desk")).toMatchObject({ status: 200, body: { receipts: [{ verified: "origin" }] } });
  });
});

describe("what an answer from the other side stands for", () => {
  const message = unsigned("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9");
  const of = (answer: CrewDialAnswer) => receiptsOfAnswer(message, "laptop/w1:p9", answer, "desk", AT, "older member");

  test("an older member's 404 is `refused: older member`; a refusal and an unknown are their own", () => {
    expect(of({ kind: "answer", status: 404, body: { error: "not found" } })).toMatchObject([{ state: "refused", reason: "older member" }]);
    expect(of({ kind: "answer", status: 401, body: { error: "unauthorized" } })).toMatchObject([{ state: "refused", reason: "signature" }]);
    expect(of({ kind: "refused", reason: "laptop is unreachable" })).toMatchObject([{ state: "refused", reason: "laptop is unreachable" }]);
    expect(of({ kind: "unknown", reason: "crew: outcome unknown" })).toMatchObject([{ state: "unknown" }]);
    expect(of({ kind: "answer", status: 200, body: { receipts: [] } })).toMatchObject([{ state: "accepted", target: "laptop/w1:p9", by: "desk" }]);
  });

  test("the far side's error text becomes a reason in the form every reader keeps (added 2026-10-18)", () => {
    const [refused] = of({ kind: "answer", status: 500, body: { error: `\u001b[2Jbusy\nnow ${"x".repeat(200)}` } });
    // The escape and the line break become spaces, runs of spaces one, and the text is cut at 120.
    expect(refused?.reason).toBe(`crew: [2Jbusy now ${"x".repeat(200)}`.slice(0, 120));
    expect(refused?.reason).toHaveLength(120);
  });

  test("a member sends every message for elsewhere to its lead once", async () => {
    const payloads: string[] = [];
    const route = memberRouteRemote({
      self: "laptop",
      post: async (payload) => {
        payloads.push(payload);
        return { kind: "answer", status: 404, body: null };
      },
      now: () => AT,
    });
    expect(await route(signed("wt_aaaaaaaaaaa1", "laptop", "all"), "all")).toMatchObject([{ state: "refused", reason: "older lead", target: "all" }]);
    expect(payloads.length).toBe(1);
  });
});

describe("the outcome report", () => {
  /** A delivered receipt for a message from `desk` to this member's pane, as the log hands it to the report. */
  function record(id: string, state: WalkyReceipt["state"] = "delivered", at = AT, reason?: string) {
    const receipt: WalkyReceipt = { id, target: "laptop/w1:p9", state, verified: "lead" as const, at, by: "laptop" };
    return { session: "main", paneId: "w1:p9", instance: "aaaa", target: "laptop/w1:p9", message: signed(id, "desk", "laptop/w1:p9"), receipt: reason === undefined ? receipt : { ...receipt, reason }, sender: null, acceptedAt: at };
  }

  test("holds receipts for messages from elsewhere past `accepted`, and reports them until the lead acks the cursor", async () => {
    const peer = service("laptop", [pane("w1:p9")]);
    const report = new WalkyReport("laptop", { epoch: "0a1b2c3d", now: () => AT });
    report.listen(peer.log);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore(), now: () => AT });
    const message = signed("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9");
    await fromLeadOf(crew, "w1:p9", { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "laptop") }, "desk");
    await peer.service.deliverer.settled();
    // Its own message is never reported: the lead heard of it when it routed it.
    await peer.service.send({ id: "wt_aaaaaaaaaaa2", to: "laptop/w1:p9", body: "mine", replyTo: null }, { kind: "operator", label: "cli" });
    await peer.service.deliverer.settled();
    const first = report.report();
    expect(first).toMatchObject({ receipts: [{ id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "delivered" }] });
    expect(first?.cursor).toMatch(/^0a1b2c3d\.\d+$/u);
    // An answer the lead never read loses nothing: the next one carries the same receipts.
    expect(report.report()).toEqual(first);
    report.ack(first!.cursor);
    expect(report.report()).toBeNull();
  });

  test("an ack drops every receipt at or below its seq, and a receipt held after the answer survives it", () => {
    const report = new WalkyReport("laptop", { epoch: "0a1b2c3d", now: () => AT });
    report.note(record("wt_bbbbbbbbbbb1"));
    report.note(record("wt_bbbbbbbbbbb2"));
    const read = report.report();
    expect(read?.cursor).toBe("0a1b2c3d.2");
    report.note(record("wt_bbbbbbbbbbb3"));
    report.ack(read!.cursor);
    expect(report.report()).toEqual({ receipts: [expect.objectContaining({ id: "wt_bbbbbbbbbbb3" })], cursor: "0a1b2c3d.3" });
  });

  test("a newer state is a new receipt: an ack of the older one keeps it", () => {
    const report = new WalkyReport("laptop", { epoch: "0a1b2c3d", now: () => AT });
    report.note(record("wt_bbbbbbbbbbb1", "inbox-only"));
    const read = report.report();
    report.note(record("wt_bbbbbbbbbbb1", "delivered", AT + 1));
    report.ack(read!.cursor);
    expect(report.report()).toEqual({ receipts: [expect.objectContaining({ id: "wt_bbbbbbbbbbb1", state: "delivered" })], cursor: "0a1b2c3d.2" });
  });

  test("an ack of another epoch, or one that is not a cursor, acks nothing", () => {
    const report = new WalkyReport("laptop", { epoch: "0a1b2c3d", now: () => AT });
    report.note(record("wt_bbbbbbbbbbb1"));
    for (const ack of ["ffffffff.9", "0a1b2c3d", "0A1B2C3D.1", "0a1b2c3d.-1", "", null]) {
      report.ack(ack);
      expect(report.report()?.receipts).toHaveLength(1);
    }
    // A fresh epoch per bridge process, eight hex characters.
    expect(new WalkyReport("laptop").epoch).toMatch(/^[0-9a-f]{8}$/u);
  });

  test("holds at most 100, oldest dropped, and drops a receipt 10 minutes after it was held", () => {
    let now = AT;
    const small = new WalkyReport("laptop", { max: 3, now: () => now });
    for (let n = 0; n < 5; n += 1) small.note(record(`wt_${String(n).padStart(12, "b")}`));
    expect(small.report()?.receipts.map((receipt) => receipt.id)).toEqual(["wt_bbbbbbbbbbb2", "wt_bbbbbbbbbbb3", "wt_bbbbbbbbbbb4"]);
    expect(WALKY_REPORT_MAX).toBe(100);
    now = AT + 10 * 60 * 1000;
    expect(small.report()?.receipts).toHaveLength(3);
    now += 1;
    expect(small.report()).toBeNull();
  });

  test("the snapshot sibling reads as receipts and a cursor; absent or malformed is no report", () => {
    const receipt: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "delivered", verified: "lead", at: AT, by: "laptop" };
    expect(readWalkyReport(wire({ agents: [], walky: { receipts: [receipt, { bad: 1 }], cursor: "0a1b2c3d.7" } }), "walky")).toEqual({ receipts: [receipt], cursor: "0a1b2c3d.7" });
    // A member before the ack sends no cursor: the receipts still read, and nothing is acked.
    expect(readWalkyReport(wire({ walky: { receipts: [receipt] } }), "walky")).toEqual({ receipts: [receipt], cursor: null });
    expect(readWalkyReport(wire({ walky: { receipts: [receipt], cursor: "not a cursor" } }), "walky")).toEqual({ receipts: [receipt], cursor: null });
    expect(readWalkyReport({ agents: [] }, "walky")).toEqual({ receipts: [], cursor: null });
    expect(readWalkyReport({ walky: "nope" }, "walky")).toEqual({ receipts: [], cursor: null });
  });

  test("the lead writes a member's report into its log, for that member's own panes only", async () => {
    const posted = async (memberId: string): Promise<CrewDialAnswer> => ({
      kind: "answer",
      status: 200,
      body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "lead", at: AT, by: memberId }] },
    });
    const lead = service("desk", [pane("w1:p1")], posted);
    await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "laptop/w9:p9", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    const delivered: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "laptop/w9:p9", state: "delivered", verified: "origin", at: AT + 5, by: "laptop" };
    const forged: WalkyReceipt[] = [
      { ...delivered, by: "other" },
      { ...delivered, target: "other/w9:p9", by: "laptop" },
      { ...delivered, id: "wt_bbbbbbbbbbb1" },
    ];
    expect(mergeReport(lead.log, "laptop", [...forged, delivered])).toBe(1);
    expect(lead.service.status("wt_aaaaaaaaaaa1").receipts).toMatchObject([{ state: "delivered", target: "laptop/w9:p9" }]);
    expect(mergeReport(lead.log, "laptop", [delivered])).toBe(0);
  });

  test("a held receipt, `accepted` with what holds it, is reported (M62 spec 02); a bare `accepted` is not", () => {
    const report = new WalkyReport("laptop", { epoch: "0a1b2c3d", now: () => AT });
    report.note(record("wt_bbbbbbbbbbb1", "accepted"));
    expect(report.report()).toBeNull();
    report.note(record("wt_bbbbbbbbbbb1", "accepted", AT + 1, "draft present"));
    report.note(record("wt_bbbbbbbbbbb1", "accepted", AT + 2, "turn running"));
    expect(report.report()?.receipts).toMatchObject([{ id: "wt_bbbbbbbbbbb1", state: "accepted", reason: "turn running" }]);
    report.note(record("wt_bbbbbbbbbbb1", "delivered", AT + 3));
    expect(report.report()?.receipts).toMatchObject([{ id: "wt_bbbbbbbbbbb1", state: "delivered" }]);
  });

  test("under an older lead a held receipt reads as `accepted`: its reason crosses, it never goes over `unknown`, and the outcome replaces it", async () => {
    const posted = async (memberId: string): Promise<CrewDialAnswer> => ({
      kind: "answer",
      status: 200,
      body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "lead", at: AT, by: memberId }] },
    });
    const lead = service("desk", [pane("w1:p1")], posted);
    await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "laptop/w9:p9", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    const held: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "laptop/w9:p9", state: "accepted", reason: "draft present", verified: "origin", at: AT + 5, by: "laptop" };
    // The member's snapshot sibling, off the wire, as any lead since 2026-10-18 reads it: the field is kept.
    const offWire = readWalkyReport(parseJson(JSON.stringify({ walky: { receipts: [held], cursor: "0a1b2c3d.1" } })), "walky");
    expect(offWire.receipts).toEqual([held]);
    // The merge is an older lead's own rule, unchanged: a newer `accepted` replaces the dial's `accepted`.
    expect(mergeReport(lead.log, "laptop", offWire.receipts)).toBe(1);
    expect(lead.service.status("wt_aaaaaaaaaaa1").receipts).toMatchObject([{ state: "accepted", reason: "draft present" }]);
    // It ranks as `accepted`: never over `unknown`, never over a finished state.
    const unknown: WalkyReceipt = { ...held, state: "unknown", reason: "member slow", at: AT + 1 };
    expect(movesForward(unknown, { ...held, at: AT + 9 })).toBe(false);
    expect(movesForward({ ...held, state: "delivered" }, { ...held, at: AT + 9 })).toBe(false);
    const delivered: WalkyReceipt = { ...held, state: "delivered", at: AT + 6 };
    const { reason: _gone, ...done } = delivered;
    expect(mergeReport(lead.log, "laptop", [done])).toBe(1);
    expect(lead.service.status("wt_aaaaaaaaaaa1").receipts).toMatchObject([{ state: "delivered" }]);
    expect(mergeReport(lead.log, "laptop", [{ ...held, at: AT + 7 }])).toBe(0);
  });

  test("the lead takes a held receipt of the same millisecond as the dial's `accepted`, once (2026-10-22 rig case 21, message 3)", async () => {
    const posted = async (memberId: string): Promise<CrewDialAnswer> => ({
      kind: "answer",
      status: 200,
      body: { receipts: [{ id: "wt_aaaaaaaaaaa2", target: `${memberId}/w9:p9`, state: "accepted", verified: "origin", at: AT, by: memberId }] },
    });
    const lead = service("desk", [pane("w1:p1")], posted);
    await lead.service.send({ id: "wt_aaaaaaaaaaa2", to: "laptop/w9:p9", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect(lead.service.status("wt_aaaaaaaaaaa2").receipts).toMatchObject([{ state: "accepted", at: AT }]);
    expect(lead.service.status("wt_aaaaaaaaaaa2").receipts[0]?.reason).toBeUndefined();
    const held: WalkyReceipt = { id: "wt_aaaaaaaaaaa2", target: "laptop/w9:p9", state: "accepted", reason: "draft present", verified: "origin", at: AT, by: "laptop", sendId: "wt_aaaaaaaaaaa2-1659612a" };
    expect(mergeReport(lead.log, "laptop", [held])).toBe(1);
    expect(lead.service.status("wt_aaaaaaaaaaa2").receipts).toMatchObject([{ state: "accepted", reason: "draft present" }]);
    // The report rides every snapshot answer until the ack: the resend writes nothing.
    expect(mergeReport(lead.log, "laptop", [held])).toBe(0);
  });
});

describe("a member that never answers", () => {
  test("its leg is the lead's own `unknown: member slow` at the leg cap, the rest answer at once, and its report still lands", async () => {
    const routeRemote = leadRouteRemote({
      self: "desk",
      members: () => ["laptop", "other"],
      signing: () => ({ keyPem: material("desk").keyPem, crewId: CREW.crewId }),
      legMs: 40,
      now: () => AT,
      post: async (memberId) => {
        if (memberId === "laptop") return new Promise<CrewDialAnswer>(() => undefined);
        return { kind: "answer", status: 200, body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: "other/w2:p1", state: "accepted", verified: "lead", at: AT, by: "other" }] } };
      },
    });
    const lead = service("desk", [pane("w1:p1")], undefined, { routeRemote });
    const started = performance.now();
    const answer = await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "all", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect(performance.now() - started).toBeLessThan(1000);
    const receipts = answer.ok ? answer.receipts : [];
    expect(receipts.map((receipt) => `${receipt.target} ${receipt.state} ${receipt.reason ?? "-"}`)).toEqual([
      "desk/w1:p1 accepted -",
      "laptop/all unknown member slow",
      "other/w2:p1 accepted -",
    ]);
    // The member delivered after all: its snapshot report names the pane, and the lead takes it.
    const late: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p8", state: "delivered", verified: "lead", at: AT + 9000, by: "laptop" };
    expect(mergeReport(lead.log, "laptop", [late])).toBe(1);
    await lead.service.deliverer.settled();
    const shown = lead.service.status("wt_aaaaaaaaaaa1").receipts.map((receipt) => `${receipt.target} ${receipt.state}`);
    expect(shown).toContain("laptop/w1:p8 delivered");
    // The pane answers for the leg: `laptop/all: unknown` is gone from `status` and from the phone's
    // retry of the same id.
    expect(shown.some((line) => line.startsWith("laptop/all"))).toBe(false);
    const retry = await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "all", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect((retry.ok ? retry.receipts : []).map((receipt) => receipt.target).toSorted()).toEqual(["all", "desk/w1:p1", "laptop/w1:p8", "other/w2:p1"]);
  });
});

describe("`who` on a lead", () => {
  test("lists every member's agent panes from the sweep's bodies, with the member's address", () => {
    const paneOf = (paneId: string, over: Partial<PaneWire> = {}): PaneWire =>
      // SAFETY: a test fixture carrying the fields `crewTargets` reads; the rest of the wire shape is irrelevant here.
      ({ paneId, agent: "agent-x", status: "idle", cwd: "/home/a/collie", gitHead: { kind: "branch", name: "main" }, ...over }) as PaneWire;
    const targets = crewTargets(
      [
        { memberId: "laptop", name: "laptop", reachable: true, body: { sessions: [], agents: [paneOf("w1:p9"), paneOf("w1:p9"), paneOf("w1:p3", { kind: "shell" })], shellPanes: [], workspaces: [], tabs: [] } },
        { memberId: "other", name: "other", reachable: false, body: { sessions: [], agents: [paneOf("w2:p1")], shellPanes: [], workspaces: [], tabs: [] } },
        { memberId: "gone", name: "gone", reachable: false, body: null },
      ],
      true,
    );
    expect(targets).toEqual([
      { address: "laptop/w1:p9", memberId: "laptop", machine: "laptop", harness: "agent-x", label: "collie#main", state: "idle" },
      { address: "other/w2:p1", memberId: "other", machine: "other", harness: "agent-x", label: "collie#main", state: "unreachable" },
    ]);
  });

  test("names a member's pane by its instance token when the member sends one, bare when it does not", () => {
    const paneOf = (paneId: string, over: Partial<PaneWire> = {}): PaneWire =>
      // SAFETY: a test fixture carrying the fields `crewTargets` reads; the rest of the wire shape is irrelevant here.
      ({ paneId, agent: "agent-x", status: "idle", cwd: "/home/a/collie", ...over }) as PaneWire;
    const targets = crewTargets(
      [{ memberId: "laptop", name: "laptop", reachable: true, body: { sessions: [], agents: [paneOf("w1:p1", { instance: "k3f9" }), paneOf("w1:p2"), paneOf("w1:p3", { instance: "../x" })], shellPanes: [], workspaces: [], tabs: [] } }],
      true,
    );
    expect(targets.map((target) => target.address)).toEqual(["laptop/w1:p1#k3f9", "laptop/w1:p2", "laptop/w1:p3"]);
  });
});

describe("an older member (CREW_PROTOCOL §21)", () => {
  test("below 1.23.0 is older; on a lead built before 1.23.0 the floor is the lead's own version; no version is never older", () => {
    expect(olderThanWalky("1.22.4", "1.23.0", compareSemver)).toBe(true);
    expect(olderThanWalky("1.23.0", "1.23.0", compareSemver)).toBe(false);
    expect(olderThanWalky("1.24.1", "1.23.0", compareSemver)).toBe(false);
    // A development lead at 1.22.5 carries the feature: members at its version are not older.
    expect(olderThanWalky("1.22.5", "1.22.5", compareSemver)).toBe(false);
    expect(olderThanWalky("1.22.4", "1.22.5", compareSemver)).toBe(true);
    expect(olderThanWalky(null, "1.23.0", compareSemver)).toBe(false);
    expect(olderThanWalky("unknown", "1.23.0", compareSemver)).toBe(false);
  });

  test("the lead refuses `older member` at once, dials nothing, and counts the refusal", async () => {
    const posts: string[] = [];
    const routeRemote = leadRouteRemote({
      self: "desk",
      members: () => ["laptop", "other"],
      signing: () => ({ keyPem: material("desk").keyPem, crewId: CREW.crewId }),
      post: async (memberId) => {
        posts.push(memberId);
        return { kind: "answer", status: 200, body: { receipts: [] } };
      },
      older: (memberId) => memberId === "laptop",
      now: () => AT,
    });
    const lead = service("desk", [pane("w1:p1")], undefined, { routeRemote });
    const answer = await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "laptop/w9:p9", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect(answer).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "older member", target: "laptop/w9:p9" }] });
    expect(posts).toEqual([]);
    expect(lead.service.refusals().counts).toEqual({ "older member": 1 });
  });
});

describe("the skipped list on a lead", () => {
  test("lists every member's shell panes once, from the bodies, and never an agent pane", () => {
    const paneOf = (paneId: string, over: Partial<PaneWire> = {}): PaneWire =>
      // SAFETY: a test fixture carrying the fields `crewSkipped` reads; the rest of the wire shape is irrelevant here.
      ({ paneId, agent: null, kind: "shell", status: "idle", cwd: "/home/a/collie", gitHead: { kind: "branch", name: "main" }, ...over }) as PaneWire;
    const skipped = crewSkipped(
      [
        {
          memberId: "laptop",
          name: "laptop",
          reachable: true,
          body: { sessions: [], agents: [paneOf("w1:p9", { agent: "agent-x", kind: "agent" }), paneOf("w1:p3")], shellPanes: [paneOf("w1:p3"), paneOf("w1:p4")], workspaces: [], tabs: [] },
        },
        { memberId: "gone", name: "gone", reachable: false, body: null },
      ],
      true,
    );
    expect(skipped).toEqual([
      { address: "laptop/w1:p3", memberId: "laptop", machine: "laptop", label: "collie#main" },
      { address: "laptop/w1:p4", memberId: "laptop", machine: "laptop", label: "collie#main" },
    ]);
  });
});

describe("the outcome comes back to the sender's machine (§21, added 2026-10-18)", () => {
  /** A member whose lead answers every message for elsewhere with its own `accepted`. */
  function sender() {
    return service("laptop", [pane("w1:p8")], undefined, {
      outcomesOnLead: true,
      routeRemote: async (message) => [{ id: message.id, target: message.to, state: "accepted", verified: "local", at: AT, by: "desk" }],
    });
  }
  const delivered: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "other/w1:p9", state: "delivered", verified: "origin", at: AT + 5, by: "other" };

  test("a member writes its lead's push for its own message, newer or another state only, and answers the count", async () => {
    const laptop = sender();
    await laptop.service.send({ id: "wt_aaaaaaaaaaa1", to: "other/w1:p9", body: "hi", replyTo: null }, { kind: "agent", pane: pane("w1:p8") });
    expect(laptop.service.status("wt_aaaaaaaaaaa1")).toMatchObject({ receipts: [{ state: "accepted" }], elsewhere: ["other/w1:p9"] });
    // A message this member did not send, held for a target elsewhere: never written.
    laptop.log.record(signed("wt_ccccccccccc1", "desk", "other/w1:p9"), "other/w1:p9", { session: null, paneId: null, instance: null }, { ...delivered, id: "wt_ccccccccccc1", state: "accepted" });
    const crew = new WalkyCrew({ service: laptop.service, trust: () => peerStore(), now: () => AT });
    const push = {
      receipts: [
        delivered,
        { bad: 1 },
        { ...delivered, id: "wt_bbbbbbbbbbb1" },
        { ...delivered, id: "wt_ccccccccccc1" },
        // This member's own pane is its own word, whatever the lead says.
        { ...delivered, target: "laptop/w1:p8", by: "laptop" },
      ],
    };
    expect(crew.outcomes(wire(push), "desk")).toEqual({ status: 200, body: { written: 1 } });
    expect(laptop.service.status("wt_aaaaaaaaaaa1")).toMatchObject({ receipts: [{ target: "other/w1:p9", state: "delivered", by: "other", verified: "origin" }], elsewhere: [] });
    expect(laptop.log.get("wt_ccccccccccc1", "other/w1:p9")?.receipt.state).toBe("accepted");
    // The same push again writes nothing; an older one of the same state neither.
    expect(crew.outcomes(wire(push), "desk")).toEqual({ status: 200, body: { written: 0 } });
    expect(writeOutcomes(laptop.log, "laptop", [{ ...delivered, at: AT }])).toBe(0);
    // A finished outcome is never replaced, not even by another finished one.
    expect(writeOutcomes(laptop.log, "laptop", [{ ...delivered, state: "inbox-only", at: AT + 1 }])).toBe(0);
  });

  test("only its own lead may push, and a body with no receipts list is a 400", async () => {
    const laptop = sender();
    const crew = new WalkyCrew({ service: laptop.service, trust: () => peerStore(), now: () => AT });
    expect(crew.outcomes(wire({ receipts: [delivered] }), "other")).toMatchObject({ status: 401 });
    const lost = new WalkyCrew({ service: laptop.service, trust: () => peerStore({ lead: null }), now: () => AT });
    expect(lost.outcomes(wire({ receipts: [delivered] }), "desk")).toMatchObject({ status: 401 });
    expect(crew.outcomes(wire({}), "desk")).toMatchObject({ status: 400 });
    expect(crew.outcomes(wire({ receipts: "all" }), "desk")).toMatchObject({ status: 400 });
  });

  test("an `accepted` answer that lands after the pushed outcome never writes over it", async () => {
    let laptop: Rig | null = null;
    laptop = service("laptop", [pane("w1:p8")], undefined, {
      outcomesOnLead: true,
      routeRemote: async (message) => {
        // The lead's push arrives while the member still waits for the lead's answer.
        writeOutcomes(laptop!.log, "laptop", [delivered]);
        return [{ id: message.id, target: message.to, state: "accepted", verified: "local", at: AT, by: "desk" }];
      },
    });
    await laptop.service.send({ id: "wt_aaaaaaaaaaa1", to: "other/w1:p9", body: "hi", replyTo: null }, { kind: "agent", pane: pane("w1:p8") });
    expect(laptop.service.status("wt_aaaaaaaaaaa1").receipts).toMatchObject([{ state: "delivered" }]);
  });
});

describe("the lead's side of the exchange (§21, added 2026-10-18)", () => {
  interface Pushed {
    readonly memberId: string;
    readonly receipts: readonly WalkyReceipt[];
  }

  /** A lead side whose pushes are recorded and answered from `answers`, and whose "at once" runs on `run()`. */
  function rig(answers: CrewDialAnswer[] = [], over: { max?: number; now?: () => number } = {}) {
    const lead = service("desk", [pane("w1:p1")], async (memberId) => ({
      kind: "answer",
      status: 200,
      body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "origin", at: AT, by: memberId }] },
    }));
    const pushed: Pushed[] = [];
    const queue: (() => void)[] = [];
    const side = new WalkyLeadSide({
      self: "desk",
      log: lead.log,
      push: async (memberId, payload) => {
        // SAFETY: the side posts the JSON it built itself.
        pushed.push({ memberId, receipts: (JSON.parse(payload) as { receipts: WalkyReceipt[] }).receipts });
        return answers.shift() ?? { kind: "answer", status: 200, body: { written: 1 } };
      },
      later: (work) => queue.push(work),
      ...over,
    });
    side.listen();
    const run = async (): Promise<void> => {
      for (const work of queue.splice(0)) work();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { lead, side, pushed, run };
  }

  /** A log record of a message `from` sent to `target`, with its receipt at `state`. */
  function record(from: string, target: string, state: WalkyReceipt["state"] = "delivered", id = "wt_aaaaaaaaaaa1", at = AT) {
    return { session: null, paneId: null, instance: null, target, message: signed(id, from, target), receipt: { id, target, state, verified: "origin" as const, at, by: target.split("/")[0]! }, sender: null, acceptedAt: at };
  }

  test("a member's report is merged into the log, and its cursor is what the next dial acks", async () => {
    const { lead, side } = rig();
    await lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "other/w9:p9", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect(side.ackFor("other")).toBeNull();
    const delivered: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "other/w9:p9", state: "delivered", verified: "origin", at: AT + 5, by: "other" };
    expect(side.report("other", [delivered], "0a1b2c3d.4")).toBe(1);
    expect(side.ackFor("other")).toBe("0a1b2c3d.4");
    expect(lead.service.status("wt_aaaaaaaaaaa1").receipts).toMatchObject([{ state: "delivered" }]);
    // A report with no cursor (a member before the ack) leaves the last one in place; a member gone takes it.
    side.report("other", [delivered], null);
    expect(side.ackFor("other")).toBe("0a1b2c3d.4");
    side.forget("other");
    expect(side.ackFor("other")).toBeNull();
  });

  test("a member's message to another member: the outcome goes back to the sender in one push, and a 200 empties it", async () => {
    const { lead, side, pushed, run } = rig();
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    // From laptop's agent: one to this lead's own pane, one routed on to `other`.
    await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1"), member({ memberId: "laptop" }));
    await fromMemberOf(crew, signed("wt_aaaaaaaaaaa2", "laptop", "other/w9:p9"), member({ memberId: "laptop" }));
    await lead.service.deliverer.settled();
    side.report("other", [{ id: "wt_aaaaaaaaaaa2", target: "other/w9:p9", state: "delivered", verified: "lead", at: AT + 5, by: "other" }], null);
    // The lead's own message, and an `accepted`, are never held for anyone.
    await lead.service.send({ id: "wt_aaaaaaaaaaa3", to: "other/w9:p9", body: "mine", replyTo: null }, { kind: "operator", label: "phone" });
    expect(side.pending("laptop").map((receipt) => `${receipt.id} ${receipt.target} ${receipt.state}`)).toEqual([
      "wt_aaaaaaaaaaa1 desk/w1:p1 delivered",
      "wt_aaaaaaaaaaa2 other/w9:p9 delivered",
    ]);
    expect(side.pending("desk")).toEqual([]);
    expect(pushed).toEqual([]);
    await run();
    expect(pushed.map((push) => `${push.memberId} ${String(push.receipts.length)}`)).toEqual(["laptop 2"]);
    expect(side.pending("laptop")).toEqual([]);
  });

  test("a receipt for a target on the sender's own machine is never pushed: that outcome is the sender's word", () => {
    const { side } = rig();
    side.note(record("laptop", "laptop/w1:p8"));
    side.note(record("laptop", "laptop/all"));
    side.note(record("laptop", "other/w1:p9", "accepted"));
    expect(side.pending("laptop")).toEqual([]);
    side.note(record("laptop", "all"));
    expect(side.pending("laptop")).toHaveLength(1);
  });

  test("a held receipt, `accepted` with what holds it (M62 spec 02), goes in the member's outbox; a bare `accepted` does not", () => {
    const { side } = rig();
    side.note(record("laptop", "other/w1:p9", "accepted"));
    expect(side.pending("laptop")).toEqual([]);
    const held = record("laptop", "other/w1:p9", "accepted");
    side.note({ ...held, receipt: { ...held.receipt, reason: "draft present" } });
    expect(side.pending("laptop")).toMatchObject([{ state: "accepted", reason: "draft present" }]);
  });

  test("a refused or unknown push keeps the batch for the next sweep; a 404 drops it until a new receipt settles", async () => {
    const { side, pushed, run } = rig([
      { kind: "refused", reason: "laptop is unreachable" },
      { kind: "unknown", reason: "crew: timed out" },
      { kind: "answer", status: 200, body: { written: 1 } },
      { kind: "answer", status: 404, body: { error: "not found" } },
    ]);
    side.note(record("laptop", "other/w1:p9"));
    await run();
    expect(side.pending("laptop")).toHaveLength(1);
    // A sweep that did not reach laptop pushes nothing.
    side.swept(["other"]);
    await run();
    expect(pushed).toHaveLength(1);
    side.swept(["laptop"]);
    await run();
    expect(side.pending("laptop")).toHaveLength(1);
    side.swept(["laptop"]);
    await run();
    expect(side.pending("laptop")).toEqual([]);
    expect(pushed).toHaveLength(3);
    // Then the member answers 404: an older member. The batch goes, and the sweeps after it push nothing.
    side.note(record("laptop", "other/w1:p9", "delivered", "wt_aaaaaaaaaaa2"));
    await run();
    expect(pushed).toHaveLength(4);
    expect(side.pending("laptop")).toEqual([]);
    side.swept(["laptop"]);
    await run();
    expect(pushed).toHaveLength(4);
    // A new receipt settles: that one is pushed, once.
    side.note(record("laptop", "other/w1:p9", "delivered", "wt_aaaaaaaaaaa3"));
    await run();
    expect(pushed.map((push) => push.receipts.map((receipt) => receipt.id))).toEqual([
      ["wt_aaaaaaaaaaa1"],
      ["wt_aaaaaaaaaaa1"],
      ["wt_aaaaaaaaaaa1"],
      ["wt_aaaaaaaaaaa2"],
      ["wt_aaaaaaaaaaa3"],
    ]);
  });

  test("a newer receipt that settles while a push is on the wire survives it, and goes in the next push", async () => {
    let answer: (value: CrewDialAnswer) => void = () => undefined;
    const pushed: WalkyReceipt[][] = [];
    const lead = service("desk", []);
    const side = new WalkyLeadSide({
      self: "desk",
      log: lead.log,
      push: (_memberId, payload) => {
        // SAFETY: the side posts the JSON it built itself.
        pushed.push((JSON.parse(payload) as { receipts: WalkyReceipt[] }).receipts);
        return new Promise((resolve) => (answer = resolve));
      },
      later: (work) => work(),
    });
    side.note(record("laptop", "other/w1:p9", "inbox-only"));
    expect(pushed).toHaveLength(1);
    side.note(record("laptop", "other/w1:p9", "delivered", "wt_aaaaaaaaaaa1", AT + 1));
    expect(pushed).toHaveLength(1);
    answer({ kind: "answer", status: 200, body: { written: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushed.map((batch) => batch.map((receipt) => receipt.state))).toEqual([["inbox-only"], ["delivered"]]);
    answer({ kind: "answer", status: 200, body: { written: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(side.pending("laptop")).toEqual([]);
  });

  test("holds at most 100 per member, oldest dropped, and 10 minutes each", () => {
    let now = AT;
    const { side } = rig([], { max: 2, now: () => now });
    for (const id of ["wt_aaaaaaaaaaa1", "wt_aaaaaaaaaaa2", "wt_aaaaaaaaaaa3"]) side.note(record("laptop", "other/w1:p9", "delivered", id));
    expect(side.pending("laptop").map((receipt) => receipt.id)).toEqual(["wt_aaaaaaaaaaa2", "wt_aaaaaaaaaaa3"]);
    expect(WALKY_OUTBOX_MAX).toBe(100);
    now = AT + 10 * 60 * 1000 + 1;
    expect(side.pending("laptop")).toEqual([]);
  });

  test("the whole loop: a member's agent sees the outcome the lead learned from the receiving member", async () => {
    const lead = service("desk", [], async (memberId) => ({
      kind: "answer",
      status: 200,
      body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "origin", at: AT, by: memberId }] },
    }));
    const leadCrew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    let laptopCrew: WalkyCrew | null = null;
    const queue: (() => void)[] = [];
    const side = new WalkyLeadSide({
      self: "desk",
      log: lead.log,
      push: async (_memberId, payload) => {
        // SAFETY: the side posts the JSON it built itself.
        const answer = laptopCrew!.outcomes(JSON.parse(payload) as JsonValue, "desk");
        return { kind: "answer", status: answer.status, body: wire(answer.body) };
      },
      later: (work) => queue.push(work),
    });
    side.listen();
    const laptop = service("laptop", [pane("w1:p8")], undefined, {
      outcomesOnLead: true,
      routeRemote: memberRouteRemote({
        self: "laptop",
        post: async (payload) => {
          // SAFETY: the member posts the JSON it built itself.
          const answer = await leadCrew.fromMember(JSON.parse(payload) as JsonValue, member({ memberId: "laptop" }));
          return { kind: "answer", status: answer.status, body: wire(answer.body) };
        },
        now: () => AT,
      }),
    });
    laptopCrew = new WalkyCrew({ service: laptop.service, trust: () => peerStore(), now: () => AT });
    await laptop.service.send({ id: "wt_aaaaaaaaaaa1", to: "other/w9:p9", body: "hi", replyTo: null }, { kind: "agent", pane: pane("w1:p8") });
    expect(laptop.service.status("wt_aaaaaaaaaaa1")).toMatchObject({ receipts: [{ state: "accepted", by: "other" }], elsewhere: ["other/w9:p9"] });
    // `other` reports on the lead's next sweep, and the lead pushes the outcome back.
    side.report("other", [{ id: "wt_aaaaaaaaaaa1", target: "other/w9:p9", state: "delivered", verified: "origin", at: AT + 5, by: "other" }], "0a1b2c3d.1");
    for (const work of queue.splice(0)) work();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(laptop.service.status("wt_aaaaaaaaaaa1")).toMatchObject({ receipts: [{ state: "delivered", by: "other", verified: "origin" }], elsewhere: [] });
    expect(side.pending("laptop")).toEqual([]);
  });
});

describe("an outcome never moves backwards (§21, added 2026-10-18)", () => {
  const receipt = (state: WalkyReceipt["state"], at = AT): WalkyReceipt => ({ id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p8", state, verified: "lead", at, by: "laptop" });

  test("accepted, then unknown, then a finished state; a finished state is never replaced", () => {
    expect(movesForward(receipt("accepted"), receipt("unknown"))).toBe(true);
    expect(movesForward(receipt("accepted"), receipt("delivered"))).toBe(true);
    expect(movesForward(receipt("unknown"), receipt("inbox-only"))).toBe(true);
    expect(movesForward(receipt("unknown"), receipt("accepted", AT + 1))).toBe(false);
    for (const done of ["delivered", "inbox-only", "refused", "expired"] as const) {
      for (const next of ["accepted", "unknown", "delivered", "inbox-only", "refused"] as const) expect(movesForward(receipt(done), receipt(next, AT + 1))).toBe(false);
    }
    // The same state again only when it is newer.
    expect(movesForward(receipt("unknown"), receipt("unknown"))).toBe(false);
    expect(movesForward(receipt("unknown"), receipt("unknown", AT + 1))).toBe(true);
  });

  test("a held send written in the millisecond of its bare `accepted` crosses; a resend of it does not (2026-10-22 rig case 21, message 3)", () => {
    const bare = receipt("accepted");
    const held: WalkyReceipt = { ...bare, reason: "draft present" };
    expect(movesForward(bare, held)).toBe(true);
    // The resend the report carries until the ack, and a bare `accepted` of the same millisecond.
    expect(movesForward(held, held)).toBe(false);
    expect(movesForward(held, bare)).toBe(false);
    // Another reason in the same millisecond is no move: only a newer one changes the reason.
    expect(movesForward(held, { ...bare, reason: "turn running" })).toBe(false);
    expect(movesForward(held, { ...bare, reason: "turn running", at: AT + 1 })).toBe(true);
    // Never over a finished state, never backwards.
    expect(movesForward(receipt("delivered"), { ...receipt("delivered"), reason: "draft present" })).toBe(false);
    expect(movesForward(receipt("unknown"), held)).toBe(false);
  });

  test("on the lead: a member's report lands during the leg, and the leg's `unknown: member slow` does not go over it", async () => {
    const routeRemote = leadRouteRemote({
      self: "desk",
      members: () => ["laptop"],
      signing: () => ({ keyPem: material("desk").keyPem, crewId: CREW.crewId }),
      legMs: 60,
      now: () => AT,
      post: () => new Promise<CrewDialAnswer>(() => undefined),
    });
    const lead = service("desk", [pane("w1:p1")], undefined, { routeRemote });
    const states: string[] = [];
    lead.log.onReceipt((record) => states.push(record.receipt.state));
    const sending = lead.service.send({ id: "wt_aaaaaaaaaaa1", to: "laptop/w1:p8", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mergeReport(lead.log, "laptop", [receipt("delivered", AT + 5)])).toBe(1);
    const answer = await sending;
    // The answer says what the leg came to; the log keeps what the member reported.
    expect(answer.ok ? answer.receipts : []).toMatchObject([{ state: "unknown", reason: "member slow" }]);
    expect(lead.log.get("wt_aaaaaaaaaaa1", "laptop/w1:p8")?.receipt).toMatchObject({ state: "delivered", by: "laptop" });
    expect(states).toEqual(["accepted", "delivered"]);
  });

  test("on a member: the lead pushes `delivered`, then the member's own dial to the lead fails, and `unknown` does not go over it", async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const laptop = service("laptop", [pane("w1:p8")], undefined, {
      outcomesOnLead: true,
      routeRemote: async () => {
        await gate;
        throw new Error("timed out");
      },
    });
    const sending = laptop.service.send({ id: "wt_aaaaaaaaaaa1", to: "other/w1:p9", body: "hi", replyTo: null }, { kind: "agent", pane: pane("w1:p8") });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const pushed: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "other/w1:p9", state: "delivered", verified: "origin", at: AT + 5, by: "other" };
    expect(writeOutcomes(laptop.log, "laptop", [pushed])).toBe(1);
    open();
    await sending;
    expect(laptop.log.get("wt_aaaaaaaaaaa1", "other/w1:p9")?.receipt).toMatchObject({ state: "delivered", by: "other" });
    // The same for an answer that is a receipt: the dial's `unknown` replaces only `accepted`.
    const later = service("laptop", [pane("w1:p8")], undefined, {
      outcomesOnLead: true,
      routeRemote: async (message) => {
        writeOutcomes(later.log, "laptop", [{ ...pushed, id: message.id }]);
        return [{ id: message.id, target: message.to, state: "unknown", reason: "crew: timed out", verified: "local", at: AT + 9, by: "laptop" }];
      },
    });
    await later.service.send({ id: "wt_aaaaaaaaaaa2", to: "other/w1:p9", body: "hi", replyTo: null }, { kind: "agent", pane: pane("w1:p8") });
    expect(later.log.get("wt_aaaaaaaaaaa2", "other/w1:p9")?.receipt.state).toBe("delivered");
  });
});

describe("a pane receipt under a leg sent as a whole (§21, added 2026-10-18)", () => {
  const accepted = (id: string, target: string): WalkyReceipt => ({ id, target, state: "accepted", verified: "local", at: AT, by: "desk" });
  const pane8 = (id: string, target = "laptop/w1:p8", by = "laptop"): WalkyReceipt => ({ id, target, state: "delivered", verified: "lead", at: AT + 1, by });
  const placement = { session: null, paneId: null, instance: null };

  test("the lead never takes one for the reporting member's own broadcast", () => {
    const lead = service("desk", [pane("w1:p1")]);
    lead.log.record(signed("wt_aaaaaaaaaaa1", "laptop", "all"), "all", placement, accepted("wt_aaaaaaaaaaa1", "all"));
    expect(mergeReport(lead.log, "laptop", [pane8("wt_aaaaaaaaaaa1")])).toBe(0);
    expect(lead.log.get("wt_aaaaaaaaaaa1", "laptop/w1:p8")).toBeNull();
    // Another member's broadcast, which the lead routed to laptop, is taken.
    lead.log.record(signed("wt_aaaaaaaaaaa2", "other", "all"), "all", placement, accepted("wt_aaaaaaaaaaa2", "all"));
    expect(mergeReport(lead.log, "laptop", [pane8("wt_aaaaaaaaaaa2")])).toBe(1);
  });

  test("the target must be bare and trimmed, so one pane never gets two records", () => {
    const lead = service("desk", [pane("w1:p1")]);
    lead.log.record(signed("wt_aaaaaaaaaaa1", "desk", "laptop/all"), "laptop/all", placement, accepted("wt_aaaaaaaaaaa1", "laptop/all"));
    for (const target of ["laptop/w1:p8#k3f9", " laptop/w1:p8", "laptop/w1:p8 "]) expect(mergeReport(lead.log, "laptop", [pane8("wt_aaaaaaaaaaa1", target)])).toBe(0);
    expect(mergeReport(lead.log, "laptop", [pane8("wt_aaaaaaaaaaa1")])).toBe(1);
    expect(lead.log.all("wt_aaaaaaaaaaa1").map((record) => record.target).toSorted()).toEqual(["laptop/all", "laptop/w1:p8"]);
  });

  test("one message gains at most WALKY_LEG_PANES_MAX panes on one member", () => {
    const lead = service("desk", [pane("w1:p1")]);
    lead.log.record(signed("wt_aaaaaaaaaaa1", "desk", "laptop/all"), "laptop/all", placement, accepted("wt_aaaaaaaaaaa1", "laptop/all"));
    const many = Array.from({ length: WALKY_LEG_PANES_MAX + 5 }, (_, n) => pane8("wt_aaaaaaaaaaa1", `laptop/w1:p${String(n + 100)}`));
    expect(mergeReport(lead.log, "laptop", many)).toBe(WALKY_LEG_PANES_MAX);
    expect(mergeReport(lead.log, "laptop", [pane8("wt_aaaaaaaaaaa1", "laptop/w9:p9")])).toBe(0);
  });

  test("a broadcasting member takes the lead's push for a pane of a slow leg, under its own message only", () => {
    const laptop = service("laptop", [pane("w1:p8")]);
    const mine = signed("wt_aaaaaaaaaaa1", "laptop", "all");
    laptop.log.record(mine, "all", placement, { ...accepted(mine.id, "all"), by: "laptop" });
    laptop.log.record(mine, "other/all", placement, { id: mine.id, target: "other/all", state: "unknown", reason: "member slow", verified: "local", at: AT, by: "desk" });
    const typed = pane8(mine.id, "other/w1:p9", "other");
    expect(writeOutcomes(laptop.log, "laptop", [{ ...typed, target: "other/w1:p9#k3f9" }])).toBe(0);
    expect(writeOutcomes(laptop.log, "laptop", [typed])).toBe(1);
    expect(laptop.log.get(mine.id, "other/w1:p9")?.receipt).toMatchObject({ state: "delivered", by: "other" });
    expect(writeOutcomes(laptop.log, "laptop", [typed])).toBe(0);
    // A leg of a message this member did not send: nothing.
    const theirs = signed("wt_aaaaaaaaaaa2", "desk", "all");
    laptop.log.record(theirs, "other/all", placement, { ...accepted(theirs.id, "other/all") });
    expect(writeOutcomes(laptop.log, "laptop", [pane8(theirs.id, "other/w1:p9", "other")])).toBe(0);
  });
});

describe("a workspace scope across a crew of two members (M75 spec 02)", () => {
  /** `who` on the lead, from a member's panes: what its sweep would hold. */
  const listed = (memberId: string, panes: readonly WalkyPane[]): WalkyTarget[] =>
    panes.filter((p) => p.agent).map((p) => ({ address: `${memberId}/${p.paneId}#${p.instance}`, memberId, machine: memberId, harness: p.harness, label: p.label, state: "idle" }));
  const otherStore = (): TrustStoreData => peerStore({ self: createTrustStore(selfIdentity("other", material("other"), T0)).self });

  /** A lead `desk` and two members, `laptop` and `other`, wired end to end through the real crew halves. */
  function crewOfThree() {
    const crews = new Map<string, WalkyCrew>();
    const deskPanes = [pane("w1:p1", { label: "collie-workspace#main" }), pane("w1:p2", { label: "elsewhere#main" })];
    const laptopPanes = [pane("w1:p8", { label: "collie-workspace#main" }), pane("w1:p9", { label: "collie-workspace#feat" })];
    const otherPanes = [pane("w2:p1", { label: "collie-workspace#main" }), pane("w2:p2", { label: "elsewhere#main" })];
    const legs: string[] = [];
    const lead = service(
      "desk",
      deskPanes,
      async (memberId, segment, payload) => {
        legs.push(`${memberId} ${segment}`);
        // SAFETY: the route posts the JSON it built itself.
        const answer = await crews.get(memberId)!.fromLead(segment, JSON.parse(payload) as JsonValue, "desk");
        return { kind: "answer", status: answer.status, body: wire(answer.body) };
      },
      { remoteTargets: () => [...listed("laptop", laptopPanes), ...listed("other", otherPanes)], knownMembers: () => ["desk", "laptop", "other"] },
    );
    const leadCrew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const laptop = service("laptop", laptopPanes, undefined, {
      outcomesOnLead: true,
      knownMembers: () => ["laptop", "desk"],
      routeRemote: memberRouteRemote({
        self: "laptop",
        post: async (payload) => {
          // SAFETY: the member posts the JSON it built itself.
          const answer = await leadCrew.fromMember(JSON.parse(payload) as JsonValue, member({ memberId: "laptop" }));
          return { kind: "answer", status: answer.status, body: wire(answer.body) };
        },
        now: () => AT,
      }),
    });
    const other = service("other", otherPanes);
    crews.set("laptop", new WalkyCrew({ service: laptop.service, trust: () => peerStore(), now: () => AT }));
    crews.set("other", new WalkyCrew({ service: other.service, trust: otherStore, now: () => AT }));
    return { lead, laptop, other, laptopPanes, legs };
  }

  const settledAll = async (...rigs: Rig[]) => {
    for (const r of rigs) await r.service.deliverer.settled();
  };

  test("a scope from a member's pane: the lead expands it once, one delivery per matching pane on every member, each with its own receipt", async () => {
    const { lead, laptop, other, laptopPanes, legs } = crewOfThree();
    const answer = await laptop.service.send({ id: "wt_aaaaaaaaaaa1", to: "collie-workspace", body: "hi", replyTo: null }, { kind: "agent", pane: laptopPanes[0]! });
    const receipts = answer.ok ? answer.receipts : [];
    expect(receipts.map((r) => `${r.target} ${r.state} ${r.by}`)).toEqual(["desk/w1:p1 accepted desk", "laptop/w1:p9 accepted laptop", "other/w2:p1 accepted other"]);
    // One leg per pane, the sender's own machine included: it handed the scope over whole.
    expect(legs.toSorted()).toEqual(["laptop w1:p9", "other w2:p1"]);
    await settledAll(lead, laptop, other);
    expect(lead.host.sends).toEqual(["w1:p1"]);
    expect(laptop.host.sends).toEqual(["w1:p9"]);
    expect(other.host.sends).toEqual(["w2:p1"]);
    // Every machine logged its own delivery under the one parent id, with `to` as typed.
    for (const [r, target] of [
      [lead, "desk/w1:p1"],
      [laptop, "laptop/w1:p9"],
      [other, "other/w2:p1"],
    ] as const) {
      expect(r.log.get("wt_aaaaaaaaaaa1", target)?.receipt.state).toBe("delivered");
      expect(r.log.get("wt_aaaaaaaaaaa1", target)?.message.to).toBe("collie-workspace");
    }
    // The lead's parent lists all three, each with its member.
    expect(lead.service.status("wt_aaaaaaaaaaa1").deliveries?.map((d) => `${d.address} ${d.member}`)).toEqual(["desk/w1:p1 desk", "laptop/w1:p9 laptop", "other/w2:p1 other"]);
    // The sender's own machine reports its delivery, though the message is its own: the lead routed it there.
    const report = new WalkyReport("laptop", { epoch: "0a1b2c3d", now: () => AT });
    report.note(laptop.log.get("wt_aaaaaaaaaaa1", "laptop/w1:p9")!);
    expect(report.report()?.receipts).toMatchObject([{ target: "laptop/w1:p9", state: "delivered", by: "laptop" }]);
    expect(mergeReport(lead.log, "laptop", report.report()!.receipts)).toBe(1);
    expect(lead.log.get("wt_aaaaaaaaaaa1", "laptop/w1:p9")?.receipt.state).toBe("delivered");
  });

  test("`here` from a member's pane reaches its siblings on both members and never the sender", async () => {
    const { laptop, lead, other, laptopPanes } = crewOfThree();
    const answer = await laptop.service.send({ id: "wt_aaaaaaaaaaa2", to: "here", body: "hi", replyTo: null }, { kind: "agent", pane: laptopPanes[0]! });
    expect(answer.ok && answer.receipts.map((r) => r.target)).toEqual(["desk/w1:p1", "laptop/w1:p9", "other/w2:p1"]);
    await settledAll(lead, laptop, other);
    expect(laptop.host.sends).toEqual(["w1:p9"]);
  });

  test("`here` from a herdr-core member's flat pane, through that member's socket and the crew hop, reaches the lead's pane in the same folder (2026-10-30)", async () => {
    // The live shape: member `bluefin-hc` (a hyphen), its pane the flat `t1`, placed by HC_TERMINAL_* markers.
    const hcPanes = [pane("t1", { label: "collie-workspace#main" })];
    const deskPanes = [pane("w1:p1", { label: "collie-workspace#main" }), pane("w1:p2", { label: "elsewhere#main" })];
    const lead = service("desk", deskPanes, undefined, { remoteTargets: () => listed("bluefin-hc", hcPanes), knownMembers: () => ["desk", "bluefin-hc"] });
    const leadCrew = new WalkyCrew({ service: lead.service, trust: () => leadStore(), now: () => AT });
    const hops: string[] = [];
    const hc = service("bluefin-hc", hcPanes, undefined, {
      outcomesOnLead: true,
      knownMembers: () => ["bluefin-hc", "desk"],
      routeRemote: memberRouteRemote({
        self: "bluefin-hc",
        post: async (payload) => {
          // SAFETY: the member posts the JSON it built itself.
          const body = JSON.parse(payload) as JsonValue;
          hops.push(JSON.stringify(body));
          const answer = await leadCrew.fromMember(body, member({ memberId: "bluefin-hc" }));
          return { kind: "answer", status: answer.status, body: wire(answer.body) };
        },
        now: () => AT,
      }),
    });
    const hcMatcher: BeaconMatcher = {
      namespace: "hc",
      scope: async () => "/run/user/1000/herdr-core/default.sock",
      matches: (at, marker, scope) => marker.scope === scope && at.paneId === marker.pane,
      notesWithoutHooks: { agentDetection: "", agentSessionRef: "" },
    };
    const place: PlaceTarget = { session: "main", matcher: hcMatcher, paneIds: () => ["t1"] };
    const line = JSON.stringify({ v: 1, op: "send", markers: [{ namespace: "hc", scope: "/run/user/1000/herdr-core/default.sock", pane: "t1" }], id: "wt_aaaaaaaaaah1", to: "here", body: "scope proof", replyTo: null });
    const read = readWalkyRequest(line);
    if (!read.ok) throw new Error(read.reason);
    const answer = await answerRequest(hc.service, read.request, [place]);
    expect(answer).toMatchObject({ ok: true, receipts: [{ target: "desk/w1:p1", state: "accepted", by: "desk" }] });
    // The member handed `here` over whole, signed by `bluefin-hc`, with the label the lead resolves it from.
    expect(hops).toHaveLength(1);
    expect(JSON.parse(hops[0]!)).toMatchObject({ to: "here", from: { memberId: "bluefin-hc", address: "bluefin-hc/t1#aaaa", label: "collie-workspace#main" }, signer: "bluefin-hc" });
    await lead.service.deliverer.settled();
    await hc.service.deliverer.settled();
    expect(lead.host.sends).toEqual(["w1:p1"]);
    expect(hc.host.sends).toEqual([]);
    expect(lead.log.get("wt_aaaaaaaaaah1", "desk/w1:p1")?.receipt.state).toBe("delivered");
  });

  test("a member refuses a routed scope for a pane whose label is not in it, and a scope routed to `all`", async () => {
    const { other } = crewOfThree();
    const crew = new WalkyCrew({ service: other.service, trust: () => peerStore({ self: createTrustStore(selfIdentity("other", material("other"), T0)).self }), now: () => AT });
    const message = signed("wt_aaaaaaaaaaa3", "desk", "collie-workspace", OPERATOR("desk"));
    const body = { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "other") };
    expect(await fromLeadOf(crew, "w2:p2", body, "desk")).toMatchObject({ status: 200, body: { receipts: [{ target: "other/w2:p2", state: "refused", reason: OUT_OF_SCOPE }] } });
    expect(await fromLeadOf(crew, "all", body, "desk")).toMatchObject({ status: 400 });
    await other.service.deliverer.settled();
    expect(other.host.sends).toEqual([]);
  });

  test("the lead refuses a member's id as a bare word, and a scope with no pane, before anything is dialled", async () => {
    const { laptop, laptopPanes, legs } = crewOfThree();
    const send = (id: string, to: string) => laptop.service.send({ id, to, body: "hi", replyTo: null }, { kind: "agent", pane: laptopPanes[0]! });
    expect(await send("wt_aaaaaaaaaaa4", "other")).toMatchObject({ ok: true, receipts: [{ target: "other", state: "refused", reason: scopeIsMember("other") }] });
    expect(await send("wt_aaaaaaaaaaa5", "nowhere")).toMatchObject({ ok: true, receipts: [{ target: "nowhere", state: "refused", reason: scopeEmpty("nowhere") }] });
    expect(legs).toEqual([]);
  });
});
