// mcode's remembered log path is checked against the root that found it, and only that root.
//
// The cache used to hold the path alone and guess its root back with a bare `startsWith`, falling
// back to the path itself when no root string matched (a configured root that is a symlink). A check
// of a path against itself accepts whatever the name points at later. Temp folders only.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { McodeTranscriptSource } from "./mcode.ts";

const ID = "mvs_cachetest01";
const DIR = `session_${Buffer.from(ID).toString("base64url")}`;
const REF = { kind: "id", value: ID } as const;

const made: string[] = [];

afterEach(async () => {
  for (const base of made.splice(0)) await rm(base, { recursive: true, force: true });
});

async function tempBase(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "collie-mcode-cache-")));
  made.push(base);
  return base;
}

/** The log of the session under `root` on one day. */
function logOn(root: string, day: string, time = "10-00-00-000"): string {
  return join(root, "2026", "11", day, `${time}-${DIR}`, "messages.jsonl");
}

async function readable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}\n");
}

describe("mcode: a remembered log path", () => {
  test("a cached log replaced by a symlink out of a symlinked root is refused, and the scan runs", async () => {
    const base = await tempBase();
    const real = join(base, "real-sessions");
    const root = join(base, "sessions");
    await mkdir(real, { recursive: true });
    await symlink(real, root, "dir");
    const outside = join(base, "outside.jsonl");
    await writeFile(outside, '{"secret":"outside the root"}\n');
    const newest = logOn(real, "08");
    const older = logOn(real, "07");
    await readable(newest);
    await readable(older);

    const src = new McodeTranscriptSource(root);
    expect(await src.resolve(REF)).toBe(newest);

    await rm(newest);
    await symlink(outside, newest);
    // The scan runs again: the refused newest is skipped for the older log of the same session.
    expect(await src.resolve(REF)).toBe(older);
  });

  test("a symlinked configured root still serves its own log, from the cache too", async () => {
    const base = await tempBase();
    const real = join(base, "real-sessions");
    const root = join(base, "sessions");
    await mkdir(real, { recursive: true });
    await symlink(real, root, "dir");
    const log = logOn(real, "08");
    await readable(log);

    const src = new McodeTranscriptSource(root);
    expect(await src.resolve(REF)).toBe(log);
    expect(await src.resolve(REF)).toBe(log);
  });

  test("a root whose name starts with another root's name is not taken for that root", async () => {
    // `sessions` and `sessions-evil` share a prefix. A log of `sessions-evil` swapped for a link into
    // `sessions` must be judged by `sessions-evil`, which refuses it.
    const base = await tempBase();
    const sessions = join(base, "sessions");
    const evil = join(base, "sessions-evil");
    const inSessions = join(sessions, "other.jsonl");
    await readable(inSessions);
    const log = logOn(evil, "08");
    await readable(log);

    const src = new McodeTranscriptSource([sessions, evil]);
    expect(await src.resolve(REF)).toBe(log);

    await rm(log);
    await symlink(inSessions, log);
    expect(await src.resolve(REF)).toBeNull();
  });
});
