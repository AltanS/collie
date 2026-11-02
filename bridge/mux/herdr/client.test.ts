import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toPipeName } from "../../dial.ts";
import type { JsonObject } from "../../json.ts";
import { HerdrClient } from "./client.ts";

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
