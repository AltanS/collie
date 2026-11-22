import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSinceFile, statFile } from "./files.ts";
import { LiveWindows, SEQ_BASE, TICK_FLOOR_MS } from "./live.ts";
import { NO_CHANGE, noUnknowns, parseWith, type RowReducer } from "./reduce.ts";
import { TranscriptStore } from "./store.ts";
import type { AgentSessionRef, JournalAdapter, TranscriptEntry } from "./types.ts";

// A log REWRITTEN under a live window, read through the real file source (`readSinceFile`), not a fake: the
// reports of #842 and #843 are about what the byte cursor can and cannot see, and a fake of the cursor would be
// a fake of the thing under test. Each row is `{"id":"<name>"}` and becomes one assistant turn.

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const row = (id: string) => JSON.stringify({ id });
const ref: AgentSessionRef = { kind: "id", value: "s1" };

function reducer(): RowReducer {
  return {
    push(line: string) {
      if (line === "") return NO_CHANGE;
      // SAFETY: every row in this file is written by `row` above, which always makes `{"id": string}`.
      const id = (JSON.parse(line) as { id: string }).id;
      const entry: TranscriptEntry = { uuid: id, ts: "", role: "assistant", parts: [{ kind: "text", text: id }] };
      return { added: [entry], changed: NO_CHANGE.changed };
    },
    unknowns: noUnknowns,
    queued: () => [],
  };
}

async function lab(lines: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "collie-live-rewrite-"));
  dirs.push(dir);
  const path = join(dir, "log.jsonl");
  const write = async (rows: string[], mtime: number) => {
    await writeFile(path, rows.map((line) => `${line}\n`).join(""));
    await utimes(path, mtime / 1000, mtime / 1000);
  };
  await write(lines, 1_700_000_000_000);
  let now = 100_000;
  const adapter: JournalAdapter = {
    agent: "fake",
    source: {
      resolve: async () => path,
      stat: (key) => statFile(key),
      load: async (key) => {
        const text = await Bun.file(key).text();
        const st = await stat(key);
        return { text, complete: true, size: st.size, mtimeMs: st.mtimeMs };
      },
      readSince: (key, cursor) => readSinceFile(key, cursor),
    },
    parse: (text) => parseWith(reducer(), text),
    reducer,
  };
  return {
    adapter,
    write,
    live: new LiveWindows(new TranscriptStore(), () => now),
    settle: () => {
      now += TICK_FLOOR_MS + 1;
    },
  };
}

describe("a log rewritten at the same size, read from a real file (#842)", () => {
  test("the window rebuilds and shows the replacement rows", async () => {
    const fx = await lab([row("old-1"), row("old-2")]);
    const one = await fx.live.window(fx.adapter, ref, { limit: 10 });
    expect(one?.upserts.map((e) => e.uuid)).toEqual(["old-1", "old-2"]);

    // The same length, new content, a newer modified time: what a compaction or an edit in place leaves.
    await fx.write([row("new-1"), row("new-2")], 1_700_000_005_000);
    fx.settle();
    const two = await fx.live.window(fx.adapter, ref, { limit: 10, after: { gen: one!.gen, rev: one!.rev } });
    expect(two?.gen).not.toBe(one!.gen);
    expect(two?.upserts.map((e) => [e.uuid, e.seq])).toEqual([
      ["new-1", SEQ_BASE],
      ["new-2", SEQ_BASE + 1],
    ]);

    // A fresh reader holding nothing sees the replacement too, not the retired rows.
    const fresh = await fx.live.window(fx.adapter, ref, { limit: 10 });
    expect(fresh?.upserts.map((e) => e.uuid)).toEqual(["new-1", "new-2"]);
  });

  test("a touch that leaves the bytes alone keeps the generation", async () => {
    const fx = await lab([row("old-1"), row("old-2")]);
    const one = await fx.live.window(fx.adapter, ref, { limit: 10 });

    await fx.write([row("old-1"), row("old-2")], 1_700_000_005_000);
    fx.settle();
    const two = await fx.live.window(fx.adapter, ref, { limit: 10, after: { gen: one!.gen, rev: one!.rev } });
    expect(two?.gen).toBe(one!.gen);
    expect(two?.upserts).toEqual([]);
  });
});

describe("an older page after the log was rewritten (#843)", () => {
  test("it carries the new generation, for a same-size rewrite", async () => {
    const fx = await lab([row("old-1"), row("old-2"), row("old-3")]);
    const one = await fx.live.window(fx.adapter, ref, { limit: 10 });

    await fx.write([row("new-1"), row("new-2"), row("new-3")], 1_700_000_005_000);
    fx.settle();
    const older = await fx.live.older(fx.adapter, ref, { seq: SEQ_BASE + 2, uuid: "new-3" }, 10);
    expect(older?.gen).not.toBe(one!.gen);
    expect(older?.upserts.map((e) => e.uuid)).toEqual(["new-1", "new-2"]);

    // The next poll answers with the generation the page carried, so the client does not replace twice.
    const next = await fx.live.window(fx.adapter, ref, { limit: 10, after: { gen: one!.gen, rev: one!.rev } });
    expect(next?.gen).toBe(older!.gen);
  });

  test("it carries the new generation, for a shorter rewrite", async () => {
    const fx = await lab([row("old-1"), row("old-2"), row("old-3")]);
    const one = await fx.live.window(fx.adapter, ref, { limit: 10 });

    await fx.write([row("new-1"), row("new-2")], 1_700_000_005_000);
    fx.settle();
    const older = await fx.live.older(fx.adapter, ref, { seq: SEQ_BASE + 1, uuid: "new-2" }, 10);
    expect(older?.gen).not.toBe(one!.gen);
  });
});
