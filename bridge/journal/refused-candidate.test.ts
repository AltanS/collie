// A lookup by session id that meets a refused candidate goes on to the next one (#839, #840).
//
// Every source below finds a log by its session id under a sessions root, and every path it serves
// passes `containedRealpath` (files.ts): a symlink out of the root is refused. The defect was in the
// lookup around that check: it took ONE candidate and answered the check's verdict for it, so a
// refused first candidate hid a readable log for the same id elsewhere under the same root. These
// tests build real files and real symlinks in a temp folder; nothing outside it is read.
//
// Symlinks: the journal tests already make them with no Windows skip (codex, pi, kiro, ...), so these
// do too. A folder made unreadable with chmod is not enforced on Windows (see mcode.test.ts) and not
// for root, so that part runs only where it means something.

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ClaudeTranscriptSource } from "./claude.ts";
import { CodexTranscriptSource } from "./codex.ts";
import { firstContained, MAX_REFUSED_CANDIDATES } from "./files.ts";
import { GrokTranscriptSource } from "./grok.ts";
import { KiroTranscriptSource } from "./kiro-sessions.ts";
import { McodeTranscriptSource } from "./mcode.ts";
import { MuseTranscriptSource } from "./muse.ts";
import { PiTranscriptSource } from "./pi.ts";

const UUID = "0b6c1f7e-3a52-4d8e-9f10-2c4b6d8e0a12";
const MCODE_ID = "mvs_shadowtest01";
const MCODE_DIR = `session_${Buffer.from(MCODE_ID).toString("base64url")}`;

/** chmod 000 on a folder keeps a non-root Linux or macOS process out; elsewhere it does not. */
const CHMOD_BITES = process.platform !== "win32" && process.getuid?.() !== 0;

interface Layout {
  /** The candidate tried first (the newest name, or the newest file where names carry no time). */
  readonly first: string;
  /** A candidate tried after `first`. */
  readonly second: string;
  /** A candidate tried after `second`. Made last, so a `readdir` in creation order or its reverse
   *  meets a refused candidate before `second` either way: the old code failed on both. */
  readonly third: string;
  /** A folder tried before `second`, with a candidate for the id inside, that the test makes unreadable. */
  readonly blocked: { readonly folder: string; readonly file: string };
}

interface SourceCase {
  readonly name: string;
  /** A fresh source over `root`, resolving the case's id. */
  readonly resolve: (root: string) => Promise<string | null>;
  readonly layout: (root: string) => Layout;
}

const CASES: readonly SourceCase[] = [
  {
    name: "codex",
    resolve: (root) => new CodexTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    layout: (root) => ({
      first: join(root, "2026", "08", "12", `rollout-2026-08-12T10-00-00-${UUID}.jsonl`),
      second: join(root, "2026", "08", "11", `rollout-2026-08-11T10-00-00-${UUID}.jsonl`),
      third: join(root, "2026", "08", "10", `rollout-2026-08-10T10-00-00-${UUID}.jsonl`),
      blocked: {
        folder: join(root, "2026", "08", "13"),
        file: join(root, "2026", "08", "13", `rollout-2026-08-13T10-00-00-${UUID}.jsonl`),
      },
    }),
  },
  {
    name: "pi",
    resolve: (root) => new PiTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    layout: (root) => ({
      first: join(root, "--work-a--", `2026-10-31T10-00-00-000Z_${UUID}.jsonl`),
      second: join(root, "--work-b--", `2026-10-30T10-00-00-000Z_${UUID}.jsonl`),
      third: join(root, "--work-c--", `2026-10-29T10-00-00-000Z_${UUID}.jsonl`),
      blocked: {
        folder: join(root, "--work-0--"),
        file: join(root, "--work-0--", `2026-11-01T10-00-00-000Z_${UUID}.jsonl`),
      },
    }),
  },
  {
    name: "mcode",
    resolve: (root) => new McodeTranscriptSource(root).resolve({ kind: "id", value: MCODE_ID }),
    layout: (root) => ({
      first: join(root, "2026", "11", "08", `11-00-00-000-${MCODE_DIR}`, "messages.jsonl"),
      second: join(root, "2026", "11", "07", `10-00-00-000-${MCODE_DIR}`, "messages.jsonl"),
      third: join(root, "2026", "11", "06", `10-00-00-000-${MCODE_DIR}`, "messages.jsonl"),
      blocked: {
        folder: join(root, "2026", "11", "09"),
        file: join(root, "2026", "11", "09", `10-00-00-000-${MCODE_DIR}`, "messages.jsonl"),
      },
    }),
  },
  {
    name: "muse",
    resolve: (root) => new MuseTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    layout: (root) => ({
      first: join(root, "2026", "11", "08", UUID, "session.jsonl"),
      second: join(root, "2026", "11", "07", UUID, "session.jsonl"),
      third: join(root, "2026", "11", "06", UUID, "session.jsonl"),
      blocked: { folder: join(root, "2026", "11", "09"), file: join(root, "2026", "11", "09", UUID, "session.jsonl") },
    }),
  },
  {
    name: "claude",
    resolve: (root) => new ClaudeTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    layout: (root) => ({
      first: join(root, "-work-a", `${UUID}.jsonl`),
      second: join(root, "-work-b", `${UUID}.jsonl`),
      third: join(root, "-work-c", `${UUID}.jsonl`),
      blocked: { folder: join(root, "-work-0"), file: join(root, "-work-0", `${UUID}.jsonl`) },
    }),
  },
  {
    name: "grok",
    resolve: (root) => new GrokTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    layout: (root) => ({
      first: join(root, "work-a", UUID, "chat_history.jsonl"),
      second: join(root, "work-b", UUID, "chat_history.jsonl"),
      third: join(root, "work-c", UUID, "chat_history.jsonl"),
      blocked: { folder: join(root, "work-0"), file: join(root, "work-0", UUID, "chat_history.jsonl") },
    }),
  },
  {
    name: "kiro",
    resolve: (root) => new KiroTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    layout: (root) => ({
      first: join(root, "bucket-a", UUID, "messages.jsonl"),
      second: join(root, "bucket-b", UUID, "messages.jsonl"),
      third: join(root, "bucket-c", UUID, "messages.jsonl"),
      blocked: { folder: join(root, "bucket-0"), file: join(root, "bucket-0", UUID, "messages.jsonl") },
    }),
  },
];

interface Sandbox {
  readonly base: string;
  readonly root: string;
  /** A real file outside the root that a planted symlink points at. Never served. */
  readonly outside: string;
}

const made: string[] = [];
const locked: string[] = [];

afterEach(async () => {
  for (const folder of locked.splice(0)) await chmod(folder, 0o755).catch(() => undefined);
  for (const base of made.splice(0)) await rm(base, { recursive: true, force: true });
});

async function sandbox(): Promise<Sandbox> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-refused-")));
  made.push(base);
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const outside = join(base, "outside.jsonl");
  await writeFile(outside, '{"secret":"outside the root"}\n');
  await utimes(outside, T0 + AGE.outside, T0 + AGE.outside);
  return { base, root, outside };
}

/** A fixed clock for modified times, so a reader that orders by the file (claude, grok, kiro) sees
 *  the layout's order: the outside file newest, then `blocked`, `first`, `second`, `third`. */
const T0 = Date.UTC(2026, 10, 1) / 1000;
const AGE = { outside: 100, blocked: 50, first: 40, second: 30, third: 20 } as const;

async function readable(path: string, age: number = 0): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}\n");
  await utimes(path, T0 + age, T0 + age);
}

async function linked(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

/** A served path lies under the real root; nothing outside it ever comes back. */
function expectInside(result: string | null, box: Sandbox): void {
  if (result === null) return;
  expect(result.startsWith(box.root)).toBe(true);
  expect(result).not.toBe(box.outside);
}

for (const source of CASES) {
  describe(`${source.name}: a refused candidate does not hide a readable log for the same id`, () => {
    test("the first candidate points out of the root: the next readable one is served", async () => {
      const box = await sandbox();
      const at = source.layout(box.root);
      await linked(at.first, box.outside);
      await readable(at.second, AGE.second);
      await linked(at.third, box.outside);
      const result = await source.resolve(box.root);
      expect(result).toBe(at.second);
      expectInside(result, box);
    });

    test("two readable candidates: the first in order still wins", async () => {
      const box = await sandbox();
      const at = source.layout(box.root);
      await readable(at.first, AGE.first);
      await readable(at.second, AGE.second);
      expect(await source.resolve(box.root)).toBe(at.first);
    });

    test("only refused candidates: no log, and the outside file is never the answer", async () => {
      const box = await sandbox();
      const at = source.layout(box.root);
      await linked(at.first, box.outside);
      await linked(at.second, box.outside);
      await linked(at.third, box.outside);
      expect(await source.resolve(box.root)).toBeNull();
    });

    test("a dangling symlink and an unreadable folder before it do not stop the scan", async () => {
      const box = await sandbox();
      const at = source.layout(box.root);
      await linked(at.first, join(box.root, "gone.jsonl"));
      await readable(at.blocked.file, AGE.blocked);
      if (CHMOD_BITES) {
        await chmod(at.blocked.folder, 0o000);
        locked.push(at.blocked.folder);
      }
      await readable(at.second, AGE.second);
      const result = await source.resolve(box.root);
      // Where chmod does not bite, the blocked folder's log is readable and comes first in order.
      expect(result).toBe(CHMOD_BITES ? at.second : at.blocked.file);
      expectInside(result, box);
    });
  });
}

describe("codex: two matching names in one date folder", () => {
  test("the larger name is refused: the smaller one in the same folder is served", async () => {
    const box = await sandbox();
    const day = join(box.root, "2026", "08", "11");
    const larger = join(day, `rollout-2026-08-11T12-00-00-${UUID}.jsonl`);
    const smaller = join(day, `rollout-2026-08-11T10-00-00-${UUID}.jsonl`);
    await linked(larger, box.outside);
    await readable(smaller);
    const result = await new CodexTranscriptSource(box.root).resolve({ kind: "id", value: UUID });
    expect(result).toBe(smaller);
    expectInside(result, box);
  });

  test("both readable: the larger name wins, as before", async () => {
    const box = await sandbox();
    const day = join(box.root, "2026", "08", "11");
    await readable(join(day, `rollout-2026-08-11T10-00-00-${UUID}.jsonl`));
    await readable(join(day, `rollout-2026-08-11T12-00-00-${UUID}.jsonl`));
    expect(await new CodexTranscriptSource(box.root).resolve({ kind: "id", value: UUID })).toBe(
      join(day, `rollout-2026-08-11T12-00-00-${UUID}.jsonl`),
    );
  });
});

describe("firstContained: the work is bounded", () => {
  test(`gives up after ${MAX_REFUSED_CANDIDATES} refusals, even with a readable path behind them`, async () => {
    const box = await sandbox();
    const good = join(box.root, "good.jsonl");
    await readable(good);
    const missing = join(box.root, "missing.jsonl");
    const refusedOnly = Array.from({ length: MAX_REFUSED_CANDIDATES }, () => missing);
    expect(await firstContained([...refusedOnly, good], box.root)).toBeNull();
    expect(await firstContained([...refusedOnly.slice(1), good], box.root)).toBe(good);
  });

  test("stops pulling candidates at the first one served", async () => {
    const box = await sandbox();
    const good = join(box.root, "good.jsonl");
    await readable(good);
    let pulled = 0;
    async function* lazy(): AsyncGenerator<string> {
      for (const path of [join(box.root, "missing.jsonl"), good, box.outside]) {
        pulled += 1;
        yield path;
      }
    }
    expect(await firstContained(lazy(), box.root)).toBe(good);
    expect(pulled).toBe(2);
  });
});

describe("pi: a session the command line names by id", () => {
  test("a refused log in the folder does not hide the readable one for the same id", async () => {
    const box = await sandbox();
    const folder = join(box.root, "--srv-proj--");
    const newest = join(folder, `2026-10-31T10-00-00-000Z_${UUID}.jsonl`);
    const older = join(folder, `2026-10-30T10-00-00-000Z_${UUID}.jsonl`);
    const oldest = join(folder, `2026-10-29T10-00-00-000Z_${UUID}.jsonl`);
    await linked(newest, box.outside);
    await mkdir(folder, { recursive: true });
    await writeFile(older, `${JSON.stringify({ type: "session", version: 3, id: UUID, cwd: "/srv/proj" })}\n`);
    await linked(oldest, box.outside);
    const src = new PiTranscriptSource(box.root, { home: box.base, tmp: box.base });
    const hints = { processes: [{ argv: ["pi", "--session", UUID] }], shared: true as const };
    const ref = await src.discoverSession("/srv/proj", hints);
    expect(ref).toEqual({ kind: "id", value: UUID });
    const result = await src.resolve(ref!);
    expect(result).toBe(older);
    expectInside(result, box);
  });
});
