import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendSpoke } from "../server.ts";
import type { HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HillService, type HillAgentSender, type HillCrewMode } from "./service.ts";
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
}

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "hill-spoke-"));
  roots.push(dir);
  const state: RigState = { clock: 1000, mode: "solo", sent: 0, pushed: 0 };
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
      push: { check: () => "send", send: () => void (state.pushed += 1), clear: () => undefined },
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
    expect(sendSpoke("command", "held")).toBe(true);
    expect(sendSpoke("send", "steered")).toBe(true);
    expect(sendSpoke("send", "refused")).toBe(false);
    expect(sendSpoke("send", "typed_not_submitted")).toBe(false);
    expect(sendSpoke("discard", "discarded")).toBe(false);
    expect(sendSpoke("append", "effective")).toBe(false);
    expect(sendSpoke("prepare", "effective")).toBe(false);
  });
});
