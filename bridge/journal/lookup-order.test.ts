// Which log a lookup by session id lands on, when it may walk on past a refused one (#839, #840).
//
//  - pi: the lookup `resolve` makes and the one a command line's id makes use ONE order, so a session
//    discovered once and resolved again after a restart is the same log.
//  - Claude, grok, kiro: folder names carry no time, so the newest modified log comes first.
//  - Every reader: walking on past a refused log never reaches a file named for ANOTHER id, one whose
//    name merely ends in or contains this id.
//
// Temp folders only; nothing outside them is read.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ClaudeTranscriptSource } from "./claude.ts";
import { CodexTranscriptSource } from "./codex.ts";
import { GrokTranscriptSource } from "./grok.ts";
import { KiroTranscriptSource } from "./kiro-sessions.ts";
import { McodeTranscriptSource } from "./mcode.ts";
import { MuseTranscriptSource } from "./muse.ts";
import { PiTranscriptSource } from "./pi.ts";

const UUID = "4f2a9c1e-7b3d-4e8f-a061-5d2c8b9e0f34";
const MCODE_ID = "mvs_ordertest01";
const MCODE_CODE = Buffer.from(MCODE_ID).toString("base64url");
const T0 = Date.UTC(2026, 10, 1) / 1000;

const made: string[] = [];

afterEach(async () => {
  for (const base of made.splice(0)) await rm(base, { recursive: true, force: true });
});

async function box(): Promise<{ base: string; root: string; outside: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-lookup-order-")));
  made.push(base);
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const outside = join(base, "outside.jsonl");
  await writeFile(outside, '{"secret":"outside the root"}\n');
  return { base, root, outside };
}

/** A file with a fixed modified time, `age` seconds after the test clock's zero. */
async function file(path: string, age = 0, text = "{}\n"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await utimes(path, T0 + age, T0 + age);
}

async function linked(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

describe("pi: discovery by id and resolve land on the same log", () => {
  test("one id in both folders of a cwd: the newest name, whichever lookup asks", async () => {
    const b = await box();
    // A cwd under home is filed under two folder names; discovery lists the `--…--` one first.
    const home = join(b.base, "h");
    const cwd = join(home, "proj");
    const encoded = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
    const older = join(b.root, encoded, `2026-10-30T10-00-00-000Z_${UUID}.jsonl`);
    const newer = join(b.root, "-proj", `2026-10-31T10-00-00-000Z_${UUID}.jsonl`);
    const row = `${JSON.stringify({ type: "session", version: 3, id: UUID, cwd })}\n`;
    await file(older, 0, row);
    await file(newer, 0, row);
    const places = { home, tmp: join(b.base, "t") };

    const discovered = new PiTranscriptSource(b.root, places);
    const hints = { processes: [{ argv: ["pi", "--session", UUID] }], shared: true as const };
    const ref = await discovered.discoverSession(cwd, hints);
    expect(ref).toEqual({ kind: "id", value: UUID });
    expect(await discovered.resolve(ref!)).toBe(newer);
    // After a restart nothing is cached: resolve's own walk gives the same answer.
    expect(await new PiTranscriptSource(b.root, places).resolve(ref!)).toBe(newer);
  });
});

const BY_FILE = [
  {
    name: "claude",
    resolve: (root: string) => new ClaudeTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    at: (root: string, folder: string) => join(root, folder, `${UUID}.jsonl`),
  },
  {
    name: "grok",
    resolve: (root: string) => new GrokTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    at: (root: string, folder: string) => join(root, folder, UUID, "chat_history.jsonl"),
  },
  {
    name: "kiro",
    resolve: (root: string) => new KiroTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    at: (root: string, folder: string) => join(root, folder, UUID, "messages.jsonl"),
  },
] as const;

for (const reader of BY_FILE) {
  describe(`${reader.name}: one id in two folders`, () => {
    test("the newest modified log wins, whatever the folder names", async () => {
      const b = await box();
      await file(reader.at(b.root, "a-first-by-name"), 10);
      await file(reader.at(b.root, "z-last-by-name"), 20);
      expect(await reader.resolve(b.root)).toBe(reader.at(b.root, "z-last-by-name"));
    });

    test("on the same modified time, the folder whose name sorts first", async () => {
      const b = await box();
      await file(reader.at(b.root, "z-folder"), 10);
      await file(reader.at(b.root, "a-folder"), 10);
      expect(await reader.resolve(b.root)).toBe(reader.at(b.root, "a-folder"));
    });
  });
}

/**
 * Each reader with its exact-id log refused, beside files named for a LONGER or PREFIXED id. The
 * lookup walks on past the refusal; it must find nothing, because none of the others is this
 * session's log.
 */
const EXACT = [
  {
    name: "codex",
    resolve: (root: string) => new CodexTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    exact: (root: string) => join(root, "2026", "08", "11", `rollout-2026-08-11T12-00-00-${UUID}.jsonl`),
    decoys: (root: string) => [
      join(root, "2026", "08", "11", `rollout-2026-08-11T10-00-00-0${UUID}.jsonl`),
      join(root, "2026", "08", "11", `rollout-2026-08-11T10-00-00-${UUID}0.jsonl`),
      join(root, "2026", "08", "11", `rollout-2026-08-11T10-00-00-${UUID}.jsonl.bak`),
    ],
  },
  {
    name: "pi",
    resolve: (root: string) => new PiTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    exact: (root: string) => join(root, "--work--", `2026-10-31T10-00-00-000Z_${UUID}.jsonl`),
    decoys: (root: string) => [
      join(root, "--work--", `2026-10-30T10-00-00-000Z_0${UUID}.jsonl`),
      join(root, "--work--", `2026-10-30T10-00-00-000Z_${UUID}0.jsonl`),
      join(root, "--work--", `2026-10-30T10-00-00-000Z_${UUID}.jsonl.bak`),
    ],
  },
  {
    name: "mcode",
    resolve: (root: string) => new McodeTranscriptSource(root).resolve({ kind: "id", value: MCODE_ID }),
    exact: (root: string) => join(root, "2026", "11", "08", `11-00-00-000-session_${MCODE_CODE}`, "messages.jsonl"),
    decoys: (root: string) => [
      // Another id's code that merely ends in this one's: base64url has `_` and letters.
      join(root, "2026", "11", "08", `10-00-00-000-Xsession_${MCODE_CODE}`, "messages.jsonl"),
      join(root, "2026", "11", "08", `10-00-00-000-session_${MCODE_CODE}A`, "messages.jsonl"),
    ],
  },
  {
    name: "muse",
    resolve: (root: string) => new MuseTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    exact: (root: string) => join(root, "2026", "11", "08", UUID, "session.jsonl"),
    decoys: (root: string) => [
      join(root, "2026", "11", "08", `0${UUID}`, "session.jsonl"),
      join(root, "2026", "11", "08", `${UUID}0`, "session.jsonl"),
    ],
  },
  {
    name: "claude",
    resolve: (root: string) => new ClaudeTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    exact: (root: string) => join(root, "-work-a", `${UUID}.jsonl`),
    decoys: (root: string) => [
      join(root, "-work-b", `0${UUID}.jsonl`),
      join(root, "-work-b", `${UUID}0.jsonl`),
      join(root, "-work-b", `${UUID}.jsonl.bak`),
    ],
  },
  {
    name: "grok",
    resolve: (root: string) => new GrokTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    exact: (root: string) => join(root, "work-a", UUID, "chat_history.jsonl"),
    decoys: (root: string) => [
      join(root, "work-b", `0${UUID}`, "chat_history.jsonl"),
      join(root, "work-b", `${UUID}0`, "chat_history.jsonl"),
    ],
  },
  {
    name: "kiro",
    resolve: (root: string) => new KiroTranscriptSource(root).resolve({ kind: "id", value: UUID }),
    exact: (root: string) => join(root, "bucket-a", UUID, "messages.jsonl"),
    decoys: (root: string) => [
      join(root, "bucket-b", `0${UUID}`, "messages.jsonl"),
      join(root, "bucket-b", `${UUID}0`, "messages.jsonl"),
    ],
  },
] as const;

for (const reader of EXACT) {
  test(`${reader.name}: past a refused log, a file for a longer or prefixed id is not served`, async () => {
    const b = await box();
    await linked(reader.exact(b.root), b.outside);
    for (const decoy of reader.decoys(b.root)) await file(decoy);
    expect(await reader.resolve(b.root)).toBeNull();
  });
}
