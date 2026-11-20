// Shared by chat.test.ts and chat.slow.test.ts: the helpers both files need. Not a test file.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { LiveWindows, type ChatWindowBody } from "../journal/live.ts";
import { buildJournalRegistry } from "../journal/registry.ts";
import { TranscriptStore } from "../journal/store.ts";
import { DurableMux } from "../mux/durable/adapter.ts";
import { FakeDurableProgram, type FakeEvent } from "../mux/durable/fixture.ts";
import type { MuxSubscription } from "../mux/types.ts";
import { paneChat } from "../server.ts";
import { StateEngine } from "../state-engine.ts";
import { DurableLogs, durableLogDir } from "./log.ts";

// END TO END: a fake durable program, the real adapter over a real socket, the real watch reading
// its events into the real pane log, the real state engine, and `paneChat` (the function behind
// GET /api/pane/:id/chat) answering from the `durable` journal adapter. No second reader path: the
// only thing this file adds to what the route uses is the program.

export const PANE = "conv-01";

export const cleanups: (() => Promise<void> | void)[] = [];

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let tries = 0; tries < 400; tries += 1) {
    const got = await read();
    if (got !== null) return got;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const item = (id: string, kind: string, text: string): FakeEvent => ({ type: "item", item: { id, kind, text } });

export async function world() {
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
