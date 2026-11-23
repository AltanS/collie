import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SendResult, WalkyHost, WalkyPane } from "./deliver.ts";
import { WalkyLog } from "./log.ts";
import { RECIPIENT_LOOKUP_MS, WalkyService, type SendAnswer, type WalkySenderRef, type WalkyServiceDeps } from "./service.ts";
import { spaceOf } from "./space.ts";
import { UNANSWERED_WINDOW_MS, type WalkyRecipient, type WalkyTarget, type WalkyUnanswered } from "./types.ts";

// What a send says of its recipient and of a message it leaves unanswered (the pick tests of 2026-11-23): the
// `recipient` and `unanswered` fields of the answer. Fake clock, made-up names, no real sleep.

const ORCHID = spaceOf({ memberId: "local", spaceId: "s1", spaceLabel: "orchid" });
const UNNAMED = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const START = 1_700_000_000_000;
const MINUTE = 60_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pane(paneId: string, over: Partial<WalkyPane> = {}): WalkyPane {
  return { session: "main", paneId, agent: true, harness: "agent-x", label: `repo#${paneId.slice(1)}`, state: "idle", activeAt: null, instance: `i${paneId.slice(1).padStart(3, "0")}`, terminal: true, off: false, space: ORCHID, ...over };
}

const lead = pane("%1");
const second = pane("%2", { name: "tern review", nameBy: "collie" });
const third = pane("%3", { name: "api docs", nameBy: "tab" });
const unnamed = pane("%4");
const bare = pane("%5", { space: UNNAMED });
const bareToo = pane("%6", { space: UNNAMED });

interface Rig {
  readonly service: WalkyService;
  readonly log: WalkyLog;
  clock: number;
  /** An agent's send from `from`, with the clock where it stands. */
  send(from: WalkyPane, to: string, id: string, replyTo?: string): Promise<SendAnswer>;
  /** Advance the fake clock. */
  wait(ms: number): void;
}

function rig(panes: readonly WalkyPane[], over: Partial<WalkyServiceDeps> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "walky-recipient-"));
  roots.push(root);
  const state = { clock: START };
  const log = new WalkyLog(join(root, "walky"), () => state.clock);
  const host: WalkyHost = { panes: () => panes, send: async (): Promise<SendResult> => ({ outcome: "sent" }), sendState: () => ({ outcome: "sent" }), cancelHeld: () => undefined };
  const service = new WalkyService({ log, host, memberId: null, enabled: () => true, machine: "desk", keyPem: () => null, now: () => state.clock, ...over });
  const out: Rig = {
    service,
    log,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
    send: async (from, to, id, replyTo) => {
      const sender: WalkySenderRef = { kind: "agent", pane: from };
      const answer = await service.send({ id, to, body: "hello", replyTo: replyTo ?? null }, sender);
      await service.deliverer.settled();
      return answer;
    },
    wait: (ms) => {
      state.clock += ms;
    },
  };
  return out;
}

/** The answer's `unanswered` field, `undefined` when it carries none. */
function unansweredOf(answer: SendAnswer): WalkyUnanswered | undefined {
  return answer.ok ? answer.unanswered : undefined;
}

function recipientOf(answer: SendAnswer): WalkyRecipient | undefined {
  return answer.ok ? answer.recipient : undefined;
}

describe("the recipient of a send to one address", () => {
  test("a pane of this machine: its NAME, SPACE and MACHINE as `who` lists the row", async () => {
    const r = rig([lead, second, third]);
    const answer = await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1");
    expect(recipientOf(answer)).toEqual({ name: "tern review", space: ORCHID, machine: "desk" });
    // The same values the row of `who` carries.
    const row = r.service.who().find((target) => target.address.startsWith("local/%2"))!;
    expect(recipientOf(answer)).toEqual({ name: row.name, space: row.space, machine: row.machine });
  });

  test("a pane with no NAME has no `name`", async () => {
    const r = rig([lead, unnamed]);
    const answer = await r.send(lead, "local/%4", "wt_aaaaaaaaaaa1");
    expect(recipientOf(answer)).toEqual({ space: ORCHID, machine: "desk" });
    expect(Object.keys(recipientOf(answer) ?? {})).not.toContain("name");
  });

  test("a space with no name of its own is carried as it is, with its `named` flag off", async () => {
    const r = rig([bare, bareToo]);
    expect(recipientOf(await r.send(bare, "local/%6", "wt_aaaaaaaaaaa1"))).toEqual({ space: UNNAMED, machine: "desk" });
  });

  test("an address with the token names the same row", async () => {
    const r = rig([lead, second]);
    const answer = await r.send(lead, "local/%2#i002", "wt_aaaaaaaaaaa1");
    expect(recipientOf(answer)).toMatchObject({ name: "tern review" });
  });

  test("a crew member's pane on a lead: what the lead knows of it", async () => {
    const far: WalkyTarget = { address: "laptop/w9:p1#cccc", memberId: "laptop", machine: "far-desk", harness: "agent-x", label: "repo#far", state: "idle", space: ORCHID, name: "oc lead", nameBy: "collie" };
    const r = rig([lead], {
      memberId: "desk",
      remoteTargets: () => [far],
      knownMembers: () => ["desk", "laptop"],
      routeRemote: async (message, member) => [{ id: message.id, target: `${member}/w9:p1`, state: "accepted", verified: "lead", at: START, by: member }],
    });
    const answer = await r.send(lead, "laptop/w9:p1#cccc", "wt_aaaaaaaaaaa1");
    expect(recipientOf(answer)).toEqual({ name: "oc lead", space: ORCHID, machine: "far-desk" });
  });

  test("on a member, a pane of another machine is looked up in the lead's list", async () => {
    const far: WalkyTarget = { address: "desk/w9:p1#cccc", memberId: "desk", machine: "main-desk", harness: "agent-x", label: "repo#far", state: "idle", space: ORCHID };
    const asked: string[] = [];
    const r = rig([lead], {
      memberId: "laptop",
      outcomesOnLead: true,
      knownMembers: () => ["laptop", "desk"],
      leadTargets: async () => {
        asked.push("lead");
        return [far];
      },
      routeRemote: async (message, member) => [{ id: message.id, target: `${member}/w9:p1`, state: "accepted", verified: "none", at: START, by: "laptop" }],
    });
    const answer = await r.send(lead, "desk/w9:p1#cccc", "wt_aaaaaaaaaaa1");
    expect(recipientOf(answer)).toEqual({ space: ORCHID, machine: "main-desk" });
    expect(asked).toEqual(["lead"]);
    // A pane of this member's own machine is never looked up at the lead.
    await r.send(lead, "local/%1", "wt_aaaaaaaaaaa2");
    expect(asked).toEqual(["lead"]);
  });

  test("on a member, a lead that does not answer, or answers too slowly, leaves the recipient out: the send goes on", async () => {
    const slept: number[] = [];
    const never = rig([lead], {
      memberId: "laptop",
      outcomesOnLead: true,
      knownMembers: () => ["laptop", "desk"],
      leadTargets: () => new Promise(() => undefined),
      // The lookup's bound passes at once; every other wait of the service stays as it was.
      sleep: async (ms) => {
        slept.push(ms);
        if (ms !== RECIPIENT_LOOKUP_MS) await new Promise(() => undefined);
      },
      routeRemote: async (message, member) => [{ id: message.id, target: `${member}/w9:p1`, state: "accepted", verified: "none", at: START, by: "laptop" }],
    });
    const slow = await never.send(lead, "desk/w9:p1#cccc", "wt_aaaaaaaaaaa1");
    expect(slow.ok && slow.receipts[0]?.state).toBe("accepted");
    expect(recipientOf(slow)).toBeUndefined();
    expect(slept).toContain(RECIPIENT_LOOKUP_MS);
    const failing = rig([lead], {
      memberId: "laptop",
      outcomesOnLead: true,
      knownMembers: () => ["laptop", "desk"],
      leadTargets: async () => null,
      routeRemote: async (message, member) => [{ id: message.id, target: `${member}/w9:p1`, state: "accepted", verified: "none", at: START, by: "laptop" }],
    });
    expect(recipientOf(await failing.send(lead, "desk/w9:p1#cccc", "wt_aaaaaaaaaaa2"))).toBeUndefined();
  });

  test("none for `here`, a folder, `all` and a reply, and none in a refusal", async () => {
    const r = rig([lead, second, third]);
    expect(recipientOf(await r.send(lead, "here", "wt_aaaaaaaaaaa1"))).toBeUndefined();
    expect(recipientOf(await r.send(lead, "repo", "wt_aaaaaaaaaaa2"))).toBeUndefined();
    // A reply goes to the sender of what it answers, and carries no recipient.
    await r.send(third, "local/%1", "wt_aaaaaaaaaaa3");
    expect(recipientOf(await r.send(lead, "local/%3", "wt_aaaaaaaaaaa4", "wt_aaaaaaaaaaa3"))).toBeUndefined();
    // A send to the own pane is refused, so nobody got it.
    const refused = await r.send(lead, "local/%1", "wt_aaaaaaaaaaa5");
    expect(refused.ok && refused.receipts[0]?.state).toBe("refused");
    expect(recipientOf(refused)).toBeUndefined();
    expect(unansweredOf(refused)).toBeUndefined();
  });

  test("an operator's send carries neither field", async () => {
    const r = rig([lead, second]);
    const answer = await r.service.send({ id: "wt_aaaaaaaaaaa1", to: "local/%2", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    expect(recipientOf(answer)).toBeUndefined();
    expect(unansweredOf(answer)).toBeUndefined();
  });
});

describe("a message from another session that is not answered", () => {
  test("is named when the sender writes to someone else: its id and the sender's NAME", async () => {
    const r = rig([lead, second, third]);
    await r.send(third, "local/%1", "wt_cccccccccccc");
    r.wait(MINUTE);
    const answer = await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1");
    expect(unansweredOf(answer)).toEqual({ id: "wt_cccccccccccc", from: "api docs" });
    // The send itself went as asked.
    expect(r.log.get("wt_aaaaaaaaaaa1", "local/%2")?.receipt.state).toBe("delivered");
  });

  test("names the sender's address when it has no NAME", async () => {
    const r = rig([lead, second, unnamed]);
    await r.send(unnamed, "local/%1", "wt_dddddddddddd");
    const answer = await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1");
    expect(unansweredOf(answer)).toEqual({ id: "wt_dddddddddddd", from: "local/%4#i004" });
  });

  test("is the newest one, and only one", async () => {
    const r = rig([lead, second, third, unnamed]);
    await r.send(third, "local/%1", "wt_cccccccccccc");
    r.wait(MINUTE);
    await r.send(unnamed, "local/%1", "wt_dddddddddddd");
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1"))).toMatchObject({ id: "wt_dddddddddddd" });
  });

  test("is absent when the recipient IS that message's sender, and the next older one from another session is named", async () => {
    const r = rig([lead, second, third]);
    await r.send(third, "local/%1", "wt_cccccccccccc");
    expect(unansweredOf(await r.send(lead, "local/%3", "wt_aaaaaaaaaaa1"))).toBeUndefined();
    expect(unansweredOf(await r.send(lead, "local/%3#i003", "wt_aaaaaaaaaaa2"))).toBeUndefined();
    r.wait(MINUTE);
    await r.send(second, "local/%1", "wt_bbbbbbbbbbbb");
    // The newest is from the recipient: the older one from another session is the one named.
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa3"))).toEqual({ id: "wt_cccccccccccc", from: "api docs" });
  });

  test("is absent after a `reply` to it", async () => {
    const r = rig([lead, second, third]);
    await r.send(third, "local/%1", "wt_cccccccccccc");
    await r.send(lead, "local/%3", "wt_aaaaaaaaaaa1", "wt_cccccccccccc");
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa2"))).toBeUndefined();
  });

  test("is absent after 10 minutes, and present just inside them", async () => {
    const r = rig([lead, second, third]);
    await r.send(third, "local/%1", "wt_cccccccccccc");
    r.wait(UNANSWERED_WINDOW_MS);
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1"))).toMatchObject({ id: "wt_cccccccccccc" });
    r.wait(1);
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa2"))).toBeUndefined();
  });

  test("is absent for an operator's message, and for a message to another pane", async () => {
    const r = rig([lead, second, third]);
    await r.service.send({ id: "wt_oooooooooooo", to: "local/%1", body: "hi", replyTo: null }, { kind: "operator", label: "phone" });
    await r.service.deliverer.settled();
    await r.send(third, "local/%2", "wt_cccccccccccc");
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1"))).toBeUndefined();
  });

  test("is absent for `here`, a folder and a reply, which carry neither line", async () => {
    const r = rig([lead, second, third]);
    await r.send(third, "local/%1", "wt_cccccccccccc");
    expect(unansweredOf(await r.send(lead, "here", "wt_aaaaaaaaaaa1"))).toBeUndefined();
    expect(unansweredOf(await r.send(lead, "local/%2", "wt_aaaaaaaaaaa2", "wt_cccccccccccc"))).toBeUndefined();
  });

  test("never carries a word of the body or the subject", async () => {
    const r = rig([lead, second, third]);
    await r.service.send({ id: "wt_cccccccccccc", to: "local/%1", body: "the secret plan", replyTo: null, subject: "the subject words" }, { kind: "agent", pane: third });
    await r.service.deliverer.settled();
    const answer = await r.send(lead, "local/%2", "wt_aaaaaaaaaaa1");
    expect(JSON.stringify(unansweredOf(answer))).not.toMatch(/secret|subject/u);
  });
});
