import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_CURSOR } from "./cursor.ts";
import { FIRST_TAIL_BYTES, readSinceFile } from "./files.ts";
import { buildJournalRegistry, KNOWN_HARNESS_NAMES } from "./registry.ts";

// The live read of a log FILE, shared by claude, codex, pi and grok. Real files in a temp directory,
// like every other source test here: the behaviour under test is byte counting against a file that
// grows, and a fake of the filesystem would be a fake of the thing being tested. No test needs a big
// session — the bound is a parameter precisely so a 30-byte file can prove what a 186 MB one does.

/** A row of exactly 8 bytes with its newline, so every offset in these tests is countable by hand. */
const row = (n: number) => `{"i":${n}}`;

async function lab() {
  const dir = await mkdtemp(join(tmpdir(), "collie-since-"));
  const path = join(dir, "log.jsonl");
  return {
    path,
    other: join(dir, "other.jsonl"),
    write: (text: string) => writeFile(path, text),
    append: (text: string) => appendFile(path, text),
    clean: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("readSinceFile", () => {
  test("a first read takes what is there and says the answer replaces nothing", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n${row(2)}\n`);

    const first = await readSinceFile(f.path, NO_CURSOR);
    expect(first.lines).toEqual([row(1), row(2)]);
    expect(first.reset).toBe(true);
    expect(first.cursor).not.toBe(NO_CURSOR);

    await f.clean();
  });

  test("a resume adds only what was appended", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);

    await f.append(`${row(2)}\n`);
    const next = await readSinceFile(f.path, first.cursor);
    expect(next.lines).toEqual([row(2)]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  test("a tick where nothing moved reads no rows and keeps the position", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);

    const again = await readSinceFile(f.path, first.cursor);
    expect(again.lines).toEqual([]);
    expect(again.reset).toBe(false);
    expect(again.cursor).toBe(first.cursor);

    await f.clean();
  });

  // The rule the whole design rests on: the offset only ever advances to a row boundary, so a row
  // the agent is halfway through writing is neither parsed nor lost.
  test("a torn last row is held back, then parsed once, when its newline arrives", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n{"i":2`);

    const first = await readSinceFile(f.path, NO_CURSOR);
    expect(first.lines).toEqual([row(1)]);

    await f.append(`}\n`);
    const next = await readSinceFile(f.path, first.cursor);
    expect(next.lines).toEqual([row(2)]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  test("a first read is bounded, and drops the half row the bound landed in", async () => {
    const f = await lab();
    await f.write([row(1), row(2), row(3), row(4), ""].join("\n"));

    // 22 bytes back from the end of a 32-byte log lands at byte 10, inside row 2 — so row 2 is a
    // fragment here, not a row.
    const first = await readSinceFile(f.path, NO_CURSOR, 22);
    expect(first.lines).toEqual([row(3), row(4)]);
    expect(first.reset).toBe(true);

    // And the bound is only about the FIRST read: the resume after it is an append.
    await f.append(`${row(5)}\n`);
    const next = await readSinceFile(f.path, first.cursor, 22);
    expect(next.lines).toEqual([row(5)]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  test("a truncated log resets rather than resuming at an offset that means nothing", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n${row(2)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);

    await truncate(f.path, 0);
    await f.append(`${row(9)}\n`);
    const next = await readSinceFile(f.path, first.cursor);
    expect(next.lines).toEqual([row(9)]);
    expect(next.reset).toBe(true);

    await f.clean();
  });

  // Claude's hand-over arrives here as nothing more than a different path, which is the point: the
  // cursor is stamped with the log it was taken on.
  test("a cursor taken on another log resets", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    await writeFile(f.other, `${row(7)}\n${row(8)}\n`);

    const first = await readSinceFile(f.path, NO_CURSOR);
    const moved = await readSinceFile(f.other, first.cursor);
    expect(moved.lines).toEqual([row(7), row(8)]);
    expect(moved.reset).toBe(true);

    await f.clean();
  });

  test("a cursor left more than one window behind resets instead of reading the gap", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR, 20);

    for (const n of [2, 3, 4, 5]) await f.append(`${row(n)}\n`);
    const next = await readSinceFile(f.path, first.cursor, 20);
    expect(next.reset).toBe(true);
    // The newest rows that fit in the window, and no half row with them.
    expect(next.lines).toEqual([row(4), row(5)]);

    await f.clean();
  });

  test("a log that vanished holds the cursor rather than blanking the session", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);

    await rm(f.path);
    const gone = await readSinceFile(f.path, first.cursor);
    expect(gone).toEqual({ lines: [], cursor: first.cursor, reset: false, fromStart: false });

    await f.clean();
  });

  test("an empty log reads nothing, and the append after it is an append", async () => {
    const f = await lab();
    await f.write("");

    const first = await readSinceFile(f.path, NO_CURSOR);
    expect(first.lines).toEqual([]);
    expect(first.reset).toBe(true);

    await f.append(`${row(1)}\n`);
    const next = await readSinceFile(f.path, first.cursor);
    expect(next.lines).toEqual([row(1)]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  // A window with no newline in it at all. The two cases look identical and mean opposite things.
  test("a row still being written holds the position until its newline exists", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);

    await f.append(`{"i":2,"long`);
    const midway = await readSinceFile(f.path, first.cursor);
    expect(midway.lines).toEqual([]);
    expect(midway.cursor).toBe(first.cursor);

    await f.append(`":true}\n`);
    const done = await readSinceFile(f.path, midway.cursor);
    expect(done.lines).toEqual([`{"i":2,"long":true}`]);

    await f.clean();
  });

  test("a row longer than the bound is stepped past, not re-read for ever", async () => {
    const f = await lab();
    await f.write(`${"x".repeat(60)}\n`);

    // The window is the tail of one row whose head the bound cut off, so no read from here can ever
    // complete it. `loadTail` drops its clipped head for the same reason.
    const first = await readSinceFile(f.path, NO_CURSOR, 20);
    expect(first.lines).toEqual([]);
    expect(first.reset).toBe(true);

    await f.append(`${row(1)}\n`);
    const next = await readSinceFile(f.path, first.cursor, 20);
    expect(next.lines).toEqual([row(1)]);
    expect(next.reset).toBe(false);

    await f.clean();
  });

  // `fromStart` is the one thing a caller cannot work out for itself: a bounded tail and a whole small
  // file arrive looking the same. It is what makes the live window's "load older" exact rather than a
  // guess (journal/live.ts § hasOlder), so it is pinned in all three of its states.
  test("a first read that began at byte 0 says so; a bounded one does not", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n${row(2)}\n`);
    expect((await readSinceFile(f.path, NO_CURSOR)).fromStart).toBe(true);

    // The same file, read under a bound too small to reach its head.
    const bounded = await readSinceFile(f.path, NO_CURSOR, 12);
    expect(bounded.reset).toBe(true);
    expect(bounded.fromStart).toBe(false);

    await f.clean();
  });

  test("an append never claims the start, whatever it carries", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);
    expect(first.fromStart).toBe(true);

    await f.append(`${row(2)}\n`);
    const next = await readSinceFile(f.path, first.cursor);
    expect(next.reset).toBe(false);
    expect(next.fromStart).toBe(false);

    await f.clean();
  });

  test("a truncated log resets AND claims the start, because it now is the start", async () => {
    const f = await lab();
    await f.write(`${row(1)}\n${row(2)}\n`);
    const first = await readSinceFile(f.path, NO_CURSOR);

    await truncate(f.path, 0);
    await f.write(`${row(9)}\n`);
    const after = await readSinceFile(f.path, first.cursor);
    expect(after.reset).toBe(true);
    expect(after.fromStart).toBe(true);
    expect(after.lines).toEqual([row(9)]);

    await f.clean();
  });

  test("the default bound is the live window's, not the History page's", () => {
    expect(FIRST_TAIL_BYTES).toBe(2 * 1024 * 1024);
  });
});

// Requirement: `readSince` is on `TranscriptSource` and implemented by ALL SIX harnesses. The type
// checker proves it is present; this proves every one of them ANSWERS, including the two that are
// SQLite and share none of the code above. A key no adapter can serve is the one input all six
// accept, and their answer to it is the same sentence: nothing new, hold what you have.
describe("every harness answers a live read", () => {
  const registry = buildJournalRegistry({
    claude: ["/nope/claude"],
    codex: ["/nope/codex"],
    pi: ["/nope/pi"],
    opencode: ["/nope/opencode"],
    grok: ["/nope/grok"],
    hermes: ["/nope/hermes"],
    muse: ["/nope/muse"],
  });

  test("the seven this build ships are the seven under test", () => {
    expect(Object.keys(registry).toSorted()).toEqual([...KNOWN_HARNESS_NAMES].toSorted());
    expect(KNOWN_HARNESS_NAMES).toHaveLength(7);
  });

  test.each(Object.keys(registry))("%s reports nothing new for a key it cannot serve", async (agent) => {
    const adapter = registry[agent];
    expect(adapter).toBeDefined();
    const answer = await adapter?.source.readSince("/nope/not-a-key", NO_CURSOR);
    expect(answer).toEqual({ lines: [], cursor: NO_CURSOR, reset: false, fromStart: false });
  });
});
