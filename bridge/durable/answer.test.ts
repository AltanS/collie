import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { JsonValue } from "../json.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "../mux/durable/adapter.ts";
import { FakeDurableClock, FakeDurableProgram, isPrivateFile, privateTestDir } from "../mux/durable/fixture.ts";
import { muxGone, muxOk, muxRefused, muxUnreachable, type MuxAdapter, type MuxAnswerResult, type MuxOutcome } from "../mux/types.ts";
import type { AnswerRequest, AnswerResponse, Ask } from "../types.ts";
import {
  ANSWER_RECEIPTS_FILE,
  answerDigest,
  AnswerReceiptStore,
  answerPane,
  memoryAnswerReceipts,
  NO_ANSWERS,
  type AnswerDeps,
  type AnswerReceipt,
  type AnswerReceiptSurface,
  type AnswerReply,
} from "./answer.ts";

// `POST /api/pane/:id/answer` (ADR 0100). The claims:
//
//   1. Each outcome reaches the phone in one shape: taken, too-late, stale (with the current ask),
//      unknown, refused.
//   2. The receipt is written BEFORE the answer leaves, and a receipt that cannot be written sends
//      nothing.
//   3. A repeat of a request id with a settled outcome answers from the receipt and sends nothing; one
//      still in flight is joined; an unknown one stays open, so "Try again" with the same id sends
//      once more and the program answers `replayed`.
//   4. A pane whose adapter takes no answers gets the ADR 0022 refusal word, `unsupported`.
//   5. Through the real adapter and a fake program over a real socket, every outcome of WIRE.md
//      section 7.3 comes back as the phone expects.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const OTHER_ID = "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d";

function body(over: Record<string, JsonValue> = {}): JsonValue {
  return { requestId: ID, askId: "ask-1", revision: 1, optionId: "allow", ...over };
}

const STALE_ASK: Ask = {
  id: "ask-1",
  kind: "permission",
  toolCallId: "call-1",
  revision: 2,
  title: "write_note wants to write /tmp/x",
  itemId: "item-1",
  options: [{ id: "allow", label: "Allow", effect: "allow" }],
};

/** An adapter that answers from a script and counts every call. */
class ScriptedAdapter {
  readonly calls: Array<[string, AnswerRequest]> = [];
  gate: Promise<void> | null = null;
  constructor(public outcomes: MuxOutcome<MuxAnswerResult>[], private readonly onCall?: () => void) {}
  answerAsk = async (paneId: string, answer: AnswerRequest): Promise<MuxOutcome<MuxAnswerResult>> => {
    this.calls.push([paneId, answer]);
    this.onCall?.();
    if (this.gate !== null) await this.gate;
    return this.outcomes.shift() ?? muxOk({ kind: "unknown", detail: "script ran out" });
  };
}

function rig(adapter: Pick<MuxAdapter, "answerAsk">, receipts: AnswerReceiptSurface = memoryAnswerReceipts()) {
  const audit: AuditEntry[] = [];
  let settled = 0;
  const deps: AnswerDeps = {
    adapter,
    receipts,
    audit: { record: (entry) => audit.push(entry) },
    device: "pixel",
    session: "default",
    settled: () => (settled += 1),
    now: () => Date.now(),
  };
  const call = async (paneId: string, raw: JsonValue | undefined = body()): Promise<AnswerReply> => {
    const reply = await answerPane(paneId, raw, deps);
    if ("text" in reply) throw new Error(`bad body: ${reply.text}`);
    return reply;
  };
  return { deps, receipts, audit, call, settledCount: () => settled };
}

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-answer-"));
  dirs.push(dir);
  return privateTestDir(dir);
}
const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const program of programs.splice(0)) await program.close();
});

describe("answer: one shape for every outcome", () => {
  test("taken: 200, ok, and the engine is told so the ask leaves the next snapshot", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    const r = rig(adapter);
    const reply = await r.call("conv-02");
    expect(reply).toEqual({ status: 200, body: { ok: true, outcome: "taken" } });
    expect(adapter.calls).toEqual([["conv-02", { requestId: ID, askId: "ask-1", revision: 1, optionId: "allow" }]]);
    expect(r.settledCount()).toBe(1);
    expect(r.receipts.get(ID)?.state).toBe("taken");
    expect(r.audit).toEqual([
      {
        action: "answer",
        paneId: "conv-02",
        session: "default",
        device: "pixel",
        detail: { requestId: ID, askId: "ask-1", revision: 1, optionId: "allow", outcome: "taken" },
      },
    ]);
  });

  test("too-late: 200, and a pane gone from the program's layout reads the same", async () => {
    const late = rig(new ScriptedAdapter([muxOk({ kind: "too-late", replayed: false })]));
    expect(await late.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "too-late" } });
    const gone = rig(new ScriptedAdapter([muxGone("no such pane")]));
    expect(await gone.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "too-late" } });
    expect(gone.receipts.get(ID)?.state).toBe("too-late");
  });

  test("stale: 409 with the ask in its current form, and nothing ran", async () => {
    const r = rig(new ScriptedAdapter([muxOk({ kind: "stale", ask: STALE_ASK })]));
    expect(await r.call("conv-02")).toEqual({ status: 409, body: { ok: false, outcome: "stale", ask: STALE_ASK } });
    expect(r.settledCount()).toBe(0);
  });

  test("unknown: 504, and the receipt stays open", async () => {
    const r = rig(new ScriptedAdapter([muxOk({ kind: "unknown", detail: "no answer within 5000ms" })]));
    expect(await r.call("conv-02")).toEqual({ status: 504, body: { ok: false, outcome: "unknown", detail: "no answer within 5000ms" } });
    expect(r.receipts.get(ID)?.state).toBe("unknown");
  });

  test("unknown: a program that did not answer at all is unknown too, and the receipt stays open", async () => {
    const r = rig(new ScriptedAdapter([muxUnreachable("starting")]));
    expect(await r.call("conv-02")).toEqual({ status: 504, body: { ok: false, outcome: "unknown", detail: "starting" } });
    // Nothing reached the program, and the receipt says so: a retry is a plain first try.
    expect(r.receipts.get(ID)?.state).toBe("unsent");
  });

  test("refused: 409 with the refusal's word, kept on the receipt", async () => {
    const r = rig(new ScriptedAdapter([muxRefused("program answered 400 bad-option")]));
    expect(await r.call("conv-02")).toEqual({
      status: 409,
      body: { ok: false, outcome: "refused", reason: "refused", detail: "program answered 400 bad-option" },
    });
    expect(r.receipts.get(ID)).toMatchObject({ state: "refused", reason: "refused" });
  });

  test("refusal: a pane whose adapter takes no answers gets `unsupported`, and no receipt is written", async () => {
    const r = rig({});
    expect(await r.call("w1:p1")).toEqual({ status: 409, body: { ok: false, outcome: "refused", reason: "unsupported", detail: NO_ANSWERS } });
    expect(r.receipts.get(ID)).toBeUndefined();
    expect(r.audit).toEqual([]);
  });

  test("a body that is not an answer is a plain 400, and nothing is sent", async () => {
    const adapter = new ScriptedAdapter([]);
    const r = rig(adapter);
    for (const bad of [
      undefined,
      "text",
      body({ requestId: "not-a-uuid" }),
      body({ askId: "" }),
      body({ revision: 0 }),
      body({ revision: 1.5 }),
      body({ optionId: 3 }),
      body({ note: 7 }),
    ]) {
      expect(await answerPane("conv-02", bad, r.deps)).toEqual({ status: 400, text: "bad body" });
    }
    expect(adapter.calls).toEqual([]);
  });
});

describe("answer: the receipt comes first", () => {
  test("the receipt is on file, pending, while the answer is on its way", async () => {
    const receipts = memoryAnswerReceipts();
    const seen: Array<string | undefined> = [];
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })], () => seen.push(receipts.get(ID)?.state));
    await rig(adapter, receipts).call("conv-02");
    expect(seen).toEqual(["pending"]);
  });

  test("a receipt that cannot be written sends nothing", async () => {
    const memory = memoryAnswerReceipts();
    const failing: AnswerReceiptSurface = { ...memory, recordFirst: () => Promise.resolve(false) };
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    const reply = await rig(adapter, failing).call("conv-02");
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ ok: false, outcome: "refused", reason: "refused" });
    expect(adapter.calls).toEqual([]);
  });

  test("on disk: the file is owner-only, and a pending receipt survives a bridge restart", async () => {
    const dir = stateDir();
    const first = new AnswerReceiptStore(dir);
    await first.load();
    expect(existsSync(join(dir, ANSWER_RECEIPTS_FILE))).toBe(false);
    await rig(new ScriptedAdapter([muxOk({ kind: "unknown", detail: "connection reset" })]), first).call("conv-02");
    const file = join(dir, ANSWER_RECEIPTS_FILE);
    expect(isPrivateFile(file)).toBe(true);
    // No note and no ask text on disk: ids and the state only.
    expect(readFileSync(file, "utf8")).not.toContain("note");

    const second = new AnswerReceiptStore(dir);
    await second.load();
    expect(second.get(ID)?.state).toBe("unknown");
    expect(readFileSync(file, "utf8")).not.toContain(".tmp");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  test("on disk: a settled receipt replays after a bridge restart, and nothing is sent", async () => {
    const dir = stateDir();
    const first = new AnswerReceiptStore(dir);
    await first.load();
    await rig(new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]), first).call("conv-02");
    const second = new AnswerReceiptStore(dir);
    await second.load();
    const adapter = new ScriptedAdapter([]);
    expect(await rig(adapter, second).call("conv-02")).toEqual({ status: 200, body: { ok: true, outcome: "taken", replayed: true } });
    expect(adapter.calls).toEqual([]);
  });
});

describe("answer: replay", () => {
  test("a repeat of a settled request id answers from the receipt and sends nothing", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    const r = rig(adapter);
    await r.call("conv-02");
    expect(await r.call("conv-02")).toEqual({ status: 200, body: { ok: true, outcome: "taken", replayed: true } });
    expect(await r.call("conv-02")).toEqual({ status: 200, body: { ok: true, outcome: "taken", replayed: true } });
    expect(adapter.calls).toHaveLength(1);
  });

  test("every settled outcome replays as itself", async () => {
    const cases: Array<[MuxOutcome<MuxAnswerResult>, AnswerResponse]> = [
      [muxOk({ kind: "too-late", replayed: false }), { ok: false, outcome: "too-late", replayed: true }],
      [muxOk({ kind: "stale", ask: STALE_ASK }), { ok: false, outcome: "stale", replayed: true }],
      [muxRefused("no"), { ok: false, outcome: "refused", reason: "refused", detail: "no", replayed: true }],
    ];
    for (const [outcome, replayed] of cases) {
      const adapter = new ScriptedAdapter([outcome]);
      const r = rig(adapter);
      await r.call("conv-02");
      expect((await r.call("conv-02")).body).toEqual(replayed);
      expect(adapter.calls).toHaveLength(1);
    }
  });

  test("a second tap while the first is in flight is joined, never sent twice", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    let release = () => {};
    adapter.gate = new Promise((resolve) => (release = resolve));
    const r = rig(adapter);
    const first = r.call("conv-02");
    const second = r.call("conv-02");
    release();
    expect((await first).body).toEqual({ ok: true, outcome: "taken" });
    expect((await second).body).toEqual({ ok: true, outcome: "taken" });
    expect(adapter.calls).toHaveLength(1);
  });

  test("Try again after an unknown outcome sends once more with the SAME request id", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "unknown", detail: "connection reset" }), muxOk({ kind: "taken", replayed: true })]);
    const r = rig(adapter);
    expect((await r.call("conv-02")).body.outcome).toBe("unknown");
    expect(await r.call("conv-02")).toEqual({ status: 200, body: { ok: true, outcome: "taken", replayed: true } });
    expect(adapter.calls.map(([, a]) => a.requestId)).toEqual([ID, ID]);
    expect(r.receipts.get(ID)?.state).toBe("taken");
  });

  test("a request id already used for another answer is refused, and nothing is sent", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    const r = rig(adapter);
    await r.call("conv-02");
    for (const other of [body({ optionId: "deny" }), body({ askId: "ask-2" }), body({ revision: 2 })]) {
      const reply = await r.call("conv-02", other);
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ ok: false, outcome: "refused", reason: "request-id-reused" });
    }
    expect((await r.call("conv-03")).body).toMatchObject({ ok: false, outcome: "refused", reason: "request-id-reused" });
    expect(adapter.calls).toHaveLength(1);
  });

  test("a reused id is refused even while the first request is still in flight, and only one POST leaves", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    let release = () => {};
    adapter.gate = new Promise((resolve) => (release = resolve));
    const r = rig(adapter);
    const first = r.call("conv-02");
    const same = r.call("conv-02");
    const other = await r.call("conv-02", body({ optionId: "deny" }));
    expect(other.body).toMatchObject({ outcome: "refused", reason: "request-id-reused" });
    release();
    await Promise.all([first, same]);
    expect(adapter.calls).toHaveLength(1);
  });
});

describe("answer: after an unknown outcome", () => {
  test("a retry that finds the ask closed is maybe-applied (200), and replays as such", async () => {
    const adapter = new ScriptedAdapter([muxOk({ kind: "unknown", detail: "connection reset" }), muxOk({ kind: "too-late", replayed: false })]);
    const r = rig(adapter);
    expect((await r.call("conv-02")).body.outcome).toBe("unknown");
    expect(await r.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "maybe-applied" } });
    expect(r.receipts.get(ID)?.state).toBe("maybe-applied");
    expect(await r.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "maybe-applied", replayed: true } });
    expect(adapter.calls).toHaveLength(2);
  });

  test("a retry that finds the ask changed, or the pane gone, is maybe-applied too", async () => {
    const stale = rig(new ScriptedAdapter([muxOk({ kind: "unknown", detail: "reset" }), muxOk({ kind: "stale", ask: STALE_ASK })]));
    await stale.call("conv-02");
    expect(await stale.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "maybe-applied" } });
    const gone = rig(new ScriptedAdapter([muxOk({ kind: "unknown", detail: "reset" }), muxGone("no such pane")]));
    await gone.call("conv-02");
    expect((await gone.call("conv-02")).body).toEqual({ ok: false, outcome: "maybe-applied" });
  });

  test("a program that replays its own too-late for this id is believed: the first try did not land", async () => {
    const r = rig(new ScriptedAdapter([muxOk({ kind: "unknown", detail: "reset" }), muxOk({ kind: "too-late", replayed: true })]));
    await r.call("conv-02");
    expect((await r.call("conv-02")).body).toEqual({ ok: false, outcome: "too-late", replayed: true });
  });

  test("after an unsent try, a too-late retry is plain too-late: nothing had reached the program", async () => {
    const r = rig(new ScriptedAdapter([muxUnreachable("connection refused"), muxOk({ kind: "too-late", replayed: false })]));
    await r.call("conv-02");
    expect(await r.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "too-late" } });
  });

  test("a pending receipt left by a bridge that stopped mid-flight reads like unknown", async () => {
    const dir = stateDir();
    const first = new AnswerReceiptStore(dir);
    await first.load();
    const adapter = new ScriptedAdapter([muxOk({ kind: "taken", replayed: false })]);
    let release = () => {};
    adapter.gate = new Promise((resolve) => (release = resolve));
    void rig(adapter, first).call("conv-02");
    await Bun.sleep(5);
    // The bridge stops here: the receipt on disk says the answer was on its way.
    const reborn = new AnswerReceiptStore(dir);
    await reborn.load();
    expect(reborn.get(ID)?.state).toBe("pending");
    const after = rig(new ScriptedAdapter([muxOk({ kind: "too-late", replayed: false })]), reborn);
    expect(await after.call("conv-02")).toEqual({ status: 200, body: { ok: false, outcome: "maybe-applied" } });
    release();
  });
});

describe("answer: the receipt store keeps a week, the newest thousand, and every young pending one", () => {
  test("pruned by age and count, never a pending receipt younger than a day", async () => {
    const dir = stateDir();
    let now = 30 * 24 * 60 * 60 * 1000;
    const store = new AnswerReceiptStore(dir, () => {}, () => now);
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const receipt = (n: number, at: number, state: AnswerReceipt["state"]): AnswerReceipt => ({
      requestId: uuid(n),
      at,
      paneId: "p",
      askId: "a",
      revision: 1,
      optionId: "o",
      digest: answerDigest("p", { askId: "a", revision: 1, optionId: "o" }),
      state,
    });
    await store.record(receipt(0, now - 8 * DAY, "taken"));
    expect(store.get(uuid(0))).toBeUndefined();
    // Two old open ones: a day and a half old goes with the count, an hour old stays.
    await store.record(receipt(1, now - 36 * HOUR, "unknown"));
    await store.record(receipt(2, now - HOUR, "pending"));
    for (let n = 3; n < 1003; n += 1) {
      now += 1;
      await store.record(receipt(n, now, "taken"));
    }
    expect(store.get(uuid(1))).toBeUndefined();
    expect(store.get(uuid(2))?.state).toBe("pending");
    expect(store.get(uuid(3))).toBeUndefined();
    expect(store.get(uuid(1002))).toBeDefined();
    const reborn = new AnswerReceiptStore(dir, () => {}, () => now);
    await reborn.load();
    expect(reborn.get(uuid(2))?.state).toBe("pending");
    expect(reborn.get(uuid(4))).toBeDefined();
  });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── Through the real adapter, over a real socket ───────────────────────────────

async function durable() {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock);
  const tick = () => clock.advance(MIN_SNAPSHOT_GAP_MS);
  expect((await adapter.poll()).ok).toBe(true);
  return { program, adapter, tick, r: rig(adapter) };
}

const ASK_02 = "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c";

describe("answer: through the durable adapter (WIRE.md section 7.3)", () => {
  test("taken: the program resolves the ask once, and a replay asks it nothing", async () => {
    const { program, r } = await durable();
    expect(await r.call("conv-02", body({ askId: ASK_02 }))).toEqual({ status: 200, body: { ok: true, outcome: "taken" } });
    expect(program.answers.map((a) => [a.paneId, a.askId, a.optionId, a.requestId])).toEqual([["conv-02", ASK_02, "allow", ID]]);
    const posts = () => program.requests.filter((q) => q.method === "POST").length;
    expect(posts()).toBe(1);
    expect((await r.call("conv-02", body({ askId: ASK_02 }))).body).toEqual({ ok: true, outcome: "taken", replayed: true });
    expect(posts()).toBe(1);
  });

  test("stale: a revision the program moved past comes back with the ask as it is now", async () => {
    const { r } = await durable();
    const reply = await r.call("conv-04", body({ askId: "ask-0a9b8c7d6e5f40312a3b4c5d6e7f8091", revision: 1 }));
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ ok: false, outcome: "stale", ask: { id: "ask-0a9b8c7d6e5f40312a3b4c5d6e7f8091", revision: 2, toolCallId: "call-04-1" } });
  });

  test("re-ask: after a program restart the old ask id answers too-late, and the new one is taken", async () => {
    const { program, adapter, tick, r } = await durable();
    program.restartReasking();
    tick();
    expect((await adapter.poll()).ok).toBe(true);
    const reasked = adapter.openAsks("conv-02")?.[0];
    expect(reasked?.toolCallId).toBe("call-02-1");
    expect(reasked?.id).not.toBe(ASK_02);
    expect((await r.call("conv-02", body({ askId: ASK_02 }))).body).toEqual({ ok: false, outcome: "too-late" });
    const fresh = await answerPane("conv-02", body({ requestId: OTHER_ID, askId: reasked?.id ?? "" }), r.deps);
    expect("body" in fresh && fresh.body).toEqual({ ok: true, outcome: "taken" });
    expect(program.answers.map((a) => a.toolCallId)).toEqual(["call-02-1"]);
  });

  test("unknown: a 500 keeps the receipt open, and Try again lands once", async () => {
    const { program, r } = await durable();
    program.override = (path) => (path.endsWith("/answer") ? new Response(JSON.stringify({ code: "internal" }), { status: 500 }) : undefined);
    expect((await r.call("conv-02", body({ askId: ASK_02 }))).body).toMatchObject({ ok: false, outcome: "unknown" });
    expect(program.answers).toEqual([]);
    program.override = null;
    expect((await r.call("conv-02", body({ askId: ASK_02 }))).body).toEqual({ ok: true, outcome: "taken" });
    expect(program.answers).toHaveLength(1);
  });

  test("a bad option is the program's refusal, and nothing ran", async () => {
    const { program, r } = await durable();
    const reply = await r.call("conv-02", body({ askId: ASK_02, optionId: "nope" }));
    expect(reply.body).toMatchObject({ ok: false, outcome: "refused", reason: "refused", detail: "program answered 400 bad-option" });
    expect(program.answers).toEqual([]);
  });

  test("a program that takes no answers is refused before anything is sent", async () => {
    const { program, adapter, tick, r } = await durable();
    program.hello.caps.asks = false;
    program.restart();
    tick();
    expect((await adapter.poll()).ok).toBe(true);
    expect((await r.call("conv-02", body({ askId: ASK_02 }))).body).toMatchObject({ ok: false, outcome: "refused", reason: "refused" });
    expect(program.requests.filter((q) => q.method === "POST")).toEqual([]);
  });
});
