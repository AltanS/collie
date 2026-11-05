import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 699: a bridge whose front door cannot listen must EXIT nonzero, so launchd, systemd and the
// Windows task restart it. Before the fix the failed `Bun.serve` threw out of the module, but the
// hold and walky sockets, the poll loop and the timers kept the process alive with no listener.
// The listen failure here is the simplest real one: the port is already held.

const root = mkdtempSync(join(tmpdir(), "collie-listen-failure-"));
const repo = join(import.meta.dir, "..");

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Outcome {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  stdout: string;
}

async function runUntilExit(argv: string[], port: number, budgetMs: number): Promise<Outcome> {
  const home = join(root, `home-${port}`);
  const state = join(root, `state-${port}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const proc = Bun.spawn(["bun", ...argv], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      COLLIE_HOST: "127.0.0.1",
      COLLIE_PORT: String(port),
      COLLIE_STATE_DIR: state,
      HERDR_SOCKET_PATH: join(root, `herdr-${port}.sock`),
      COLLIE_MULTI_SESSION: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const exited = await Promise.race([proc.exited, Bun.sleep(budgetMs).then(() => null)]);
  if (exited === null) proc.kill("SIGKILL");
  await proc.exited;
  return { exitCode: exited, timedOut: exited === null, stderr: await stderr, stdout: await stdout };
}

describe("a bridge that cannot open its port", () => {
  test("`collie _exec-bridge` exits nonzero within 10 s and says why", async () => {
    const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
    try {
      const port = holder.port ?? 0;
      const outcome = await runUntilExit(["cli/main.ts", "_exec-bridge"], port, 10_000);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.stderr).toContain("[bridge] FATAL: front door cannot listen on 127.0.0.1:" + port);
    } finally {
      holder.stop(true);
    }
  }, 20_000);

  test("`bun bridge/index.ts` exits nonzero within 10 s and says why", async () => {
    const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("held") });
    try {
      const port = holder.port ?? 0;
      const outcome = await runUntilExit(["bridge/index.ts"], port, 10_000);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("[bridge] FATAL: front door cannot listen on 127.0.0.1:" + port);
    } finally {
      holder.stop(true);
    }
  }, 20_000);
});
