// The slow cases of official.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "./fetch.ts";

// The official list (official.ts) and the add from it (official-install.ts). Every source is a bare
// repository under the test's temp dir, reached as `file://` through the test seam: nothing here touches
// the network. Each case runs real git a few times, so the limit is longer than the default.

setDefaultTimeout(30_000);

const posix = process.platform !== "win32";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-official-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// ── the git run's process group ──────────────────────────────────────────────

describe.if(posix)("a git run killed at its time cap", () => {
  test("takes its whole process group: a helper git started dies with it", async () => {
    // A stand-in `git` that starts a helper in the background (as `git fetch` starts `git-remote-https`),
    // writes the helper's pid, and waits. The run is killed at 300 ms; the helper must be gone too.
    const bin = await tempDir();
    const pidFile = join(bin, "helper.pid");
    const groupFile = join(bin, "groups");
    // It also writes its own pid, its process group, and the helper's group: `detached: true` in Bun's spawn
    // makes git the leader of a new group (its group id is its pid), and a helper git starts without a
    // setpgid of its own (as git starts `git-remote-https`) stays in that group, so the group kill reaches it.
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nsleep 30 &\nhelper=$!\necho $helper > "${pidFile}"\necho "$$ $(ps -o pgid= -p $$) $(ps -o pgid= -p $helper)" > "${groupFile}"\nwait\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    const run = await spawnGit(["fetch"], { cwd: bin, env: { PATH: `${bin}:/usr/bin:/bin` }, timeoutMs: 1_000 });
    expect(run.timedOut).toBe(true);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    const [gitPid, gitGroup, helperGroup] = (await readFile(groupFile, "utf8")).trim().split(/\s+/u).map(Number);
    expect(gitGroup).toBe(gitPid);
    expect(helperGroup).toBe(gitPid);
    // Not the test runner's own group: a kill of git's group never reaches the bridge.
    expect(gitGroup).not.toBe(Number(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]).stdout.toString().trim()));
    // Give the kernel a moment to reap; then the helper's pid answers no signal.
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      await Bun.sleep(50);
      alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
    }
    expect(alive).toBe(false);
  });
});
