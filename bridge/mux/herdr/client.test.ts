import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toPipeName } from "../../dial.ts";
import type { JsonObject } from "../../json.ts";
import { HerdrClient, WORKTREE_TIMEOUT_MS } from "./client.ts";

// The per-call budget (ADR 0089). Every Herdr call gets the client's own budget, 5 s in production,
// except the two worktree calls, which run `git worktree add` before they answer and get
// WORKTREE_TIMEOUT_MS. Proved against a real Unix socket (a named pipe on Windows) that answers late: a call on the client's
// budget gives up, a worktree call on the same client waits and gets the reply.

const REPLY_DELAY_MS = 150;
const CLIENT_BUDGET_MS = 40;

let dir: string | null = null;
let server: net.Server | null = null;
let counter = 0;

afterEach(() => {
  server?.close();
  server = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * A one-shot Herdr stand-in: reads one request line, answers `result` after {@link REPLY_DELAY_MS}.
 *
 * It listens through node:net, which opens an AF_UNIX socket on POSIX and a named pipe on Windows,
 * so the same test runs on both. Windows has no socket file: the client dials the pipe named for
 * the socket path (`toPipeName`), so the stand-in listens on that name and the path is a plain tag.
 */
async function lateHerdr(result: JsonObject): Promise<string> {
  let path: string;
  if (process.platform === "win32") {
    path = `collie-herdr-client-${process.pid}-${++counter}`;
  } else {
    dir = mkdtempSync(join(tmpdir(), "collie-herdr-client-"));
    path = join(dir, "herdr.sock");
  }
  server = net.createServer((conn) => {
    let buf = "";
    conn.on("error", () => {
      // The client gave up and closed first; nothing to answer.
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      // SAFETY: the client under test writes exactly one JSON request line per connection.
      const req = JSON.parse(buf.slice(0, nl)) as { id: string };
      buf = "";
      setTimeout(() => {
        if (conn.destroyed) return;
        conn.end(`${JSON.stringify({ id: req.id, result })}\n`);
      }, REPLY_DELAY_MS);
    });
  });
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(process.platform === "win32" ? toPipeName(path) : path, resolve);
  });
  return path;
}

const PANE = { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", cwd: "/repo/.worktrees/x" };

describe("HerdrClient per-call timeout", () => {
  test("a worktree call gets a budget far above the default", () => {
    expect(WORKTREE_TIMEOUT_MS).toBe(60_000);
  });

  test("an ordinary call gives up at the client's own budget", async () => {
    const client = new HerdrClient(await lateHerdr({ worktrees: [] }), CLIENT_BUDGET_MS);
    await expect(client.listWorktrees("/repo")).rejects.toThrow(
      `herdr worktree.list: timed out after ${CLIENT_BUDGET_MS}ms`,
    );
  });

  test("worktree.create on the same client waits past that budget and gets the reply", async () => {
    const client = new HerdrClient(
      await lateHerdr({ workspace: { label: "x" }, root_pane: PANE }),
      CLIENT_BUDGET_MS,
    );
    const created = await client.createWorktree({ cwd: "/repo", branch: "worktree/x" });
    expect(created.paneId).toBe("w9:p1");
    expect(created.cwd).toBe("/repo/.worktrees/x");
  });

  test("worktree.open on the same client waits past that budget too", async () => {
    const client = new HerdrClient(
      await lateHerdr({ workspace: { label: "x" }, root_pane: PANE, already_open: true }),
      CLIENT_BUDGET_MS,
    );
    const opened = await client.openWorktree({ cwd: "/repo", path: "/repo/.worktrees/x" });
    expect(opened.alreadyOpen).toBe(true);
  });
});
