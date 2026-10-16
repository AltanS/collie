import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "../audit.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "../mux/durable/adapter.ts";
import { FakeDurableClock, FakeDurableProgram } from "../mux/durable/fixture.ts";
import type { MuxAdapter, MuxControlOutcome } from "../mux/types.ts";
import type { ControlRequest, PaneWire } from "../types.ts";
import {
  CONTROL_RECEIPTS_FILE,
  ControlReceiptStore,
  controlDigest,
  controlPane,
  memoryControlReceipts,
  NO_ACTIONS,
  type ControlDeps,
  type ControlReceiptSurface,
  type ControlReply,
} from "./control.ts";
import { readControlBody } from "./parse.ts";
import { withActions } from "./pane-asks.ts";

// `POST /api/pane/:id/action` (M53 spec 07). The third act of the control route, and it follows send and abort:
//
//   1. The body names an action id and, optionally, the turn the phone saw. A turn that moved is 409 `stale`;
//      no turn named is not checked.
//   2. The receipt is written before the act leaves. A repeat of a settled request id answers from it and sends
//      nothing; an unknown outcome stays open, and the same id goes once more.
//   3. One request id, one payload: the same id for another action, pane or turn is `request-id-reused`.
//   4. A pane whose adapter takes no controls answers `unsupported`, with the words for actions.
//   5. `actions` rides the pane wire only for a pane whose adapter lists them.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const OTHER_ID = "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d";
const ESCALATE = { id: "escalate", label: "Escalate", icon: "flag" } as const;

const body = (over: JsonObject = {}): JsonValue => ({ requestId: ID, actionId: "escalate", ...over });

class ScriptedAdapter {
  readonly calls: Array<[string, ControlRequest]> = [];
  constructor(public outcomes: MuxControlOutcome[]) {}
  controlTurn = async (paneId: string, request: ControlRequest): Promise<MuxControlOutcome> => {
    this.calls.push([paneId, request]);
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
  const call = async (paneId: string, raw?: JsonValue): Promise<ControlReply> => {
    const reply = await controlPane("action", paneId, raw ?? body(), deps);
    if ("text" in reply) throw new Error(`bad body: ${reply.text}`);
    return reply;
  };
  return { deps, receipts, audit, call, settledCount: () => settled };
}

const dirs: string[] = [];
const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const program of programs.splice(0)) await program.close();
});

/** The real adapter over a real socket to a fake program whose conv-03 lists the Escalate action, read once. */
async function durable(options: { actions?: boolean } = {}) {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  program.hello.caps.actions = options.actions ?? true;
  program.snapshot.panes = program.snapshot.panes.map((pane) => (pane.id === "conv-03" ? { ...pane, actions: [ESCALATE, { id: "pause", label: "Pause", icon: "pause" as const, disabled: true as const }] } : pane));
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock);
  const tick = () => clock.advance(MIN_SNAPSHOT_GAP_MS);
  expect((await adapter.poll()).ok).toBe(true);
  const posts = () => program.requests.filter((q) => q.method === "POST");
  return { program, adapter, tick, posts, r: rig(adapter) };
}

describe("action: the body", () => {
  test("action: an action id, a request id and an optional turn id make a request", () => {
    expect(readControlBody("action", body())).toEqual({ act: "action", requestId: ID, actionId: "escalate" });
    expect(readControlBody("action", body({ turnId: "turn-03-c" }))).toEqual({ act: "action", requestId: ID, actionId: "escalate", turnId: "turn-03-c" });
  });

  test("action: a missing action id, an empty one, a mistyped field or no request id is no request", () => {
    const bad: JsonValue[] = [
      { requestId: ID },
      body({ actionId: "" }),
      body({ actionId: 4 }),
      body({ turnId: "" }),
      body({ turnId: 4 }),
      { actionId: "escalate" },
      body({ requestId: "not-a-uuid" }),
      [],
      null,
    ];
    for (const raw of bad) {
      expect(readControlBody("action", raw)).toBeNull();
    }
  });

  test("action: the digest binds the pane, the action and the turn, and no turn is its own value", () => {
    const base = controlDigest("conv-03", { act: "action", requestId: ID, actionId: "escalate" });
    expect(controlDigest("conv-03", { act: "action", requestId: OTHER_ID, actionId: "escalate" })).toBe(base);
    expect(controlDigest("conv-01", { act: "action", requestId: ID, actionId: "escalate" })).not.toBe(base);
    expect(controlDigest("conv-03", { act: "action", requestId: ID, actionId: "pause" })).not.toBe(base);
    expect(controlDigest("conv-03", { act: "action", requestId: ID, actionId: "escalate", turnId: "turn-03-c" })).not.toBe(base);
  });
});

describe("action: through the route", () => {
  test("action: a tap reaches the program once, with the request id, the action id and the turn", async () => {
    const { program, posts, r } = await durable();
    expect(await r.call("conv-03", body({ turnId: "turn-03-c" }))).toEqual({ status: 200, body: { ok: true, outcome: "ok" } });
    expect(program.actionsRun).toEqual([{ requestId: ID, paneId: "conv-03", actionId: "escalate", turnId: "turn-03-c" }]);
    expect(posts().map((p) => p.path)).toEqual(["/session/v1/pane/conv-03/action"]);
    expect(r.settledCount()).toBe(1);
    expect(r.receipts.get(ID)).toMatchObject({ act: "action", target: "action", targetId: "escalate", state: "ok" });
    expect(r.audit).toEqual([
      { action: "action", paneId: "conv-03", session: "default", device: "pixel", detail: { requestId: ID, outcome: "ok", actionId: "escalate", turnId: "turn-03-c" } },
    ]);
  });

  test("action: no turn named is not checked, and a repeat of the request id answers from the receipt and sends nothing", async () => {
    const { program, posts, r } = await durable();
    expect((await r.call("conv-03")).body).toEqual({ ok: true, outcome: "ok" });
    expect(await r.call("conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok", replayed: true } });
    expect(posts()).toHaveLength(1);
    expect(program.actionsRun).toHaveLength(1);
  });

  test("action: a turn that moved is 409 stale with what is current, and the socket is not touched", async () => {
    const { program, posts, r } = await durable();
    const reply = await r.call("conv-03", body({ turnId: "turn-03-b" }));
    expect(reply).toEqual({ status: 409, body: { ok: false, outcome: "stale", turnId: "turn-03-c", askIds: [] } });
    expect(posts()).toEqual([]);
    expect(program.actionsRun).toEqual([]);
    expect(r.receipts.get(ID)).toMatchObject({ state: "stale", currentTurnId: "turn-03-c" });
  });

  test("action: an action the pane does not list is refused before the socket, and a pane that is gone is refused too", async () => {
    const { posts, r } = await durable();
    expect(await r.call("conv-03", body({ actionId: "other" }))).toMatchObject({ status: 409, body: { ok: false, outcome: "refused", reason: "refused" } });
    expect(await r.call("conv-01", body({ requestId: OTHER_ID }))).toMatchObject({ status: 409, body: { outcome: "refused" } }); // conv-01 lists none
    expect(await r.call("conv-99", body({ requestId: "2d1a8c3e-5f4b-4e7a-8c9d-3f4a5b6c7d8e" }))).toMatchObject({ status: 409, body: { outcome: "refused" } });
    expect(posts()).toEqual([]);
  });

  test("action: the program's 404 no-such-action and 422 action-refused are refusals that carry its words", async () => {
    const { program, r } = await durable();
    program.actionRefusal = "Already escalated.";
    const refused = await r.call("conv-03");
    expect(refused).toMatchObject({ status: 409, body: { ok: false, outcome: "refused", reason: "refused" } });
    expect(refused.body.ok === false && refused.body.outcome === "refused" ? refused.body.detail : "").toContain("Already escalated.");
    // A refusal settles the receipt: the same id answers the same, and a new id may try again.
    program.actionRefusal = null;
    expect((await r.call("conv-03", body({ requestId: OTHER_ID }))).body).toEqual({ ok: true, outcome: "ok" });
    // A button the program lists as disabled is refused by the program as well.
    const dimmed = await r.call("conv-03", body({ requestId: "3e2b9d4f-6a5c-4f8b-9dae-4a5b6c7d8e9f", actionId: "pause" }));
    expect(dimmed).toMatchObject({ status: 409, body: { outcome: "refused" } });
    expect(program.actionsRun.map((a) => a.actionId)).toEqual(["escalate"]);
  });

  test("action: the same request id for another action, pane or turn is request-id-reused, and nothing is sent", async () => {
    const { posts, r } = await durable();
    await r.call("conv-03");
    const sent = posts().length;
    for (const other of [body({ actionId: "pause" }), body({ turnId: "turn-03-c" })]) {
      expect(await r.call("conv-03", other)).toMatchObject({ status: 409, body: { outcome: "refused", reason: "request-id-reused" } });
    }
    expect(await r.call("conv-01")).toMatchObject({ status: 409, body: { outcome: "refused", reason: "request-id-reused" } });
    expect(posts()).toHaveLength(sent);
  });

  test("action: a program that declared no actions refuses, and the socket is not touched", async () => {
    const { posts, r, adapter } = await durable({ actions: false });
    expect(adapter.paneActions("conv-03")).toBeUndefined();
    expect(await r.call("conv-03")).toMatchObject({ status: 409, body: { outcome: "refused", reason: "unsupported" } });
    expect(posts()).toEqual([]);
  });

  test("action: an adapter with no controls answers unsupported with the words for actions", async () => {
    const r = rig({});
    expect(await r.call("conv-03")).toEqual({ status: 409, body: { ok: false, outcome: "refused", reason: "unsupported", detail: NO_ACTIONS } });
  });

  test("action: an unknown outcome keeps the receipt open, and the same request id goes once more and replays", async () => {
    const adapter = new ScriptedAdapter([{ kind: "unknown", detail: "connection reset" }, { kind: "ok", replayed: true }]);
    const r = rig(adapter);
    expect(await r.call("conv-03")).toEqual({ status: 504, body: { ok: false, outcome: "unknown", detail: "connection reset" } });
    expect(r.receipts.get(ID)).toMatchObject({ state: "unknown", act: "action", target: "action" });
    expect(await r.call("conv-03")).toEqual({ status: 200, body: { ok: true, outcome: "ok", replayed: true } });
    expect(adapter.calls.map(([pane, req]) => [pane, req.act, req.requestId])).toEqual([["conv-03", "action", ID], ["conv-03", "action", ID]]);
  });

  test("action: a receipt on disk survives a bridge restart and replays, and sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-action-"));
    dirs.push(dir);
    const first = new ControlReceiptStore(dir);
    await first.load();
    await rig(new ScriptedAdapter([{ kind: "ok", replayed: false }]), first).call("conv-03");
    const second = new ControlReceiptStore(dir);
    await second.load();
    expect(second.get(ID)).toMatchObject({ act: "action", target: "action", targetId: "escalate", state: "ok" });
    const adapter = new ScriptedAdapter([]);
    expect((await rig(adapter, second).call("conv-03")).body).toEqual({ ok: true, outcome: "ok", replayed: true });
    expect(adapter.calls).toEqual([]);
    expect(CONTROL_RECEIPTS_FILE).toBe("control-receipts.json");
  });
});

describe("action: on the pane wire", () => {
  // SAFETY: the pane helpers read `paneId` and nothing else of the wire, so a stub that carries it stands for a pane.
  const wire = (paneId: string): PaneWire => ({ paneId }) as PaneWire;

  test("action: a pane whose program lists actions carries them, a copy, in the program's order", async () => {
    const { adapter } = await durable();
    const out = withActions(wire("conv-03"), adapter);
    expect(out.actions).toEqual([ESCALATE, { id: "pause", label: "Pause", icon: "pause", disabled: true }]);
    expect(out.actions).not.toBe(adapter.paneActions("conv-03"));
  });

  test("action: every other pane is returned as it came, the same object", async () => {
    const { adapter } = await durable();
    const plain = wire("conv-01");
    expect(withActions(plain, adapter)).toBe(plain);
    expect(withActions(plain, {})).toBe(plain);
    expect(withActions(wire("conv-99"), adapter)).toEqual(wire("conv-99"));
  });
});
