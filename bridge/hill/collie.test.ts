import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HillCollieRef, HillDecision, HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { readDecision } from "./parse.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HILL_ANSWER_RUNNING, HILL_NO_ANSWER_HANDLER, HillService, type HillAgentSender, type HillCollieSender, type HillCollieVerdict, type HillPostAnswer } from "./service.ts";
import { HillStore } from "./store.ts";

// COLLIE'S OWN DECISION (crew slice 3): kind `collie`, minted only by bridge code. Its answer types
// nothing and taps nothing: it runs `onCollieAnswer` with the ref, which acts on exactly that hash.

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const REF: HillCollieRef = { type: "version", id: "legs", hash: "a".repeat(64) };
const SENDER: HillCollieSender = { kind: "collie", ref: REF, label: "Browser leg" };
const POSTER: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "agent-x", label: "repo#one", host: "desk" };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Rig {
  readonly hill: HillService;
  readonly store: HillStore;
  readonly sent: string[];
  readonly calls: { ref: HillCollieRef; intent: string }[];
  verdict: HillCollieVerdict | "throw";
  walky: boolean;
  /** Runs while the handler waits, before it answers: a sync of the version card, say. */
  during?: () => void;
}

function rig(dir: string | null = null, handler = true): Rig {
  let n = 0;
  const store = new HillStore(dir, () => 1000);
  const state: Omit<Rig, "hill" | "store"> = { sent: [], calls: [], verdict: { ok: true }, walky: true };
  const onCollieAnswer = async (ref: HillCollieRef, intent: string): Promise<HillCollieVerdict> => {
    state.calls.push({ ref, intent });
    state.during?.();
    if (state.verdict === "throw") throw new Error("copy failed");
    return state.verdict;
  };
  const deps: ConstructorParameters<typeof HillService>[0] = {
    store,
    receipts: memoryHillReceipts(),
    place: (address) => (address.startsWith("local/%1") ? { address: "local/%1#aaaa", label: "repo#one", host: "desk", unattended: false } : null),
    send: async (_to, body) => {
      state.sent.push(body);
      return "typed";
    },
    crewMode: () => "solo",
    walkyOn: () => state.walky,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => 1000,
    mintId: () => `dc_col${String((n += 1)).padStart(9, "0")}`,
  };
  const hill = new HillService(handler ? { ...deps, onCollieAnswer } : deps);
  return Object.assign(state, { hill, store });
}

function card(n: number, over: Partial<HillPostInput> = {}): HillPostInput {
  return {
    requestId: uuid(n),
    title: "Use the new version of Browser leg?",
    summary: "It runs the new code from now on. 3 files changed. It asks for no new rights.",
    options: [
      { intent: "use", label: "Use the new version" },
      { intent: "keep", label: "Keep the old version" },
    ],
    text: "none",
    ...over,
  };
}

function posted(answer: HillPostAnswer): HillDecision {
  if (!answer.ok) throw new Error(`refused: ${answer.code ?? "-"} ${answer.error}`);
  return answer.decision;
}

async function tap(r: Rig, decision: HillDecision, rid: number, intent: string) {
  const outcome = await r.hill.answer({ rid: uuid(rid), node: `hill/${decision.id}`, intent, value: { text: null } }, decision.id, "Pixel 9");
  if (outcome.kind !== "receipt") throw new Error(outcome.kind);
  return outcome.receipt;
}

describe("posting Collie's own Decision", () => {
  test("it is stored as kind collie with its ref, from this bridge, naming no session, and needs no WalkyTalky", () => {
    const r = rig();
    r.walky = false;
    const decision = posted(r.hill.postCollie(SENDER, card(1, { about: "local/%1", replyTo: "local/%1" })));
    expect(decision.from).toEqual({ kind: "collie", address: null, trickId: null, trickKey: null, memberId: "m_aaaaaaaaaa", harness: null, label: "Browser leg", host: "desk", trickHost: null, ref: REF });
    expect(decision).toMatchObject({ about: null, replyTo: null, target: null, priority: "today", media: [] });
    expect(r.hill.collieDecisions("version").map((held) => held.id)).toEqual([decision.id]);
    expect(r.hill.collieDecisions("proposal")).toEqual([]);
  });

  test("it carries no image, and an agent's post with WalkyTalky off is still refused", () => {
    const r = rig();
    const refused = r.hill.postCollie(SENDER, card(1, { images: [{ path: "/etc/passwd" }] }));
    expect(refused).toMatchObject({ ok: false, code: "too_many_images" });
    r.walky = false;
    expect(r.hill.post(POSTER, card(2))).toMatchObject({ ok: false, code: "walky_off" });
  });

  test("a newer card supersedes the open one of the same ref; an agent cannot withdraw or supersede it", () => {
    const r = rig();
    const first = posted(r.hill.postCollie(SENDER, card(1)));
    const newer = { ...SENDER, ref: { ...REF, hash: "b".repeat(64) } };
    const second = posted(r.hill.postCollie(newer, card(2, { supersedes: first.id })));
    expect(r.store.get(first.id)).toMatchObject({ state: "superseded", supersededBy: second.id });
    expect(r.hill.withdraw(POSTER, second.id)).toMatchObject({ ok: false, missing: true });
    expect(r.hill.post(POSTER, card(3, { supersedes: second.id }))).toMatchObject({ ok: false, code: "bad_supersedes" });
    expect(r.hill.status(POSTER, second.id)).toMatchObject({ ok: false, missing: true });
    expect(r.hill.withdrawCollie(newer, second.id, "approved elsewhere")).toMatchObject({ ok: true, decision: { state: "withdrawn", closedReason: "approved elsewhere" } });
  });
});

describe("answering Collie's own Decision", () => {
  test("an option runs the handler with the ref and closes answered; nothing is typed and no tap runs", async () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(1)));
    const receipt = await tap(r, decision, 10, "use");
    expect(receipt).toMatchObject({ code: "ok", state: "answered", delivery: "none", trick: "none" });
    expect(r.calls).toEqual([{ ref: REF, intent: "use" }]);
    expect(r.sent).toEqual([]);
    expect(r.store.get(decision.id)).toMatchObject({ state: "answered", answer: { intent: "use", label: "Use the new version" } });
    // The same rid again answers the stored receipt and acts no second time.
    expect(await tap(r, decision, 10, "use")).toMatchObject({ code: "ok" });
    expect(r.calls).toHaveLength(1);
  });

  test("a refusal (the code moved) is a rejected receipt in plain words, and the card stays open for another tap", async () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(1)));
    r.verdict = { ok: false, reason: "The trick changed again. A new card replaces this one." };
    expect(await tap(r, decision, 10, "use")).toMatchObject({ code: "rejected", reason: "The trick changed again. A new card replaces this one.", state: "open" });
    expect(r.store.get(decision.id)?.state).toBe("open");
    r.verdict = "throw";
    expect(await tap(r, decision, 11, "keep")).toMatchObject({ code: "rejected", reason: HILL_NO_ANSWER_HANDLER, state: "open" });
    r.verdict = { ok: true };
    expect(await tap(r, decision, 12, "keep")).toMatchObject({ code: "ok", state: "answered" });
  });

  test("a dismiss closes it with no act; no handler wired refuses every option", async () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(1)));
    expect(await tap(r, decision, 10, "dismiss")).toMatchObject({ code: "ok", state: "dismissed" });
    expect(r.calls).toEqual([]);
    const bare = rig(null, false);
    const other = posted(bare.hill.postCollie(SENDER, card(1)));
    expect(await tap(bare, other, 10, "use")).toMatchObject({ code: "rejected", reason: HILL_NO_ANSWER_HANDLER });
    expect(await tap(bare, other, 11, "answer")).toMatchObject({ code: "rejected", state: "open" });
  });

  test("while its answer runs, no withdraw or supersede closes it under the answer", async () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(1)));
    const seen: unknown[] = [];
    r.during = () => {
      seen.push(r.hill.withdrawCollie(SENDER, decision.id, "approved elsewhere"));
      seen.push(r.hill.postCollie(SENDER, card(2, { supersedes: decision.id })));
    };
    expect(await tap(r, decision, 10, "use")).toMatchObject({ code: "ok", state: "answered" });
    expect(seen).toEqual([
      { ok: false, missing: false, error: HILL_ANSWER_RUNNING },
      { ok: false, code: "bad_supersedes", error: HILL_ANSWER_RUNNING },
    ]);
    // After the answer the guard is gone: the closed card answers as closed, not as being answered.
    expect(r.hill.withdrawCollie(SENDER, decision.id, "x")).toMatchObject({ ok: false, error: `${decision.id} is answered, nothing to withdraw` });
  });
});

describe("reading Collie's own Decision", () => {
  test("only the bridge's own store reads kind collie; a lead's answer or a socket answer never does", () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(1)));
    const raw = JSON.parse(JSON.stringify(decision));
    expect(readDecision(raw)).toBeNull();
    expect(readDecision(raw, { collie: true })?.from.ref).toEqual(REF);
  });

  test("a collie decision with a bad ref, or naming a session or a trick, does not read; an agent's with a ref does not either", () => {
    const r = rig();
    const decision = JSON.parse(JSON.stringify(posted(r.hill.postCollie(SENDER, card(1)))));
    const opts = { collie: true };
    expect(readDecision({ ...decision, from: { ...decision.from, ref: undefined } }, opts)).toBeNull();
    expect(readDecision({ ...decision, from: { ...decision.from, ref: { ...REF, hash: "short" } } }, opts)).toBeNull();
    expect(readDecision({ ...decision, from: { ...decision.from, ref: { ...REF, type: "shell" } } }, opts)).toBeNull();
    expect(readDecision({ ...decision, from: { ...decision.from, address: "local/%1#aaaa" } }, opts)).toBeNull();
    expect(readDecision({ ...decision, from: { ...decision.from, trickId: "legs" } }, opts)).toBeNull();
    const agent = JSON.parse(JSON.stringify(posted(r.hill.post(POSTER, card(2)))));
    expect(readDecision(agent, opts)?.from.kind).toBe("agent");
    expect(readDecision({ ...agent, from: { ...agent.from, ref: REF } }, opts)).toBeNull();
  });

  test("a store keeps Collie's decision across a restart, and an unreadable one stays in the file untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "hill-collie-"));
    roots.push(dir);
    const r = rig(dir);
    const decision = posted(r.hill.postCollie(SENDER, card(1)));
    const again = rig(dir);
    expect(again.store.get(decision.id)?.from).toMatchObject({ kind: "collie", ref: REF });
    // What an older build sees: a kind it does not know. Simulated with a broken ref; it is kept raw.
    const file = join(dir, "decisions.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.decisions[0].from.ref.hash = "nope";
    writeFileSync(file, JSON.stringify(doc));
    const older = rig(dir);
    expect(older.store.get(decision.id)).toBeUndefined();
    posted(older.hill.post(POSTER, card(2)));
    expect(JSON.parse(readFileSync(file, "utf8")).decisions.map((entry: { id: string }) => entry.id)).toContain(decision.id);
  });
});

describe("clearing Collie's own Decision", () => {
  test("a closed one leaves a tombstone under its collie key, an open one stays, and a repeated request id is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hill-collie-"));
    roots.push(dir);
    const r = rig(dir);
    const closed = posted(r.hill.postCollie(SENDER, card(1)));
    await tap(r, closed, 50, "keep");
    const open = posted(r.hill.postCollie({ ...SENDER, ref: { ...REF, id: "other" } }, card(2)));
    expect(r.hill.clear(null)).toEqual({ cleared: [closed.id], skipped: [] });
    expect(r.store.get(closed.id)).toBeUndefined();
    expect(r.store.get(open.id)?.state).toBe("open");
    expect(r.hill.clearedState(closed.id)).toBe("answered");
    expect(r.store.tombstone(closed.id)).toMatchObject({ requestId: uuid(1), key: "collie:version:legs", state: "answered" });
    // The tombstone is on disk: a restarted bridge still refuses the same request id instead of posting twice.
    const again = rig(dir);
    expect(again.hill.clearedState(closed.id)).toBe("answered");
    const repost = again.hill.postCollie(SENDER, card(1));
    expect(repost.ok).toBe(false);
  });
});
