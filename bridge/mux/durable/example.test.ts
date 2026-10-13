import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ControlRequest } from "../../types.ts";
import { DurableMux, SYSTEM_CLOCK } from "./adapter.ts";
import { DurableSocketClient } from "./client.ts";
import type { DurableEventSink } from "./events.ts";
import type { DurableEvent, DurablePane } from "./protocol.ts";

// THE EXAMPLE, DRIVEN BY THE REAL ADAPTER (M50 spec 10). `examples/durable-member` is the one public
// program that speaks the wire, so this is the proof that WIRE.md, this adapter and the example agree.
// It starts the example as a child process on a socket in a fresh temp folder, then runs the adapter
// and its socket client against it: hello and ready, a snapshot, the events, an answer, a send, a
// stop, a starter, and a restart that keeps an open ask's id.
//
// It needs the example's own install (Pi Durable is not a dependency of collie), so without one it
// skips and says how to get it. It skips on Windows, where the example has no private socket.

const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "durable-member");
const INSTALLED = existsSync(join(EXAMPLE, "node_modules"));
const RUNS = INSTALLED && process.platform !== "win32";

const NOT_INSTALLED = "example deps not installed: run bun install in examples/durable-member";
if (!INSTALLED) {
  // Bun prints no name for a skipped test, so the reason goes to the log as well.
  console.warn(`example.test.ts skipped: ${NOT_INSTALLED}`);
  test.skip(NOT_INSTALLED, () => {});
}

/** Every event the reader handed over, per pane, in order. */
class Recorder implements DurableEventSink {
  readonly batches = new Map<string, DurableEvent[][]>();
  apply(paneId: string, events: readonly DurableEvent[]): Promise<number> {
    const list = this.batches.get(paneId) ?? [];
    list.push([...events]);
    this.batches.set(paneId, list);
    return Promise.resolve(events.length);
  }
  all(paneId: string): DurableEvent[] {
    return (this.batches.get(paneId) ?? []).flat();
  }
}

async function until<T>(what: string, look: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const seen = await look();
    if (seen !== undefined) return seen;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Read the child's stdout until the line that starts with `listening`. */
async function listeningLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => void reader.cancel(), ms);
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`the example exited or timed out before it listened; it printed: ${text}`);
      text += decoder.decode(chunk.value, { stream: true });
      const line = text.split("\n").find((row) => row.startsWith("listening "));
      if (line !== undefined) return line;
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

describe.skipIf(!RUNS)("the example program against the real adapter", () => {
  const dir = RUNS ? mkdtempSync(join(tmpdir(), "collie-dm-")) : "";
  // `mkdtemp` makes the folder 0700, which is what the example and the adapter's path walk ask of it.
  const socket = join(dir, "s.sock");
  const data = join(dir, "data");
  const recorder = new Recorder();
  const adapter = new DurableMux(new DurableSocketClient(socket), SYSTEM_CLOCK, recorder);
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let ticket = "";

  /** A pane as the adapter's last read shows it, after a fresh read. */
  async function pane(id: string): Promise<DurablePane | undefined> {
    await adapter.refresh();
    return adapter.program()?.snapshot.panes.find((candidate) => candidate.id === id);
  }
  const notes = () => (existsSync(join(data, "notes.txt")) ? readFileSync(join(data, "notes.txt"), "utf8").trim().split("\n") : []);

  /** Start the example on the socket and the data folder, and wait for its listening line. */
  async function boot(): Promise<void> {
    // The socket and the data folder are set; the timings are the example's own defaults. Off Linux
    // the example starts only without its descendant check, and this test is about the wire.
    const check = process.platform === "linux" ? "descendant" : "off";
    const spawned = Bun.spawn(["bun", join(EXAMPLE, "app.ts")], {
      cwd: EXAMPLE,
      env: { ...process.env, COLLIE_DURABLE_SOCKET: socket, DM_DATA: data, DM_CALLER_CHECK: check, REAL_MODEL: "" },
      stdout: "pipe",
      stderr: "inherit",
    });
    child = spawned;
    expect(await listeningLine(spawned.stdout, 10_000)).toBe(`listening ${socket}`);
  }

  beforeAll(boot, 12_000);

  afterAll(async () => {
    if (child !== null && child.exitCode === null) {
      child.kill("SIGTERM");
      const gone = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!gone) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  test("example: hello agrees version 1, and the program is ready with every cap", async () => {
    expect((await adapter.poll()).ok).toBe(true);
    const session = adapter.program()?.session;
    expect(session?.version).toBe(1);
    expect(session?.hostName).toBe("durable-member");
    expect(session?.caps).toEqual({ asks: true, starters: true, send: true, steer: true, abort: true });
  });

  test("example: the snapshot holds the ticket a first start opens, and it waits on one ask", async () => {
    const mux = await adapter.snapshot();
    expect(mux.panes.length).toBeGreaterThanOrEqual(1);
    const first = mux.panes[0];
    expect(first?.agent).toBe("durable");
    expect(first?.tabLabel).toBe("Inbox");
    ticket = first?.paneId ?? "";
    const asks = await until("an open ask", async () => {
      await adapter.refresh();
      const open = adapter.openAsks(ticket) ?? [];
      return open.length === 1 ? open : undefined;
    });
    expect(asks[0]?.options.map((option) => option.id)).toEqual(["allow", "deny"]);
    expect((await pane(ticket))?.state).toBe("waiting");
  });

  test("example: the events reader reads the history, then only what came after its cursor", async () => {
    await adapter.syncEvents();
    const first = recorder.all(ticket);
    expect(first.some((event) => event.type === "item" && event.item.kind === "user" && event.item.text.includes("Triage ticket"))).toBe(true);
    expect(first.some((event) => event.type === "ask")).toBe(true);
    expect(first.some((event) => event.type === "reset")).toBe(false); // the current epoch from 0 is a plain read
    const before = recorder.batches.get(ticket)?.length ?? 0;
    await adapter.syncEvents(); // nothing moved: no new batch
    expect(recorder.batches.get(ticket)?.length ?? 0).toBe(before);
  });

  test("example: an allow runs the tool once, and a repeat with the same request id replays", async () => {
    const ask = adapter.openAsks(ticket)?.[0];
    if (ask === undefined) throw new Error("no open ask");
    const answer = { requestId: crypto.randomUUID(), askId: ask.id, revision: ask.revision, optionId: "allow" };
    expect(await adapter.answerAsk(ticket, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    expect(await adapter.answerAsk(ticket, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: true } });
    await until("the ticket idle", async () => ((await pane(ticket))?.state === "idle" ? true : undefined));
    expect(notes()).toHaveLength(1);
    expect(adapter.program()?.snapshot.panes.some((candidate) => candidate.tabId === "triage:helpers")).toBe(true);
    await adapter.syncEvents();
    const after = recorder.all(ticket);
    expect(after.some((event) => event.type === "ask-closed" && event.by === "phone")).toBe(true);
    expect(after.some((event) => event.type === "item" && event.item.kind === "reply" && event.item.text.includes("The helper says"))).toBe(true);
  });

  test("example: a send starts a new turn, and a stop ends it with a settled event and no item", async () => {
    const oldTurn = (await pane(ticket))?.turnId ?? "";
    const sendId = crypto.randomUUID();
    const send: ControlRequest = { act: "send", requestId: sendId, target: { kind: "turn", id: oldTurn }, text: "one more thing", steer: false };
    expect(await adapter.controlTurn(ticket, send)).toEqual({ kind: "ok", replayed: false });
    const working = await until("a new turn", async () => {
      const seen = await pane(ticket);
      return seen?.state === "working" && seen.turnId !== oldTurn ? seen : undefined;
    });
    // The scripted answer to a follow-up takes ten seconds, so there is a run to stop.
    const abort: ControlRequest = { act: "abort", requestId: crypto.randomUUID(), target: { kind: "turn", id: working.turnId } };
    expect(await adapter.controlTurn(ticket, abort)).toEqual({ kind: "ok", replayed: false });
    await until("idle after the stop", async () => ((await pane(ticket))?.state === "idle" ? true : undefined));
    await adapter.syncEvents();
    const events = recorder.all(ticket);
    expect(events).toContainEqual({ type: "settled", inputId: expect.any(String), requestId: sendId, status: "unanswered", reason: "aborted" });
    const sent = events.findIndex((event) => event.type === "item" && event.item.kind === "user" && event.item.text === "one more thing");
    expect(sent).toBeGreaterThan(-1);
    expect(events.slice(sent + 1).some((event) => event.type === "item" && (event.item.kind === "reply" || event.item.kind === "notice"))).toBe(false);
  });

  test("example: a starter opens a new pane, and a repeat with the same request id opens nothing", async () => {
    const listed = await adapter.listStarters();
    expect(listed.starters.map((starter) => starter.id)).toContain("new-triage");
    const requestId = crypto.randomUUID();
    const started = await adapter.startStarter("new-triage", requestId);
    if (started.kind !== "started") throw new Error(`the starter did not start: ${JSON.stringify(started)}`);
    expect(started.replayed).toBe(false);
    expect(started.paneId).not.toBe(ticket);
    expect(adapter.program()?.snapshot.panes.some((candidate) => candidate.id === started.paneId)).toBe(true);
    expect(await adapter.startStarter("new-triage", requestId)).toEqual({ kind: "started", paneId: started.paneId, replayed: true });
    expect(adapter.program()?.snapshot.panes.filter((candidate) => candidate.tabId === "triage:inbox")).toHaveLength(2);
  });

  test("example: after a restart the adapter lists the same ask id, and an answer sent across the wake is taken once", async () => {
    const started = adapter.program()?.snapshot.panes.find((candidate) => candidate.tabId === "triage:inbox" && candidate.id !== ticket);
    if (started === undefined) throw new Error("no started ticket");
    const before = await until("the started ticket's ask", async () => {
      await adapter.refresh();
      return adapter.openAsks(started.id)?.[0];
    });
    const epoch = adapter.program()?.session.epoch;
    child?.kill("SIGKILL");
    await child?.exited;
    await boot();
    const after = await until("the program again, in a new epoch", async () => {
      await adapter.refresh();
      const program = adapter.program();
      return program !== null && program.session.epoch !== epoch ? adapter.openAsks(started.id)?.[0] : undefined;
    }, 10_000);
    expect([after.id, after.toolCallId, after.revision]).toEqual([before.id, before.toolCallId, 1]);
    const written = notes().length;
    const answer = { requestId: crypto.randomUUID(), askId: before.id, revision: before.revision, optionId: "allow" };
    expect(await adapter.answerAsk(started.id, answer)).toEqual({ ok: true, value: { kind: "taken", replayed: false } });
    await until("the ticket idle", async () => ((await pane(started.id))?.state === "idle" ? true : undefined), 10_000);
    expect(notes()).toHaveLength(written + 1);
  }, 30_000);
});
