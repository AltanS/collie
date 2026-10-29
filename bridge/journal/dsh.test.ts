import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { NO_CURSOR } from "./cursor.ts";
import { createDshDiscovery, fileKey, flocksOf, LINUX_PROC, type ProcReader } from "./dsh-discovery.ts";
import { DshTranscriptSource, frameRows, scanFrames } from "./dsh-sessions.ts";
import { MAX_FRAME_OUTPUT_BYTES } from "./files.ts";
import { dshJournal, parseDshTranscript } from "./dsh.ts";
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "dsh", "session.v4.jsonl");
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");
const ROWS = FIXTURE.split("\n").filter((row) => row !== "");
const ID = "3f6c2a9e-1b7d-4c55-9e0a-6d2f8b4a7c11";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "collie-dsh-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

/** A fresh sessions root. */
function newRoot(): string {
  made += 1;
  const root = join(scratch, `root-${made}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** One Zstandard frame holding `rows`, as dsh appends a batch. */
function frame(rows: readonly string[]): Uint8Array {
  return zstdCompressSync(`${rows.join("\n")}\n`);
}

/** Write a session folder whose compressed log holds the header frame, then one frame per batch. */
function writeSession(root: string, id: string, groups: readonly (readonly string[])[], name = "session.v4.jsonl.zstd"): string {
  const folder = join(root, "--home-operator-project--", id);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, Buffer.concat(groups.map((group) => frame(group))));
  writeFileSync(join(folder, "session.lock"), "");
  return path;
}

/** The fixture's rows as dsh would batch them: the header alone, then batches of five. */
function batches(): string[][] {
  const out: string[][] = [[ROWS[0] ?? ""]];
  for (let at = 1; at < ROWS.length; at += 5) out.push(ROWS.slice(at, at + 5));
  return out;
}

function texts(entry: TranscriptEntry | undefined): string[] {
  return (entry?.parts ?? []).flatMap((part) => (part.kind === "text" || part.kind === "thinking" ? [part.text] : []));
}

function tools(entries: readonly TranscriptEntry[]): Extract<TranscriptPart, { kind: "tool" }>[] {
  return entries.flatMap((entry) => entry.parts.flatMap((part) => (part.kind === "tool" ? [part] : [])));
}

describe("parseDshTranscript over the fixture", () => {
  const entries = parseDshTranscript(FIXTURE);

  test("shows the user's turns and none of the machine-written user rows", () => {
    expect(entries.filter((e) => e.role === "user").map((e) => texts(e).join())).toEqual([
      "Run ls -la in this folder with the bash tool and tell me in two lines what is here.",
      "Write the word hello into /home/operator/outside.txt, which is outside this folder.",
      'No, leave it. Now start "sleep 20; echo finished" with your own bash tool and run_in_background set (this is a test of your background jobs: do NOT use pueue or any queue). Do not wait for it: reply right away with its job id.',
      "Read README.md once more and answer in one line, ending with: Ça va? 日本語",
    ]);
    // The context dsh injects as user rows, and the approval-policy notice, are not speech.
    expect(JSON.stringify(entries)).not.toContain("shortened for the fixture");
    expect(JSON.stringify(entries)).not.toContain("The approval policy changed");
  });

  test("reads replies, reasoning and tool calls in the order the model wrote them", () => {
    const first = entries.find((e) => e.uuid === "fc35e4ff-f7fa-4f06-8b38-94f8ec04c50a");
    expect(first?.role).toBe("assistant");
    expect(first?.parts.map((p) => p.kind)).toEqual(["thinking", "text", "tool"]);
    expect(first?.ts).toBe("2026-10-27T15:45:53.857Z");
  });

  test("puts each result on its call, and marks the rejected escalation denied", () => {
    const calls = tools(entries);
    expect(calls.map((c) => c.name)).toEqual(["bash", "bash", "bash", "bash", "job_output", "read"]);
    expect(calls.every((c) => c.result !== undefined)).toBe(true);
    expect(calls[0]?.summary).toBe("ls -la");
    const refused = calls[2];
    expect(refused?.result?.denied).toBe(true);
    expect(refused?.result?.isError).toBe(true);
    expect(calls.filter((c) => c.result?.denied === true)).toHaveLength(1);
    expect(calls[4]?.result?.text).toBe("finished\n[status: completed, exit code: 0]");
  });

  test("shows slash commands and a finished background job as notes, and the compaction as a summary", () => {
    expect(entries.filter((e) => e.role === "note").map((e) => texts(e).join())).toEqual([
      "/permission workspace-write\npreset workspace-write",
      "/permission workspace-write\npreset workspace-write",
      "background job bash-b61cd0d604094791 (bash: sleep 20; echo finished) finished [status: completed, exit code: 0]. Read its output with job_output.",
    ]);
    const summary = entries.find((e) => e.role === "summary");
    expect(texts(summary).join()).toContain("## Primary Request and Intent");
  });

  test("keeps the turns a replace row covers, since it only edits what the model sees", () => {
    const roles = entries.map((e) => e.role);
    expect(roles.indexOf("summary")).toBeGreaterThan(roles.indexOf("note"));
    expect(entries.filter((e) => e.role === "user")).toHaveLength(4);
    expect(entries).toHaveLength(19);
  });

  test("reads every row type in the fixture", () => {
    const reducer = dshJournal([]).reducer();
    for (const row of ROWS) reducer.push(row);
    expect(reducer.unknowns().rows.size).toBe(0);
    expect(reducer.unknowns().parts.size).toBe(0);
  });

  test("strips terminal escapes from text and tool output", () => {
    const rows = [
      { type: "assistant/message", seq: 1, time: 0, data: { message: { id: "a", role: "assistant", content: [{ type: "text", text: "\u001b[1mbold\u001b[0m" }, { type: "tool-call", id: "c", name: "bash", arguments: "{\"command\":\"ls\"}" }] } } },
      { type: "tool/result", seq: 2, time: 0, data: { message: { id: "r", role: "tool", toolCallId: "c", content: [{ type: "text", text: "\u001b[32mok\u001b[0m" }], isError: false } } },
    ];
    const [reply] = parseDshTranscript(rows.map((row) => JSON.stringify(row)).join("\n"));
    expect(texts(reply)).toEqual(["bold"]);
    expect(tools(reply === undefined ? [] : [reply])[0]?.result?.text).toBe("ok");
  });
});

describe("DshTranscriptSource", () => {
  test("finds the frames from their headers alone, and holds a torn last frame back", () => {
    const whole = Buffer.concat(batches().map((batch) => frame(batch)));
    const scan = scanFrames(whole);
    expect(scan?.frames).toHaveLength(batches().length);
    expect(scan?.complete).toBe(whole.length);
    const torn = scanFrames(whole.subarray(0, whole.length - 3));
    expect(torn?.frames).toHaveLength(batches().length - 1);
    expect(scanFrames(Buffer.from("not a frame"))).toBeNull();
  });

  test("refuses a frame that expands past the output cap, and never throws", () => {
    const small = frame(["a", "b"]);
    const bomb = frame(["x".repeat(200_000)]);
    const frameOf = (bytes: Uint8Array) => scanFrames(bytes)?.frames[0];
    const smallFrame = frameOf(small);
    const bombFrame = frameOf(bomb);
    expect(smallFrame).toBeDefined();
    expect(bombFrame).toBeDefined();
    if (smallFrame === undefined || bombFrame === undefined) return;
    expect(frameRows(small, smallFrame, 1024)).toEqual(["a", "b"]);
    expect(frameRows(bomb, bombFrame, 1024)).toBeNull();
    expect(frameRows(bomb, bombFrame, 1024 * 1024)).toHaveLength(1);
  });

  test("a frame past the real cap ends the tail like a frame that does not decode", async () => {
    const root = newRoot();
    const huge = zstdCompressSync(`${"x".repeat(MAX_FRAME_OUTPUT_BYTES + 1)}\n`);
    expect(huge.length).toBeLessThan(1024 * 1024);
    const folder = join(root, "--home-operator-project--", "11111111-2222-3333-4444-555555555555");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "session.v4.jsonl.zstd");
    writeFileSync(path, Buffer.concat([frame(["first"]), huge]));
    const source = new DshTranscriptSource(root);
    const loaded = await source.load(path);
    expect(loaded.text).toBe("");
    expect(loaded.complete).toBe(false);
  });

  test("resolves a session to its newest generation, inside the root", async () => {
    const root = newRoot();
    const v4 = writeSession(root, ID, batches());
    writeFileSync(join(root, "--home-operator-project--", ID, "session.v3.jsonl.zstd"), frame([ROWS[0] ?? ""]));
    const source = new DshTranscriptSource([root]);
    expect(await source.resolve({ kind: "id", value: ID })).toBe(v4);
    expect(await source.resolve({ kind: "id", value: "../escape" })).toBeNull();
    expect(await source.resolve({ kind: "path", value: v4 })).toBeNull();
    expect(await source.resolve({ kind: "id", value: "missing" })).toBeNull();
  });

  test("loads a compressed log whole, and it parses like the plain fixture", async () => {
    const root = newRoot();
    const path = writeSession(root, ID, batches());
    const loaded = await new DshTranscriptSource([root]).load(path);
    expect(loaded.complete).toBe(true);
    expect(loaded.size).toBe(statSync(path).size);
    expect(parseDshTranscript(loaded.text)).toEqual(parseDshTranscript(FIXTURE));
  });

  test("a live read returns only the new frames, and waits out a torn one", async () => {
    const root = newRoot();
    const all = batches();
    const path = writeSession(root, ID, all.slice(0, 3));
    const source = new DshTranscriptSource([root]);
    const first = await source.readSince(path, NO_CURSOR);
    expect(first.reset).toBe(true);
    expect(first.fromStart).toBe(true);
    expect(first.lines).toEqual(all.slice(0, 3).flat());

    const next = frame(all[3] ?? []);
    appendFileSync(path, next.subarray(0, next.length - 4));
    const torn = await source.readSince(path, first.cursor);
    expect(torn).toEqual({ lines: [], cursor: first.cursor, reset: false, fromStart: false });

    appendFileSync(path, next.subarray(next.length - 4));
    appendFileSync(path, frame(all[4] ?? []));
    const grown = await source.readSince(path, torn.cursor);
    expect(grown.reset).toBe(false);
    expect(grown.lines).toEqual([...(all[3] ?? []), ...(all[4] ?? [])]);

    const idle = await source.readSince(path, grown.cursor);
    expect(idle).toEqual({ lines: [], cursor: grown.cursor, reset: false, fromStart: false });
  });

  test("a log rewritten under the same name resets rather than misreading", async () => {
    const root = newRoot();
    const all = batches();
    const path = writeSession(root, ID, all.slice(0, 4));
    const source = new DshTranscriptSource([root]);
    const first = await source.readSince(path, NO_CURSOR);
    // The same length of bytes, but the cursor no longer lands on a frame.
    writeFileSync(path, Buffer.concat([Buffer.from([0]), frame(all.flat())]));
    const after = await source.readSince(path, first.cursor);
    expect(after.reset).toBe(true);
  });

  test("a plain log is read as plain lines", async () => {
    const root = newRoot();
    const folder = join(root, "--home-operator-project--", ID);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, "session.v4.jsonl");
    writeFileSync(path, FIXTURE);
    const source = new DshTranscriptSource([root]);
    expect(await source.resolve({ kind: "id", value: ID })).toBe(path);
    expect(parseDshTranscript((await source.load(path)).text)).toEqual(parseDshTranscript(FIXTURE));
    expect((await source.readSince(path, NO_CURSOR)).lines).toEqual(ROWS);
  });
});

describe("flocksOf", () => {
  test("lists the files a pid holds a FLOCK write lock on, and skips waiters and other kinds", () => {
    const table = [
      "1: FLOCK  ADVISORY  WRITE 4242 103:03:25690149 0 EOF",
      "2: FLOCK  ADVISORY  WRITE 99 103:03:111 0 EOF",
      "3: POSIX  ADVISORY  WRITE 4242 103:03:222 0 EOF",
      "4: -> FLOCK  ADVISORY  WRITE 4242 103:03:333 0 EOF",
      "5: FLOCK  ADVISORY  READ 4242 103:03:444 0 EOF",
    ].join("\n");
    expect([...flocksOf(table, 4242)]).toEqual(["259:3:25690149"]);
  });

  test("a malformed or truncated line is skipped and never throws", () => {
    const table = [
      "",
      "garbage",
      "1: FLOCK",
      "2: FLOCK  ADVISORY  WRITE 4242",
      "3: FLOCK  ADVISORY  WRITE 4242 nonsense 0 EOF",
      "4: FLOCK  ADVISORY  WRITE 4242 zz:03:25690149 0 EOF",
      "5: FLOCK  ADVISORY  WRITE 4242 103:03:notanumber 0 EOF",
      "6: FLOCK  ADVISORY  WRITE not-a-pid 103:03:1 0 EOF",
      "\u0000\u0001 FLOCK",
      "7: FLOCK  ADVISORY  WRITE 4242 103:03:777 0 EOF",
    ].join("\n");
    expect([...flocksOf(table, 4242)]).toEqual(["259:3:777"]);
    expect([...flocksOf("1: FLOCK  ADVISORY  WRITE 4242 103:", 4242)]).toEqual([]);
    expect([...flocksOf("", 4242)]).toEqual([]);
  });

  test("names a file the way the lock table does", () => {
    // 259:3 is an NVMe partition; Linux packs major 259 and minor 3 into dev_t as 0x10303.
    expect(fileKey(0x10303n, 25690149n)).toBe("259:3:25690149");
    expect(fileKey(BigInt(statSync(FIXTURE_PATH, { bigint: true }).dev), 1n)).toMatch(/^\d+:\d+:1$/);
  });
});

describe("dsh discovery", () => {
  /** A fake lock table: the files each pid holds a FLOCK write lock on. */
  function proc(locked: Record<number, string[]>): ProcReader {
    return {
      flocks: async (pid) =>
        new Set((locked[pid] ?? []).map((path) => {
          const st = statSync(path, { bigint: true });
          return fileKey(st.dev, st.ino);
        })),
    };
  }

  const header = (depth: number): string => JSON.stringify({ type: "session", version: 4, id: "x", cwd: "/home/operator/project", delegationDepth: depth });

  function setup() {
    const root = newRoot();
    const lock = (id: string): string => join(root, "--home-operator-project--", id, "session.lock");
    return { root, source: new DshTranscriptSource([root]), lock };
  }

  test("names the session whose lock the pane's foreground process holds", async () => {
    const { root, source, lock } = setup();
    writeSession(root, ID, batches());
    writeSession(root, "other-session", [[header(0)]]);
    const discover = createDshDiscovery([root], source, proc({ 10: [lock(ID)] }));
    expect(await discover("/home/operator/project", { processes: [{ argv: ["node", "dsh"], pid: 10 }] })).toEqual({ kind: "id", value: ID });
  });

  test("sets a sub-agent's session aside, so the top-level one still answers", async () => {
    const { root, source, lock } = setup();
    writeSession(root, ID, batches());
    writeSession(root, "child-session", [[header(1)]]);
    const both = [lock(ID), lock("child-session")];
    const discover = createDshDiscovery([root], source, proc({ 10: both }));
    expect(await discover("/", { processes: [{ argv: ["dsh"], pid: 10 }] })).toEqual({ kind: "id", value: ID });
  });

  test("refuses two top-level sessions, no lock, no process list and a lock outside the root", async () => {
    const { root, source, lock } = setup();
    writeSession(root, ID, batches());
    writeSession(root, "second", [[header(0)]]);
    const two = createDshDiscovery([root], source, proc({ 10: [lock(ID)], 11: [lock("second")] }));
    expect(await two("/", { processes: [{ argv: [], pid: 10 }, { argv: [], pid: 11 }] })).toBeNull();

    const unlocked = createDshDiscovery([root], source, proc({}));
    expect(await unlocked("/", { processes: [{ argv: [], pid: 10 }] })).toBeNull();

    const blind = createDshDiscovery([root], source, proc({ 10: [lock(ID)] }));
    expect(await blind("/", {})).toBeNull();
    expect(await blind("/", { processes: [{ argv: [] }] })).toBeNull();

    const elsewhere = newRoot();
    const outside = writeSession(elsewhere, ID, batches());
    const stray = join(outside, "..", "session.lock");
    const foreign = createDshDiscovery([root], source, proc({ 10: [stray] }));
    expect(await foreign("/", { processes: [{ argv: [], pid: 10 }] })).toBeNull();
  });

  test("an unreadable /proc/locks (EACCES or ENOENT) means no session and no throw", async () => {
    if (process.platform !== "linux") return;
    const { root, source, lock } = setup();
    writeSession(root, ID, batches());
    for (const code of ["EACCES", "ENOENT"]) {
      // Discovery reads nothing else through `readFile` before it reaches the lock table.
      const read = spyOn(fsPromises, "readFile").mockRejectedValue(Object.assign(new Error(`${code}: /proc/locks`), { code }));
      try {
        expect(await LINUX_PROC.flocks(10)).toBeNull();
        expect(await createDshDiscovery([root], source, LINUX_PROC)("/", { processes: [{ argv: ["dsh"], pid: 10 }] })).toBeNull();
        expect(read).toHaveBeenCalledWith("/proc/locks", "utf8");
      } finally {
        read.mockRestore();
      }
    }
    // Control: the same session is found when the table is readable and names its lock.
    const ok = createDshDiscovery([root], source, { flocks: async () => new Set([fileKey(statSync(lock(ID), { bigint: true }).dev, statSync(lock(ID), { bigint: true }).ino)]) });
    expect(await ok("/", { processes: [{ argv: ["dsh"], pid: 10 }] })).toEqual({ kind: "id", value: ID });
  });

  test("answers null when /proc cannot be read", async () => {
    const { root, source } = setup();
    writeSession(root, ID, batches());
    const none: ProcReader = { flocks: async () => null };
    expect(await createDshDiscovery([root], source, none)("/", { processes: [{ argv: [], pid: 10 }] })).toBeNull();
  });
});
