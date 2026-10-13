import { afterEach, describe, expect, test } from "bun:test";

import { withOpenAsks } from "../../durable/pane-asks.ts";
import type { PaneWire } from "../../types.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { DurableOutcomeUnknown, DurableSocketClient, DurableUnreachable, type DurablePost, type DurableReply, type DurableTransport } from "./client.ts";
import { FakeDurableClock, FakeDurableProgram, hasHostileChars, hostileText, SOCKET_ONLY_SKIP } from "./fixture.ts";
import type { DurableAsk } from "./protocol.ts";

// Asks as data on the durable adapter (ADR 0100, WIRE.md sections 4, 7.3, 7.6 and 8):
//
//   • `openAsks` lists a pane's open asks from the last layout read, cleaned, and only when the
//     program raises asks at all. The wire builder caps them at five.
//   • `answerAsk` is one POST. The client tells "nothing was sent" apart from "may have landed".
//   • A PERSON'S TAP ONLY: the adapter never sends an answer by itself, not while it polls, not on a
//     restart, and not after an answer whose outcome was unknown.

const programs: FakeDurableProgram[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** The real socket client, with every POST counted and the next ones failing on demand. */
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
  const read = async () => {
    clock.advance(MIN_SNAPSHOT_GAP_MS);
    return adapter.poll();
  };
  return { program, clock, transport, adapter, read };
}

function askOn(n: number, over: Partial<DurableAsk> = {}): DurableAsk {
  return {
    id: `ask-extra-${String(n)}`,
    kind: "permission",
    toolCallId: `call-extra-${String(n)}`,
    revision: 1,
    title: `shell wants to run job ${String(n)}`,
    itemId: `item-extra-${String(n)}`,
    options: [{ id: "allow", label: "Allow", effect: "allow" }],
    ...over,
  };
}

const WIRE_PANE: PaneWire = {
  paneId: "conv-02",
  workspaceId: "ws-notes",
  workspaceLabel: "notes",
  workspaceNumber: 1,
  tabId: "ws-notes:research",
  agent: "durable",
  status: "blocked",
  cwd: "/home/denis/notes/papers",
  focused: false,
  kind: "agent",
};

describe("openAsks", () => {
  test("a pane's open asks come from the last layout read, in the phone's shape", async () => {
    const { adapter, read } = await rig();
    expect(adapter.openAsks("conv-02")).toBeUndefined(); // nothing read yet
    expect((await read()).ok).toBe(true);
    expect(adapter.openAsks("conv-02")).toEqual([
      {
        id: "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c",
        kind: "permission",
        toolCallId: "call-02-1",
        revision: 1,
        title: "write_note wants to write /home/denis/notes/summary.txt",
        itemId: "item-02-7",
        options: [
          { id: "allow", label: "Allow once", effect: "allow" },
          { id: "always", label: "Always allow", effect: "allow-always" },
          { id: "deny", label: "Deny", effect: "deny" },
        ],
        reason: "The summary is the answer to your last question.",
        tool: { name: "write_note", summary: "path=/home/denis/notes/summary.txt" },
      },
    ]);
    expect(adapter.openAsks("conv-01")).toEqual([]);
    expect(adapter.openAsks("no-such-pane")).toBeUndefined();
  });

  test("a program that raises no asks gives its panes no asks field", async () => {
    const { program, adapter, read } = await rig();
    program.hello.caps.asks = false;
    expect((await read()).ok).toBe(true);
    expect(adapter.openAsks("conv-02")).toBeUndefined();
    expect(withOpenAsks(WIRE_PANE, adapter)).toBe(WIRE_PANE);
  });

  test("hostile ask text is cleaned before the phone sees it", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOn(1, { title: hostileText("rm"), reason: hostileText("because"), options: [{ id: "allow", label: hostileText("Yes"), effect: "allow" }] }));
    expect((await read()).ok).toBe(true);
    const [shown] = adapter.openAsks("conv-01") ?? [];
    for (const text of [shown?.title ?? "", shown?.reason ?? "", shown?.options[0]?.label ?? ""]) {
      expect(hasHostileChars(text.replaceAll("\n", ""))).toBe(false);
    }
    expect(Buffer.byteLength(shown?.title ?? "")).toBeLessThanOrEqual(256);
  });

  test("asks on the wire: every open ask is listed, and a pane of another adapter gains nothing", async () => {
    const { program, adapter, read } = await rig();
    for (let i = 1; i <= 6; i++) program.raiseAsk("conv-02", askOn(i));
    expect((await read()).ok).toBe(true);
    const wired = withOpenAsks(WIRE_PANE, adapter);
    expect(wired.asks?.map((a) => a.toolCallId)).toEqual(["call-02-1", ...[1, 2, 3, 4, 5, 6].map((i) => `call-extra-${String(i)}`)]);
    expect("moreAsks" in wired).toBe(false);
    const herdrPane: PaneWire = { ...WIRE_PANE, paneId: "w1:p1", agent: "claude" };
    expect(withOpenAsks(herdrPane, {})).toBe(herdrPane);
    expect("asks" in withOpenAsks(herdrPane, {})).toBe(false);
    // A durable pane with nothing open says so with an empty list.
    const quiet = withOpenAsks({ ...WIRE_PANE, paneId: "conv-01" }, adapter);
    expect(quiet.asks).toEqual([]);
  });

  test("asks on the wire: fifty open asks all reach the pane, the adapter's own cap", async () => {
    const { program, adapter, read } = await rig();
    for (let i = 1; i <= 60; i++) program.raiseAsk("conv-02", askOn(i));
    expect((await read()).ok).toBe(true);
    expect(withOpenAsks(WIRE_PANE, adapter).asks).toHaveLength(50);
  });

  test("an ask whose title or reason was cut or changed by cleaning carries cleaned: true", async () => {
    const { program, adapter, read } = await rig();
    program.raiseAsk("conv-01", askOn(1, { title: "plain title", reason: "plain reason" }));
    program.raiseAsk("conv-01", askOn(2, { title: `run\u200b ls` }));
    program.raiseAsk("conv-01", askOn(3, { title: "ok", reason: "x".repeat(5000) }));
    expect((await read()).ok).toBe(true);
    const shown = adapter.openAsks("conv-01") ?? [];
    const flag = (toolCallId: string) => shown.find((a) => a.toolCallId === toolCallId)?.cleaned;
    expect(shown.map((a) => a.toolCallId)).toEqual(["call-extra-1", "call-extra-2", "call-extra-3"]);
    expect(flag("call-extra-1")).toBeUndefined();
    expect(flag("call-extra-2")).toBe(true);
    expect(flag("call-extra-3")).toBe(true);
    expect("cleaned" in (shown[0] ?? {})).toBe(false);
  });
});

describe("the POST on the socket client", () => {
  // Socket only: the path of a socket that nothing listens on.
  test.skipIf(SOCKET_ONLY_SKIP)("a socket with nothing listening is `nothing was sent`", async () => {
    const program = await FakeDurableProgram.start();
    const path = program.socketPath;
    await program.close();
    const client = new DurableSocketClient(path);
    const sent = client.post({ path: "/pane/conv-02/answer", version: 1, body: {}, timeoutMs: 1000, maxBytes: 16384 });
    await expect(sent).rejects.toBeInstanceOf(DurableUnreachable);
  });

  test("a POST past its budget is `may have landed`, never retried", async () => {
    const program = await FakeDurableProgram.startWire();
    programs.push(program);
    let seen = 0;
    program.override = (path) => {
      if (!path.endsWith("/answer")) return undefined;
      seen += 1;
      return Bun.sleep(300).then(() => new Response(JSON.stringify({ result: "taken" }), { status: 200 }));
    };
    const client = program.wire();
    const sent = client.post({ path: "/pane/conv-02/answer", version: 1, body: {}, timeoutMs: 50, maxBytes: 16384 });
    await expect(sent).rejects.toBeInstanceOf(DurableOutcomeUnknown);
    await Bun.sleep(350);
    expect(seen).toBe(1);
  });
});

describe("a person's tap only (ADR 0100, rule 4)", () => {
  test("the adapter never answers on its own: through polls, a restart, a starting window and a dropped socket", async () => {
    const { program, adapter, transport, read } = await rig();
    expect((await read()).ok).toBe(true);
    for (let i = 0; i < 5; i++) await read();
    program.restartReasking();
    await read();
    program.ready = false;
    await read();
    program.ready = true;
    await read();
    await program.dropConnections();
    await read();
    await adapter.refresh();
    expect(transport.posts).toEqual([]);
    expect(program.requests.filter((q) => q.method === "POST")).toEqual([]);
    expect(program.answers).toEqual([]);
    // The asks are still open: nobody answered them.
    expect(program.asksOf("conv-02")).toHaveLength(1);
  });

  test("after an answer whose outcome was unknown, the adapter sends nothing more by itself", async () => {
    const { program, adapter, transport, read } = await rig();
    expect((await read()).ok).toBe(true);
    transport.failNext = new DurableOutcomeUnknown("no answer within 5000ms");
    const outcome = await adapter.answerAsk("conv-02", {
      requestId: "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c",
      askId: "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c",
      revision: 1,
      optionId: "allow",
    });
    expect(outcome).toEqual({ ok: true, value: { kind: "unknown", detail: "no answer within 5000ms" } });
    for (let i = 0; i < 5; i++) await read();
    program.restartReasking();
    await read();
    await read();
    expect(transport.posts).toHaveLength(1);
    expect(program.answers).toEqual([]);
  });

  test("an answer the adapter could not send leaves the next read to start with hello", async () => {
    const { program, adapter, transport, read } = await rig();
    expect((await read()).ok).toBe(true);
    transport.failNext = new DurableUnreachable("connection refused");
    const outcome = await adapter.answerAsk("conv-02", {
      requestId: "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c",
      askId: "ask-6f1d0c2a8b3e4d57a9c01e2b3d4f5a6c",
      revision: 1,
      optionId: "allow",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable", detail: "connection refused" });
    const before = program.requests.length;
    await read();
    expect(program.requests[before]?.path).toBe("/session/v1/hello");
  });

  test("an id that breaks the id rule never leaves the adapter", async () => {
    const { adapter, transport, read } = await rig();
    expect((await read()).ok).toBe(true);
    const outcome = await adapter.answerAsk("conv-02", {
      requestId: "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c",
      askId: "has space",
      revision: 1,
      optionId: "allow",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "refused" });
    expect(transport.posts).toEqual([]);
  });
});
