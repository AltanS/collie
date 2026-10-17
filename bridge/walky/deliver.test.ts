import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintIdentity } from "../crew/identity.ts";
import { verifyMessage } from "./canonical.ts";
import { HELD_LIMIT_MS, reasonOf, sendIdOf, type SendResult, type WalkyHost, type WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { RateLimiter } from "./rate.ts";
import { WalkyService, type WalkyServiceDeps } from "./service.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pane(paneId: string, over: Partial<WalkyPane> = {}): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId}`, state: "idle", terminal: true, ...over };
}

class FakeHost implements WalkyHost {
  readonly sends: { pane: string; id: string; text: string }[] = [];
  readonly states = new Map<string, SendResult>();
  readonly cancelled: string[] = [];
  answer: SendResult = { outcome: "sent" };
  constructor(public list: WalkyPane[]) {}
  panes(): readonly WalkyPane[] {
    return this.list;
  }
  async send(target: WalkyPane, sendId: string, text: string): Promise<SendResult> {
    this.sends.push({ pane: target.paneId, id: sendId, text });
    this.states.set(sendId, this.answer);
    return this.answer;
  }
  sendState(sendId: string): SendResult | null {
    return this.states.get(sendId) ?? null;
  }
  cancelHeld(_session: string, _paneId: string, sendId: string): void {
    this.cancelled.push(sendId);
    this.states.set(sendId, { outcome: "cancelled" });
  }
}

interface Rig {
  readonly service: WalkyService;
  readonly host: FakeHost;
  readonly log: WalkyLog;
  clock: number;
}

function rig(panes: WalkyPane[], over: Partial<WalkyServiceDeps> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "walky-deliver-"));
  roots.push(root);
  const state = { clock: 1_786_000_000_000 };
  const log = new WalkyLog(join(root, "walky"), () => state.clock);
  const host = new FakeHost(panes);
  const service = new WalkyService({
    log,
    host,
    memberId: null,
    enabled: () => true,
    machine: "desk",
    keyPem: () => null,
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms;
    },
    ...over,
  });
  return {
    service,
    host,
    log,
    get clock() {
      return state.clock;
    },
    set clock(value) {
      state.clock = value;
    },
  };
}

const operator = { kind: "operator" as const, label: "cli" };
const send = (id: string, to: string, body = "hello") => ({ id, to, body, replyTo: null });

describe("one message to one pane", () => {
  test("is logged and accepted before any key, then typed as the envelope and delivered", async () => {
    const r = rig([pane("w1:p1")]);
    const answer = await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    expect(answer).toMatchObject({ ok: true, receipts: [{ id: "wt_aaaaaaaaaaa1", target: "local/w1:p1", state: "accepted", by: "solo" }] });
    await r.service.deliverer.settled();
    expect(r.host.sends).toEqual([{ pane: "w1:p1", id: sendIdOf("wt_aaaaaaaaaaa1", "local/w1:p1"), text: "[walky-talky wt_aaaaaaaaaaa1] from operator (cli)\nhello" }]);
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "delivered", sendId: sendIdOf("wt_aaaaaaaaaaa1", "local/w1:p1") });
    // Delivered through the screen: the inbox entry is acked.
    expect(r.log.inbox("main", "w1:p1")).toEqual([]);
  });

  test("the same id again returns the stored receipt and types nothing", async () => {
    const r = rig([pane("w1:p1")]);
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    await r.service.deliverer.settled();
    const again = await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    expect(again).toMatchObject({ ok: true, receipts: [{ state: "delivered" }] });
    expect(r.host.sends).toHaveLength(1);
  });

  test("the same id with another text is refused and logs nothing", async () => {
    const r = rig([pane("w1:p1")]);
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    r.clock += 5;
    const other = await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1", "other"), operator);
    expect(other).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "id reused" }] });
  });

  test("a refused send leaves the message in the inbox, with the reason", async () => {
    const r = rig([pane("w1:p1")]);
    r.host.answer = { outcome: "refused", reason: "not_free" };
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    await r.service.deliverer.settled();
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "inbox-only", reason: "dialog open" });
    expect(r.service.inbox("main", "w1:p1", false).map((entry) => entry.id)).toEqual(["wt_aaaaaaaaaaa1"]);
  });

  test("an unknown outcome stays unknown and is never sent again", async () => {
    const r = rig([pane("w1:p1")]);
    r.host.answer = { outcome: "unknown", reason: "no_evidence" };
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    await r.service.deliverer.settled();
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "unknown", reason: "no evidence" });
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    expect(r.host.sends).toHaveLength(1);
  });

  test("a held send that goes out in time is delivered", async () => {
    const r = rig([pane("w1:p1")]);
    r.host.answer = { outcome: "held" };
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    r.host.states.set(sendIdOf("wt_aaaaaaaaaaa1", "local/w1:p1"), { outcome: "effective" });
    await r.service.deliverer.settled();
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts[0]?.state).toBe("delivered");
  });

  test("a send still held after 10 minutes is cancelled, and the message stays in the inbox", async () => {
    const r = rig([pane("w1:p1")]);
    r.host.answer = { outcome: "held" };
    const start = r.clock;
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    await r.service.deliverer.settled();
    expect(r.clock - start).toBeGreaterThanOrEqual(HELD_LIMIT_MS);
    expect(r.host.cancelled).toEqual([sendIdOf("wt_aaaaaaaaaaa1", "local/w1:p1")]);
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "inbox-only", reason: "held past 10 minutes" });
  });

  test("a session with no terminal keeps the inbox and skips the typing", async () => {
    const r = rig([pane("w1:p1", { terminal: false })]);
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    await r.service.deliverer.settled();
    expect(r.host.sends).toEqual([]);
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts[0]).toMatchObject({ state: "inbox-only", reason: "no terminal" });
  });
});

describe("refusals", () => {
  test("a missing pane, a shell pane, an empty body", async () => {
    const r = rig([pane("w1:p1"), pane("w1:p2", { agent: false, harness: null })]);
    expect(await r.service.send(send("wt_aaaaaaaaaaa1", "local/w9:p9"), operator)).toMatchObject({ receipts: [{ state: "refused", reason: "no such pane" }] });
    expect(await r.service.send(send("wt_aaaaaaaaaaa2", "local/w1:p2"), operator)).toMatchObject({ receipts: [{ state: "refused", reason: "not an agent pane" }] });
    expect(await r.service.send(send("wt_aaaaaaaaaaa3", "local/w1:p1", "‎\n"), operator)).toEqual({ ok: false, error: "empty body" });
    expect(r.host.sends).toEqual([]);
  });

  test("COLLIE_WALKY=off refuses `off` and logs nothing", async () => {
    const r = rig([pane("w1:p1")], { enabled: () => false });
    expect(await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator)).toMatchObject({ receipts: [{ state: "refused", reason: "off" }] });
    expect(r.service.status("wt_aaaaaaaaaaa1").receipts).toEqual([]);
  });

  test("the 31st message from one sender in 10 minutes is refused `rate limit`", async () => {
    const r = rig([pane("w1:p1")], { rate: new RateLimiter(2) });
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    await r.service.send(send("wt_aaaaaaaaaaa2", "local/w1:p1"), operator);
    expect(await r.service.send(send("wt_aaaaaaaaaaa3", "local/w1:p1"), operator)).toMatchObject({ receipts: [{ state: "refused", reason: "rate limit" }] });
  });

  test("another member, with no crew seam, is refused `crew routing not built`", async () => {
    const r = rig([pane("w1:p1")], { memberId: "desk" });
    expect(await r.service.send(send("wt_aaaaaaaaaaa1", "laptop/w1:p1"), operator)).toMatchObject({ receipts: [{ state: "refused", reason: "crew routing not built" }] });
    expect(await r.service.send(send("wt_aaaaaaaaaaa2", "laptop/all"), operator)).toMatchObject({ receipts: [{ state: "refused", reason: "crew routing not built" }] });
  });

  test("another member goes through the seam once it is there, accepted first", async () => {
    const seen: string[] = [];
    const r = rig([pane("w1:p1")], {
      memberId: "desk",
      routeRemote: async (message, members) => {
        seen.push(`${message.id} ${members}`);
        return [];
      },
    });
    expect(await r.service.send(send("wt_aaaaaaaaaaa1", "laptop/w1:p1"), operator)).toMatchObject({ receipts: [{ state: "accepted", target: "laptop/w1:p1" }] });
    expect(seen).toEqual(["wt_aaaaaaaaaaa1 laptop"]);
  });
});

describe("fan-out and senders", () => {
  test("`all` reaches every agent pane but the sender, one receipt each", async () => {
    const panes = [pane("w1:p1"), pane("w1:p2"), pane("w1:p3", { agent: false, harness: null }), pane("w1:p4")];
    const r = rig(panes);
    const answer = await r.service.send(send("wt_aaaaaaaaaaa1", "all"), { kind: "agent", pane: panes[0]! });
    expect(answer).toMatchObject({ ok: true, receipts: [{ target: "local/w1:p2" }, { target: "local/w1:p4" }] });
    await r.service.deliverer.settled();
    expect(r.host.sends.map((sent) => sent.pane)).toEqual(["w1:p2", "w1:p4"]);
    expect(r.host.sends[0]!.text.split("\n")[0]).toBe("[walky-talky wt_aaaaaaaaaaa1] from agent local/w1:p1 (agent-x, repo#w1:p1)");
  });

  test("on a crew the message is signed with this member's key", async () => {
    const identity = mintIdentity({ commonName: "collie-desk" });
    const r = rig([pane("w1:p1")], { memberId: "desk", keyPem: () => identity.keyPem });
    await r.service.send(send("wt_aaaaaaaaaaa1", "desk/w1:p1"), operator);
    const message = r.service.status("wt_aaaaaaaaaaa1").message;
    expect(message?.signer).toBe("desk");
    expect(message !== null && verifyMessage(message, identity.certPem)).toBe(true);
  });

  test("`who` lists agent panes only, with machine, harness, label and state", () => {
    const r = rig([pane("w1:p1"), pane("w1:p2", { agent: false, harness: null })]);
    expect(r.service.who()).toEqual([{ address: "local/w1:p1", memberId: "local", machine: "desk", harness: "agent-x", label: "repo#w1:p1", state: "idle" }]);
  });
});

describe("after a restart", () => {
  test("an accepted receipt with no send is left in the inbox; a settled send is read back", async () => {
    const r = rig([pane("w1:p1"), pane("w1:p2")]);
    const slow = new Promise<SendResult>(() => undefined);
    r.host.send = async () => slow;
    await r.service.send(send("wt_aaaaaaaaaaa1", "local/w1:p1"), operator);
    // A fresh service over the same log: the bridge restarted while the first send was out.
    const host = new FakeHost([pane("w1:p1")]);
    host.states.set(sendIdOf("wt_aaaaaaaaaaa1", "local/w1:p1"), { outcome: "sent" });
    const next = new WalkyService({ log: new WalkyLog(join(roots[0]!, "walky"), () => r.clock), host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null });
    expect(next.deliverer.recover()).toBe(1);
    await next.deliverer.settled();
    expect(next.status("wt_aaaaaaaaaaa1").receipts[0]?.state).toBe("delivered");
  });
});

describe("reasons", () => {
  test("in the receipt's words", () => {
    expect(reasonOf({ outcome: "refused", reason: "turn_running" })).toBe("turn running");
    expect(reasonOf({ outcome: "typed_not_submitted", reason: "mismatch" })).toBe("typed, not submitted");
    expect(reasonOf({ outcome: "expired" })).toBe("expired");
  });
});
