import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import { withAgentHints } from "../beacon/hint.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { durableJournal, STOPPED_TEXT } from "../journal/durable.ts";
import { TranscriptStore } from "../journal/store.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "../mux/durable/adapter.ts";
import { DurableSocketClient } from "../mux/durable/client.ts";
import { FakeDurableClock, FakeDurableProgram, isPrivateFile, privateTestDir } from "../mux/durable/fixture.ts";
import type { MuxAdapter, MuxControlOutcome } from "../mux/types.ts";
import type { ControlRequest, ControlResponse, PaneWire } from "../types.ts";
import {
  CONTROL_RECEIPTS_FILE,
  ControlReceiptStore,
  controlPane,
  memoryControlReceipts,
  namesCurrent,
  NO_CONTROLS,
  NO_RAW_INPUT,
  rawInputRefusal,
  type ControlDeps,
  type ControlReceiptSurface,
  type ControlReply,
} from "./control.ts";
import { DurableLogs } from "./log.ts";
import { withOpenAsks, withTurn } from "./pane-asks.ts";

// `POST /api/pane/:id/send` and `/abort` (ADR 0101). The claims:
//
//   1. A control names the newest turn id or an open ask id. The newest is accepted; an older one is
//      409 `stale` with what is current, and the adapter refuses it before the socket. Free text with
//      no name, or with both, is a plain 400.
//   2. The receipt is written BEFORE the control leaves. A repeat of a settled request id answers from
//      it and sends nothing; one in flight is joined; an unknown one stays open, so "Try again" with
//      the same id goes once more and the program answers `replayed`.
//   3. Each outcome reaches the phone in one shape: ok, stale, unknown, refused (`unsupported` for a
//      pane or a program that cannot take the act).
//   4. Abort follows the same rules, and a stop writes no item: the program's `settled` event is the
//      one "stopped" line the log shows.
//   5. A durable pane refuses `/reply` and `/keys` with the ADR 0022 word, and every other pane keeps
//      them; `turnId` rides the pane wire only for a pane that names turns.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const OTHER_ID = "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d";

/** conv-03 is idle on `turn-03-c`, conv-01 works on `turn-01-a`, conv-02 waits on one ask. */
const ASK_02 = "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c";

/** A key set to `undefined` in `over` reads as absent, as it would after JSON. */
function sendBody(over: JsonObject = {}): JsonValue {
  return { requestId: ID, text: "steer left", turnId: "turn-03-c", ...over };
}

function abortBody(over: JsonObject = {}): JsonValue {
  return { requestId: ID, turnId: "turn-01-a", ...over };
}

/** An adapter that answers from a script and counts every call. */
class ScriptedAdapter {
  readonly calls: Array<[string, ControlRequest]> = [];
  gate: Promise<void> | null = null;
  constructor(public outcomes: MuxControlOutcome[], private readonly onCall?: () => void) {}
  controlTurn = async (paneId: string, request: ControlRequest): Promise<MuxControlOutcome> => {
    this.calls.push([paneId, request]);
    this.onCall?.();
    if (this.gate !== null) await this.gate;
    return this.outcomes.shift() ?? { kind: "unknown", detail: "script ran out" };
  };
}

function rig(adapter: Pick<MuxAdapter, "controlTurn">, receipts: ControlReceiptSurface = memoryControlReceipts()) {
  const audit: AuditEntry[] = [];
  let settled = 0;
  const deps: ControlDeps = {
    adapter,
    receipts,
    audit: { record: (entry) => audit.push(entry) },
    device: "pixel",
    session: "default",
    settled: () => (settled += 1),
    now: () => Date.now(),
  };
  const call = async (act: "send" | "abort", paneId: string, raw?: JsonValue): Promise<ControlReply> => {
    const reply = await controlPane(act, paneId, raw ?? (act === "send" ? sendBody() : abortBody()), deps);
    if ("text" in reply) throw new Error(`bad body: ${reply.text}`);
    return reply;
  };
  return { deps, receipts, audit, call, settledCount: () => settled };
}

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-control-"));
  dirs.push(dir);
  return privateTestDir(dir);
}
const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const program of programs.splice(0)) await program.close();
});

/** The real adapter over a real socket to a fake program, read once. */
async function durable(options: { logs?: DurableLogs } = {}) {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock, options.logs ?? null);
  const tick = () => clock.advance(MIN_SNAPSHOT_GAP_MS);
  expect((await adapter.poll()).ok).toBe(true);
  const posts = () => program.requests.filter((q) => q.method === "POST");
  return { program, adapter, tick, posts, r: rig(adapter) };
}

// ── The spec's checklist ──────────────────────────────────────────────────────

describe("control: the turn id", () => {
  test("turn id: a send with the newest turn id is accepted, and the program starts a turn", async () => {
    const { program, adapter, tick, r } = await durable();
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok" } });
    expect(program.sends).toEqual([{ paneId: "conv-03", requestId: ID, text: "steer left", steer: false, turnId: "turn-03-c", askId: null }]);
    expect(r.settledCount()).toBe(1);
    // The idle pane started a new turn, so the next listing names it and the old one is stale.
    tick();
    await adapter.poll();
    expect(adapter.paneTurn("conv-03")).not.toBe("turn-03-c");
  });

  test("turn id: an older turn id gets 409 with the current turn and asks, and the socket is not touched", async () => {
    const { program, posts, r } = await durable();
    const reply = await r.call("send", "conv-03", sendBody({ turnId: "turn-03-b" }));
    expect(reply).toEqual({ status: 409, body: { ok: false, outcome: "stale", turnId: "turn-03-c", askIds: [] } });
    expect(posts()).toEqual([]);
    expect(program.sends).toEqual([]);
    expect(r.receipts.get(ID)).toMatchObject({ state: "stale", currentTurnId: "turn-03-c", currentAskIds: [] });
  });

  test("turn id: a turn that moved after the adapter's read is refused by the program, and passed up", async () => {
    const { program, posts, r } = await durable();
    // The program starts a new turn, and the adapter is still inside its 250 ms floor: its own check
    // passes on the old turn, and the program's check catches it (WIRE.md section 7.4).
    program.snapshot.panes = program.snapshot.panes.map((pane) => (pane.id === "conv-03" ? { ...pane, turnId: "turn-03-d" } : pane));
    program.touch();
    const reply = await r.call("send", "conv-03");
    expect(reply).toEqual({ status: 409, body: { ok: false, outcome: "stale", turnId: "turn-03-d", askIds: [] } });
    expect(posts()).toHaveLength(1);
    expect(program.sends).toEqual([]);
  });

  test("turn id: an open ask id names its pane; a closed one is stale and lists the open ones", async () => {
    const { program, r } = await durable();
    const stale = await r.call("send", "conv-02", sendBody({ turnId: undefined, askId: "ask-gone" }));
    expect(stale).toEqual({ status: 409, body: { ok: false, outcome: "stale", turnId: "turn-02-a", askIds: [ASK_02] } });
    const taken = await r.call("send", "conv-02", sendBody({ requestId: OTHER_ID, turnId: undefined, askId: ASK_02, text: "only this file" }));
    expect(taken.body).toEqual({ ok: true, outcome: "ok" });
    expect(program.sends.map((s) => [s.askId, s.turnId])).toEqual([[ASK_02, null]]);
  });

  test("turn id: the guard is one rule, the newest turn or an open ask", () => {
    const view = { turnId: "t2", askIds: ["a1", "a2"] };
    expect(namesCurrent({ kind: "turn", id: "t2" }, view)).toBe(true);
    expect(namesCurrent({ kind: "turn", id: "t1" }, view)).toBe(false);
    expect(namesCurrent({ kind: "ask", id: "a2" }, view)).toBe(true);
    expect(namesCurrent({ kind: "ask", id: "t2" }, view)).toBe(false);
  });
});

describe("control: unnamed", () => {
  test("unnamed: free text with no turn or ask id is refused, and nothing is sent", async () => {
    const { program, posts, r } = await durable();
    for (const raw of [sendBody({ turnId: undefined }), { requestId: ID, text: "go" }]) {
      expect(await controlPane("send", "conv-03", raw, r.deps)).toEqual({ status: 400, text: "bad body" });
    }
    expect(posts()).toEqual([]);
    expect(program.sends).toEqual([]);
    expect(r.receipts.get(ID)).toBeUndefined();
  });

  test("unnamed: both a turn id and an ask id is no name either", async () => {
    const { posts, r } = await durable();
    expect(await controlPane("send", "conv-02", sendBody({ askId: ASK_02 }), r.deps)).toEqual({ status: 400, text: "bad body" });
    expect(await controlPane("abort", "conv-02", abortBody({ askId: ASK_02 }), r.deps)).toEqual({ status: 400, text: "bad body" });
    expect(posts()).toEqual([]);
  });
});

describe("control: the request id", () => {
  test("request id: a repeat returns the receipt and sends nothing a second time", async () => {
    const { program, posts, r } = await durable();
    expect((await r.call("send", "conv-03")).body).toEqual({ ok: true, outcome: "ok" });
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok", replayed: true } });
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok", replayed: true } });
    expect(posts()).toHaveLength(1);
    expect(program.sends).toHaveLength(1);
  });

  test("request id: the phone's id reaches the program unchanged, with the name and nothing else", async () => {
    const { posts, r } = await durable();
    await r.call("send", "conv-01", sendBody({ turnId: "turn-01-a", steer: true }));
    const post = posts()[0];
    expect(post?.path).toBe("/session/v1/pane/conv-01/send");
    expect(JSON.parse(post?.body ?? "")).toEqual({ requestId: ID, text: "steer left", steer: true, turnId: "turn-01-a" });
  });

  test("request id: Try again after an unknown outcome sends once more with the SAME id, and acts once", async () => {
    const { program, posts, r } = await durable();
    program.override = (path) => (path.endsWith("/send") ? new Response(JSON.stringify({ code: "internal" }), { status: 500 }) : undefined);
    expect(await r.call("send", "conv-03")).toEqual({ status: 504, body: { ok: false, outcome: "unknown", detail: "the durable agent answered 500" } });
    expect(r.receipts.get(ID)?.state).toBe("unknown");
    program.override = null;
    expect((await r.call("send", "conv-03")).body).toEqual({ ok: true, outcome: "ok" });
    expect(posts().map((q) => JSON.parse(q.body ?? "").requestId)).toEqual([ID, ID]);
    expect(program.sends).toHaveLength(1);
  });

  test("request id: a program that saw the id before answers replayed, and the phone is told so", async () => {
    const adapter = new ScriptedAdapter([{ kind: "unknown", detail: "connection reset" }, { kind: "ok", replayed: true }]);
    const r = rig(adapter);
    expect((await r.call("send", "conv-03")).body.outcome).toBe("unknown");
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok", replayed: true } });
    expect(adapter.calls.map(([, q]) => q.requestId)).toEqual([ID, ID]);
    expect(r.receipts.get(ID)?.state).toBe("ok");
  });

  test("request id: a second tap while the first is in flight is joined, never sent twice", async () => {
    const adapter = new ScriptedAdapter([{ kind: "ok", replayed: false }]);
    let release = () => {};
    adapter.gate = new Promise((resolve) => (release = resolve));
    const r = rig(adapter);
    const first = r.call("send", "conv-03");
    const second = r.call("send", "conv-03");
    release();
    expect((await first).body).toEqual({ ok: true, outcome: "ok" });
    expect((await second).body).toEqual({ ok: true, outcome: "ok" });
    expect(adapter.calls).toHaveLength(1);
  });

  test("request id: an id already used for another control is refused, and nothing is sent", async () => {
    const adapter = new ScriptedAdapter([{ kind: "ok", replayed: false }]);
    const r = rig(adapter);
    await r.call("send", "conv-03");
    for (const [act, paneId, raw] of [
      ["send", "conv-03", sendBody({ text: "steer right" })],
      ["send", "conv-03", sendBody({ steer: true })],
      ["send", "conv-03", sendBody({ turnId: "turn-03-d" })],
      ["send", "conv-04", sendBody()],
      ["abort", "conv-03", abortBody({ turnId: "turn-03-c" })],
    ] as const) {
      const reply = await r.call(act, paneId, raw);
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ ok: false, outcome: "refused", reason: "request-id-reused" });
    }
    expect(adapter.calls).toHaveLength(1);
  });

  test("request id: after an unknown outcome, a retry that finds the turn moved on is maybe-applied (200)", async () => {
    const adapter = new ScriptedAdapter([{ kind: "unknown", detail: "connection reset" }, { kind: "stale", turnId: "turn-03-d", askIds: [] }]);
    const r = rig(adapter);
    expect((await r.call("send", "conv-03")).body.outcome).toBe("unknown");
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: false, outcome: "maybe-applied" } });
    expect(r.receipts.get(ID)?.state).toBe("maybe-applied");
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: false, outcome: "maybe-applied", replayed: true } });
    expect(adapter.calls).toHaveLength(2);
  });

  test("request id: after an unsent try, a stale retry stays stale, because nothing had left", async () => {
    const r = rig(new ScriptedAdapter([{ kind: "unreachable", detail: "connection refused" }, { kind: "stale", turnId: "t9", askIds: [] }]));
    await r.call("send", "conv-03");
    expect((await r.call("send", "conv-03")).status).toBe(409);
  });

  test("request id: every settled outcome replays as itself", async () => {
    const cases: Array<[MuxControlOutcome, ControlResponse]> = [
      [{ kind: "stale", turnId: "t9", askIds: ["a1"] }, { ok: false, outcome: "stale", turnId: "t9", askIds: ["a1"], replayed: true }],
      [{ kind: "unsupported", detail: "no" }, { ok: false, outcome: "refused", reason: "unsupported", detail: "no", replayed: true }],
      [{ kind: "refused", detail: "no" }, { ok: false, outcome: "refused", reason: "refused", detail: "no", replayed: true }],
      [{ kind: "gone", detail: "gone" }, { ok: false, outcome: "refused", reason: "refused", detail: "gone", replayed: true }],
    ];
    for (const [outcome, replayed] of cases) {
      const adapter = new ScriptedAdapter([outcome]);
      const r = rig(adapter);
      await r.call("send", "conv-03");
      expect((await r.call("send", "conv-03")).body).toEqual(replayed);
      expect(adapter.calls).toHaveLength(1);
    }
  });
});

describe("control: abort", () => {
  test("abort: the newest turn id stops the run; an older one gets 409 and stops nothing", async () => {
    const { program, posts, r } = await durable();
    const stale = await r.call("abort", "conv-01", abortBody({ turnId: "turn-01-0" }));
    expect(stale).toEqual({ status: 409, body: { ok: false, outcome: "stale", turnId: "turn-01-a", askIds: [] } });
    expect(posts()).toEqual([]);
    expect(await r.call("abort", "conv-01", abortBody({ requestId: OTHER_ID }))).toEqual({ status: 200, body: { ok: true, outcome: "ok" } });
    expect(program.aborts).toEqual([{ paneId: "conv-01", requestId: OTHER_ID, turnId: "turn-01-a", askId: null, stopped: true }]);
    expect(program.snapshot.panes.find((p) => p.id === "conv-01")?.state).toBe("idle");
  });

  test("abort: unnamed is refused as a plain 400, and nothing is sent", async () => {
    const { posts, r } = await durable();
    expect(await controlPane("abort", "conv-01", { requestId: ID }, r.deps)).toEqual({ status: 400, text: "bad body" });
    expect(posts()).toEqual([]);
  });

  test("abort: a repeat request id returns the receipt and stops nothing a second time", async () => {
    const { program, posts, r } = await durable();
    await r.call("abort", "conv-01");
    expect((await r.call("abort", "conv-01")).body).toEqual({ ok: true, outcome: "ok", replayed: true });
    expect(posts()).toHaveLength(1);
    expect(program.aborts).toHaveLength(1);
  });

  test("abort: an open ask id stops the run, and the ask closes as stopped", async () => {
    const { program, r } = await durable();
    expect((await r.call("abort", "conv-02", abortBody({ turnId: undefined, askId: ASK_02 }))).body).toEqual({ ok: true, outcome: "ok" });
    expect(program.asksOf("conv-02")).toEqual([]);
  });

  test("abort: a pane with nothing running answers ok and does nothing", async () => {
    const { program, r } = await durable();
    expect((await r.call("abort", "conv-03", abortBody({ turnId: "turn-03-c" }))).body).toEqual({ ok: true, outcome: "ok" });
    expect(program.aborts.map((a) => a.stopped)).toEqual([false]);
    expect(program.eventCount("conv-03")).toBe(0);
  });

  test("abort: a program without the abort cap is refused as unsupported, and nothing is sent", async () => {
    const { program, adapter, tick, posts, r } = await durable();
    program.hello.caps.abort = false;
    program.restart();
    tick();
    expect((await adapter.poll()).ok).toBe(true);
    const reply = await r.call("abort", "conv-01");
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ ok: false, outcome: "refused", reason: "unsupported" });
    expect(posts()).toEqual([]);
  });

  test("abort: a stop writes no item, and the settled event is the one stopped line the log shows", async () => {
    const state = stateDir();
    const logDir = join(state, "durable");
    const logs = new DurableLogs(logDir);
    const { program, adapter, tick, r } = await durable({ logs });
    program.appendEvent("conv-01", { type: "item", item: { id: "u1", kind: "user", text: "write the summary" } });
    tick();
    await adapter.poll();
    await adapter.syncEvents();

    const journal = durableJournal([logDir]);
    const store = new TranscriptStore();
    const entries = async () => {
      const page = await store.page(journal, { kind: "id", value: "conv-01" }, { limit: 200 });
      if (page === null) throw new Error("no log");
      return page.entries;
    };
    expect((await entries()).map((entry) => entry.uuid)).toEqual(["u1"]);

    expect((await r.call("abort", "conv-01")).body).toEqual({ ok: true, outcome: "ok" });
    tick();
    await adapter.poll();
    await adapter.syncEvents();

    const after = await entries();
    // Exactly one new line, the stop note drawn from the settled event, and no other item.
    expect(after).toHaveLength(2);
    expect(after[0]?.uuid).toBe("u1");
    expect(after[1]?.parts).toEqual([{ kind: "text", text: STOPPED_TEXT }]);
    expect(after.filter((entry) => entry.parts.some((part) => part.kind === "text" && part.text === STOPPED_TEXT))).toHaveLength(1);
  });
});

// ── Every outcome, the receipt, the caps, and bad bodies ──────────────────────

describe("control: one shape for every outcome", () => {
  test("ok: 200, the engine is told, and the audit line names the turn and the text", async () => {
    const adapter = new ScriptedAdapter([{ kind: "ok", replayed: false }]);
    const r = rig(adapter);
    expect(await r.call("send", "conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok" } });
    expect(adapter.calls).toEqual([["conv-03", { act: "send", requestId: ID, target: { kind: "turn", id: "turn-03-c" }, text: "steer left", steer: false }]]);
    expect(r.settledCount()).toBe(1);
    expect(r.audit).toEqual([
      {
        action: "send",
        paneId: "conv-03",
        session: "default",
        device: "pixel",
        detail: { requestId: ID, outcome: "ok", turnId: "turn-03-c", text: "steer left", steer: false },
      },
    ]);
  });

  test("stale: 409 with the current turn and asks, and the engine is not told", async () => {
    const r = rig(new ScriptedAdapter([{ kind: "stale", turnId: "t9", askIds: ["a1", "a2"] }]));
    expect(await r.call("abort", "conv-01")).toEqual({ status: 409, body: { ok: false, outcome: "stale", turnId: "t9", askIds: ["a1", "a2"] } });
    expect(r.settledCount()).toBe(0);
    expect(r.audit[0]).toMatchObject({ action: "abort", detail: { outcome: "stale", turnId: "turn-01-a" } });
  });

  test("unknown: 504 and the receipt stays open, for a lost reply and for a program not asked at all", async () => {
    for (const outcome of [{ kind: "unknown", detail: "no answer within 5000ms" }, { kind: "unreachable", detail: "starting" }] as const) {
      const r = rig(new ScriptedAdapter([outcome]));
      expect(await r.call("send", "conv-03")).toEqual({ status: 504, body: { ok: false, outcome: "unknown", detail: outcome.detail } });
      expect(r.receipts.get(ID)?.state).toBe(outcome.kind === "unknown" ? "unknown" : "unsent");
    }
  });

  test("refused: 409 with the refusal's word, kept on the receipt; a gone pane is refused too", async () => {
    const cases: Array<[MuxControlOutcome, "unsupported" | "refused"]> = [
      [{ kind: "unsupported", detail: "This durable agent takes no text from here." }, "unsupported"],
      [{ kind: "refused", detail: "the durable agent answered 409 request-id-reused" }, "refused"],
      [{ kind: "gone", detail: "The conversation is not in the durable agent's layout." }, "refused"],
    ];
    for (const [outcome, reason] of cases) {
      const r = rig(new ScriptedAdapter([outcome]));
      const reply = await r.call("send", "conv-03");
      expect(reply).toEqual({ status: 409, body: { ok: false, outcome: "refused", reason, detail: "detail" in outcome ? outcome.detail : "" } });
      expect(r.receipts.get(ID)).toMatchObject({ state: "refused", reason });
    }
  });

  test("refusal: a pane whose adapter takes no controls gets `unsupported`, and no receipt is written", async () => {
    const r = rig({});
    for (const act of ["send", "abort"] as const) {
      expect(await r.call(act, "w1:p1")).toEqual({ status: 409, body: { ok: false, outcome: "refused", reason: "unsupported", detail: NO_CONTROLS } });
    }
    expect(r.receipts.get(ID)).toBeUndefined();
    expect(r.audit).toEqual([]);
  });
});

describe("control: the program's caps", () => {
  test("caps: no send cap, or a steer with no steer cap, is unsupported before anything is sent", async () => {
    const { program, adapter, tick, posts, r } = await durable();
    program.hello.caps.steer = false;
    program.restart();
    tick();
    expect((await adapter.poll()).ok).toBe(true);
    const steer = await r.call("send", "conv-01", sendBody({ turnId: "turn-01-a", steer: true }));
    expect(steer.body).toMatchObject({ ok: false, outcome: "refused", reason: "unsupported" });
    expect(posts()).toEqual([]);
    // Without `steer` the same send is a follow-up, which the program takes.
    expect((await r.call("send", "conv-01", sendBody({ requestId: OTHER_ID, turnId: "turn-01-a" }))).body).toEqual({ ok: true, outcome: "ok" });

    program.hello.caps.send = false;
    program.restart();
    tick();
    expect((await adapter.poll()).ok).toBe(true);
    const none = await r.call("send", "conv-03", sendBody({ requestId: "2d1e8c3f-5a4b-4e7a-8c9d-3f4a5b6c7d8e" }));
    expect(none.body).toMatchObject({ ok: false, outcome: "refused", reason: "unsupported" });
    expect(posts()).toHaveLength(1);
  });

  test("caps: a program's own not-supported is passed up as unsupported", async () => {
    const { program, r } = await durable();
    program.override = (path) => (path.endsWith("/send") ? new Response(JSON.stringify({ code: "not-supported" }), { status: 409 }) : undefined);
    expect((await r.call("send", "conv-03")).body).toMatchObject({ ok: false, outcome: "refused", reason: "unsupported" });
  });

  test("a pane gone from the program's layout is refused before the socket", async () => {
    const { posts, r } = await durable();
    expect((await r.call("send", "conv-99")).body).toMatchObject({ ok: false, outcome: "refused", reason: "refused" });
    expect(posts()).toEqual([]);
  });
});

describe("control: the receipt comes first", () => {
  test("the receipt is on file, pending, while the control is on its way", async () => {
    const receipts = memoryControlReceipts();
    const seen: Array<string | undefined> = [];
    const adapter = new ScriptedAdapter([{ kind: "ok", replayed: false }], () => seen.push(receipts.get(ID)?.state));
    await rig(adapter, receipts).call("send", "conv-03");
    expect(seen).toEqual(["pending"]);
  });

  test("a receipt that cannot be written sends nothing", async () => {
    const memory = memoryControlReceipts();
    const failing: ControlReceiptSurface = { ...memory, recordFirst: () => Promise.resolve(false) };
    const adapter = new ScriptedAdapter([{ kind: "ok", replayed: false }]);
    const reply = await rig(adapter, failing).call("abort", "conv-01");
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ ok: false, outcome: "refused", reason: "refused" });
    expect(adapter.calls).toEqual([]);
  });

  test("on disk: owner-only, no text, and a pending receipt survives a bridge restart", async () => {
    const dir = stateDir();
    const first = new ControlReceiptStore(dir);
    await first.load();
    expect(existsSync(join(dir, CONTROL_RECEIPTS_FILE))).toBe(false);
    await rig(new ScriptedAdapter([{ kind: "unknown", detail: "connection reset" }]), first).call("send", "conv-03");
    const file = join(dir, CONTROL_RECEIPTS_FILE);
    expect(isPrivateFile(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("steer left");

    const second = new ControlReceiptStore(dir);
    await second.load();
    expect(second.get(ID)).toMatchObject({ state: "unknown", act: "send", target: "turn", targetId: "turn-03-c", steer: false });
  });

  test("on disk: a settled receipt replays after a bridge restart, and nothing is sent", async () => {
    const dir = stateDir();
    const first = new ControlReceiptStore(dir);
    await first.load();
    await rig(new ScriptedAdapter([{ kind: "stale", turnId: "t9", askIds: [] }]), first).call("abort", "conv-01");
    const second = new ControlReceiptStore(dir);
    await second.load();
    const adapter = new ScriptedAdapter([]);
    expect((await rig(adapter, second).call("abort", "conv-01")).body).toEqual({ ok: false, outcome: "stale", turnId: "t9", askIds: [], replayed: true });
    expect(adapter.calls).toEqual([]);
  });
});

describe("control: a body that is not a control", () => {
  test("is a plain 400, and nothing is sent", async () => {
    const adapter = new ScriptedAdapter([]);
    const r = rig(adapter);
    const sends: Array<JsonValue | undefined> = [
      undefined,
      "text",
      [],
      sendBody({ requestId: "not-a-uuid" }),
      sendBody({ requestId: undefined }),
      sendBody({ text: "" }),
      sendBody({ text: undefined }),
      sendBody({ text: 7 }),
      sendBody({ text: "é".repeat(16_385) }),
      sendBody({ steer: "yes" }),
      sendBody({ turnId: "" }),
      sendBody({ turnId: 3 }),
      sendBody({ turnId: null }),
      sendBody({ turnId: undefined, askId: "" }),
    ];
    for (const bad of sends) expect(await controlPane("send", "conv-03", bad, r.deps)).toEqual({ status: 400, text: "bad body" });
    for (const bad of [undefined, abortBody({ requestId: "x" }), abortBody({ turnId: undefined }), abortBody({ askId: "a1" })]) {
      expect(await controlPane("abort", "conv-01", bad, r.deps)).toEqual({ status: 400, text: "bad body" });
    }
    expect(adapter.calls).toEqual([]);
  });

  test("text up to 32768 bytes is taken, and the adapter holds the same cap", async () => {
    const adapter = new ScriptedAdapter([{ kind: "ok", replayed: false }]);
    const r = rig(adapter);
    expect((await r.call("send", "conv-03", sendBody({ text: "a".repeat(32_768) }))).body).toEqual({ ok: true, outcome: "ok" });
    const { adapter: real } = await durable();
    const over = await real.controlTurn("conv-03", { act: "send", requestId: ID, target: { kind: "turn", id: "turn-03-c" }, text: "a".repeat(32_769), steer: false });
    expect(over.kind).toBe("refused");
  });
});

// ── The raw routes, and the pane wire ─────────────────────────────────────────

describe("raw input on a pane that takes guarded controls", () => {
  test("/reply and /keys answer the ADR 0022 refusal on a durable pane, through the decorator the bridge wraps it in", () => {
    const wrapped = withAgentHints(new DurableMux(new DurableSocketClient(undefined)), { hooksInstalled: () => false });
    expect(rawInputRefusal(wrapped)).toEqual({ status: 409, body: { ok: false, outcome: "refused", reason: "unsupported", detail: NO_RAW_INPUT } });
  });

  test("every other pane keeps /reply and /keys as they are", () => {
    expect(rawInputRefusal({})).toBeNull();
  });
});

describe("turnId on the pane wire", () => {
  const wire: PaneWire = {
    paneId: "conv-02",
    workspaceId: "ws-notes",
    workspaceLabel: "notes",
    workspaceNumber: 1,
    tabId: "ws-notes:main",
    agent: "durable",
    status: "blocked",
    cwd: "/home/you",
    focused: false,
    kind: "agent",
  };

  test("a durable pane carries its newest turn beside its asks; a pane of another adapter comes back as is", async () => {
    const { adapter } = await durable();
    const out = withTurn(withOpenAsks(wire, adapter), adapter);
    expect(out.turnId).toBe("turn-02-a");
    expect(out.asks?.map((ask) => ask.id)).toEqual([ASK_02]);
    expect(withTurn(wire, {})).toBe(wire);
    // A pane the program does not list carries no turn.
    expect("turnId" in withTurn({ ...wire, paneId: "conv-99" }, adapter)).toBe(false);
  });

  test("an unreachable program names no turn, so the phone cannot send one", () => {
    const adapter = new DurableMux(new DurableSocketClient(undefined));
    expect(adapter.paneTurn("conv-02")).toBeUndefined();
    expect(withTurn(wire, adapter)).toBe(wire);
  });
});
