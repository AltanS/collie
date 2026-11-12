// A pane's address survives a new conversation in it (review 12, after M1). The walky instance token is
// the suffix of a WalkyTalky address (`<member>/<pane>#<token>`): the inbox, the per-session off flag, a
// held send, a reply's pin and the name lookup (`who`, and the phone's) are all keyed on it. It changes only when the
// pane is out of sight for longer than the grace (instances.ts). A `/clear`, a resume or a restart of
// the agent program in the same open pane is the same pane, so the address and everything keyed on it
// stay. These tests run the REAL registry (WalkyInstances) wired as bridge/index.ts wires it (stamp, the
// 10 s observe, onDrop to the inbox and the off store) and the real deliver path (WalkyService).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendIdOf, type SendResult, type WalkyHost, type WalkyPane } from "./deliver.ts";
import { INSTANCE_TICK_MS, WalkyInstances } from "./instances.ts";
import { WalkyLog } from "./log.ts";
import { WalkyOff } from "./off.ts";
import { WalkyService } from "./service.ts";
import { spaceOf } from "./space.ts";
import { WALKY_OFF } from "./types.ts";

const SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A pane as the multiplexer lists it, before the registry stamps it; `conversation` is the agent session id the bridge reads for it. */
interface RawPane extends Omit<WalkyPane, "instance" | "off"> {
  conversation: string | null;
}

function raw(paneId: string, conversation: string): RawPane {
  return { session: "main", paneId, agent: true, harness: "claude", label: `repo#${paneId}`, state: "idle", activeAt: null, terminal: true, space: SPACE, conversation };
}

/** The bridge's walky host: every list stamped by the registry, the off flag read through the row (index.ts `walkyHost`). */
class Desk implements WalkyHost {
  readonly states = new Map<string, SendResult>();
  readonly typed: string[] = [];
  answer: (paneId: string) => SendResult = () => ({ outcome: "sent" });
  constructor(
    public list: RawPane[],
    private readonly instances: WalkyInstances,
    private readonly off: WalkyOff,
  ) {}
  panes(): readonly WalkyPane[] {
    const bare = this.list.map(({ conversation: _conversation, ...pane }) => pane);
    return this.instances.stamp(bare).map((pane) => Object.assign(pane, { off: this.off.isOff(pane) }));
  }
  async send(target: WalkyPane, sendId: string): Promise<SendResult> {
    this.typed.push(sendId);
    const result = this.answer(target.paneId);
    this.states.set(sendId, result);
    return result;
  }
  sendState(sendId: string): SendResult | null {
    return this.states.get(sendId) ?? null;
  }
  cancelHeld(_session: string, _paneId: string, sendId: string): void {
    this.states.set(sendId, { outcome: "cancelled" });
  }
}

function bridge() {
  const root = mkdtempSync(join(tmpdir(), "walky-survives-"));
  roots.push(root);
  const clock = { now: 1_786_000_000_000 };
  const dir = join(root, "walky");
  const instances = new WalkyInstances(dir, () => clock.now);
  const log = new WalkyLog(dir, () => clock.now);
  const off = new WalkyOff(dir, () => clock.now);
  // As index.ts: a token that goes takes its inbox and its off row with it.
  instances.onDrop((session, paneId, token) => log.inboxDrop(session, paneId, token));
  instances.onDrop((session, paneId, token) => off.drop(session, paneId, token));
  const desk = new Desk([raw("w1:p1", "s1"), raw("w1:p2", "t1"), raw("w1:p3", "u1")], instances, off);
  // The deliverer's waits stand still until the test lets the clock run: a held send then waits through the
  // change of conversation in real order, not past its 60 minutes in one go.
  const waiting: (() => void)[] = [];
  let running = false;
  const run = (): void => {
    running = true;
    for (const go of waiting.splice(0)) go();
  };
  const service = new WalkyService({
    log,
    host: desk,
    memberId: null,
    enabled: () => true,
    machine: "desk",
    keyPem: () => null,
    now: () => clock.now,
    sleep: async (ms) => {
      if (!running) await new Promise<void>((resolve) => waiting.push(resolve));
      clock.now += ms;
    },
  });
  /** The bridge's 10 s look at its panes (index.ts `walkyInstanceTimer`), `n` times. */
  const ticks = (n: number): void => {
    for (let i = 0; i < n; i++) {
      clock.now += INSTANCE_TICK_MS;
      instances.observe(desk.panes());
    }
  };
  const at = (paneId: string): WalkyPane => {
    const found = desk.panes().find((pane) => pane.paneId === paneId);
    if (found === undefined) throw new Error(`no pane ${paneId}`);
    return found;
  };
  return { desk, service, log, off, ticks, at, run };
}

type Change = (desk: Desk, ticks: (n: number) => void) => void;

/** The list with every pane but p2 (the peer, which stays as it is) changed as `patch` says. */
function changed(list: readonly RawPane[], patch: Partial<RawPane>): RawPane[] {
  const out: RawPane[] = [];
  for (const pane of list) out.push(pane.paneId === "w1:p2" ? pane : Object.assign({}, pane, patch));
  return out;
}

/** What each new conversation does to the pane as the bridge reads it. */
const CHANGES: [string, Change][] = [
  [
    "a /clear (a new agent session id)",
    (desk, ticks) => {
      desk.list = changed(desk.list, { conversation: "cleared-new-id" });
      ticks(1);
    },
  ],
  [
    "a resume (another agent session id)",
    (desk, ticks) => {
      desk.list = changed(desk.list, { conversation: "resumed-older-id", state: "working" });
      ticks(1);
      desk.list = changed(desk.list, { state: "idle" });
    },
  ],
  [
    "a restart of the same agent program in the same pane",
    (desk, ticks) => {
      // The program exits: the pane is a shell for two looks, no session id. Then it starts again with a new one.
      const before = desk.list;
      desk.list = changed(before, { agent: false, harness: null, conversation: null });
      ticks(2);
      desk.list = changed(before, { conversation: "restarted" });
      ticks(1);
    },
  ],
];

const agentIn = (pane: WalkyPane) => ({ kind: "agent" as const, pane });
const operator = { kind: "operator" as const, label: "cli" };

describe("walky survives a new conversation in the same pane", () => {
  for (const [what, change] of CHANGES) {
    test(`walky survives ${what}: a held send, a reply pin, the off flag, the inbox and the name lookup`, async () => {
      const b = bridge();
      b.ticks(1);
      const before = b.at("w1:p1");
      const address = `local/w1:p1#${before.instance}`;
      // The operator's message to p1 is typed and held by a draft; p1 asks p2; p2 sends p1 a message that
      // waits in p1's inbox, unread.
      b.desk.answer = (paneId) => (paneId === "w1:p1" ? { outcome: "held", reason: "draft_present" } : { outcome: "sent" });
      await b.service.send({ id: "wt_aaaaaaaaaaa3", to: address, body: "held", replyTo: null }, operator);
      const held = sendIdOf("wt_aaaaaaaaaaa3", "local/w1:p1");
      expect(b.desk.typed).toEqual([held]);
      expect(await b.service.send({ id: "wt_aaaaaaaaaaa1", to: "local/w1:p2", body: "question?", replyTo: null }, agentIn(before))).toMatchObject({ ok: true });
      expect(await b.service.send({ id: "wt_aaaaaaaaaaa2", to: address, body: "unread", replyTo: null }, agentIn(b.at("w1:p2")))).toMatchObject({ ok: true });
      // p3 turned its walky talky off.
      b.off.set(b.at("w1:p3"), true, "session");
      const offAddress = `local/w1:p3#${b.at("w1:p3").instance}`;

      change(b.desk, b.ticks);
      // Past the grace, as the bridge keeps looking.
      b.ticks(4);

      const after = b.at("w1:p1");
      expect(after.instance).toBe(before.instance);
      // 1. The held send: the release finds the same instance, and the send is delivered.
      expect(b.service.deliverer.stillMeant(held, "main", "w1:p1")).toBe(true);
      b.desk.states.set(held, { outcome: "effective" });
      b.run();
      await b.service.deliverer.settled();
      expect(b.service.status("wt_aaaaaaaaaaa3").receipts[0]).toMatchObject({ state: "delivered" });
      // 2. The reply pin: p2's answer to p1's question reaches p1.
      b.desk.answer = () => ({ outcome: "sent" });
      const reply = await b.service.send({ id: "wt_aaaaaaaaaaa4", to: null, body: "answer", replyTo: "wt_aaaaaaaaaaa1" }, agentIn(b.at("w1:p2")));
      expect(reply).toMatchObject({ ok: true, receipts: [{ target: "local/w1:p1" }] });
      await b.service.deliverer.settled();
      expect(b.service.status("wt_aaaaaaaaaaa4").receipts[0]?.state).toBe("delivered");
      // 3. The off flag: p3 is still off, and an agent's message to it is refused.
      expect(b.at("w1:p3").off).toBe(true);
      expect(await b.service.send({ id: "wt_aaaaaaaaaaa5", to: offAddress, body: "hi", replyTo: null }, agentIn(b.at("w1:p2")))).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: WALKY_OFF }] });
      // 4. The inbox: p1's unread message is still there.
      expect(b.log.inbox("main", "w1:p1", after.instance).map((message) => message.id)).toContain("wt_aaaaaaaaaaa2");
      // 5. The name lookup (`collie walky who`): the address a peer learned before still names the pane.
      expect(b.service.who().find((target) => target.address === address)).toMatchObject({ label: "repo#w1:p1", harness: "claude" });
    });
  }
});
