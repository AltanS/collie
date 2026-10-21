import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";
import type { WalkyReceipt } from "../walky/types.ts";
import { member, neverProxy } from "./fixtures.ts";
import { apiPathFor, crewRouteFor, forwardAuditAction, forwardKind, forwardPaneId, forwardToPeer, type ForwardAuditEntry, type ForwardTransport } from "./forward.ts";
import { CrewLead } from "./lead.ts";
import type { PeerOutcome } from "./peer-client.ts";
import { CrewRegistry, type PeerState } from "./registry.ts";

// Walky talky's half of the crew wire (CREW_PROTOCOL.md §21): the lead's message to a member is a
// forwardable write on `pane/<id>/walky`, and a member's report rides its `/crew/v1/snapshot` answer
// as the additive-optional sibling `walky: { receipts, cursor }`. Absent or malformed is "nothing to
// report". The lead acks the cursor on its next dial of that member (`X-Crew-Walky-Ack`, 2026-10-18).

const NOW = 1_754_000_000_000;

const body = {
  sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 0, working: 0, blocked: 0 }],
  agents: [],
  shellPanes: [],
};

const receipt: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "laptop/w1:p9", state: "delivered", verified: "lead", at: NOW, by: "laptop" };

describe("the lead's message to a member is a forwarded WRITE on `pane/<id>/walky`", () => {
  test("the route is on the allowlist, by pane or `all`, and nothing under it is", () => {
    expect(crewRouteFor("/api/pane/w1:p9/walky")).toBe("pane/w1:p9/walky");
    expect(crewRouteFor("/api/pane/all/walky")).toBe("pane/all/walky");
    expect(crewRouteFor("/api/pane/w1:p9/walky/x")).toBeNull();
    expect(apiPathFor("pane/w1%3Ap9/walky")).toBe("/api/pane/w1%3Ap9/walky");
  });

  test("a write on the write budget, audited on the lead as the member audits it", () => {
    expect(forwardKind("pane/w1:p9/walky")).toBe("write");
    expect(forwardKind("pane/w1:p9/walky", "POST")).toBe("write");
    expect(forwardAuditAction("pane/w1:p9/walky")).toBe("walky.deliver");
    expect(forwardAuditAction("pane/w1:p9/walky", "POST")).toBe("walky.deliver");
    expect(forwardPaneId("pane/w1%3Ap9/walky")).toBe("w1:p9");
  });
});

describe("a phone's read of a member pane's walky list is a forwarded READ on the same route (added 2026-10-18)", () => {
  const LINK = { memberId: "laptop", address: "laptop.example:8787" };
  const STALE: PeerState = { memberId: "laptop", health: "unreachable", lastSeenAt: NOW - 60_000, reason: "connection refused", version: null, conflict: null, preflight: null };

  function dial(answer: PeerOutcome<Response>) {
    const calls: { route: string; params: Record<string, string>; method: string | undefined; budgetMs: number | undefined }[] = [];
    const transport: ForwardTransport = async (_link, route, params, init, budgetMs) => {
      calls.push({ route, params, method: init.method, budgetMs });
      return answer;
    };
    return { transport, calls };
  }

  const list = JSON.stringify({ messages: [{ id: "wt_aaaaaaaaaaa1", receipt: { ...receipt, verified: "origin" } }] });
  const answered = (res: Response): PeerOutcome<Response> => ({ ok: true, value: res, status: res.status, member: "laptop", receivedAt: NOW, date: null });

  test("the GET is a read: no write budget, no audit line, the POST stays the write", () => {
    expect(forwardKind("pane/w1:p9/walky", "GET")).toBe("read");
    expect(forwardAuditAction("pane/w1:p9/walky", "GET")).toBeNull();
    // Only that one route turns on the method: every other route keeps its own kind.
    expect(forwardKind("pane/w1:p9/reply", "GET")).toBe("write");
    expect(forwardKind("pane/w1:p9/chat", "GET")).toBe("read");
  });

  test("it is tried against a member the sweep last saw down, and the member's own list comes back byte for byte", async () => {
    const { transport, calls } = dial(answered(new Response(list, { status: 200, headers: { "content-type": "application/json; charset=utf-8", etag: '"abc"' } })));
    const audit: ForwardAuditEntry[] = [];
    const url = new URL("https://lead.example/api/pane/w1%3Ap9/walky?limit=50&host=laptop&session=main");
    const res = await forwardToPeer(new Request(url), url, { link: LINK, state: STALE, transport, maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES, audit: (entry) => audit.push(entry) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(list);
    // Not masked: the member's own route does not mask a body either, so the tag is the member's.
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(calls).toEqual([{ route: "pane/w1%3Ap9/walky", params: { limit: "50", session: "main" }, method: "GET", budgetMs: undefined }]);
    expect(audit).toEqual([]);
  });

  test("a member that cannot be reached, or that predates the read, is a refusal: the phone draws no card and no mark", async () => {
    const url = new URL("https://lead.example/api/pane/w1%3Ap9/walky?limit=50&host=laptop");
    const down = dial({ ok: false, state: "unreachable", reason: "connection refused", attempted: true, receivedAt: NOW });
    const gone = await forwardToPeer(new Request(url), url, { link: LINK, state: STALE, transport: down.transport, maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES });
    expect(gone.status).toBe(503);
    expect(await gone.json()).toMatchObject({ ok: false, code: "host_unreachable", host: "laptop" });
    // A member without the route answers the crew's own 404, passed on as it is.
    const older = dial(answered(new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } })));
    expect((await forwardToPeer(new Request(url), url, { link: LINK, state: STALE, transport: older.transport, maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES })).status).toBe(404);
  });

  test("the lead's own POST on the route still refuses a member the sweep saw down, before any dial", async () => {
    const { transport, calls } = dial(answered(new Response("{}")));
    const url = new URL("https://lead.example/api/pane/w1%3Ap9/walky?host=laptop");
    const res = await forwardToPeer(new Request(url, { method: "POST", body: "{}" }), url, { link: LINK, state: STALE, transport, maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES });
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("the sweep hands a member's walky report to the lead", () => {
  function sweepWith(answer: PeerOutcome<unknown>, acks: Record<string, string> = {}) {
    const seen: { memberId: string; receipts: readonly WalkyReceipt[]; cursor: string | null }[] = [];
    const dialled: (string | null | undefined)[] = [];
    const swept: (readonly string[])[] = [];
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({
        sessions: { get: () => undefined },
        self: "desk",
        members: () => [member({ memberId: "laptop" })],
      }),
      snapshot: async (_link, _view, _fresh, follow) => {
        dialled.push(follow?.walkyAck);
        return answer;
      },
      proxy: neverProxy,
      self: { id: "desk", name: "desk" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => NOW,
      onWalkyReceipts: (memberId, receipts, cursor) => seen.push({ memberId, receipts, cursor }),
      walkyAck: (memberId) => acks[memberId] ?? null,
      onWalkySwept: (memberIds) => swept.push(memberIds),
    });
    return { l, seen, dialled, swept };
  }

  const ok = (value: JsonValue): PeerOutcome<unknown> => ({ ok: true, value, status: 200, member: null, receivedAt: NOW, date: null });

  test("a carried report reaches the lead with its cursor, its bad entries dropped", async () => {
    const { l, seen } = sweepWith(ok({ ...body, walky: { receipts: [{ ...receipt }, { id: "nope" }], cursor: "0a1b2c3d.3" } }));
    await l.sweep();
    expect(seen).toEqual([{ memberId: "laptop", receipts: [receipt], cursor: "0a1b2c3d.3" }]);
  });

  test("each dial carries the cursor the lead owes that member, and the members that answered are handed on", async () => {
    const { l, dialled, swept } = sweepWith(ok(body), { laptop: "0a1b2c3d.3" });
    await l.sweep();
    expect(dialled).toEqual(["0a1b2c3d.3"]);
    expect(swept).toEqual([["laptop"]]);
    const down = sweepWith({ ok: false, state: "unreachable", reason: "down", receivedAt: NOW });
    await down.l.sweep();
    expect(down.dialled).toEqual([null]);
    expect(down.swept).toEqual([[]]);
  });

  test("an older member, an empty report, a malformed one and a failed dial call nothing", async () => {
    for (const answer of [
      ok(body),
      ok({ ...body, walky: { receipts: [] } }),
      ok({ ...body, walky: "lots" }),
      { ok: false, state: "unreachable", reason: "down", receivedAt: NOW } as const,
    ]) {
      const { l, seen } = sweepWith(answer);
      await l.sweep();
      expect(seen).toEqual([]);
    }
  });
});
