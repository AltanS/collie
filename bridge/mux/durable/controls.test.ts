import { afterEach, describe, expect, test } from "bun:test";

import type { ControlRequest } from "../../types.ts";
import type { MuxControlOutcome } from "../types.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { DurableOutcomeUnknown, DurableUnreachable, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { FakeDurableClock, FakeDurableProgram } from "./fixture.ts";
import { parseControlPost, parseControlReply, parseStaleControl } from "./protocol.ts";

// Send and abort on the durable adapter (ADR 0101, WIRE.md sections 4, 7.4, 7.5 and 7.6):
//
//   • `paneTurn` names a pane's newest turn from the last layout read, and asks nothing new.
//   • `controlTurn` checks the name against the layout before the socket; only a current name is
//     sent, as ONE POST. The client tells "nothing was sent" apart from "may have landed".
//   • The program's own answers map onto the outcomes the route renders.
//   • The body the adapter writes and the body a program reads are checked by one rule.

const ID = "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c";

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** The real socket client, with every POST counted and the next one failing on demand. */
class CountingTransport implements DurableTransport {
  readonly posts: DurablePost[] = [];
  failNext: Error | null = null;
  constructor(private readonly inner: DurableTransport) {}
  get(request: Parameters<DurableTransport["get"]>[0]): Promise<DurableReply> {
    return this.inner.get(request);
  }
  post(request: DurablePost): Promise<DurableReply> {
    this.posts.push(request);
    const failure = this.failNext;
    this.failNext = null;
    if (failure !== null) return Promise.reject(failure);
    return this.inner.post(request);
  }
}

async function rig() {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const transport = new CountingTransport(program.wire());
  const adapter = new DurableMux(transport, clock);
  expect((await adapter.poll()).ok).toBe(true);
  return { program, clock, transport, adapter, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS) };
}

const send = (over: Partial<Extract<ControlRequest, { act: "send" }>> = {}): ControlRequest => ({
  act: "send",
  requestId: ID,
  target: { kind: "turn", id: "turn-03-c" },
  text: "go on",
  steer: false,
  ...over,
});

describe("paneTurn", () => {
  test("names each listed pane's newest turn, and none for a pane the program does not list", async () => {
    const { adapter } = await rig();
    expect(adapter.paneTurn("conv-01")).toBe("turn-01-a");
    expect(adapter.paneTurn("conv-04")).toBe("turn-04-a");
    expect(adapter.paneTurn("conv-99")).toBeUndefined();
  });

  test("a turn that changed in the program is named after the next read", async () => {
    const { program, adapter, tick } = await rig();
    program.snapshot.panes = program.snapshot.panes.map((pane) => (pane.id === "conv-01" ? { ...pane, turnId: "turn-01-b" } : pane));
    program.touch();
    tick();
    await adapter.poll();
    expect(adapter.paneTurn("conv-01")).toBe("turn-01-b");
  });
});

describe("controlTurn", () => {
  test("an id that breaks the id rule is refused, and nothing is sent", async () => {
    const { transport, adapter } = await rig();
    expect((await adapter.controlTurn("conv-03", send({ target: { kind: "turn", id: "has space" } }))).kind).toBe("refused");
    expect((await adapter.controlTurn("conv/03", send())).kind).toBe("refused");
    expect(transport.posts).toEqual([]);
  });

  test("a stale name is refused with what is current, before the socket", async () => {
    const { transport, adapter } = await rig();
    expect(await adapter.controlTurn("conv-04", send({ target: { kind: "ask", id: "ask-old" } }))).toEqual({
      kind: "stale",
      turnId: "turn-04-a",
      askIds: ["ask-0a9b8c7d6e5f40312a3b4c5d6e7f8091"],
    });
    expect(transport.posts).toEqual([]);
  });

  test("an abort is one POST to the abort route, carrying the request id and the name only", async () => {
    const { transport, adapter } = await rig();
    expect(await adapter.controlTurn("conv-01", { act: "abort", requestId: ID, target: { kind: "turn", id: "turn-01-a" } })).toEqual({ kind: "ok", replayed: false });
    expect(transport.posts.map((p) => [p.path, p.body])).toEqual([["/pane/conv-01/abort", { requestId: ID, turnId: "turn-01-a" }]]);
  });

  test("a POST that never left is unreachable; one that may have landed is unknown; neither is sent again", async () => {
    const { transport, adapter, tick } = await rig();
    transport.failNext = new DurableUnreachable("connection refused");
    expect(await adapter.controlTurn("conv-03", send())).toEqual({ kind: "unreachable", detail: "connection refused" });
    tick();
    transport.failNext = new DurableOutcomeUnknown("no answer within 5000ms");
    expect(await adapter.controlTurn("conv-03", send())).toEqual({ kind: "unknown", detail: "no answer within 5000ms" });
    expect(transport.posts).toHaveLength(2);
  });

  test("the program's answers map onto the route's outcomes", async () => {
    const { program, adapter, tick } = await rig();
    const cases: Array<[number, object, MuxControlOutcome["kind"]]> = [
      [404, { code: "no-such-pane" }, "gone"],
      [409, { code: "not-supported" }, "unsupported"],
      [409, { code: "request-id-reused" }, "refused"],
      [400, { code: "bad-body" }, "refused"],
      [413, { code: "too-large" }, "refused"],
      [503, { code: "starting" }, "unreachable"],
      [502, { code: "internal" }, "unknown"],
      [200, { nonsense: true }, "unknown"],
    ];
    for (const [status, body, kind] of cases) {
      // A 503 sends the adapter back to `hello`: each case starts from a fresh read.
      tick();
      program.override = (path) => (path.endsWith("/send") ? new Response(JSON.stringify(body), { status }) : undefined);
      expect((await adapter.controlTurn("conv-03", send())).kind).toBe(kind);
    }
  });

  test("a program's stale that names no turn is read again from the layout", async () => {
    const { program, adapter } = await rig();
    program.override = (path) => (path.endsWith("/send") ? new Response(JSON.stringify({ code: "stale" }), { status: 409 }) : undefined);
    expect(await adapter.controlTurn("conv-03", send())).toEqual({ kind: "stale", turnId: "turn-03-c", askIds: [] });
  });

  test("a steer joins the running turn, and a follow-up to a running turn waits", async () => {
    const { program, adapter } = await rig();
    const running = { kind: "turn", id: "turn-01-a" } as const;
    expect((await adapter.controlTurn("conv-01", send({ target: running, steer: true }))).kind).toBe("ok");
    expect((await adapter.controlTurn("conv-01", send({ requestId: "1c0f7b2d-4e3a-4d6f-9b8c-2e3f4a5b6c7d", target: running }))).kind).toBe("ok");
    // Neither moved the turn: the same id still names it.
    expect(program.snapshot.panes.find((pane) => pane.id === "conv-01")?.turnId).toBe("turn-01-a");
    expect(program.sends.map((s) => s.steer)).toEqual([true, false]);
  });
});

describe("the wire shapes", () => {
  test("a control reply is `ok: true`, with `replayed` when the program saw the id before", () => {
    expect(parseControlReply('{"ok":true}')).toEqual({ replayed: false });
    expect(parseControlReply('{"ok":true,"replayed":true}')).toEqual({ replayed: true });
    expect(parseControlReply('{"ok":false}')).toBeNull();
    expect(parseControlReply("nope")).toBeNull();
  });

  test("a stale refusal's turn and ask ids are read under the id rule", () => {
    expect(parseStaleControl('{"code":"stale","turnId":"t2","askIds":["a1","has space",3,"a2"]}')).toEqual({ turnId: "t2", askIds: ["a1", "a2"] });
    expect(parseStaleControl('{"code":"stale","turnId":"a/b"}')).toEqual({ turnId: null, askIds: [] });
  });

  test("a program reads exactly one name, a request id, and for a send 1 to 32768 bytes of text", () => {
    expect(parseControlPost('{"requestId":"r","text":"hi","turnId":"t"}', "send")).toEqual({ requestId: "r", turnId: "t", askId: null, text: "hi", steer: false });
    expect(parseControlPost('{"requestId":"r","askId":"a","turnId":null}', "abort")).toEqual({ requestId: "r", turnId: null, askId: "a", text: "", steer: false });
    expect(parseControlPost("{", "send")).toBe("bad-json");
    for (const bad of [
      '{"requestId":"r","text":"hi"}',
      '{"requestId":"r","text":"hi","turnId":"t","askId":"a"}',
      '{"requestId":"r","text":"","turnId":"t"}',
      `{"requestId":"r","text":"${"a".repeat(32_769)}","turnId":"t"}`,
      '{"requestId":"r","text":"hi","turnId":"t","steer":"yes"}',
      '{"text":"hi","turnId":"t"}',
    ]) {
      expect(parseControlPost(bad, "send")).toBeNull();
    }
  });
});
