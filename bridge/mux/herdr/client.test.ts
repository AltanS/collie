import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SocketWriteFailed, toPipeName } from "../../dial.ts";
import { bunWritesAnswer } from "../../dial.write-fails.ts";
import type { JsonObject } from "../../json.ts";
import { HerdrClient, HerdrNoReply, HerdrTimeout } from "./client.ts";

// The client's per-call budget. Proved against a real Unix socket (a named pipe on Windows) that
// answers late: a call gives up at the budget the client was built with.

const REPLY_DELAY_MS = 150;
const CLIENT_BUDGET_MS = 40;

let dir: string | null = null;
let server: net.Server | null = null;
let counter = 0;
/** The last request line the stand-in read, parsed. */
let lastRequest: { method: string; params: JsonObject } | null = null;

afterEach(() => {
  server?.close();
  server = null;
  lastRequest = null;
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
      const req = JSON.parse(buf.slice(0, nl)) as { id: string; method: string; params: JsonObject };
      lastRequest = { method: req.method, params: req.params };
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

describe("HerdrClient per-call timeout", () => {
  test("a call gives up at the client's own budget", async () => {
    const client = new HerdrClient(await lateHerdr({ workspaces: [] }), CLIENT_BUDGET_MS);
    await expect(client.listWorkspaces()).rejects.toThrow(
      `herdr workspace.list: timed out after ${CLIENT_BUDGET_MS}ms`,
    );
  });
});

/** A Herdr stand-in that reads one request line and closes the connection without a reply. */
async function droppingHerdr(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "collie-herdr-client-"));
  const path = join(dir, "herdr.sock");
  server = net.createServer((conn) => {
    let buf = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) conn.destroy();
    });
  });
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(path, resolve);
  });
  return path;
}

/** A stand-in that never reads: it closes with the request unread, which resets the connection. */
async function resettingServer(name: string): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "collie-herdr-client-"));
  const path = join(dir, name);
  server = net.createServer({ pauseOnConnect: true }, (conn) => {
    conn.on("error", () => {});
    setTimeout(() => conn.destroy(), 50);
  });
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(path, resolve);
  });
  return path;
}

/** What `call` rejects with, as an Error, or null when it resolves. */
async function rejection(call: () => Promise<void>): Promise<Error | null> {
  try {
    await call();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}

// M100 spec 03: a connection that closes after the request went out may follow a request Herdr acted
// on, so it is its own class; a dial that never reached Herdr is not.
describe.skipIf(process.platform === "win32")("HerdrClient, a connection closed before the reply", () => {
  test("a close after the request went out rejects with HerdrNoReply and the old words", async () => {
    const client = new HerdrClient(await droppingHerdr(), 2000);
    const caught = await rejection(() => client.sendPaneText("w1:p1", "hello"));
    expect(caught).toBeInstanceOf(HerdrNoReply);
    expect(caught?.message).toBe("herdr pane.send_text: connection closed before reply");
  });

  test("a connection reset after the request went out rejects with HerdrNoReply", async () => {
    const client = new HerdrClient(await resettingServer("herdr.sock"), 2000);
    const caught = await rejection(() => client.sendPaneText("w1:p1", "hello"));
    expect(caught).toBeInstanceOf(HerdrNoReply);
  });

  test("a write the socket refused after it took part of the request rejects with HerdrNoReply", async () => {
    const restore = bunWritesAnswer([4, -1]);
    try {
      const caught = await rejection(() => new HerdrClient("/nowhere/herdr.sock", 2000).sendPaneText("w1:p1", "hello"));
      expect(caught).toBeInstanceOf(HerdrNoReply);
      expect(caught?.message).toBe("herdr pane.send_text: socket write failed");
    } finally {
      restore();
    }
  });

  test("a write the socket refused before it took a byte rejects with the plain error", async () => {
    const restore = bunWritesAnswer([-1]);
    try {
      const caught = await rejection(() => new HerdrClient("/nowhere/herdr.sock", 2000).sendPaneText("w1:p1", "hello"));
      expect(caught).toBeInstanceOf(SocketWriteFailed);
      expect(caught).not.toBeInstanceOf(HerdrNoReply);
    } finally {
      restore();
    }
  });

  test("a socket with nobody behind it rejects with the dial's own error, not HerdrNoReply", async () => {
    dir = mkdtempSync(join(tmpdir(), "collie-herdr-client-"));
    const client = new HerdrClient(join(dir, "none.sock"), 2000);
    const caught = await rejection(() => client.sendPaneText("w1:p1", "hello"));
    expect(caught).not.toBeInstanceOf(HerdrNoReply);
    expect(caught).not.toBeInstanceOf(HerdrTimeout);
    expect(caught !== null && "code" in caught ? caught.code : null).toBe("ENOENT");
  });
});

describe("HerdrClient processInfo", () => {
  const GROUP = {
    pane_id: "w9:p1",
    foreground_processes: [
      { pid: 4242, name: "muse-bin-1.4.4", argv: ["muse", "resume", "01a0a28c-ba4b-76f2"] },
      { pid: 4243, name: "rg", argv: null },
    ],
  };

  test("it asks pane.process_info and returns the foreground group untouched", async () => {
    const client = new HerdrClient(await lateHerdr({ process_info: GROUP }), 1_000);
    await expect(client.processInfo("w9:p1")).resolves.toEqual(GROUP);
    expect(lastRequest?.method).toBe("pane.process_info");
    expect(lastRequest?.params).toEqual({ pane_id: "w9:p1" });
  });

  test("a pane with no foreground group answers without the key", async () => {
    const client = new HerdrClient(await lateHerdr({ process_info: { pane_id: "w9:p1" } }), 1_000);
    await expect(client.processInfo("w9:p1")).resolves.toEqual({ pane_id: "w9:p1" });
  });
});

describe("HerdrClient openWorktree", () => {
  // The shape of a real `worktree.open` answer, probed on herdr 0.9.5 (2026-11-13): the same
  // `workspace` and `root_pane` a `workspace.create` gives, the worktree block on the workspace, and
  // `already_open`.
  const ANSWER = {
    type: "worktree_opened",
    already_open: false,
    workspace: {
      workspace_id: "w3",
      label: "feat-x",
      worktree: { checkout_path: "/srv/repo-wt/feat-x", is_linked_worktree: true, repo_key: "/srv/repo/.git" },
    },
    tab: { tab_id: "w3:t1", workspace_id: "w3" },
    root_pane: { pane_id: "w3:p1", workspace_id: "w3", tab_id: "w3:t1", cwd: "/srv/repo-wt/feat-x" },
  };

  test("it sends worktree.open with the repo root as cwd, the checkout as path, and never focuses", async () => {
    const client = new HerdrClient(await lateHerdr(ANSWER), 1_000);
    const shell = await client.openWorktree({ cwd: "/srv/repo", path: "/srv/repo-wt/feat-x", label: "feat-x" });
    expect(lastRequest?.method).toBe("worktree.open");
    expect(lastRequest?.params).toEqual({ cwd: "/srv/repo", path: "/srv/repo-wt/feat-x", label: "feat-x", focus: false });
    expect(shell).toEqual({
      paneId: "w3:p1",
      workspaceId: "w3",
      workspaceLabel: "feat-x",
      tabId: "w3:t1",
      cwd: "/srv/repo-wt/feat-x",
    });
  });

  test("an empty label is left off the wire", async () => {
    const client = new HerdrClient(await lateHerdr(ANSWER), 1_000);
    await client.openWorktree({ cwd: "/srv/repo", path: "/srv/repo-wt/feat-x", label: "" });
    expect(lastRequest?.params).toEqual({ cwd: "/srv/repo", path: "/srv/repo-wt/feat-x", focus: false });
  });
});
