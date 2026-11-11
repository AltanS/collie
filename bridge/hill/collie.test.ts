import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HillCollieRef, HillDecision, HillPostInput } from "../../web/src/lib/hill/wire.ts";
import type { View } from "../../web/src/lib/tricks/schema.ts";
import { groupDigest, groupPartHash } from "./group.ts";
import { HILL_GROUP_NOT_YOURS, readAnswerRequest, readDecision, readPostFields } from "./parse.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HILL_ANSWER_RUNNING, HILL_CODE_OLD_APP, HILL_CODE_READ_FIRST, HILL_GROUP_CHANGED, HILL_GROUP_OLD_APP, HILL_NO_ANSWER_HANDLER, hillGroupOpenAll, HillService, type HillAgentSender, type HillCollieSender, type HillCollieVerdict, type HillPostAnswer } from "./service.ts";
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
    // C-A7 (review 8): only an agent's card is marked "you wrote to this session"; Collie's own never.
    expect(readDecision({ ...raw, spokeAfter: 5000 }, { collie: true })).not.toHaveProperty("spokeAfter");
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

// A GROUP OF CARDS (crew slice 8): only Collie's own Decision carries one, through `postCollie`.
describe("a group of cards", () => {
  const VIEW = (n: number): View => [{ kind: "para", text: `Card ${String(n)} words.` }];
  const GROUP = { decline: "keep", parts: [VIEW(1), VIEW(2), VIEW(3)] };

  test("postCollie stores the cards with their hashes and the digest; the file reads it back whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "hill-group-"));
    roots.push(dir);
    const r = rig(dir);
    const decision = posted(r.hill.postCollie(SENDER, card(1, { group: GROUP })));
    const group = decision.group!;
    expect(group.parts.map((part) => part.sha256)).toEqual(group.parts.map((part) => groupPartHash(part.view)));
    expect(group.digest).toBe(groupDigest(REF, group.parts.map((part) => part.sha256)));
    expect(new HillStore(dir, () => 1000).get(decision.id)?.group).toEqual(group);
  });

  test("a group of one card, of nine, with a decline that is no option, or beside a view is refused", () => {
    const r = rig();
    for (const group of [{ ...GROUP, parts: [VIEW(1)] }, { ...GROUP, parts: Array.from({ length: 9 }, (_, i) => VIEW(i)) }, { ...GROUP, decline: "later" }]) {
      expect(r.hill.postCollie(SENDER, card(1, { group }))).toMatchObject({ ok: false, code: "bad_body" });
    }
    expect(r.hill.postCollie(SENDER, card(2, { group: GROUP, view: VIEW(1) }))).toMatchObject({ ok: false, code: "bad_body" });
  });

  test("an agent's post and a trick's post carrying a group are refused", () => {
    const r = rig();
    expect(r.hill.post(POSTER, card(3, { group: GROUP }))).toEqual({ ok: false, code: "bad_body", error: HILL_GROUP_NOT_YOURS });
    expect(r.hill.postDecision({ kind: "trick", trickId: "legs", trickKey: "k", label: "Legs", memberId: "m_aaaaaaaaaa" }, card(4, { group: GROUP }))).toEqual({ ok: false, code: "bad_body", error: HILL_GROUP_NOT_YOURS });
    expect(readPostFields({ ...JSON.parse(JSON.stringify(card(5))), group: GROUP })).toEqual({ ok: false, code: "bad_body", error: HILL_GROUP_NOT_YOURS });
    expect(readPostFields({ ...JSON.parse(JSON.stringify(card(6))), parts: [] })).toEqual({ ok: false, code: "bad_body", error: HILL_GROUP_NOT_YOURS });
  });

  test("the file drops a group on an agent's decision, and one whose card or digest does not match", () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(7, { group: GROUP })));
    const raw = JSON.parse(JSON.stringify(decision));
    expect(readDecision(raw, { collie: true })?.group).toEqual(decision.group);
    const asAgent = { ...raw, from: { ...raw.from, kind: "agent", address: "local/%1#aaaa", ref: undefined } };
    expect(readDecision(JSON.parse(JSON.stringify(asAgent)), { collie: true })).toBeNull();
    const changed = JSON.parse(JSON.stringify(raw));
    changed.group.parts[1].view = VIEW(9);
    expect(readDecision(changed, { collie: true })).toBeNull();
    const moved = JSON.parse(JSON.stringify(raw));
    moved.group.parts.reverse();
    expect(readDecision(moved, { collie: true })).toBeNull();
  });

  test("an answer's group fields are read strictly: a digest of 64 hex, the opened cards each once, 1 to 8", () => {
    const base = { rid: uuid(1), node: "hill/dc_col000000001", intent: "use", value: { text: null } };
    expect(readAnswerRequest({ ...base, group: { digest: "a".repeat(64), opened: [1, 2, 3] } })).toMatchObject({ ok: true, request: { group: { digest: "a".repeat(64), opened: [1, 2, 3] } } });
    for (const group of [{ digest: "x", opened: [1] }, { digest: "a".repeat(64), opened: [0] }, { digest: "a".repeat(64), opened: [1, 1] }, { digest: "a".repeat(64), opened: [9] }, { digest: "a".repeat(64) }]) {
      expect(readAnswerRequest({ ...base, group })).toEqual({ ok: false, error: "bad group" });
    }
    expect(readAnswerRequest(base)).toMatchObject({ ok: true });
  });

  test("the yes needs the digest and every card; keep and a dismiss need neither", async () => {
    const r = rig();
    const decision = posted(r.hill.postCollie(SENDER, card(8, { group: GROUP })));
    const digest = decision.group!.digest;
    const answer = async (rid: number, intent: string, group?: { digest: string; opened: number[] }) => {
      const request = { rid: uuid(rid), node: `hill/${decision.id}`, intent, value: { text: null } };
      const outcome = await r.hill.answer(group === undefined ? request : { ...request, group }, decision.id, "Pixel 9");
      if (outcome.kind !== "receipt") throw new Error(outcome.kind);
      return outcome.receipt;
    };
    expect(await answer(10, "use")).toMatchObject({ code: "rejected", reason: HILL_GROUP_OLD_APP });
    expect(await answer(11, "use", { digest: "b".repeat(64), opened: [1, 2, 3] })).toMatchObject({ code: "rejected", reason: HILL_GROUP_CHANGED });
    expect(await answer(12, "use", { digest, opened: [1, 3] })).toMatchObject({ code: "rejected", reason: hillGroupOpenAll(3) });
    expect(hillGroupOpenAll(3)).toBe("Open all 3 cards first.");
    expect(r.calls).toEqual([]);
    expect(await answer(13, "use", { digest, opened: [3, 1, 2] })).toMatchObject({ code: "ok", state: "answered" });
    expect(r.calls).toEqual([{ ref: REF, intent: "use" }]);
    const other = posted(r.hill.postCollie({ ...SENDER, ref: { ...REF, id: "other" } }, card(9, { group: GROUP })));
    const outcome = await r.hill.answer({ rid: uuid(14), node: `hill/${other.id}`, intent: "keep", value: { text: null } }, other.id, "Pixel 9");
    expect(outcome).toMatchObject({ kind: "receipt", receipt: { code: "ok" } });
  });

  test("a single card of code is held to the group's rule: the yes needs its hash and opened [1] (C-A2)", async () => {
    const r = rig();
    const code: View = [{ kind: "para", text: "The change." }, { kind: "diff", text: "@@ -1 +1 @@\n-a\n+b", attrs: { file: "a.ts" } }];
    const decision = posted(r.hill.postCollie(SENDER, card(20, { view: code })));
    const answer = async (rid: number, intent: string, group?: { digest: string; opened: number[] }) => {
      const request = { rid: uuid(rid), node: `hill/${decision.id}`, intent, value: { text: null } };
      const outcome = await r.hill.answer(group === undefined ? request : { ...request, group }, decision.id, "Pixel 9");
      if (outcome.kind !== "receipt") throw new Error(outcome.kind);
      return outcome.receipt;
    };
    expect(await answer(21, "use")).toMatchObject({ code: "rejected", reason: HILL_CODE_OLD_APP });
    expect(await answer(22, "use", { digest: "b".repeat(64), opened: [1] })).toMatchObject({ code: "rejected", reason: HILL_GROUP_CHANGED });
    expect(await answer(28, "use", { digest: REF.hash, opened: [2] })).toMatchObject({ code: "rejected", reason: HILL_CODE_READ_FIRST });
    expect(r.calls).toEqual([]);
    expect(await answer(23, "use", { digest: REF.hash, opened: [1] })).toMatchObject({ code: "ok", state: "answered" });
    expect(r.calls).toEqual([{ ref: REF, intent: "use" }]);
    // Its decline needs nothing opened; a card with no code is answered as before.
    const kept = posted(r.hill.postCollie({ ...SENDER, ref: { ...REF, id: "kept" } }, card(24, { view: code })));
    expect(await r.hill.answer({ rid: uuid(25), node: `hill/${kept.id}`, intent: "keep", value: { text: null } }, kept.id, "Pixel 9")).toMatchObject({ receipt: { code: "ok" } });
    const words = posted(r.hill.postCollie({ ...SENDER, ref: { ...REF, id: "words" } }, card(26, { view: [{ kind: "para", text: "No code." }] })));
    expect(await r.hill.answer({ rid: uuid(27), node: `hill/${words.id}`, intent: "use", value: { text: null } }, words.id, "Pixel 9")).toMatchObject({ receipt: { code: "ok" } });
  });
});
