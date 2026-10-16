import { afterEach, describe, expect, test } from "bun:test";

import { muxConfigBody } from "../../server.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { DurableOutcomeUnknown, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { FakeDurableClock, FakeDurableProgram } from "./fixture.ts";
import { parseConversationItems, parseConversations } from "./protocol.ts";

// A durable program serves its own history and takes a reopen (WIRE.md 7.16, M53 spec 11):
//
//   • `caps.history` declares `programHistory`, `caps.reopen` declares `reopenConversation`, from the last good read.
//   • `listConversations` and `conversationItems` are reads, paged by the program's opaque cursor, cleaned.
//   • `reopenConversation` posts one `/reopen` with a request id it mints, never retries, and names the pane after.
//   • A program with no cap is not asked.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** The real client, with every POST counted and the next one failing on demand. */
class CountingTransport implements DurableTransport {
  readonly posts: DurablePost[] = [];
  readonly gets: string[] = [];
  failNext: Error | null = null;
  constructor(private readonly inner: DurableTransport) {}
  get(request: Parameters<DurableTransport["get"]>[0]): Promise<DurableReply> {
    this.gets.push(request.path);
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

const row = (id: string, state: "open" | "closed", extra: Record<string, string | number> = {}) => ({
  id,
  title: `T ${id}`,
  startedAt: "2026-10-13T09:00:00.000Z",
  state,
  items: 2,
  ...extra,
});
const reply = (id: string, text: string) => ({ id, kind: "reply", text, ts: "2026-10-13T09:00:00.000Z" });

async function rig(caps: { history: boolean; reopen: boolean } = { history: true, reopen: true }) {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  program.hello.caps.history = caps.history;
  program.hello.caps.reopen = caps.reopen;
  program.hello.caps.close = true;
  program.conversations = [
    { row: row("conv-01", "open"), items: [reply("a1", "one"), reply("a2", "two")] },
    { row: row("conv-gone", "closed", { endedAt: "2026-10-13T10:00:00.000Z" }), items: [reply("b1", "old"), reply("b2", "older")] },
  ];
  const clock = new FakeDurableClock();
  const transport = new CountingTransport(program.wire());
  const adapter = new DurableMux(transport, clock);
  expect((await adapter.poll()).ok).toBe(true);
  return { program, clock, transport, adapter, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS + 50) };
}

describe("history and reopen capabilities", () => {
  test("history: programHistory and reopenConversation follow the program's caps, and fail closed without them", async () => {
    const withCaps = await rig();
    expect(withCaps.adapter.capabilities.supports.programHistory).toBe(true);
    expect(withCaps.adapter.capabilities.supports.reopenConversation).toBe(true);
    expect(muxConfigBody(withCaps.adapter).capabilities.programHistory).toBe(true);

    const without = await rig({ history: false, reopen: false });
    expect(without.adapter.capabilities.supports.programHistory).toBe(false);
    expect(without.adapter.capabilities.supports.reopenConversation).toBe(false);
    const asked = without.transport.gets.length;
    const list = await without.adapter.listConversations({});
    expect(list).toMatchObject({ ok: false, reason: "unsupported", capability: "programHistory" });
    expect(await without.adapter.conversationItems("conv-01", {})).toMatchObject({ ok: false, reason: "unsupported" });
    expect(await without.adapter.reopenConversation("conv-gone")).toMatchObject({ ok: false, reason: "unsupported", capability: "reopenConversation" });
    // Not asked: no history GET and no POST left the adapter.
    expect(without.transport.gets.slice(asked).filter((path) => path.includes("conversation"))).toEqual([]);
    expect(without.transport.posts).toEqual([]);
  });

  test("history: before the first read the caps read absent", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    program.hello.caps.history = true;
    program.hello.caps.reopen = true;
    const adapter = new DurableMux(program.wire(), new FakeDurableClock());
    expect(adapter.capabilities.supports.programHistory).toBe(false);
    expect(adapter.capabilities.supports.reopenConversation).toBe(false);
  });
});

describe("the program's conversation list", () => {
  test("conversations: newest first, open and closed, an open one names its pane, and the cursor pages it", async () => {
    const { adapter, program } = await rig();
    const all = await adapter.listConversations({});
    if (!all.ok) throw new Error(all.detail);
    expect(all.value.items.map((item) => [item.id, item.state, item.paneId])).toEqual([
      ["conv-01", "open", "conv-01"],
      ["conv-gone", "closed", undefined],
    ]);
    expect(all.value.items[1]?.endedAt).toBe("2026-10-13T10:00:00.000Z");
    const first = await adapter.listConversations({ limit: 1 });
    if (!first.ok) throw new Error(first.detail);
    expect([first.value.items.map((item) => item.id), first.value.next]).toEqual([["conv-01"], "c1"]);
    const second = await adapter.listConversations({ after: first.value.next, limit: 1 });
    if (!second.ok) throw new Error(second.detail);
    expect([second.value.items.map((item) => item.id), second.value.next]).toEqual([["conv-gone"], undefined]);
    expect(program.requests.filter((request) => request.path.endsWith("/conversations")).map((request) => request.search)).toEqual(["", "?limit=1", "?after=c1&limit=1"]);
  });

  test("conversations: a cursor the program never gave is refused before anything is sent, and a 400 is a refusal", async () => {
    const { adapter, transport, program } = await rig();
    const before = transport.gets.length;
    expect(await adapter.listConversations({ after: "has space" })).toMatchObject({ ok: false, reason: "refused" });
    expect(await adapter.listConversations({ limit: 0 })).toMatchObject({ ok: false, reason: "refused" });
    expect(transport.gets.slice(before).filter((path) => path.includes("conversations"))).toEqual([]);
    expect(await adapter.listConversations({ after: "zzz" })).toMatchObject({ ok: false, reason: "refused" });
    expect(program.requests.at(-1)?.search).toBe("?after=zzz");
  });

  test("conversations: a row that breaks a rule is dropped alone, and a page with a bad next is not read", () => {
    const parsed = parseConversations(
      JSON.stringify({
        items: [row("good", "closed"), row("a b", "open"), { ...row("no-start", "open"), startedAt: "yesterday" }, { ...row("odd", "open"), state: "paused" }, row("good", "open")],
      }),
    );
    expect(parsed.ok && parsed.value.items.map((item) => [item.id, item.state])).toEqual([["good", "closed"]]);
    expect(parseConversations(JSON.stringify({ items: [], next: "has space" })).ok).toBe(false);
    expect(parseConversations(JSON.stringify({ items: Array.from({ length: 101 }, (_, n) => row(`c${String(n)}`, "open")) })).ok).toBe(false);
    const cleaned = parseConversations(JSON.stringify({ items: [{ ...row("x", "open"), title: "a\u0007b", subtitle: "  line  " }] }));
    expect(cleaned.ok && cleaned.value.items[0]).toMatchObject({ title: "ab", subtitle: "line" });
  });
});

describe("one conversation's items", () => {
  test("conversations: items oldest first, open and closed alike, paged with more and next", async () => {
    const { adapter } = await rig();
    const closed = await adapter.conversationItems("conv-gone", {});
    if (!closed.ok) throw new Error(closed.detail);
    expect([closed.value.items.map((item) => item.id), closed.value.more, closed.value.next]).toEqual([["b1", "b2"], false, undefined]);
    const first = await adapter.conversationItems("conv-01", { limit: 1 });
    if (!first.ok) throw new Error(first.detail);
    expect([first.value.items.map((item) => item.id), first.value.more, first.value.next]).toEqual([["a1"], true, "i1"]);
    const rest = await adapter.conversationItems("conv-01", { after: "i1" });
    if (!rest.ok) throw new Error(rest.detail);
    expect(rest.value.items.map((item) => item.id)).toEqual(["a2"]);
  });

  test("conversations: an unknown conversation, or an id that breaks the rule, is gone", async () => {
    const { adapter, transport } = await rig();
    expect(await adapter.conversationItems("nobody", {})).toMatchObject({ ok: false, reason: "gone" });
    const before = transport.gets.length;
    expect(await adapter.conversationItems("a b", {})).toMatchObject({ ok: false, reason: "gone" });
    expect(transport.gets.length).toBe(before);
  });

  test("conversations: a bad item is dropped and counted, a second version of an id replaces the first in place", () => {
    const parsed = parseConversationItems(
      JSON.stringify({ items: [reply("a", "one"), { id: "b", kind: "mystery" }, reply("c", "three"), reply("a", "one, longer")], more: false }),
    );
    expect(parsed.ok && parsed.value.items.map((item) => [item.id, "text" in item ? item.text : ""])).toEqual([
      ["a", "one, longer"],
      ["c", "three"],
    ]);
    expect(parsed.ok && parsed.value.droppedItems).toBe(1);
    // `more` without a `next` cannot go on, so it reads as the last page.
    const stuck = parseConversationItems(JSON.stringify({ items: [], more: true }));
    expect(stuck.ok && stuck.value.more).toBe(false);
  });
});

describe("reopen", () => {
  test("reopen: a closed pane comes back under the same id after one POST, and the answer names it", async () => {
    const { adapter, transport, program, tick } = await rig();
    expect(await adapter.closePane("conv-02")).toEqual({ ok: true, value: undefined });
    tick();
    expect((await adapter.snapshot()).panes.some((pane) => pane.paneId === "conv-02")).toBe(false);
    const posts = transport.posts.length;
    tick();
    const reopened = await adapter.reopenConversation("conv-02");
    expect(reopened).toEqual({ ok: true, value: { paneId: "conv-02" } });
    expect(transport.posts.length).toBe(posts + 1);
    const body = { requestId: "", id: "", ...transport.posts.at(-1)?.body };
    expect(body.id).toBe("conv-02");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(program.reopens).toEqual([{ requestId: body.requestId, id: "conv-02" }]);
    expect((await adapter.snapshot()).panes.some((pane) => pane.paneId === "conv-02")).toBe(true);
  });

  test("reopen: the program's refusals map onto the route's refusals", async () => {
    const { adapter, program, tick } = await rig();
    expect(await adapter.reopenConversation("nobody")).toMatchObject({ ok: false, reason: "gone" });
    await adapter.closePane("conv-02");
    tick();
    program.reopenRefusal = "archived for good";
    expect(await adapter.reopenConversation("conv-02")).toMatchObject({ ok: false, reason: "refused", detail: "The durable agent did not bring this conversation back: archived for good" });
    expect(await adapter.reopenConversation("a b")).toMatchObject({ ok: false, reason: "refused" });
  });

  test("reopen: a POST that may have left is a refusal that says so, and it is never sent again", async () => {
    const { adapter, transport, tick } = await rig();
    await adapter.closePane("conv-02");
    tick();
    const posts = transport.posts.length;
    transport.failNext = new DurableOutcomeUnknown("the connection dropped after the request left");
    const outcome = await adapter.reopenConversation("conv-02");
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.detail).toContain("may have been reopened");
    expect(transport.posts.length).toBe(posts + 1);
  });
});
