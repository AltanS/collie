import { afterEach, describe, expect, test } from "bun:test";

import type { JsonValue } from "../../json.ts";
import type { ControlRequest } from "../../types.ts";
import { muxConfigBody } from "../../server.ts";
import { MUX_CAPABILITIES } from "../capabilities.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { ACTION_LABEL_MAX, actionLabelOf } from "./clean.ts";
import { DurableOutcomeUnknown, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { FakeDurableClock, FakeDurableProgram } from "./fixture.ts";
import { parseActionPost, parseHello, parseSnapshot } from "./protocol.ts";

// The belt actions a durable program lists for a pane (M53 spec 07, WIRE.md sections 4 and 7.10):
//
//   • The cap of the last good read declares `programActions`, and no other capability changes with it.
//   • The adapter cleans the list: at most 4, a label of at most 16 characters, a known icon or none.
//   • `paneActions` names a pane's list from the last read and asks nothing; a program with no cap lists none.
//   • `controlTurn` with an `action` posts ONE `/pane/:id/action`, never retried, with the turn only when named.
//   • The program's answers map onto the outcomes the route renders.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";
const ESCALATE = { id: "escalate", label: "Escalate", icon: "flag" } as const;

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

class CountingTransport implements DurableTransport {
  readonly posts: DurablePost[] = [];
  failNext: Error | null = null;
  replyNext: DurableReply | null = null;
  constructor(private readonly inner: DurableTransport) {}
  get(request: Parameters<DurableTransport["get"]>[0]): Promise<DurableReply> {
    return this.inner.get(request);
  }
  post(request: DurablePost): Promise<DurableReply> {
    this.posts.push(request);
    const failure = this.failNext;
    this.failNext = null;
    if (failure !== null) return Promise.reject(failure);
    const canned = this.replyNext;
    this.replyNext = null;
    if (canned !== null) return Promise.resolve(canned);
    return this.inner.post(request);
  }
}

async function rig(options: { actions: boolean } = { actions: true }) {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  program.hello.caps.actions = options.actions;
  program.snapshot.panes = program.snapshot.panes.map((pane) => (pane.id === "conv-03" ? { ...pane, actions: [ESCALATE] } : pane));
  const clock = new FakeDurableClock();
  const transport = new CountingTransport(program.wire());
  const adapter = new DurableMux(transport, clock);
  expect((await adapter.poll()).ok).toBe(true);
  return { program, clock, transport, adapter, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS) };
}

const act = (over: Partial<Extract<ControlRequest, { act: "action" }>> = {}): ControlRequest => ({ act: "action", requestId: ID, actionId: "escalate", ...over });

describe("action capability", () => {
  test("programActions follows the program's own caps.actions, and nothing else changes with it", async () => {
    const withCap = await rig({ actions: true });
    expect(withCap.adapter.capabilities.supports.programActions).toBe(true);
    expect(muxConfigBody(withCap.adapter).capabilities.programActions).toBe(true);
    for (const other of MUX_CAPABILITIES.filter((capability) => ["renameTab", "renameSpace", "closePane", "closeTab"].includes(capability))) {
      expect(withCap.adapter.capabilities.supports[other]).toBe(false);
    }
    const without = await rig({ actions: false });
    expect(without.adapter.capabilities.supports.programActions).toBe(false);
    expect(muxConfigBody(without.adapter).capabilities.programActions).toBe(false);
  });

  test("it is absent before the first read, and replaced by the next hello", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    program.hello.caps.actions = true;
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(program.wire(), clock);
    expect(adapter.capabilities.supports.programActions).toBe(false);
    await adapter.snapshot();
    expect(adapter.capabilities.supports.programActions).toBe(true);
    program.hello.caps.actions = false;
    program.restart();
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    await adapter.snapshot();
    expect(adapter.capabilities.supports.programActions).toBe(false);
  });

  test("hello decodes actions: true, and an absent actions is false", () => {
    const hello = (caps: Record<string, boolean>) =>
      parseHello(JSON.stringify({ service: "collie-durable", protocol: { min: 1, max: 1 }, host: { name: "h" }, epoch: "e", ready: true, caps }));
    const on = hello({ actions: true });
    const off = hello({ asks: true });
    expect(on.ok && on.value.caps.actions).toBe(true);
    expect(off.ok && off.value.caps.actions).toBe(false);
  });
});

describe("action cleaning", () => {
  const paneWith = (actions: JsonValue | undefined) =>
    parseSnapshot(
      JSON.stringify({
        rev: 1,
        epoch: "e",
        workspaces: [{ id: "w", title: "W" }],
        tabs: [{ id: "w:t", workspaceId: "w", title: "T" }],
        panes: [{ id: "p", workspaceId: "w", tabId: "w:t", title: "P", harness: "x", state: "idle", lastActiveAt: 0, turnId: "t1", openAsks: [], actions }],
        starters: [],
      }),
      false,
    );
  const actionsOf = (actions: JsonValue | undefined) => {
    const parsed = paneWith(actions);
    if (!parsed.ok) throw new Error("the snapshot did not parse");
    return parsed.value.panes[0]!.actions;
  };

  test("at most 4 actions are kept, in order, and an empty or mistyped list reads as absent", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id }));
    expect((actionsOf(five) ?? []).map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    expect(actionsOf([])).toBeUndefined();
    expect(actionsOf("nope")).toBeUndefined();
    expect(actionsOf(undefined)).toBeUndefined();
  });

  test("a label is cleaned and cut to 16 characters; an empty label, a bad id and a repeated id are left out", () => {
    const got = actionsOf([
      { id: "long", label: `  A label${String.fromCharCode(0x202e)} that is far too long ` },
      { id: "empty", label: "   " },
      { id: "bad id", label: "x" },
      { id: "long", label: "Again" },
      { label: "no id" },
      "not an object",
      { id: "ok", label: "Ok" },
    ]);
    expect(got).toEqual([{ id: "long", label: "A label that is" }, { id: "ok", label: "Ok" }]);
    expect(actionLabelOf("é".repeat(ACTION_LABEL_MAX + 4))).toBe("é".repeat(ACTION_LABEL_MAX)); // characters, not bytes
  });

  test("an unknown icon draws none, a known one stays, and busy and disabled are kept only when true", () => {
    const got = actionsOf([
      { id: "a", label: "A", icon: "flag" },
      { id: "b", label: "B", icon: "rocket" },
      { id: "c", label: "C", icon: 4, busy: true, disabled: true },
      { id: "d", label: "D", busy: "yes", disabled: false },
    ]);
    expect(got).toEqual([
      { id: "a", label: "A", icon: "flag" },
      { id: "b", label: "B" },
      { id: "c", label: "C", busy: true, disabled: true },
      { id: "d", label: "D" },
    ]);
  });
});

describe("paneActions", () => {
  test("names each listed pane's actions, and none for a pane that lists none or is not listed", async () => {
    const { adapter } = await rig();
    expect(adapter.paneActions("conv-03")).toEqual([ESCALATE]);
    expect(adapter.paneActions("conv-01")).toBeUndefined();
    expect(adapter.paneActions("conv-99")).toBeUndefined();
  });

  test("a program that never declared the cap lists none, even when its snapshot carries some", async () => {
    const { adapter } = await rig({ actions: false });
    expect(adapter.paneActions("conv-03")).toBeUndefined();
  });

  test("a change in the program is named after the next read", async () => {
    const { program, adapter, tick } = await rig();
    program.snapshot.panes = program.snapshot.panes.map((pane) => (pane.id === "conv-03" ? { ...pane, actions: [{ ...ESCALATE, disabled: true as const }] } : pane));
    program.touch();
    tick();
    await adapter.poll();
    expect(adapter.paneActions("conv-03")).toEqual([{ ...ESCALATE, disabled: true }]);
  });
});

describe("controlTurn with an action", () => {
  test("posts /pane/:id/action with the request id and the action id, and the turn only when named", async () => {
    const { transport, adapter, program, tick } = await rig();
    expect(await adapter.controlTurn("conv-03", act())).toEqual({ kind: "ok", replayed: false });
    tick();
    expect(await adapter.controlTurn("conv-03", act({ requestId: "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d", turnId: "turn-03-c" }))).toEqual({ kind: "ok", replayed: false });
    expect(transport.posts.map((p) => [p.path, p.body])).toEqual([
      ["/pane/conv-03/action", { requestId: ID, actionId: "escalate" }],
      ["/pane/conv-03/action", { requestId: "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d", actionId: "escalate", turnId: "turn-03-c" }],
    ]);
    expect(program.actionsRun).toHaveLength(2);
  });

  test("the body the adapter writes is the body a program reads", async () => {
    const { transport, adapter } = await rig();
    await adapter.controlTurn("conv-03", act({ turnId: "turn-03-c" }));
    expect(parseActionPost(JSON.stringify(transport.posts[0]!.body))).toEqual({ requestId: ID, actionId: "escalate", turnId: "turn-03-c" });
    expect(parseActionPost(JSON.stringify({ requestId: ID, actionId: "x" }))).toEqual({ requestId: ID, actionId: "x", turnId: null });
    expect(parseActionPost(JSON.stringify({ actionId: "x" }))).toBeNull();
    expect(parseActionPost("{")).toBe("bad-json");
  });

  test("an id that breaks the rule, an action the pane does not list and a pane that is gone are refused before the socket", async () => {
    const { transport, adapter } = await rig();
    expect((await adapter.controlTurn("conv-03", act({ actionId: "has space" }))).kind).toBe("refused");
    expect((await adapter.controlTurn("conv-03", act({ actionId: "other" }))).kind).toBe("refused");
    expect((await adapter.controlTurn("conv-01", act())).kind).toBe("refused");
    expect((await adapter.controlTurn("conv-99", act())).kind).toBe("gone");
    expect(transport.posts).toEqual([]);
  });

  test("a stale turn is refused with what is current, before the socket", async () => {
    const { transport, adapter } = await rig();
    expect(await adapter.controlTurn("conv-03", act({ turnId: "turn-03-b" }))).toEqual({ kind: "stale", turnId: "turn-03-c", askIds: [] });
    expect(transport.posts).toEqual([]);
  });

  test("with the cap absent the verb answers unsupported, and the socket is not touched", async () => {
    const { transport, adapter } = await rig({ actions: false });
    expect((await adapter.controlTurn("conv-03", act())).kind).toBe("unsupported");
    expect(transport.posts).toEqual([]);
  });

  test("the program's answers map onto the outcomes the route renders", async () => {
    const { transport, adapter, tick } = await rig();
    const cases: Array<[number, object, string]> = [
      [404, { code: "no-such-pane" }, "gone"],
      [404, { code: "no-such-action" }, "refused"],
      [409, { code: "not-supported" }, "unsupported"],
      [409, { code: "request-id-reused" }, "refused"],
      [422, { code: "action-refused", message: "Not now." }, "refused"],
      [400, { code: "bad-body" }, "refused"],
      [503, { code: "starting" }, "unreachable"],
      [502, { code: "internal" }, "unknown"],
      [200, { nonsense: true }, "unknown"],
    ];
    for (const [status, body, kind] of cases) {
      tick();
      transport.replyNext = { status, text: JSON.stringify(body), etag: null };
      const outcome = await adapter.controlTurn("conv-03", act());
      expect([status, JSON.stringify(body), outcome.kind]).toEqual([status, JSON.stringify(body), kind]);
      if (status === 422 && outcome.kind === "refused") expect(outcome.detail).toContain("Not now.");
    }
  });

  test("a POST that may have landed is unknown, and it is never sent again", async () => {
    const { transport, adapter } = await rig();
    transport.failNext = new DurableOutcomeUnknown("no answer within 5000ms");
    expect(await adapter.controlTurn("conv-03", act())).toEqual({ kind: "unknown", detail: "no answer within 5000ms" });
    expect(transport.posts).toHaveLength(1);
  });
});
