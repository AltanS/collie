import { afterEach, describe, expect, test } from "bun:test";

import { MUX_CAPABILITIES } from "../capabilities.ts";
import { muxConfigBody } from "../../server.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { DurableOutcomeUnknown, DurableUnreachable, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { durableHttpWorld, durableWorld, FakeDurableClock, FakeDurableProgram } from "./fixture.ts";
import { parseClosePost, parseHello } from "./protocol.ts";

// A durable program closes a conversation or a tab through its own `close` cap (WIRE.md sections 3, 4 and 7.9):
//
//   • The cap of the last good read declares `closePane` and `closeTab`, and no other capability changes with it.
//     There is no workspace close capability: the phone has no control for one, so a workspace close stays on the wire.
//   • `closePane` and `closeTab` post one `/close` with a request id they mint, and never retry.
//   • The program's answers map onto the refusals the close routes render.
//   • A program with no cap is not asked.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** The real socket client, with every POST counted and the next one failing or answering on demand. */
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

async function rig(options: { close: boolean } = { close: true }) {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  program.hello.caps.close = options.close;
  const clock = new FakeDurableClock();
  const transport = new CountingTransport(program.wire());
  const adapter = new DurableMux(transport, clock);
  expect((await adapter.poll()).ok).toBe(true);
  return { program, clock, transport, adapter, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS) };
}

const paneIds = async (adapter: DurableMux) => (await adapter.snapshot()).panes.map((pane) => pane.paneId);
const tabIds = async (adapter: DurableMux) => (await adapter.snapshot()).tabs.map((tab) => tab.tabId);

describe("close capability", () => {
  test("closePane and closeTab follow the program's own caps.close, and nothing else changes with it", async () => {
    const withCap = await rig({ close: true });
    expect(withCap.adapter.capabilities.supports.closePane).toBe(true);
    expect(withCap.adapter.capabilities.supports.closeTab).toBe(true);
    expect(muxConfigBody(withCap.adapter).capabilities.closePane).toBe(true);
    expect(muxConfigBody(withCap.adapter).capabilities.closeTab).toBe(true);
    for (const other of MUX_CAPABILITIES.filter((capability) => ["renamePane", "createTab", "createSpace", "renameTab", "renameSpace"].includes(capability))) {
      expect(withCap.adapter.capabilities.supports[other]).toBe(false);
    }

    const without = await rig({ close: false });
    expect(without.adapter.capabilities.supports.closePane).toBe(false);
    expect(without.adapter.capabilities.supports.closeTab).toBe(false);
    expect(muxConfigBody(without.adapter).capabilities.closePane).toBe(false);
  });

  test("the cap is absent before the first read, and replaced by the next hello", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    program.hello.caps.close = true;
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(program.wire(), clock);
    expect(adapter.capabilities.supports.closePane).toBe(false);
    await adapter.snapshot();
    expect(adapter.capabilities.supports.closePane).toBe(true);
    program.hello.caps.close = false;
    program.restart();
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    await adapter.snapshot();
    expect(adapter.capabilities.supports.closePane).toBe(false);
  });

  test("hello decodes close: true, and an absent close is false", () => {
    const hello = (caps: Record<string, boolean>) =>
      parseHello(JSON.stringify({ service: "collie-durable", protocol: { min: 1, max: 1 }, host: { name: "h" }, epoch: "e", ready: true, caps }));
    const on = hello({ close: true });
    const off = hello({ asks: true });
    expect(on.ok && on.value.caps.close).toBe(true);
    expect(off.ok && off.value.caps.close).toBe(false);
  });

  test("the close body is read by one rule: three kinds, a request id and an id", () => {
    expect(parseClosePost(JSON.stringify({ requestId: "r", kind: "workspace", id: "w" }))).toEqual({ requestId: "r", kind: "workspace", id: "w" });
    expect(parseClosePost(JSON.stringify({ requestId: "r", kind: "space", id: "w" }))).toBeNull();
    expect(parseClosePost(JSON.stringify({ kind: "pane", id: "w" }))).toBeNull();
    expect(parseClosePost("{")).toBe("bad-json");
  });
});

describe("closePane", () => {
  test("posts /close with a fresh request id, kind pane and the id, and the next read no longer lists it", async () => {
    const { adapter, transport, program } = await rig();
    expect(await paneIds(adapter)).toContain("conv-01");
    const answer = await adapter.closePane("conv-01");
    expect(answer.ok).toBe(true);
    expect(transport.posts).toHaveLength(1);
    const post = transport.posts[0]!;
    expect(post.path).toBe("/close");
    expect(post.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), kind: "pane", id: "conv-01" });
    expect(program.closes).toHaveLength(1);
    const ids = await paneIds(adapter);
    expect(ids).not.toContain("conv-01");
    expect(ids).toContain("conv-02");
  });

  test("each call mints its own request id", async () => {
    const { adapter, transport } = await rig();
    await adapter.closePane("conv-01");
    await adapter.closePane("conv-03");
    const [a, b] = transport.posts.map((post) => parseClosePost(JSON.stringify(post.body)));
    expect(a).toMatchObject({ kind: "pane", id: "conv-01" });
    expect(b).toMatchObject({ kind: "pane", id: "conv-03" });
    expect(a !== "bad-json" && a?.requestId).not.toBe(b !== "bad-json" && b?.requestId);
  });

  test("with the cap absent the verb answers unsupported, names closePane, and touches no socket", async () => {
    const { adapter, program, transport } = await rig({ close: false });
    const before = program.requests.length;
    expect(await adapter.closePane("conv-01")).toMatchObject({ ok: false, reason: "unsupported", capability: "closePane" });
    expect(await adapter.closeTab("ws-notes:main")).toMatchObject({ ok: false, reason: "unsupported", capability: "closeTab" });
    expect(transport.posts).toEqual([]);
    expect(program.requests.length).toBe(before);
  });

  test("a cap that went away since the last read is read again before anything is posted", async () => {
    const { adapter, program, transport, tick } = await rig();
    program.hello.caps.close = false;
    program.restart();
    tick();
    expect(await adapter.closePane("conv-01")).toMatchObject({ ok: false, reason: "unsupported", capability: "closePane" });
    expect(transport.posts).toEqual([]);
  });

  test("an id that breaks the rule is refused and nothing is sent", async () => {
    const { adapter, transport } = await rig();
    expect(await adapter.closePane("conv 01")).toMatchObject({ ok: false, reason: "refused" });
    expect(transport.posts).toEqual([]);
  });

  test("a pane the layout does not list is gone, a tab id is not a pane id, and nothing is sent", async () => {
    const { adapter, transport } = await rig();
    expect(await adapter.closePane("conv-99")).toMatchObject({ ok: false, reason: "gone" });
    expect(await adapter.closePane("ws-notes:main")).toMatchObject({ ok: false, reason: "gone" });
    expect(transport.posts).toEqual([]);
  });

  test("a pane that left between the read and the post: 404 no-such-target is gone", async () => {
    const { adapter, program, transport } = await rig();
    transport.replyNext = { status: 404, text: JSON.stringify({ code: "no-such-target" }), etag: null };
    expect(await adapter.closePane("conv-01")).toMatchObject({ ok: false, reason: "gone" });
    expect(program.closes).toEqual([]);
  });

  test("422 close-refused is a refusal that carries the program's words, and the pane stays", async () => {
    const { adapter, program } = await rig();
    program.closeRefusal = "A running turn cannot be closed.";
    const answer = await adapter.closePane("conv-01");
    expect(answer).toMatchObject({ ok: false, reason: "refused" });
    if (!answer.ok) expect(answer.detail).toContain("A running turn cannot be closed.");
    expect(await paneIds(adapter)).toContain("conv-01");
    program.closeRefusal = null;
    expect((await adapter.closePane("conv-01")).ok).toBe(true);
  });

  test("409 not-supported from the program is unsupported", async () => {
    const { adapter, transport } = await rig();
    transport.replyNext = { status: 409, text: JSON.stringify({ code: "not-supported" }), etag: null };
    expect(await adapter.closePane("conv-01")).toMatchObject({ ok: false, reason: "unsupported", capability: "closePane" });
  });

  test("503 starting is unreachable", async () => {
    const { adapter, transport } = await rig();
    transport.replyNext = { status: 503, text: JSON.stringify({ code: "starting" }), etag: null };
    expect(await adapter.closePane("conv-01")).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("400, 403 and 409 request-id-reused are refusals that name the code", async () => {
    const { adapter, transport } = await rig();
    for (const [status, code] of [
      [400, "bad-body"],
      [403, "caller-refused"],
      [409, "request-id-reused"],
    ] as const) {
      transport.replyNext = { status, text: JSON.stringify({ code }), etag: null };
      const answer = await adapter.closePane("conv-01");
      expect(answer).toMatchObject({ ok: false, reason: "refused" });
      if (!answer.ok) expect(answer.detail).toContain(code);
    }
  });

  test("a POST that may have left, a 5xx and an unreadable 200 say the close may have been applied, and it is never retried", async () => {
    const { adapter, transport } = await rig();
    const nexts: readonly (DurableOutcomeUnknown | DurableReply)[] = [
      new DurableOutcomeUnknown("timed out after 3000ms"),
      { status: 500, text: JSON.stringify({ code: "internal" }), etag: null },
      { status: 200, text: "not json", etag: null },
    ];
    for (const next of nexts) {
      transport.posts.length = 0;
      if (next instanceof DurableOutcomeUnknown) transport.failNext = next;
      else transport.replyNext = next;
      const answer = await adapter.closePane("conv-01");
      expect(answer).toMatchObject({ ok: false, reason: "refused" });
      if (!answer.ok) expect(answer.detail).toContain("may have been closed");
      expect(transport.posts).toHaveLength(1);
    }
  });

  test("a POST that never left is unreachable, and the next read starts with hello", async () => {
    const { adapter, transport, program, tick } = await rig();
    transport.failNext = new DurableUnreachable("connection refused");
    expect(await adapter.closePane("conv-01")).toMatchObject({ ok: false, reason: "unreachable" });
    program.requests.length = 0;
    tick();
    await adapter.poll();
    expect(program.requests.map((request) => request.path.replace("/session/v1", ""))).toEqual(["/hello", "/snapshot"]);
  });
});

describe("closeTab", () => {
  test("posts /close with kind tab, and the tab and the conversations in it leave the next read", async () => {
    const { adapter, transport, program } = await rig();
    const answer = await adapter.closeTab("ws-notes:research");
    expect(answer.ok).toBe(true);
    expect(transport.posts[0]!.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), kind: "tab", id: "ws-notes:research" });
    expect(program.closes).toMatchObject([{ kind: "tab", id: "ws-notes:research" }]);
    expect(await tabIds(adapter)).not.toContain("ws-notes:research");
    expect(await paneIds(adapter)).not.toContain("conv-02"); // its ask went with it
    expect(await paneIds(adapter)).toContain("conv-01");
  });

  test("a tab the layout does not list is gone, a pane id is not a tab id, and nothing is sent", async () => {
    const { adapter, transport } = await rig();
    expect(await adapter.closeTab("ws-notes:nope")).toMatchObject({ ok: false, reason: "gone" });
    expect(await adapter.closeTab("conv-01")).toMatchObject({ ok: false, reason: "gone" });
    expect(transport.posts).toEqual([]);
  });

  test("a 422 and a missing answer name the tab", async () => {
    const { adapter, program, transport } = await rig();
    program.closeRefusal = "Keep this one.";
    const refused = await adapter.closeTab("ws-notes:main");
    expect(refused).toMatchObject({ ok: false, reason: "refused" });
    if (!refused.ok) expect(refused.detail).toContain("Keep this one.");
    transport.failNext = new DurableOutcomeUnknown("no answer within 3000ms");
    const unknown = await adapter.closeTab("ws-notes:main");
    if (!unknown.ok) expect(unknown.detail).toContain("tab may have been closed");
  });
});

describe("close in the conformance worlds", () => {
  for (const [name, make] of [
    ["socket", durableWorld],
    ["https with a bearer token", durableHttpWorld],
  ] as const) {
    test(`close over ${name}: the adapter declares closePane and closeTab, closes a pane and then a tab, and the next snapshot drops them`, async () => {
      const world = await make();
      try {
        const { adapter } = world;
        const before = await adapter.snapshot();
        expect(adapter.capabilities.supports.closePane).toBe(true);
        expect(adapter.capabilities.supports.closeTab).toBe(true);
        const pane = before.panes[0]!;
        expect((await adapter.closePane(pane.paneId)).ok).toBe(true);
        const afterPane = await adapter.snapshot();
        expect(afterPane.panes.some((candidate) => candidate.paneId === pane.paneId)).toBe(false);
        expect(afterPane.panes.length).toBe(before.panes.length - 1);
        const tab = afterPane.tabs[0]!;
        expect((await adapter.closeTab(tab.tabId)).ok).toBe(true);
        const afterTab = await adapter.snapshot();
        expect(afterTab.tabs.some((candidate) => candidate.tabId === tab.tabId)).toBe(false);
        expect(afterTab.panes.every((candidate) => candidate.tabId !== tab.tabId)).toBe(true);
      } finally {
        await world.close();
      }
    });
  }
});
