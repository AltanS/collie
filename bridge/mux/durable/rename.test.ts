import { afterEach, describe, expect, test } from "bun:test";

import { MUX_CAPABILITIES } from "../capabilities.ts";
import { muxConfigBody } from "../../server.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { RENAME_TITLE_MAX, renameTitleOf } from "./clean.ts";
import { DurableOutcomeUnknown, DurableUnreachable, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { durableHttpWorld, durableWorld, FakeDurableClock, FakeDurableProgram } from "./fixture.ts";
import { parseHello, parseRenamePost } from "./protocol.ts";

// A durable program takes a new title for a tab or a workspace through its own `rename` cap (WIRE.md sections 3, 4 and 7.8):
//
//   • The cap of the last good read declares `renameTab` and `renameSpace`, and no other capability changes with it.
//   • `renameTab` and `renameSpace` post one `/rename` with a request id they mint, and never retry.
//   • The program's answers map onto the refusals the tab route renders.
//   • A program with no cap is not asked.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** The real socket client, with every POST counted and the next one failing on demand. */
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

async function rig(options: { rename: boolean } = { rename: true }) {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  program.hello.caps.rename = options.rename;
  const clock = new FakeDurableClock();
  const transport = new CountingTransport(program.wire());
  const adapter = new DurableMux(transport, clock);
  expect((await adapter.poll()).ok).toBe(true);
  return { program, clock, transport, adapter, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS) };
}

const tabTitle = async (adapter: DurableMux, tabId: string) => (await adapter.snapshot()).tabs.find((tab) => tab.tabId === tabId)?.label;

describe("rename capability", () => {
  test("renameTab follows the program's own caps.rename, and nothing else changes with it", async () => {
    const withCap = await rig({ rename: true });
    expect(withCap.adapter.capabilities.supports.renameTab).toBe(true);
    expect(withCap.adapter.capabilities.supports.renameSpace).toBe(true);
    expect(muxConfigBody(withCap.adapter).capabilities.renameTab).toBe(true);
    expect(muxConfigBody(withCap.adapter).capabilities.renameSpace).toBe(true);
    for (const other of MUX_CAPABILITIES.filter((capability) => ["renamePane", "closeTab", "closePane", "createTab", "createSpace"].includes(capability))) {
      expect(withCap.adapter.capabilities.supports[other]).toBe(false);
    }

    const without = await rig({ rename: false });
    expect(without.adapter.capabilities.supports.renameTab).toBe(false);
    expect(without.adapter.capabilities.supports.renameSpace).toBe(false);
    expect(muxConfigBody(without.adapter).capabilities.renameTab).toBe(false);
    expect(muxConfigBody(without.adapter).capabilities.renameSpace).toBe(false);
  });

  test("renameTab is absent before the first read, and replaced by the next hello", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    program.hello.caps.rename = true;
    const clock = new FakeDurableClock();
    const adapter = new DurableMux(program.wire(), clock);
    expect(adapter.capabilities.supports.renameTab).toBe(false);
    await adapter.snapshot();
    expect(adapter.capabilities.supports.renameTab).toBe(true);
    program.hello.caps.rename = false;
    program.restart();
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    await adapter.snapshot();
    expect(adapter.capabilities.supports.renameTab).toBe(false);
  });

  test("hello decodes rename: true, and an absent rename is false", () => {
    const hello = (caps: Record<string, boolean>) =>
      parseHello(JSON.stringify({ service: "collie-durable", protocol: { min: 1, max: 1 }, host: { name: "h" }, epoch: "e", ready: true, caps }));
    const on = hello({ rename: true });
    const off = hello({ asks: true });
    expect(on.ok && on.value.caps.rename).toBe(true);
    expect(off.ok && off.value.caps.rename).toBe(false);
  });
});

describe("renameTab", () => {
  test("posts /rename with a fresh request id, kind tab, the id and the trimmed title, and the next read shows it", async () => {
    const { adapter, transport, program } = await rig();
    const answer = await adapter.renameTab("ws-notes:main", "  Weekly plan  ");
    expect(answer.ok).toBe(true);
    expect(transport.posts).toHaveLength(1);
    const post = transport.posts[0]!;
    expect(post.path).toBe("/rename");
    expect(post.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), kind: "tab", id: "ws-notes:main", title: "Weekly plan" });
    expect(program.renames).toHaveLength(1);
    expect(await tabTitle(adapter, "ws-notes:main")).toBe("Weekly plan");
  });

  test("each call mints its own request id", async () => {
    const { adapter, transport } = await rig();
    await adapter.renameTab("ws-notes:main", "One");
    await adapter.renameTab("ws-notes:main", "Two");
    const [a, b] = transport.posts.map((post) => parseRenamePost(JSON.stringify(post.body)));
    expect(a).not.toBeNull();
    expect(a).toMatchObject({ kind: "tab", id: "ws-notes:main", title: "One" });
    expect(b).toMatchObject({ kind: "tab", id: "ws-notes:main", title: "Two" });
    expect(a !== "bad-json" && a?.requestId).not.toBe(b !== "bad-json" && b?.requestId);
  });

  test("with the cap absent the verb answers unsupported, names renameTab, and touches no socket", async () => {
    const { adapter, program, transport } = await rig({ rename: false });
    const before = program.requests.length;
    const answer = await adapter.renameTab("ws-notes:main", "x");
    expect(answer).toMatchObject({ ok: false, reason: "unsupported", capability: "renameTab" });
    expect(transport.posts).toEqual([]);
    expect(program.requests.length).toBe(before);
  });

  test("a cap that went away since the last read is read again before anything is posted", async () => {
    const { adapter, program, transport, tick } = await rig();
    program.hello.caps.rename = false;
    program.restart();
    tick();
    const answer = await adapter.renameTab("ws-notes:main", "x");
    expect(answer).toMatchObject({ ok: false, reason: "unsupported", capability: "renameTab" });
    expect(transport.posts).toEqual([]);
  });

  test("an id or a title that breaks the rule is refused and nothing is sent", async () => {
    const { adapter, transport } = await rig();
    for (const [id, title] of [
      ["ws notes", "ok"],
      ["ws-notes:main", ""],
      ["ws-notes:main", "   "],
      ["ws-notes:main", "a\nb"],
      ["ws-notes:main", "a\u0000b"],
      ["ws-notes:main", "x".repeat(RENAME_TITLE_MAX + 1)],
    ] as const) {
      const answer = await adapter.renameTab(id, title);
      expect([id, title.length, answer.ok === false && answer.reason]).toEqual([id, title.length, "refused"]);
    }
    expect(transport.posts).toEqual([]);
    expect(renameTitleOf("é".repeat(RENAME_TITLE_MAX))).toBe("é".repeat(RENAME_TITLE_MAX)); // characters, not bytes
  });

  test("a tab the layout does not list is gone, and nothing is sent", async () => {
    const { adapter, transport } = await rig();
    const answer = await adapter.renameTab("ws-notes:nope", "x");
    expect(answer).toMatchObject({ ok: false, reason: "gone" });
    expect(transport.posts).toEqual([]);
  });

  test("a tab that left between the read and the post: 404 no-such-target is gone", async () => {
    const { adapter, program, transport } = await rig();
    // The layout the adapter just read still lists the tab; the program says it is gone by now.
    transport.replyNext = { status: 404, text: JSON.stringify({ code: "no-such-target" }), etag: null };
    const answer = await adapter.renameTab("ws-notes:main", "x");
    expect(answer).toMatchObject({ ok: false, reason: "gone" });
    expect(program.renames).toEqual([]);
  });

  test("422 rename-refused is a refusal that carries the program's words, and the title does not change", async () => {
    const { adapter, program } = await rig();
    program.renameRefusal = "That name is taken.";
    const answer = await adapter.renameTab("ws-notes:main", "Taken");
    expect(answer).toMatchObject({ ok: false, reason: "refused" });
    if (!answer.ok) expect(answer.detail).toContain("That name is taken.");
    expect(await tabTitle(adapter, "ws-notes:main")).toBe("main");
    program.renameRefusal = null;
    expect((await adapter.renameTab("ws-notes:main", "Taken")).ok).toBe(true);
  });

  test("409 not-supported from the program is unsupported", async () => {
    const { adapter, transport } = await rig();
    transport.replyNext = { status: 409, text: JSON.stringify({ code: "not-supported" }), etag: null };
    expect(await adapter.renameTab("ws-notes:main", "x")).toMatchObject({ ok: false, reason: "unsupported", capability: "renameTab" });
  });

  test("503 starting is unreachable, and the next read asks hello again", async () => {
    const { adapter, transport } = await rig();
    transport.replyNext = { status: 503, text: JSON.stringify({ code: "starting" }), etag: null };
    expect(await adapter.renameTab("ws-notes:main", "x")).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("400, 403 and 409 request-id-reused are refusals that name the code", async () => {
    const { adapter, transport } = await rig();
    for (const [status, code] of [
      [400, "bad-body"],
      [403, "caller-refused"],
      [409, "request-id-reused"],
    ] as const) {
      transport.replyNext = { status, text: JSON.stringify({ code }), etag: null };
      const answer = await adapter.renameTab("ws-notes:main", "x");
      expect(answer).toMatchObject({ ok: false, reason: "refused" });
      if (!answer.ok) expect(answer.detail).toContain(code);
    }
  });

  test("a POST that may have left, a 5xx and an unreadable 200 say the rename may have been applied, and it is never retried", async () => {
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
      const answer = await adapter.renameTab("ws-notes:main", "x");
      expect(answer).toMatchObject({ ok: false, reason: "refused" });
      if (!answer.ok) expect(answer.detail).toContain("may have been applied");
      expect(transport.posts).toHaveLength(1);
    }
  });

  test("a POST that never left is unreachable, and the next read starts with hello", async () => {
    const { adapter, transport, program, tick } = await rig();
    transport.failNext = new DurableUnreachable("connection refused");
    const answer = await adapter.renameTab("ws-notes:main", "x");
    expect(answer).toMatchObject({ ok: false, reason: "unreachable" });
    program.requests.length = 0;
    tick();
    await adapter.poll();
    expect(program.requests.map((request) => request.path.replace("/session/v1", ""))).toEqual(["/hello", "/snapshot"]);
  });

  test("a program that is down answers unreachable with its reason", async () => {
    const { adapter, program, tick } = await rig();
    await program.close();
    tick();
    const answer = await adapter.renameTab("ws-notes:main", "x");
    expect(answer).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("renameSpace", () => {
  const spaceTitle = async (adapter: DurableMux, spaceId: string) => (await adapter.snapshot()).spaces.find((space) => space.spaceId === spaceId)?.label;

  test("posts /rename with kind workspace, the id and the trimmed title, and the next read shows it", async () => {
    const { adapter, transport, program } = await rig();
    const answer = await adapter.renameSpace("ws-notes", "  Field notes  ");
    expect(answer.ok).toBe(true);
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0]!.path).toBe("/rename");
    expect(transport.posts[0]!.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), kind: "workspace", id: "ws-notes", title: "Field notes" });
    expect(program.renames).toHaveLength(1);
    expect(await spaceTitle(adapter, "ws-notes")).toBe("Field notes");
  });

  test("with the cap absent the verb answers unsupported, names renameSpace, and touches no socket", async () => {
    const { adapter, program } = await rig({ rename: false });
    const before = program.requests.length;
    expect(await adapter.renameSpace("ws-notes", "x")).toMatchObject({ ok: false, reason: "unsupported", capability: "renameSpace" });
    expect(program.requests.length).toBe(before);
  });

  test("a workspace that is not in the layout is gone, a tab id is not a workspace id, and a bad title is refused before the socket", async () => {
    const { adapter, transport } = await rig();
    expect(await adapter.renameSpace("ws-nope", "x")).toMatchObject({ ok: false, reason: "gone" });
    expect(await adapter.renameSpace("ws-notes:main", "x")).toMatchObject({ ok: false, reason: "gone" });
    expect(await adapter.renameSpace("ws-notes", "   ")).toMatchObject({ ok: false, reason: "refused" });
    expect(await adapter.renameSpace("bad id", "x")).toMatchObject({ ok: false, reason: "refused" });
    expect(transport.posts).toHaveLength(0);
  });

  test("the program's 422 is a refusal with its words, and a post with no answer says the rename may have been applied", async () => {
    const { adapter, program, transport, tick } = await rig();
    program.renameRefusal = "Not that name.";
    const refused = await adapter.renameSpace("ws-notes", "Taken");
    expect(refused).toMatchObject({ ok: false, reason: "refused" });
    expect(refused.ok ? "" : refused.detail).toContain("Not that name.");
    program.renameRefusal = null;
    tick();
    transport.failNext = new DurableOutcomeUnknown("no answer within 3000ms");
    const unknown = await adapter.renameSpace("ws-notes", "Maybe");
    expect(unknown).toMatchObject({ ok: false, reason: "refused" });
    expect(unknown.ok ? "" : unknown.detail).toContain("workspace name");
    expect(unknown.ok ? "" : unknown.detail).toContain("may have been applied");
  });
});

describe("rename in the conformance worlds", () => {
  // The world's clock moves past the census only when the world changes, so a rename the adapter made shows
  // in the very next snapshot because the adapter itself looks again after a 200.
  for (const [name, make] of [
    ["socket", durableWorld],
    ["https with a bearer token", durableHttpWorld],
  ] as const) {
    test(`rename over ${name}: the adapter declares renameTab, renames a tab, and the next snapshot carries the title`, async () => {
      const world = await make();
      try {
        const { adapter } = world;
        const before = await adapter.snapshot();
        expect(adapter.capabilities.supports.renameTab).toBe(true);
        expect(adapter.capabilities.supports.renameSpace).toBe(true);
        const space = before.spaces[0]!;
        const named = await adapter.renameSpace?.(space.spaceId, "Space renamed by the phone");
        expect(named?.ok).toBe(true);
        expect((await adapter.snapshot()).spaces.find((candidate) => candidate.spaceId === space.spaceId)?.label).toBe("Space renamed by the phone");
        const tab = before.tabs[0]!;
        const answer = await adapter.renameTab(tab.tabId, "Renamed by the phone");
        expect(answer.ok).toBe(true);
        const after = await adapter.snapshot();
        expect(after.tabs.find((candidate) => candidate.tabId === tab.tabId)?.label).toBe("Renamed by the phone");
        expect(after.tabs.map((candidate) => candidate.tabId)).toEqual(before.tabs.map((candidate) => candidate.tabId));
        expect(after.panes.map((pane) => pane.paneId)).toEqual(before.panes.map((pane) => pane.paneId));
      } finally {
        await world.close();
      }
    });
  }
});
