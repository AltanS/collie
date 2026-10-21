import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maskSnapshotTitles, maskSubagentList } from "./answer-mask.ts";
import { ClaudeTranscriptSource } from "./journal/claude.ts";
import type { RowReducer } from "./journal/reduce.ts";
import type { JournalAdapter, TranscriptSource } from "./journal/types.ts";
import {
  MAX_SUBAGENTS,
  METALESS_RUNNING_MS,
  parseSubagentMeta,
  QUIET_RUNNING_MS,
  SubagentTracker,
  SUBAGENT_DESCRIPTION_MAX,
  type SubagentFs,
} from "./subagents.ts";
import type { AgentView } from "./types.ts";

const SID = "21fc21e5-bc20-4627-b94f-d3d20b1c86bf";
const base = mkdtempSync(join(tmpdir(), "collie-subagents-"));
const outside = mkdtempSync(join(tmpdir(), "collie-subagents-out-"));

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** The meta file fields a fixture writes, in Claude Code's own names. */
interface MetaFixture {
  agentType?: string;
  description?: string;
  model?: string;
  spawnDepth?: number;
  finished?: boolean;
}

let folderCount = 0;
/** A fresh `subagents` folder. Files written into it get the mtime the test names. */
function folder() {
  folderCount += 1;
  const dir = join(base, `case-${String(folderCount)}`, "subagents");
  mkdirSync(dir, { recursive: true });
  const write = (name: string, text: string, mtimeMs: number) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  };
  return {
    dir,
    meta: (id: string, meta: MetaFixture, mtimeMs: number) => write(`agent-${id}.meta.json`, JSON.stringify(meta), mtimeMs),
    raw: (name: string, text: string, mtimeMs: number) => write(name, text, mtimeMs),
    log: (id: string, mtimeMs: number) => write(`agent-${id}.jsonl`, '{"type":"user"}\n', mtimeMs),
  };
}

/** A clock that starts a little after the files' own mtimes, which are real wall-clock seconds. */
function clock(start = Date.now()) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

function adapterOver(dirs: () => string[]): JournalAdapter {
  const source: TranscriptSource = {
    resolve: async () => null,
    stat: async () => null,
    load: async () => ({ text: "", complete: true, size: 0, mtimeMs: 0 }),
    readSince: async () => ({ lines: [], cursor: "", reset: true, fromStart: true }),
    subagentDirs: async () => dirs(),
  };
  return {
    agent: "claude",
    source,
    parse: () => [],
    reducer: (): RowReducer => {
      throw new Error("the subagent tracker does not fold a live window");
    },
  };
}

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "project",
    workspaceNumber: 1,
    tabId: "t1",
    agent: "claude",
    agentSession: { kind: "id", value: SID },
    status: "working",
    cwd: "/work",
    focused: false,
    kind: "agent",
    ...over,
  };
}

/** How many times each file system call ran. */
interface FsCalls {
  readdir: number;
  stat: number;
  read: number;
}

/** A counting file system over the real one, so a test can say "this read touched nothing". */
interface CountingFs {
  fs: SubagentFs;
  calls: FsCalls;
}

function countingFs(): CountingFs {
  const calls: FsCalls = { readdir: 0, stat: 0, read: 0 };
  const fs: SubagentFs = {
      readdir: async (dir) => {
        calls.readdir += 1;
        return readdir(dir);
      },
      stat: async (path) => {
        calls.stat += 1;
        try {
          const st = await stat(path);
          return { mtimeMs: st.mtimeMs, size: st.size, birthtimeMs: st.birthtimeMs };
        } catch {
          return null;
        }
      },
      readText: async (path, max) => {
        calls.read += 1;
        return Bun.file(path).slice(0, max).text();
      },
  };
  return { fs, calls };
}

describe("parseSubagentMeta", () => {
  test("reads a real meta file's shape", () => {
    const meta = parseSubagentMeta(
      '{"agentType":"general-purpose","description":"Walky docs trial, haiku A","toolUseId":"toolu_01Drjgyt2NJoGYLuB6BoGS1C","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"model":"haiku","finished":true}',
    );
    expect(meta).toEqual({ finished: true, agentType: "general-purpose", model: "haiku", description: "Walky docs trial, haiku A", spawnDepth: 1 });
  });

  test("a meta without `finished` is unfinished; a non-object is null", () => {
    expect(parseSubagentMeta('{"description":"x"}')?.finished).toBe(false);
    expect(parseSubagentMeta('{"description":"x","finished":"true"}')?.finished).toBe(false);
    expect(parseSubagentMeta("{not json")).toBeNull();
    expect(parseSubagentMeta("[1,2]")).toBeNull();
  });

  test("clips the description to one line", () => {
    const meta = parseSubagentMeta(JSON.stringify({ description: `one\n\ntwo ${"x".repeat(400)}` }));
    expect(meta?.description.startsWith("one two ")).toBe(true);
    expect(meta?.description).toHaveLength(SUBAGENT_DESCRIPTION_MAX);
    expect(meta?.description.endsWith("…")).toBe(true);
  });
});

describe("SubagentTracker", () => {
  test("lists a running subagent and leaves out a finished one", async () => {
    const c = clock();
    const f = folder();
    const started = c.now() - 60_000;
    f.meta("acc7972eef92651f4", { agentType: "general-purpose", description: "Agents pill on the belt", spawnDepth: 1, model: "opus" }, started);
    f.log("acc7972eef92651f4", c.now() - 5_000);
    f.meta("a1c31a2682cba255f", { agentType: "Explore", description: "Done already", model: "haiku", finished: true }, c.now() - 10_000);
    f.log("a1c31a2682cba255f", c.now() - 10_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    const list = tracker.get(pane());
    expect(list).toHaveLength(1);
    const [one] = list!;
    expect(one).toMatchObject({ agentId: "acc7972eef92651f4", agentType: "general-purpose", model: "opus", description: "Agents pill on the belt", spawnDepth: 1 });
    expect(Number.isNaN(Date.parse(one!.startedAt!))).toBe(false);
  });

  test("is ABSENT, never [], when nothing is running", async () => {
    const c = clock();
    const f = folder();
    f.meta("a1c31a2682cba255f", { description: "Done", finished: true }, c.now() - 10_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();
  });

  test("an unfinished meta whose log has been quiet past the window is a ghost, not a runner", async () => {
    const c = clock();
    const f = folder();
    const old = c.now() - QUIET_RUNNING_MS - 60_000;
    f.meta("a42e4cca7c4fd775d", { description: "Died with its session" }, old);
    f.log("a42e4cca7c4fd775d", old);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();
  });

  test("a log with no meta counts as running only while it was written in the last ten minutes", async () => {
    const c = clock();
    const f = folder();
    f.log("a0000000000000001", c.now() - 30_000);
    f.log("a0000000000000002", c.now() - METALESS_RUNNING_MS - 60_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())?.map((s) => s.agentId)).toEqual(["a0000000000000001"]);
    expect(tracker.get(pane())?.[0]?.description).toBe("");
  });

  test("a malformed meta is skipped, and read again once it changes", async () => {
    const c = clock();
    const f = folder();
    f.raw("agent-a71a608a981ceee4a.meta.json", "{half a meta", c.now() - 20_000);
    f.log("a71a608a981ceee4a", c.now() - 1_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now, { floorMs: 1000 });
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();
    f.meta("a71a608a981ceee4a", { description: "Palette lists plugin skills", model: "sonnet" }, c.now() - 10_000);
    c.advance(1500);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())?.[0]?.description).toBe("Palette lists plugin skills");
  });

  test("a file name whose id fails the guard is never read", async () => {
    const c = clock();
    const f = folder();
    // A fork's named id, Claude's own compaction file, and a name that would climb out of the folder.
    f.meta("aalso-2-more-5069a5b0fcab4637", { description: "named fork" }, c.now() - 1_000);
    f.meta("acompact-1234abcd", { description: "compaction" }, c.now() - 1_000);
    f.raw("agent-..%2F..%2Fetc.meta.json", JSON.stringify({ description: "climb" }), c.now() - 1_000);
    const counted = countingFs();
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now, { fs: counted.fs });
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();
    expect(counted.calls.stat).toBe(0);
    expect(counted.calls.read).toBe(0);
  });

  test("a meta that is a symlink out of the folder is not read", async () => {
    const c = clock();
    const f = folder();
    const planted = join(outside, "planted.meta.json");
    writeFileSync(planted, JSON.stringify({ description: "from outside" }));
    symlinkSync(planted, join(f.dir, "agent-abcdef0123456789.meta.json"));
    f.log("abcdef0123456789", c.now() - 1_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();
  });

  test(`caps the list at ${String(MAX_SUBAGENTS)}, oldest first`, async () => {
    const c = clock();
    const f = folder();
    for (let i = 0; i < MAX_SUBAGENTS + 7; i++) {
      const id = `a${i.toString(16).padStart(16, "0")}`;
      f.meta(id, { description: `job ${String(i)}` }, c.now() - 100_000 + i * 1000);
    }
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    const list = tracker.get(pane())!;
    expect(list).toHaveLength(MAX_SUBAGENTS);
    expect(list[0]?.description).toBe("job 0");
  });

  test("the same id in two folders is listed once", async () => {
    const c = clock();
    const a = folder();
    const b = folder();
    a.meta("a71a608a981ceee4a", { description: "one" }, c.now() - 1_000);
    b.meta("a71a608a981ceee4a", { description: "one" }, c.now() - 1_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [a.dir, b.dir]) }, c.now);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toHaveLength(1);
  });

  test("a second read inside the floor touches nothing; a changed mtime re-parses", async () => {
    const c = clock();
    const f = folder();
    f.meta("a71a608a981ceee4a", { description: "first words" }, c.now() - 10_000);
    f.log("a71a608a981ceee4a", c.now() - 1_000);
    f.meta("a1c31a2682cba255f", { description: "done", finished: true }, c.now() - 10_000);
    const counted = countingFs();
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now, { floorMs: 5000, fs: counted.fs });
    await tracker.refresh([pane()]);
    expect(counted.calls).toEqual({ readdir: 1, stat: 3, read: 2 });

    c.advance(1000);
    await tracker.refresh([pane()]);
    expect(counted.calls).toEqual({ readdir: 1, stat: 3, read: 2 });

    // Past the floor with nothing changed: one listing, every meta statted, the running one's log too,
    // and nothing re-parsed.
    c.advance(5000);
    await tracker.refresh([pane()]);
    expect(counted.calls).toEqual({ readdir: 2, stat: 6, read: 2 });
    expect(tracker.get(pane())?.[0]?.description).toBe("first words");

    f.meta("a71a608a981ceee4a", { description: "second words" }, c.now() - 500);
    c.advance(5000);
    await tracker.refresh([pane()]);
    expect(counted.calls.read).toBe(3);
    expect(tracker.get(pane())?.[0]?.description).toBe("second words");

    // It finishes: it leaves the list. The next read still stats both metas, reads no log, parses nothing.
    f.meta("a71a608a981ceee4a", { description: "second words", finished: true }, c.now());
    c.advance(5000);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();
    const before = { ...counted.calls };
    c.advance(5000);
    await tracker.refresh([pane()]);
    expect(counted.calls).toEqual({ readdir: before.readdir + 1, stat: before.stat + 2, read: before.read });
  });

  test("a finished subagent that SendMessage resumes lists as running again", async () => {
    const c = clock();
    const f = folder();
    f.meta("afaccaef48d594a12", { agentType: "general-purpose", description: "Harness settings: hide status line", model: "sonnet", finished: true }, c.now() - 20 * 60_000);
    f.log("afaccaef48d594a12", c.now() - 20 * 60_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now, { floorMs: 5000 });
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toBeUndefined();

    // Claude Code writes the same meta again without `finished`, then the log moves on.
    f.meta("afaccaef48d594a12", { agentType: "general-purpose", description: "Harness settings: hide status line", model: "sonnet" }, c.now() - 14_000);
    f.log("afaccaef48d594a12", c.now() - 1_000);
    c.advance(5000);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())?.map((s) => s.agentId)).toEqual(["afaccaef48d594a12"]);
  });

  test("reads nothing for a pane whose harness source has no subagent folders", async () => {
    const c = clock();
    const f = folder();
    f.meta("a71a608a981ceee4a", { description: "x" }, c.now());
    const plain = adapterOver(() => [f.dir]);
    const { subagentDirs: _drop, ...noDirs } = plain.source;
    const counted = countingFs();
    const tracker = new SubagentTracker({ codex: { ...plain, agent: "codex", source: noDirs } }, c.now, { fs: counted.fs });
    await tracker.refresh([pane({ agent: "codex" })]);
    expect(tracker.get(pane({ agent: "codex" }))).toBeUndefined();
    expect(counted.calls.readdir).toBe(0);
  });

  test("forgets a pane that left the session's list", async () => {
    const c = clock();
    const f = folder();
    f.meta("a71a608a981ceee4a", { description: "x" }, c.now() - 1_000);
    const tracker = new SubagentTracker({ claude: adapterOver(() => [f.dir]) }, c.now);
    await tracker.refresh([pane()]);
    expect(tracker.get(pane())).toHaveLength(1);
    await tracker.refresh([]);
    expect(tracker.get(pane())).toBeUndefined();
  });
});

describe("the Claude source names the folders", () => {
  test("subagentDirs finds `<session>/subagents` beside the log, and nothing for an unsafe ref", async () => {
    const root = join(base, "projects");
    const proj = join(root, "-work");
    mkdirSync(join(proj, SID, "subagents"), { recursive: true });
    writeFileSync(join(proj, `${SID}.jsonl`), '{"type":"user","sessionId":"' + SID + '"}\n');
    const source = new ClaudeTranscriptSource(root);
    const dirs = await source.subagentDirs({ kind: "id", value: SID });
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.endsWith(join(SID, "subagents"))).toBe(true);
    expect(await source.subagentDirs({ kind: "id", value: "../../etc" })).toEqual([]);
    expect(await source.subagentDirs({ kind: "path", value: proj })).toEqual([]);
  });
});

describe("the redact mask", () => {
  const key = `sk-test-placeholder-${"0".repeat(40)}`;

  test("masks a subagent's description and nothing else", () => {
    const list = [{ agentId: "a71a608a981ceee4a", model: "opus", description: `use ${key} here` }];
    const [masked] = maskSubagentList(list);
    expect(masked!.description).not.toContain(key);
    expect(masked!.agentId).toBe("a71a608a981ceee4a");
    expect(masked!.model).toBe("opus");
    expect(list[0]!.description).toContain(key);
  });

  test("a member's snapshot gets its subagents masked on the lead", () => {
    const out = maskSnapshotTitles({
      agents: [{ subagents: [{ description: `use ${key}` }] }, {}],
      shellPanes: [],
    });
    expect(out.agents[0]!.subagents![0]!.description).not.toContain(key);
    expect(out.agents[1]!.subagents).toBeUndefined();
  });
});
