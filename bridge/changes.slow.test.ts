// The slow cases of changes.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangesScope, gitEnv, sharedDiffs, sharedFileDiff, gitRuns, CHANGES_SHARE_MS } from "./changes.ts";

/** The scope a device WITHOUT the Files right reads under: the bound on, no private folders. */
const S: ChangesScope = { home: homedir(), privateFolders: [], wide: false };

// Real git, in throwaway folders. The module's whole job is how it drives git, so a fake would
// test the fake.

let base: string;

/** gitEnv with transports allowed again, so fixtures can clone. The runner under test refuses them. */
function fixtureEnv(): Record<string, string> {
  const env = gitEnv(process.env);
  delete env.GIT_ALLOW_PROTOCOL;
  delete env.GIT_NO_LAZY_FETCH;
  delete env.GIT_PROTOCOL_FROM_USER;
  return env;
}

/** Plain git for building fixtures — NOT the hardened runner under test. */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args],
    { cwd, env: fixtureEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

function write(path: string, content: string | Uint8Array) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A repo with one committed file, `a.txt`. */
function repo(dir: string, files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n" }): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [name, content] of Object.entries(files)) write(join(dir, name), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "collie-changes-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("shared reads (ADR 0065 rule 8)", () => {
  describe("against real git", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "collie-changes-shared-"));
      repo(join(dir, "r"));
      write(join(dir, "r", "a.txt"), "changed\n");
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("two concurrent diff asks start git once between them, and run again after the window", async () => {
      const root = join(dir, "r");
      sharedDiffs.clear();
      const q = { depth: 2, nested: true, repo: ".", path: "a.txt" };
      const start = gitRuns.spawned;
      const [a, b] = await Promise.all([sharedFileDiff(root, q, S), sharedFileDiff(root, q, S)]);
      const one = gitRuns.spawned - start;
      expect(one).toBeGreaterThan(0);
      expect(a).toBe(b);
      await Bun.sleep(CHANGES_SHARE_MS + 50);
      const later = gitRuns.spawned;
      const c = await sharedFileDiff(root, q, S);
      expect(gitRuns.spawned - later).toBe(one);
      expect(c).not.toBe(a);
    });
  });
});
