// Codex after a rewind (issue #523): the active file, and the retained history in front of it.
//
// THE FIXTURES (bridge/journal/fixtures/codex-rewind/) are one real codex-cli 0.163.0 session from
// 2026-10-19, in a scratch Herdr pane in /tmp: prompts ALPHA, BRAVO, CHARLIE; a rewind to BRAVO and
// prompts DELTA, ECHO; a second rewind to DELTA and prompt FOXTROT. Codex wrote three files, and the
// conversation it shows at the end is ALPHA then FOXTROT. They are scrubbed: instructions, AGENTS.md,
// encrypted reasoning, rate limits and settings are cut down to their keys, and every
// `history_base.end_byte_offset` is recomputed against the scrubbed base, from the row whose
// `ordinal` the pointer names. Row types, ordinals, ids, names and pointers are Codex's own.

import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexHistoryBase, codexJournal, CODEX_RESCAN_MS, CodexTranscriptSource } from "./codex.ts";
import { NO_CURSOR } from "./cursor.ts";
import { LiveWindows } from "./live.ts";
import { TranscriptStore } from "./store.ts";
import type { TranscriptEntry } from "./types.ts";

const SID = "01a15321-8cfa-7c43-84fe-16ae450c8b4e";
const DAY = join("2026", "10", "19");
const ROOT_FILE = `rollout-2026-10-19T09-47-50-${SID}.jsonl`;
const SEG1 = `rollout-2026-10-19T09-49-41-${SID}_01a15323-3fc7-70a2-b7a7-67e6f5aa4c99.jsonl`;
const SEG2 = `rollout-2026-10-19T09-50-41-${SID}_01a15324-2a37-73c1-9c0c-c5c1eab5d66f.jsonl`;
const FIXTURES = join(import.meta.dir, "fixtures", "codex-rewind", DAY);
const ref = { kind: "id", value: SID } as const;

/** A sessions root holding the named fixture files, plus a hand-set clock for the rescan. */
async function sessions(...names: string[]) {
  const made = join(tmpdir(), `collie-codex-rewind-${crypto.randomUUID()}`);
  await mkdir(join(made, DAY), { recursive: true });
  const root = await realpath(made);
  for (const name of names) await copyFile(join(FIXTURES, name), join(root, DAY, name));
  const clock = { t: 1_000_000 };
  return {
    root,
    clock,
    now: () => clock.t,
    add: (name: string) => copyFile(join(FIXTURES, name), join(root, DAY, name)),
    remove: (name: string) => rm(join(root, DAY, name)),
    done: () => rm(root, { recursive: true, force: true }),
  };
}

/** What a reader sees: the turns that are speech, as text, in order. Plumbing rows drop out. */
function said(entries: readonly TranscriptEntry[]): string[] {
  return entries.flatMap((e) =>
    e.parts.flatMap((p) => (p.kind === "text" && !p.text.startsWith("# AGENTS.md") ? [`${e.role}: ${p.text}`] : [])),
  );
}

const ask = (word: string) => `user: Reply with exactly the word ${word} and nothing else.`;

describe("the fixtures are what Codex wrote", () => {
  test("three files, each later one pointing at the one before it", async () => {
    expect((await readdir(FIXTURES)).toSorted()).toEqual([ROOT_FILE, SEG1, SEG2]);
    const first = async (name: string) => (await Bun.file(join(FIXTURES, name)).text()).split("\n")[0] ?? "";
    expect(codexHistoryBase(await first(ROOT_FILE))).toBeNull();
    expect(codexHistoryBase(await first(SEG1))).toEqual({ id: SID, end: 5612 });
    expect(codexHistoryBase(await first(SEG2))).toEqual({ id: "01a15323-3fc7-70a2-b7a7-67e6f5aa4c99", end: 1093 });
  });
});

describe("CodexTranscriptSource — the active file", () => {
  test("is the newest file of the session, through two rewinds", async () => {
    const fx = await sessions(ROOT_FILE, SEG1, SEG2);
    expect(await new CodexTranscriptSource(fx.root).resolve(ref)).toBe(join(fx.root, DAY, SEG2));
    await fx.done();
  });

  test("follows a rewind that happens while the bridge holds the old path, once the rescan is due", async () => {
    const fx = await sessions(ROOT_FILE);
    const src = new CodexTranscriptSource(fx.root, fx.now);
    expect(await src.resolve(ref)).toBe(join(fx.root, DAY, ROOT_FILE));
    await fx.add(SEG1);
    // Inside the rescan window the cached path stands: a poll is a stat, not a walk.
    fx.clock.t += CODEX_RESCAN_MS - 1;
    expect(await src.resolve(ref)).toBe(join(fx.root, DAY, ROOT_FILE));
    fx.clock.t += 1;
    expect(await src.resolve(ref)).toBe(join(fx.root, DAY, SEG1));
    await fx.add(SEG2);
    fx.clock.t += CODEX_RESCAN_MS;
    expect(await src.resolve(ref)).toBe(join(fx.root, DAY, SEG2));
    await fx.done();
  });

  test("a segment in a later date folder wins over the session's first file", async () => {
    const fx = await sessions(ROOT_FILE);
    const later = join(fx.root, "2026", "10", "20");
    await mkdir(later, { recursive: true });
    await copyFile(join(FIXTURES, SEG1), join(later, SEG1));
    expect(await new CodexTranscriptSource(fx.root).resolve(ref)).toBe(join(later, SEG1));
    await fx.done();
  });
});

describe("History after a rewind", () => {
  test("one rewind: the retained turn, then the new ones, once each", async () => {
    const fx = await sessions(ROOT_FILE, SEG1);
    const page = await new TranscriptStore().page(codexJournal(fx.root), ref, { limit: 50 });
    expect(said(page?.entries ?? [])).toEqual([
      ask("ALPHA"),
      "assistant: ALPHA",
      ask("DELTA"),
      "assistant: DELTA",
      ask("ECHO"),
      "assistant: ECHO",
    ]);
    expect(page?.fileTruncated).toBe(false);
    await fx.done();
  });

  test("two rewinds: the chain is read back to the first file", async () => {
    const fx = await sessions(ROOT_FILE, SEG1, SEG2);
    const page = await new TranscriptStore().page(codexJournal(fx.root), ref, { limit: 50 });
    expect(said(page?.entries ?? [])).toEqual([ask("ALPHA"), "assistant: ALPHA", ask("FOXTROT"), "assistant: FOXTROT"]);
    await fx.done();
  });

  test("a rewind with no new prompt yet shows the retained turns", async () => {
    const fx = await sessions(ROOT_FILE);
    // The segment as Codex first writes it: its session_meta and two settings events.
    const segment = (await Bun.file(join(FIXTURES, SEG1)).text()).split("\n").slice(0, 3).join("\n");
    await Bun.write(join(fx.root, DAY, SEG1), `${segment}\n`);
    const page = await new TranscriptStore().page(codexJournal(fx.root), ref, { limit: 50 });
    expect(said(page?.entries ?? [])).toEqual([ask("ALPHA"), "assistant: ALPHA"]);
    await fx.done();
  });

  test("a base that is gone shows the segment alone and says the history is clipped", async () => {
    const fx = await sessions(ROOT_FILE, SEG1, SEG2);
    await fx.remove(SEG1);
    const page = await new TranscriptStore().page(codexJournal(fx.root), ref, { limit: 50 });
    expect(said(page?.entries ?? [])).toEqual([ask("FOXTROT"), "assistant: FOXTROT"]);
    expect(page?.fileTruncated).toBe(true);
    await fx.done();
  });

  test("a pointer back to itself ends the chain instead of looping", async () => {
    const fx = await sessions(ROOT_FILE);
    const lines = (await Bun.file(join(FIXTURES, SEG2)).text()).split("\n");
    lines[0] = (lines[0] ?? "").replace(
      `"thread_id":"01a15323-3fc7-70a2-b7a7-67e6f5aa4c99"`,
      `"thread_id":"01a15324-2a37-73c1-9c0c-c5c1eab5d66f"`,
    );
    await Bun.write(join(fx.root, DAY, SEG2), lines.join("\n"));
    const loaded = await new CodexTranscriptSource(fx.root).load(join(fx.root, DAY, SEG2));
    expect(loaded.complete).toBe(false);
    expect(said(codexJournal(fx.root).parse(loaded.text))).toEqual([ask("FOXTROT"), "assistant: FOXTROT"]);
    await fx.done();
  });
});

describe("Chat after a rewind", () => {
  test("the live read opens on the retained turns, and an append adds only the new rows", async () => {
    const fx = await sessions(ROOT_FILE, SEG1);
    const src = new CodexTranscriptSource(fx.root);
    const path = join(fx.root, DAY, SEG1);
    const whole = await Bun.file(path).text();
    const cut = whole.indexOf(`"Reply with exactly the word ECHO`);
    const head = whole.slice(0, whole.lastIndexOf("\n", cut) + 1);
    await Bun.write(path, head);

    const parse = codexJournal(fx.root).parse;
    const first = await src.readSince(path, NO_CURSOR);
    expect(first.reset).toBe(true);
    expect(first.fromStart).toBe(true);
    expect(said(parse(first.lines.join("\n")))).toEqual([ask("ALPHA"), "assistant: ALPHA", ask("DELTA"), "assistant: DELTA"]);

    await Bun.write(path, whole);
    const next = await src.readSince(path, first.cursor);
    expect(next.reset).toBe(false);
    expect(said(parse(next.lines.join("\n")))).toEqual([ask("ECHO"), "assistant: ECHO"]);
    await fx.done();
  });

  test("the Chat window moves to the new file and drops the discarded turns", async () => {
    const fx = await sessions(ROOT_FILE);
    const adapter = { ...codexJournal(fx.root), source: new CodexTranscriptSource(fx.root, fx.now) };
    const windows = new LiveWindows(new TranscriptStore(), fx.now);
    const before = await windows.window(adapter, ref, { limit: 50 });
    expect(said(before?.upserts ?? [])).toEqual([
      ask("ALPHA"),
      "assistant: ALPHA",
      ask("BRAVO"),
      "assistant: BRAVO",
      ask("CHARLIE"),
      "assistant: CHARLIE",
    ]);

    await fx.add(SEG1);
    await fx.add(SEG2);
    fx.clock.t += CODEX_RESCAN_MS;
    const after = await windows.window(adapter, ref, { limit: 50 });
    // A new generation: the client replaces what it holds rather than merging into it.
    expect(after?.gen).not.toBe(before?.gen);
    expect(said(after?.upserts ?? [])).toEqual([ask("ALPHA"), "assistant: ALPHA", ask("FOXTROT"), "assistant: FOXTROT"]);
    expect(after?.hasOlder).toBe(false);
    await fx.done();
  });
});

describe("a broken chain keeps what it could read", () => {
  test("a pointer past the first file to one that is gone: every file read still shows, marked clipped", async () => {
    const fx = await sessions(SEG2);
    // The first file, made to point at a segment nobody has, so the chain breaks two links down.
    const root = await Bun.file(join(FIXTURES, ROOT_FILE)).text();
    const pointer = `"history_base":{"thread_id":"01a15300-0000-7000-8000-000000000000","end_ordinal_exclusive":3,"end_byte_offset":10},`;
    await Bun.write(join(fx.root, DAY, ROOT_FILE), root.replace(`"history_mode":"paginated",`, `"history_mode":"paginated",${pointer}`));
    // The first file grew by the pointer, so the segment that keeps part of it keeps that much more.
    const seg1 = await Bun.file(join(FIXTURES, SEG1)).text();
    await Bun.write(join(fx.root, DAY, SEG1), seg1.replace(`"end_byte_offset":5612`, `"end_byte_offset":${5612 + pointer.length}`));
    const page = await new TranscriptStore().page(codexJournal(fx.root), ref, { limit: 50 });
    expect(said(page?.entries ?? [])).toEqual([ask("ALPHA"), "assistant: ALPHA", ask("FOXTROT"), "assistant: FOXTROT"]);
    expect(page?.fileTruncated).toBe(true);
    await fx.done();
  });
});
