import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WalkyHost, WalkyPane } from "../walky/deliver.ts";
import { WalkyLog } from "../walky/log.ts";
import { RATE_LIMIT } from "../walky/rate.ts";
import { WalkyService } from "../walky/service.ts";
import { spaceOf } from "../walky/space.ts";
import { HillCrewStateFile } from "./crew-state.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HillService } from "./service.ts";
import { HillStore } from "./store.ts";
import { walkyPlace, walkySend } from "./walky.ts";

// C-S1 (review 8): "Tell all sessions now" and the typed answers share no rate bucket, and an answer the
// walky refuses (nothing typed) never closes its Decision as answered. Driven through the real WalkyService
// and the real Hill send, over a fake multiplexer that records what it types.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });
const PANES: WalkyPane[] = Array.from({ length: 24 }, (_, i) => ({
  session: "main",
  paneId: `%${String(i + 1)}`,
  agent: true,
  harness: "agent-x",
  label: `repo#s${String(i + 1)}`,
  state: "idle",
  activeAt: null,
  instance: `i${String(i + 1).padStart(3, "0")}`,
  terminal: true,
  off: false,
  space: SPACE,
}));

function rig() {
  const stateDir = mkdtempSync(join(tmpdir(), "hill-tell-budget-"));
  roots.push(stateDir);
  const typed: { paneId: string; text: string }[] = [];
  const host: WalkyHost = {
    panes: () => PANES,
    send: async (pane, _id, text) => {
      typed.push({ paneId: pane.paneId, text });
      return { outcome: "sent" };
    },
    sendState: () => ({ outcome: "sent" }),
    cancelHeld: () => undefined,
  };
  const walky = new WalkyService({ log: new WalkyLog(join(stateDir, "walky")), host, memberId: null, enabled: () => true, machine: "lodge", keyPem: () => null });
  let w = 0;
  let n = 0;
  const clock = { now: 10_000_000 };
  const mintId = () => `wt_tb${String((w += 1)).padStart(9, "0")}`;
  const hill = new HillService({
    store: new HillStore(null, () => clock.now),
    receipts: memoryHillReceipts(),
    place: walkyPlace(walky, null),
    send: walkySend(walky, { sleep: async () => undefined, mintId }),
    tell: walkySend(walky, { sleep: async () => undefined, mintId, budget: "hill-tell" }),
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "lodge",
    now: () => clock.now,
    mintId: () => `dc_tb${String((n += 1)).padStart(10, "0")}`,
    crewState: new HillCrewStateFile(stateDir, () => undefined, () => clock.now),
  });
  const posts: string[] = [];
  for (const pane of PANES.slice(0, 20)) {
    clock.now += 1;
    const sender = hill.agentSender(pane, walky.addressOf(pane.paneId, pane.instance));
    const posted = hill.post(sender, { requestId: `00000000-0000-4000-8000-${String(posts.length + 1).padStart(12, "0")}`, title: "Ship?", summary: "Green.", options: [{ intent: "yes", label: "Yes" }], recommends: null });
    if (!posted.ok) throw new Error(posted.error);
    posts.push(posted.decision.id);
  }
  return { walky, hill, typed, posts, clock };
}

const rid = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

describe("the tell and the answers keep separate budgets (C-S1)", () => {
  test("a tell of 20, then 11 answers: every answer is typed and closes answered", async () => {
    const r = rig();
    const set = r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    if (!set.ok || set.crewState.at === null) throw new Error("not set");
    expect(await r.hill.tellAll(set.crewState.at, "Pixel 9")).toEqual({ ok: true, told: 20 });
    expect(r.typed).toHaveLength(20);
    r.typed.length = 0;
    for (let i = 0; i < 11; i += 1) {
      const id = r.posts[i]!;
      const outcome = await r.hill.answer({ rid: rid(i + 1), node: `hill/${id}`, intent: "yes", value: { text: null } }, id, "Pixel 9");
      expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok", delivery: "typed" } });
    }
    expect(r.typed).toHaveLength(11);
  });

  test("an answer the walky refuses (its rate bucket is spent) is not typed, and its Decision stays open", async () => {
    const r = rig();
    // The person's own operator messages spend the bucket the answers use.
    for (let i = 0; i < RATE_LIMIT; i += 1) await r.walky.send({ id: `wt_spent${String(i).padStart(6, "0")}`, to: "local/%24", body: "hi", replyTo: null }, { kind: "operator", label: "Pixel 9" });
    r.typed.length = 0;
    const id = r.posts[0]!;
    const outcome = await r.hill.answer({ rid: rid(1), node: `hill/${id}`, intent: "yes", value: { text: null } }, id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "rejected", state: "open", delivery: "none" } });
    expect(r.typed).toEqual([]);
    expect(r.hill.list().open.map((d) => d.id)).toContain(id);
  });

  test("told counts the sessions walky typed into: a second tell in the window reaches what its bucket holds", async () => {
    const r = rig();
    const first = r.hill.setCrewState("away", "Pixel 9", "Pixel 9");
    if (!first.ok || first.crewState.at === null) throw new Error("not set");
    expect(await r.hill.tellAll(first.crewState.at, "Pixel 9")).toEqual({ ok: true, told: 20 });
    r.clock.now += 1000;
    const second = r.hill.setCrewState("quiet", "Pixel 9", "Pixel 9");
    if (!second.ok || second.crewState.at === null) throw new Error("not set");
    expect(await r.hill.tellAll(second.crewState.at, "Pixel 9")).toEqual({ ok: true, told: RATE_LIMIT - 20 });
    expect(r.hill.crewState().told).toBe(RATE_LIMIT - 20);
  });
});
