import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CREW, leadStore, material, member, peerStore } from "../crew/fixtures.ts";
import type { PaneWire } from "../types.ts";
import { signMessage, attestationString } from "./canonical.ts";
import { verifyCanonical } from "../crew/signing.ts";
import {
  attestFor,
  checkFromLead,
  checkFromMember,
  crewTargets,
  leadRouteRemote,
  memberRouteRemote,
  mergeReport,
  receiptsOfAnswer,
  WalkyCrew,
  WalkyReport,
  WALKY_REPORT_MAX,
  type CrewDialAnswer,
} from "./crew.ts";
import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { readWalkyReport } from "./parse.ts";
import { WalkyService } from "./service.ts";
import type { JsonValue } from "../json.ts";
import type { WalkyMessage, WalkyReceipt } from "./types.ts";

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

function pane(paneId: string, over: Partial<WalkyPane> = {}): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId}`, state: "idle", terminal: true, ...over };
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

function service(memberId: string, panes: WalkyPane[], route?: Parameters<typeof leadRouteRemote>[0]["post"]): Rig {
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
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore() });
    const message = signed("wt_aaaaaaaaaaa1", "laptop", "desk/w1:p1");
    const first = await fromMemberOf(crew, message, member({ memberId: "laptop" }));
    expect(first).toMatchObject({ status: 200, body: { receipts: [{ state: "accepted", target: "desk/w1:p1", verified: "origin", by: "desk" }] } });
    await lead.service.deliverer.settled();
    const again = await fromMemberOf(crew, message, member({ memberId: "laptop" }));
    expect(again).toMatchObject({ status: 200, body: { receipts: [{ state: "delivered", target: "desk/w1:p1", verified: "origin" }] } });
    expect(lead.host.sends).toEqual(["w1:p1"]);
  });

  test("rate-limits per sender address, as the local path does", async () => {
    const lead = service("desk", [pane("w1:p1")]);
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore() });
    const laptop = member({ memberId: "laptop" });
    for (let n = 0; n < 30; n += 1) {
      const id = `wt_${n.toString().padStart(12, "a")}`;
      expect((await fromMemberOf(crew, signed(id, "laptop", "desk/w1:p1"), laptop)).status).toBe(200);
    }
    expect(await fromMemberOf(crew, signed("wt_zzzzzzzzzzzz", "laptop", "desk/w1:p1"), laptop)).toMatchObject({ body: { receipts: [{ state: "refused", reason: "rate limit" }] } });
  });

  test("routes a message for another member on, with this lead's attestation for that member", async () => {
    const posts: { memberId: string; segment: string; body: { message: WalkyMessage; attest: string } }[] = [];
    const lead = service("desk", [pane("w1:p1")], async (memberId, segment, payload) => {
      // SAFETY: the route posts the JSON it built itself.
      posts.push({ memberId, segment, body: JSON.parse(payload) as { message: WalkyMessage; attest: string } });
      return { kind: "answer", status: 200, body: { receipts: [{ id: "wt_aaaaaaaaaaa1", target: `${memberId}/w9:p9`, state: "accepted", verified: "lead", at: AT, by: memberId }] } };
    });
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore() });
    const answer = await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "other/w9:p9"), member({ memberId: "laptop" }));
    expect(answer).toMatchObject({ status: 200, body: { receipts: [{ state: "accepted", target: "other/w9:p9", by: "other" }] } });
    expect(posts.map((post) => `${post.memberId} ${post.segment}`)).toEqual(["other w9:p9"]);
    const { message, attest } = posts[0]!.body;
    expect(verifyCanonical(material("desk").certPem, attest, attestationString(message, CREW.crewId, "other"))).toBe(true);
    expect(lead.host.sends).toEqual([]);
  });

  test("`all` from a member reaches the lead's panes and every other member, never the sender's machine", async () => {
    const posted: string[] = [];
    const lead = service("desk", [pane("w1:p1")], async (memberId, segment) => {
      posted.push(`${memberId} ${segment}`);
      return { kind: "answer", status: 200, body: { receipts: [] } };
    });
    const crew = new WalkyCrew({ service: lead.service, trust: () => leadStore() });
    const answer = await fromMemberOf(crew, signed("wt_aaaaaaaaaaa1", "laptop", "all"), member({ memberId: "laptop" }));
    expect(posted).toEqual(["other all"]);
    expect(answer.body).toMatchObject({ receipts: [{ target: "desk/w1:p1" }, { target: "other/all", state: "accepted" }] });
  });
});

describe("a member takes its lead's delivery", () => {
  test("verifies the attestation, delivers as `lead`, and fans `<member>/all` out to its agent panes", async () => {
    const peer = service("laptop", [pane("w1:p8"), pane("w1:p9"), pane("w1:p7", { agent: false, harness: null })]);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore() });
    const message = signed("wt_aaaaaaaaaaa1", "other", "laptop/all");
    const body = { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "laptop") };
    const answer = await fromLeadOf(crew, "all", body, "desk");
    expect(answer).toMatchObject({ status: 200, body: { receipts: [{ target: "laptop/w1:p8", verified: "lead" }, { target: "laptop/w1:p9", verified: "lead" }] } });
    await peer.service.deliverer.settled();
    expect(peer.host.sends).toEqual(["w1:p8", "w1:p9"]);
  });

  test("refuses a caller that is not its lead, and a bad attestation, with the uniform 401", async () => {
    const peer = service("laptop", [pane("w1:p9")]);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore() });
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
  test("holds receipts for messages from elsewhere past `accepted`, at most 100, and empties on each answer", async () => {
    const peer = service("laptop", [pane("w1:p9")]);
    const report = new WalkyReport("laptop");
    report.listen(peer.log);
    const crew = new WalkyCrew({ service: peer.service, trust: () => peerStore() });
    const message = signed("wt_aaaaaaaaaaa1", "desk", "laptop/w1:p9");
    await fromLeadOf(crew, "w1:p9", { message, attest: attestFor(message, material("desk").keyPem, CREW.crewId, "laptop") }, "desk");
    await peer.service.deliverer.settled();
    // Its own message is never reported: the lead heard of it when it routed it.
    await peer.service.send({ id: "wt_aaaaaaaaaaa2", to: "laptop/w1:p9", body: "mine", replyTo: null }, { kind: "operator", label: "cli" });
    await peer.service.deliverer.settled();
    expect(report.drain()).toMatchObject([{ id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "delivered" }]);
    expect(report.drain()).toEqual([]);
    const small = new WalkyReport("laptop", 3);
    for (let n = 0; n < 5; n += 1) {
      const id = `wt_${String(n).padStart(12, "b")}`;
      small.note({ session: "main", paneId: "w1:p9", target: "laptop/w1:p9", message: signed(id, "desk", "laptop/w1:p9"), receipt: { id, target: "laptop/w1:p9", state: "delivered", verified: "lead", at: AT, by: "laptop" } });
    }
    expect(small.drain().map((receipt) => receipt.id)).toEqual(["wt_bbbbbbbbbbb2", "wt_bbbbbbbbbbb3", "wt_bbbbbbbbbbb4"]);
    expect(WALKY_REPORT_MAX).toBe(100);
  });

  test("the snapshot sibling reads as receipts; absent or malformed is no report", () => {
    const receipt: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "delivered", verified: "lead", at: AT, by: "laptop" };
    expect(readWalkyReport(wire({ agents: [], walky: { receipts: [receipt, { bad: 1 }] } }), "walky")).toEqual([receipt]);
    expect(readWalkyReport({ agents: [] }, "walky")).toEqual([]);
    expect(readWalkyReport({ walky: "nope" }, "walky")).toEqual([]);
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
});
