import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SocketWriteFailed } from "../../dial.ts";
import { bunWritesAnswer } from "../../dial.write-fails.ts";
import { TuiosClient, TuiosNoReply, TuiosTimeout } from "./client.ts";

// M100 spec 03: a connection that closes after the request went out may follow a request the daemon
// acted on, so it is its own class; a dial that never reached the daemon is not. Proved against a real
// Unix socket. tuios has no Windows transport.

let dir: string | null = null;
let server: net.Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** A daemon stand-in that reads one request line and closes the connection without a reply. */
async function droppingDaemon(): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), "collie-tuios-client-"));
  const path = join(dir, "tuios.sock");
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
  dir = mkdtempSync(join(tmpdir(), "collie-tuios-client-"));
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

describe.skipIf(process.platform === "win32")("TuiosClient, a connection closed before the reply", () => {
  test("a close after the request went out rejects with TuiosNoReply and the old words", async () => {
    const client = new TuiosClient(await droppingDaemon(), 2000);
    const caught = await rejection(() => client.sendText("main", "w1", "hello"));
    expect(caught).toBeInstanceOf(TuiosNoReply);
    expect(caught?.message).toBe("tuios send-text: connection closed before reply");
  });

  test("a connection reset after the request went out rejects with TuiosNoReply", async () => {
    const client = new TuiosClient(await resettingServer("tuios.sock"), 2000);
    const caught = await rejection(() => client.sendText("main", "w1", "hello"));
    expect(caught).toBeInstanceOf(TuiosNoReply);
  });

  test("a write the socket refused after it took part of the request rejects with TuiosNoReply", async () => {
    const restore = bunWritesAnswer([4, -1]);
    try {
      const caught = await rejection(() => new TuiosClient("/nowhere/tuios.sock", 2000).sendText("main", "w1", "hello"));
      expect(caught).toBeInstanceOf(TuiosNoReply);
      expect(caught?.message).toBe("tuios send-text: socket write failed");
    } finally {
      restore();
    }
  });

  test("a write the socket refused before it took a byte rejects with the plain error", async () => {
    const restore = bunWritesAnswer([-1]);
    try {
      const caught = await rejection(() => new TuiosClient("/nowhere/tuios.sock", 2000).sendText("main", "w1", "hello"));
      expect(caught).toBeInstanceOf(SocketWriteFailed);
      expect(caught).not.toBeInstanceOf(TuiosNoReply);
    } finally {
      restore();
    }
  });

  test("a socket with nobody behind it rejects with the dial's own error, not TuiosNoReply", async () => {
    dir = mkdtempSync(join(tmpdir(), "collie-tuios-client-"));
    const client = new TuiosClient(join(dir, "none.sock"), 2000);
    const caught = await rejection(() => client.sendText("main", "w1", "hello"));
    expect(caught).not.toBeInstanceOf(TuiosNoReply);
    expect(caught).not.toBeInstanceOf(TuiosTimeout);
    expect(caught !== null && "code" in caught ? caught.code : null).toBe("ENOENT");
  });
});
