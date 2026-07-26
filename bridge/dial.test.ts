import { describe, expect, test } from "bun:test";
import net from "node:net";

import { dialHerdr, toPipeName } from "./dial.ts";

// toPipeName is pure and runs everywhere. The live-pipe suite needs a real Windows named pipe, so
// it is skipped off win32 — mirroring the repo convention that transport code is exercised where
// it actually runs (the Unix Bun.connect path stays untested here for the same reason).

describe("toPipeName", () => {
  test("prefixes a plain socket path with the pipe namespace", () => {
    expect(toPipeName("C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock")).toBe(
      "\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock",
    );
  });

  test("passes an already-prefixed pipe name through unchanged", () => {
    expect(toPipeName("\\\\.\\pipe\\already-a-pipe")).toBe("\\\\.\\pipe\\already-a-pipe");
    expect(toPipeName("//./pipe/already-a-pipe")).toBe("//./pipe/already-a-pipe");
  });
});

const describeWin = process.platform === "win32" ? describe : describe.skip;

describeWin("dialHerdr over a live named pipe (win32 only)", () => {
  const pipeFor = (tag: string) => `\\\\.\\pipe\\collie-dial-test-${process.pid}-${tag}`;

  /** One-connection line server: waits for a request line, replies with `chunks`, then closes. */
  const serveOnce = async (pipe: string, chunks: Buffer[], gapMs = 0): Promise<net.Server> => {
    const server = net.createServer((conn) => {
      conn.once("data", () => {
        let i = 0;
        const writeNext = () => {
          if (i >= chunks.length) {
            conn.end();
            return;
          }
          conn.write(chunks[i++]!);
          setTimeout(writeNext, gapMs);
        };
        writeNext();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipe, resolve);
    });
    return server;
  };

  /** Dial, send one request line, resolve with everything received up to the first newline. */
  const requestLine = (pipe: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const received: Buffer[] = [];
      let settled = false;
      const once = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      dialHerdr(pipe, {
        data(_s, chunk) {
          received.push(Buffer.from(chunk));
          const text = Buffer.concat(received).toString("utf-8");
          if (text.includes("\n")) once(() => resolve(text.slice(0, text.indexOf("\n"))));
        },
        error(_s, err) {
          once(() => reject(err));
        },
        close() {
          once(() => reject(new Error("closed before a full reply line")));
        },
      })
        .then((s) => s.write('{"id":"t","method":"probe","params":{}}\n'))
        .catch((err) => once(() => reject(err)));
    });

  test("one-shot request/reply round-trips, accepting an already-prefixed pipe name", async () => {
    const pipe = pipeFor("roundtrip");
    const server = await serveOnce(pipe, [Buffer.from('{"ok":true}\n', "utf-8")]);
    try {
      expect(await requestLine(pipe)).toBe('{"ok":true}');
    } finally {
      server.close();
    }
  });

  test("a reply split mid-codepoint across chunks reassembles byte-perfect", async () => {
    const pipe = pipeFor("split");
    const payload = Buffer.from('{"emoji":"🐕🦮"}\n', "utf-8");
    const cut = 12; // inside the first emoji's 4-byte sequence
    const server = await serveOnce(pipe, [payload.subarray(0, cut), payload.subarray(cut)], 15);
    try {
      expect(await requestLine(pipe)).toBe('{"emoji":"🐕🦮"}');
    } finally {
      server.close();
    }
  });

  test("dialing a nonexistent pipe rejects and fires the error handler", async () => {
    let sawError = false;
    await expect(
      dialHerdr(pipeFor("nonexistent"), {
        error() {
          sawError = true;
        },
      }),
    ).rejects.toBeDefined();
    expect(sawError).toBe(true);
  });

  test("onDial cancel settles the promise instead of leaving it pending", async () => {
    let cancel: (() => void) | null = null;
    const p = dialHerdr(pipeFor("cancelled"), {
      onDial(c) {
        cancel = c;
      },
    });
    expect(cancel).not.toBeNull();
    cancel!();
    // Whether the abort lands as "closed before connect" or the connect error races first,
    // the promise must settle — a caller that already timed out must not leak a pending dial.
    await expect(p).rejects.toBeDefined();
  });
});
