import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config.ts";
import { LiveWindows, type ChatWindowBody } from "../journal/live.ts";
import { adapterFor, buildJournalRegistry } from "../journal/registry.ts";
import { TranscriptStore } from "../journal/store.ts";
import { DurableMux } from "../mux/durable/adapter.ts";
import { FakeDurableProgram, type FakeEvent } from "../mux/durable/fixture.ts";
import type { MuxSubscription } from "../mux/types.ts";
import { paneChat } from "../server.ts";
import { StateEngine } from "../state-engine.ts";
import { toPaneWire } from "../types.ts";
import { DurableLogs, durableLogDir } from "./log.ts";

// END TO END: a fake durable program, the real adapter over a real socket, the real watch reading
// its events into the real pane log, the real state engine, and `paneChat` (the function behind
// GET /api/pane/:id/chat) answering from the `durable` journal adapter. No second reader path: the
// only thing this file adds to what the route uses is the program.

const PANE = "conv-01";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let tries = 0; tries < 400; tries += 1) {
    const got = await read();
    if (got !== null) return got;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const item = (id: string, kind: string, text: string): FakeEvent => ({ type: "item", item: { id, kind, text } });

async function world() {
  const state = await mkdtemp(join(tmpdir(), "collie-durable-chat-"));
  const program = await FakeDurableProgram.startWire();
  const logs = new DurableLogs(durableLogDir(state));
  const adapter = new DurableMux(program.wire(), undefined, logs);
  const engine = new StateEngine(adapter, 40);
  const watches: MuxSubscription[] = [];
  cleanups.push(async () => {
    engine.stop();
    for (const watch of watches) watch.close();
    await program.close();
    await rm(state, { recursive: true, force: true });
  });

  const cfg = loadConfig({ COLLIE_STATE_DIR: state, HOME: state });
  const roots = { ...cfg.journalRoots, durable: [durableLogDir(state)] };
  const journals = buildJournalRegistry(roots);
  const live = new LiveWindows(new TranscriptStore());

  engine.start();
  watches.push(
    adapter.watch({
      panes: [PANE],
      // A phone is plainly reading: the census runs at its watched cadence, one second.
      attention: () => "watched",
      onTopologyChange: () => engine.pokeNow(),
      onPaneChange: () => engine.pokeNow(),
      onUp: () => undefined,
      onDown: () => undefined,
    }),
  );

  const chat = async (): Promise<(ChatWindowBody & { available: true }) | { available: false; reason: string }> => {
    const url = new URL(`http://localhost/api/pane/${PANE}/chat`);
    const res = await paneChat(cfg, journals, live, engine, adapter, PANE, url, new Request(url));
    return res.json();
  };
  return { program, adapter, engine, journals, chat, state, logs };
}

describe("Chat for a durable pane", () => {
  test("the route answers the program's items from the bridge-owned log, through the ordinary journal path", async () => {
    const { program, chat } = await world();
    program.appendEvent(PANE, item("u1", "user", "write the summary"));
    program.appendEvent(PANE, {
      type: "item",
      item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "path=/tmp/notes.txt" }, status: "running" },
    });
    program.appendEvent(PANE, item("r1", "reply", "Writing it now."));

    const body = await until(async () => {
      const got = await chat();
      return got.available && got.upserts.length === 3 ? got : null;
    }, "three items in Chat");

    expect(body.upserts.map((entry) => [entry.uuid, entry.role])).toEqual([
      ["u1", "user"],
      ["t1", "assistant"],
      ["r1", "assistant"],
    ]);
    const tool = body.upserts[1]?.parts[0];
    expect(tool).toMatchObject({ kind: "tool", name: "write_note" });
    expect(tool?.kind === "tool" && tool.result).toBeUndefined();
  });

  test("a later change reaches Chat in place, and a stop is drawn as a note", async () => {
    const { program, chat } = await world();
    program.appendEvent(PANE, item("u1", "user", "go"));
    program.appendEvent(PANE, {
      type: "item",
      item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "x" }, status: "running" },
    });
    await until(async () => {
      const got = await chat();
      return got.available && got.upserts.length === 2 ? got : null;
    }, "the first two items");

    program.appendEvent(PANE, {
      type: "item",
      item: { id: "t1", kind: "tool", tool: { kind: "other", name: "write_note", summary: "x", output: "ok" }, status: "done" },
    });
    program.appendEvent(PANE, { type: "settled", inputId: "in-1", status: "unanswered", reason: "aborted" });

    const body = await until(async () => {
      const got = await chat();
      if (!got.available) return null;
      return got.upserts.some((entry) => entry.uuid === "settled:in-1") ? got : null;
    }, "the stop note");

    const done = body.upserts.find((entry) => entry.uuid === "t1")?.parts[0];
    expect(done?.kind === "tool" && done.result).toEqual({ text: "ok" });
    expect(body.upserts.find((entry) => entry.uuid === "settled:in-1")?.parts).toEqual([{ kind: "text", text: "stopped" }]);
  });

  test("a durable pane names its session, so the phone is told it has history, and no other pane is touched", async () => {
    const { program, engine, journals, chat, logs } = await world();
    program.appendEvent(PANE, item("u1", "user", "hi"));
    await until(async () => {
      const got = await chat();
      return got.available ? got : null;
    }, "the pane in Chat");

    const pane = engine.current().agents.find((candidate) => candidate.paneId === PANE);
    expect(pane?.agent).toBe("durable");
    // The ref names the log FILE (M55): two programs may share a conversation id, never a log.
    expect(pane?.agentSession).toEqual({ kind: "path", value: logs.pathOf(PANE) });
    expect(adapterFor(journals, pane?.agent)?.agent).toBe("durable");
    // The session ref stays server-side, and `hasSession` tells the phone it may open History.
    const wire = pane === undefined ? null : toPaneWire(pane, (agent) => adapterFor(journals, agent) !== undefined);
    expect(wire).not.toBeNull();
    expect(wire?.hasSession).toBe(true);
    expect(JSON.stringify(wire)).not.toContain("agentSession");
  });

  test("the history survives the program restarting", async () => {
    const { program, chat } = await world();
    program.appendEvent(PANE, item("u1", "user", "before the restart"));
    await until(async () => {
      const got = await chat();
      return got.available && got.upserts.length === 1 ? got : null;
    }, "the first item");

    // The program restarts: the new epoch's reset view still lists the item, and the cursor starts over.
    program.restart();
    program.appendEvent(PANE, item("r1", "reply", "after the restart"));
    const body = await until(async () => {
      const got = await chat();
      return got.available && got.upserts.some((entry) => entry.uuid === "r1") ? got : null;
    }, "the item after the restart");
    expect(body.upserts.map((entry) => entry.uuid)).toEqual(["u1", "r1"]);
  });
});

// The wiring that makes the tests above true in the running bridge, pinned by source: index.ts is
// the one place that builds both ends, and no test starts it.
describe("the bridge wires the log to both ends", () => {
  const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");

  test("each program's mux target names its own log folder, under the folder the journal registry reads", () => {
    expect(src).toContain("const logDir = sourceLogDir(cfg.stateDir, source.name);");
    expect(src).toContain("[DURABLE_LOG_DIR_OPTION]: logDir");
    expect(src).toContain("durable: [durableLogDir(cfg.stateDir)]");
  });
});
