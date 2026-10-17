import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";
import type { WalkyReceipt } from "../walky/types.ts";
import { member, neverProxy } from "./fixtures.ts";
import { apiPathFor, crewRouteFor, forwardAuditAction, forwardKind, forwardPaneId } from "./forward.ts";
import { CrewLead } from "./lead.ts";
import type { PeerOutcome } from "./peer-client.ts";
import { CrewRegistry } from "./registry.ts";

// Walky talky's half of the crew wire (CREW_PROTOCOL.md §21): the lead's message to a member is a
// forwardable write on `pane/<id>/walky`, and a member's report rides its `/crew/v1/snapshot` answer
// as the additive-optional sibling `walky: { receipts }`. Absent or malformed is "nothing to report".

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
    expect(forwardAuditAction("pane/w1:p9/walky")).toBe("walky.deliver");
    expect(forwardPaneId("pane/w1%3Ap9/walky")).toBe("w1:p9");
  });
});

describe("the sweep hands a member's walky report to the lead", () => {
  function sweepWith(answer: PeerOutcome<unknown>) {
    const seen: { memberId: string; receipts: readonly WalkyReceipt[] }[] = [];
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({
        sessions: { get: () => undefined },
        self: "desk",
        members: () => [member({ memberId: "laptop" })],
      }),
      snapshot: async () => answer,
      proxy: neverProxy,
      self: { id: "desk", name: "desk" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => NOW,
      onWalkyReceipts: (memberId, receipts) => seen.push({ memberId, receipts }),
    });
    return { l, seen };
  }

  const ok = (value: JsonValue): PeerOutcome<unknown> => ({ ok: true, value, status: 200, member: null, receivedAt: NOW, date: null });

  test("a carried report reaches the lead, its bad entries dropped", async () => {
    const { l, seen } = sweepWith(ok({ ...body, walky: { receipts: [{ ...receipt }, { id: "nope" }] } }));
    await l.sweep();
    expect(seen).toEqual([{ memberId: "laptop", receipts: [receipt] }]);
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
