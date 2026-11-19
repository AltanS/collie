import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { hillSpokenClearRoute, sendSpoke, sendStartedTurn, sessionWaited } from "../server.ts";
import type { HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HILL_ANSWERED_IN_SESSION, HillService, NOT_ON_LEAD, type HillAgentSender, type HillCrewMode } from "./service.ts";
import { hillDir, HillStore } from "./store.ts";

// The quiet mark (1.29.0): a phone send that reached an agent's session marks the open Decisions that
// session posted before it, `spokeAfter`. The card stays open; nothing is typed and nothing pushes.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ONE: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "lodge" };
const TWO: HillAgentSender = { kind: "agent", address: "local/%2#bbbb", memberId: null, harness: "agent-y", label: "repo#two", host: "lodge" };

function input(n: number): HillPostInput {
  return { requestId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: "Ship?", summary: "Green.", options: [{ intent: "yes", label: "Yes" }], recommends: null };
}

/** What a test moves and reads around the service. */
interface RigState {
  clock: number;
  mode: HillCrewMode;
  sent: number;
  pushed: number;
  cleared: string[];
  audit: AuditEntry[];
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "hill-spoke-"));
  roots.push(dir);
  const state: RigState = { clock: 1000, mode: "solo", sent: 0, pushed: 0, cleared: [], audit: [] };
  let n = 0;
  const make = () =>
    new HillService({
      store: new HillStore(hillDir(dir), () => state.clock),
      receipts: memoryHillReceipts(),
      place: (address) => ({ address, label: "repo", host: "lodge", unattended: false }),
      send: async () => {
        state.sent += 1;
        return "typed";
      },
      crewMode: () => state.mode,
      walkyOn: () => true,
      memberId: "m_aaaaaaaaaa",
      machine: "lodge",
      now: () => state.clock,
      mintId: () => `dc_spoke${String((n += 1)).padStart(7, "0")}`,
      push: { check: () => "send", send: () => void (state.pushed += 1), clear: (tag) => void state.cleared.push(tag) },
      audit: (entry) => state.audit.push(entry),
    });
  return { state, hill: make(), again: make };
}

describe("the quiet mark", () => {
  test("marks the open cards of exactly that session posted before the send, once, and keeps them open", () => {
    const r = rig();
    const first = r.hill.post(ONE, input(1));
    const other = r.hill.post(TWO, input(2));
    if (!first.ok || !other.ok) throw new Error("not posted");
    r.state.clock = 5000;
    const rev = r.hill.rev();
    expect(r.hill.noteSpoke("local/%1#aaaa")).toBe(1);
    expect(r.hill.rev()).not.toBe(rev);
    const open = r.hill.list().open;
    expect(open.find((d) => d.id === first.decision.id)).toMatchObject({ state: "open", spokeAfter: 5000 });
    expect(open.find((d) => d.id === other.decision.id)?.spokeAfter).toBeUndefined();
    // Again: the first time stays; a card posted after the send is fresh.
    r.state.clock = 6000;
    const later = r.hill.post(ONE, input(3));
    expect(r.hill.noteSpoke("local/%1#aaaa", 6000)).toBe(0);
    expect(r.hill.list().open.find((d) => d.id === first.decision.id)?.spokeAfter).toBe(5000);
    expect(later.ok && r.hill.list().open.find((d) => d.id === later.decision.id)?.spokeAfter).toBeUndefined();
    // A session with the same pane but another instance token is another session.
    expect(r.hill.noteSpoke("local/%1#zzzz", 7000)).toBe(0);
    expect(r.state.sent).toBe(0);
  });

  test("the mark is kept across a restart, and a member marks nothing", () => {
    const r = rig();
    const posted = r.hill.post(ONE, input(1));
    if (!posted.ok) throw new Error("not posted");
    r.state.clock = 4000;
    r.hill.noteSpoke(ONE.address);
    expect(r.again().list().open[0]?.spokeAfter).toBe(4000);
    r.state.mode = "peer";
    const member = r.again();
    expect(member.noteSpoke(TWO.address, 9000)).toBe(0);
  });

  test("only a send that put words into the session counts", () => {
    expect(sendSpoke("send", "effective")).toBe(true);
    expect(sendSpoke("submit", "sent")).toBe(true);
    expect(sendSpoke("send", "steered")).toBe(true);
    // C-N1 (review 8): a held send may still be cancelled or expire, and a command (`/compact`) is no
    // answer to the session's question; neither marks a card.
    expect(sendSpoke("send", "held")).toBe(false);
    expect(sendSpoke("command", "effective")).toBe(false);
    expect(sendSpoke("send", "refused")).toBe(false);
    expect(sendSpoke("send", "typed_not_submitted")).toBe(false);
    expect(sendSpoke("discard", "discarded")).toBe(false);
    expect(sendSpoke("append", "effective")).toBe(false);
    expect(sendSpoke("prepare", "effective")).toBe(false);
  });
});

describe("Clear cards you answered in the session", () => {
  test("withdraws and clears every open card with the mark, types nothing, and leaves the rest", () => {
    const r = rig();
    const spoken = r.hill.post(ONE, input(1));
    const fresh = r.hill.post(TWO, input(2));
    const closed = r.hill.post(TWO, input(3));
    if (!spoken.ok || !fresh.ok || !closed.ok) throw new Error("not posted");
    r.hill.withdraw(TWO, closed.decision.id);
    r.state.clock = 5000;
    r.hill.noteSpoke(ONE.address);
    expect(r.hill.clearSpoken("Pixel 9")).toEqual({ ok: true, cleared: 1 });
    // Nothing typed into any session: the person already answered there.
    expect(r.state.sent).toBe(0);
    const list = r.hill.list();
    expect(list.open.map((d) => d.id)).toEqual([fresh.decision.id]);
    expect(list.closed.map((d) => d.id)).toEqual([closed.decision.id]);
    expect(r.hill.clearedState(spoken.decision.id)).toBe("withdrawn");
    expect(r.state.audit).toContainEqual({ action: "hill.clear.spoken", device: "Pixel 9", detail: { count: 1 } });
    // The poster reads it as withdrawn, with the reason.
    expect(r.state.audit.filter((entry) => entry.action === "hill.clear")).toHaveLength(1);
    expect(HILL_ANSWERED_IN_SESSION).toBe("your person wrote in the session");
    expect(r.hill.clearSpoken()).toEqual({ ok: true, cleared: 0 });
  });

  test("a member holds no Hill and refuses; the route takes only {} and answers the count", async () => {
    const r = rig();
    const posted = r.hill.post(ONE, input(1));
    if (!posted.ok) throw new Error("not posted");
    r.state.clock = 5000;
    r.hill.noteSpoke(ONE.address);
    expect(hillSpokenClearRoute(r.hill, { all: true }, { device: "Pixel 9", acceptEncoding: null }).status).toBe(400);
    r.state.mode = "peer";
    expect(r.hill.clearSpoken()).toEqual({ ok: false, error: NOT_ON_LEAD, notLead: true });
    expect(hillSpokenClearRoute(r.hill, {}, { device: "Pixel 9", acceptEncoding: null }).status).toBe(409);
    r.state.mode = "solo";
    expect(await hillSpokenClearRoute(r.hill, {}, { device: "Pixel 9", acceptEncoding: null }).json()).toEqual({ cleared: 1 });
    expect(r.state.sent).toBe(0);
  });

  test("with ids it clears only the cards the phone showed: one marked after the menu opened stays open (C-N5)", async () => {
    const r = rig();
    const shown = r.hill.post(ONE, input(1));
    const later = r.hill.post(TWO, input(2));
    if (!shown.ok || !later.ok) throw new Error("not posted");
    r.state.clock = 5000;
    r.hill.noteSpoke(ONE.address);
    // The phone opened the menu with one marked card; then the person wrote to the second session.
    r.state.clock = 6000;
    r.hill.noteSpoke(TWO.address);
    const answer = hillSpokenClearRoute(r.hill, { ids: [shown.decision.id] }, { device: "Pixel 9", acceptEncoding: null });
    expect(await answer.json()).toEqual({ cleared: 1 });
    expect(r.hill.list().open.map((d) => d.id)).toEqual([later.decision.id]);
    expect(hillSpokenClearRoute(r.hill, { ids: ["nope"] }, { device: "Pixel 9", acceptEncoding: null }).status).toBe(400);
  });
});

describe("a message that started the session's next turn (M96 spec 10)", () => {
  test("closes that session's open cards `withdrawn`, the person wrote in the session, and types nothing", () => {
    const r = rig();
    const asked = r.hill.post(ONE, input(1));
    const other = r.hill.post(TWO, input(2));
    if (!asked.ok || !other.ok) throw new Error("not posted");
    r.state.clock = 5000;
    r.state.audit.length = 0;
    expect(r.hill.noteSpoke(ONE.address, 5000, true)).toBe(1);
    const closed = r.hill.list().closed.find((d) => d.id === asked.decision.id);
    expect(closed).toMatchObject({ state: "withdrawn", closedAt: 5000, closedReason: HILL_ANSWERED_IN_SESSION });
    expect(r.hill.list().open.map((d) => d.id)).toEqual([other.decision.id]);
    expect(r.state.sent).toBe(0);
    expect(r.state.audit).toContainEqual({ action: "hill.spoke.closed", detail: { count: 1 } });
  });

  test("the closed card is the person's: the self-clear leaves it under Answered, and the first Clear removes it", () => {
    const r = rig();
    const asked = r.hill.post(ONE, input(1));
    const taken = r.hill.post(TWO, input(2));
    if (!asked.ok || !taken.ok) throw new Error("not posted");
    r.state.clock = 5000;
    r.hill.noteSpoke(ONE.address, 5000, true);
    // Beside it, a card its poster took back: that one leaves by itself.
    r.hill.withdraw(TWO, taken.decision.id);
    r.state.audit.length = 0;
    for (const at of [5000 + 60_000, 5000 + 10 * 60_000]) {
      r.state.clock = at;
      r.hill.sweep(at);
      const closed = r.hill.list().closed;
      expect(closed.map((d) => d.id)).toEqual([asked.decision.id]);
      expect(closed[0]).toMatchObject({ title: "Ship?", summary: "Green.", state: "withdrawn", closedReason: HILL_ANSWERED_IN_SESSION });
    }
    expect(r.hill.clearedState(taken.decision.id)).toBe("withdrawn");
    expect(r.state.audit.filter((entry) => entry.action === "hill.clear.self")).toEqual([{ action: "hill.clear.self", detail: { count: 1 } }]);
    // A restart reads it the same, and the first Clear takes it like any closed card.
    const again = r.again();
    again.sweep(5000 + 10 * 60_000);
    expect(again.list().closed.map((d) => d.id)).toEqual([asked.decision.id]);
    expect(again.clear(null)?.cleared).toEqual([asked.decision.id]);
    expect(again.list().closed.filter((d) => d.id === asked.decision.id)).toEqual([]);
    expect(again.clearedState(asked.decision.id)).toBe("withdrawn");
    expect(r.state.sent).toBe(0);
  });

  test("a card posted after the send, and one whose answer goes to another session, stay open", () => {
    const r = rig();
    const routed = r.hill.post(ONE, { ...input(1), replyTo: TWO.address });
    if (!routed.ok) throw new Error("not posted");
    r.state.clock = 5000;
    const later = r.hill.post(ONE, input(2));
    if (!later.ok) throw new Error("not posted");
    // The send happened at 4000, before the second card.
    expect(r.hill.noteSpoke(ONE.address, 4000, true)).toBe(1);
    const open = r.hill.list().open;
    // The routed one takes the quiet mark only: its answer would start a turn in TWO, not in ONE.
    expect(open.find((d) => d.id === routed.decision.id)).toMatchObject({ state: "open", spokeAfter: 4000 });
    expect(open.find((d) => d.id === later.decision.id)?.spokeAfter).toBeUndefined();
  });

  test("a steer (not started) keeps today's mark, and the second Clear still takes it", () => {
    const r = rig();
    const asked = r.hill.post(ONE, input(1));
    if (!asked.ok) throw new Error("not posted");
    r.state.clock = 5000;
    expect(r.hill.noteSpoke(ONE.address, 5000, false)).toBe(1);
    expect(r.hill.list().open[0]).toMatchObject({ state: "open", spokeAfter: 5000 });
    expect(r.hill.clearSpoken()).toEqual({ ok: true, cleared: 1 });
  });

  test("a card whose answer is running is left to that answer", async () => {
    const r = rig();
    const asked = r.hill.post(ONE, input(1));
    if (!asked.ok) throw new Error("not posted");
    r.state.clock = 5000;
    // The answer's claim is in flight: its receipt write has not settled yet.
    const answering = r.hill.answer({ rid: "00000000-0000-4000-8000-000000000999", node: `hill/${asked.decision.id}`, intent: "yes", value: { text: null } }, asked.decision.id, "Pixel 9");
    expect(r.hill.noteSpoke(ONE.address, 5000, true)).toBe(0);
    const outcome = await answering;
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok", state: "answered" } });
    expect(r.state.sent).toBe(1);
  });

  test("a member closes nothing", () => {
    const r = rig();
    const asked = r.hill.post(ONE, input(1));
    if (!asked.ok) throw new Error("not posted");
    r.state.mode = "peer";
    expect(r.again().noteSpoke(ONE.address, 9000, true)).toBe(0);
  });

  test("only a send that started the next turn counts: not a steer, not one queued behind a turn, not one into a session that was not waiting", () => {
    expect(sendStartedTurn("send", "effective", { queued: false, waited: true })).toBe(true);
    expect(sendStartedTurn("submit", "sent", { queued: false, waited: true })).toBe(true);
    expect(sendStartedTurn("send", "steered", { queued: false, waited: true })).toBe(false);
    expect(sendStartedTurn("send", "sent", { queued: true, waited: true })).toBe(false);
    expect(sendStartedTurn("send", "effective", { queued: true, waited: true })).toBe(false);
    expect(sendStartedTurn("send", "sent", { queued: false, waited: false })).toBe(false);
    expect(sendStartedTurn("send", "held", { queued: false, waited: true })).toBe(false);
    expect(sendStartedTurn("command", "effective", { queued: false, waited: true })).toBe(false);
  });

  test("a session that stopped on an error waits for the person like an idle one; a question does not (PR 787)", () => {
    expect(sessionWaited({ status: "blocked", blockedBy: "error" })).toBe(true);
    expect(sessionWaited({ status: "idle" })).toBe(true);
    expect(sessionWaited({ status: "done" })).toBe(true);
    expect(sessionWaited({ status: "blocked" })).toBe(false);
    expect(sessionWaited({ status: "working" })).toBe(false);
    expect(sessionWaited(undefined)).toBe(false);
  });

  test("a close rests on the bridge's last read of the session, not on a read at the send (follow-up)", () => {
    // KNOWN LIMIT: `waited` is the state engine's last poll, which may be seconds old, or a stored word from
    // a plugin that no longer runs. Nothing here reads the session again at the send; the follow-up spec
    // brings the Send Protocol's own first read (screen path) and the plugin's answer (data path). Until
    // then a send into a session whose last read said idle closes its cards, however old that read is.
    expect(sendStartedTurn("send", "sent", { queued: false, waited: true })).toBe(true);
  });
});
