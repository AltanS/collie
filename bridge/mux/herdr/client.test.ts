import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../../json.ts";
import { HerdrClient, WORKTREE_TIMEOUT_MS } from "./client.ts";

// The per-call budget (ADR 0089). Every Herdr call gets the client's own budget, 5 s in production,
// except the two worktree calls, which run `git worktree add` before they answer and get
// WORKTREE_TIMEOUT_MS. Proved against a real Unix socket that answers late: a call on the client's
// budget gives up, a worktree call on the same client waits and gets the reply.

const REPLY_DELAY_MS = 150;
const CLIENT_BUDGET_MS = 40;

let dir: string | null = null;
let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A one-shot Herdr stand-in: reads one request line, answers `result` after {@link REPLY_DELAY_MS}. */
function lateHerdr(result: JsonObject): string {
  dir = mkdtempSync(join(tmpdir(), "collie-herdr-client-"));
  const path = join(dir, "herdr.sock");
  const listener = Bun.listen<{ buf: string }>({
    unix: path,
    socket: {
      open(s) {
        s.data = { buf: "" };
      },
      data(s, chunk) {
        s.data.buf += chunk.toString();
        const nl = s.data.buf.indexOf("\n");
        if (nl < 0) return;
        // SAFETY: the client under test writes exactly one JSON request line per connection.
        const req = JSON.parse(s.data.buf.slice(0, nl)) as { id: string };
        setTimeout(() => {
          try {
            s.write(`${JSON.stringify({ id: req.id, result })}\n`);
            s.end();
          } catch {
            // The client already gave up and closed; nothing to answer.
          }
        }, REPLY_DELAY_MS);
      },
    },
  });
  stop = () => listener.stop(true);
  return path;
}

const PANE = { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1", cwd: "/repo/.worktrees/x" };

describe("HerdrClient per-call timeout", () => {
  test("a worktree call gets a budget far above the default", () => {
    expect(WORKTREE_TIMEOUT_MS).toBe(60_000);
  });

  test("an ordinary call gives up at the client's own budget", async () => {
    const client = new HerdrClient(lateHerdr({ worktrees: [] }), CLIENT_BUDGET_MS);
    await expect(client.listWorktrees("/repo")).rejects.toThrow(
      `herdr worktree.list: timed out after ${CLIENT_BUDGET_MS}ms`,
    );
  });

  test("worktree.create on the same client waits past that budget and gets the reply", async () => {
    const client = new HerdrClient(
      lateHerdr({ workspace: { label: "x" }, root_pane: PANE }),
      CLIENT_BUDGET_MS,
    );
    const created = await client.createWorktree({ cwd: "/repo", branch: "worktree/x" });
    expect(created.paneId).toBe("w9:p1");
    expect(created.cwd).toBe("/repo/.worktrees/x");
  });

  test("worktree.open on the same client waits past that budget too", async () => {
    const client = new HerdrClient(
      lateHerdr({ workspace: { label: "x" }, root_pane: PANE, already_open: true }),
      CLIENT_BUDGET_MS,
    );
    const opened = await client.openWorktree({ cwd: "/repo", path: "/repo/.worktrees/x" });
    expect(opened.alreadyOpen).toBe(true);
  });
});
