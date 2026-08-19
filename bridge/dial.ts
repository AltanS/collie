// Platform dial shim. On Unix the herdr API socket is a real AF_UNIX socket and Bun.connect
// handles it. On Windows (herdr Windows beta) the ".sock" path is a pointer file — the actual
// transport is a named pipe whose name is the full socket path (\\.\pipe\C:\...\herdr.sock).
// Bun.connect({unix}) cannot open named pipes, but Bun's node:net can, so we adapt it to the
// same handler shape the two call sites in mux/herdr/client.ts use (write/flush/end only).
//
// There is NO application-level handshake on either transport — herdr's `interprocess` local
// sockets carry the raw bytes ("Interprocess never inserts its own message framing or any other
// type of metadata into the stream"), so the same newline-delimited JSON-RPC speaks to both. A
// raw node:net client dialing the Unix socket was verified against a live herd on 2026-07-26.
import net from "node:net";

import { advanceWrite, startWrite, writeComplete, writeRemaining, type WriteCursor } from "./write-drain.ts";

const encoder = new TextEncoder();

/**
 * The slice of Bun's socket we use, named structurally so this file states its own contract. The
 * `byteOffset`/`byteLength` overload is what makes a resumed write possible: we re-offer the SAME
 * buffer from where the socket stopped rather than allocating a tail.
 */
type BunSocket = {
  write(data: Uint8Array, byteOffset?: number, byteLength?: number): number;
  flush(): void;
  end(): void;
};

export type SockHandle = {
  /**
   * Hand a whole payload to the socket. Backpressure is the DIALER's problem, not the caller's:
   * both branches below guarantee that every byte is either delivered or the connection fails
   * loudly through `error`/`close`. Never returns a byte count — there is nothing for a caller to
   * retry (see write-drain.ts for why the naive `socket.write()` truncated long requests).
   */
  write(data: string): void;
  flush(): void;
  /**
   * Closes the connection IMMEDIATELY — on win32 this is destroy(), not a graceful half-close,
   * so queued-but-unflushed data may be dropped. That is correct for both current consumers
   * (one-shot RPCs close only after the reply line arrives; the event stream uses it to cancel),
   * but do not reuse this handle anywhere that needs written data drained on close.
   */
  end(): void;
};

export type DialHandlers = {
  open?(s: SockHandle): void;
  data?(s: SockHandle, chunk: Uint8Array): void;
  error?(s: SockHandle, err: Error): void;
  close?(s: SockHandle): void;
  /**
   * Invoked synchronously during dialHerdr() with a canceller that aborts the dial even while it
   * is still connecting. The returned promise alone cannot do that — there is no handle to close
   * until `open` — so a caller-side timeout that fires mid-connect would otherwise leak the
   * pending OS handle until the connect itself resolves or fails.
   */
  onDial?(cancel: () => void): void;
};

/**
 * Which dialer to use. `auto` picks by platform — `node:net` on Windows (named pipes), Bun's
 * native `Bun.connect({unix})` everywhere else, which is the long-deployed path and stays the
 * default there. `net`/`bun` force one regardless of platform.
 *
 * `net` exists so the Windows dial path is RUNNABLE OFF WINDOWS: `net.connect(path)` opens an
 * AF_UNIX socket on POSIX and a named pipe on win32, so forcing it on Linux exercises the exact
 * code Windows runs, minus {@link toPipeName} (pure, and unit-tested on its own). Without it,
 * nobody who can merge this change is able to run the branch it adds.
 */
export type DialMode = "auto" | "net" | "bun";

/**
 * herdr's Windows beta names its pipe after the full socket path. Pass through a value that is
 * already a pipe name (either slash direction) so an explicit HERDR_SOCKET_PATH=\\.\pipe\… works.
 */
export function toPipeName(socketPath: string): string {
  if (socketPath.startsWith("\\\\.\\pipe\\") || socketPath.startsWith("//./pipe/")) {
    return socketPath;
  }
  return "\\\\.\\pipe\\" + socketPath;
}

export function dialHerdr(
  socketPath: string,
  handlers: DialHandlers,
  mode: DialMode = "auto",
): Promise<SockHandle> {
  const useNet = mode === "net" || (mode === "auto" && process.platform === "win32");
  if (!useNet) {
    // The handle is OURS, not the raw Bun socket, because write() has to survive a short write:
    // the unaccepted tail is parked here and resumed from `drain`. Every handler below is handed
    // this same object so `end()` and a resumed write always address one socket.
    let bunSock: BunSocket | null = null;
    let pending: { bytes: Uint8Array; cursor: WriteCursor } | null = null;

    // Push as much of the parked payload as the socket will take. Returns having either finished
    // it, or left it parked for the next `drain`. A write that accepts nothing is a stall, not an
    // error — we simply wait; a socket that will never drain dies through close/error (or the
    // caller's own timeout) rather than spinning here.
    const pump = () => {
      const s = bunSock;
      if (!s || !pending) return;
      for (;;) {
        const rest = writeRemaining(pending.cursor);
        if (rest === null) break;
        const accepted = s.write(pending.bytes, rest.offset, rest.length);
        pending = { bytes: pending.bytes, cursor: advanceWrite(pending.cursor, accepted) };
        if (accepted < 0) {
          // Bun signals a failed write with a negative count. Report it as the transport error it
          // is instead of leaving the request to time out with no explanation.
          pending = null;
          handlers.error?.(handle, new Error("socket write failed"));
          return;
        }
        if (accepted === 0) return; // full — resume on drain
      }
      if (writeComplete(pending.cursor)) pending = null;
      s.flush();
    };

    const handle: SockHandle = {
      write(data) {
        const bytes = encoder.encode(data);
        // One in-flight payload at a time is all either call site needs (one request per
        // connection, one subscribe line per stream); concatenating would silently reorder.
        if (pending) throw new Error("dial: a previous write is still draining");
        pending = { bytes, cursor: startWrite(bytes.byteLength) };
        pump();
      },
      flush() {
        bunSock?.flush();
      },
      end() {
        pending = null;
        bunSock?.end();
      },
    };

    const promise = Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          bunSock = s;
          handlers.open?.(handle);
        },
        data(s, chunk) {
          bunSock = s;
          handlers.data?.(handle, chunk);
        },
        drain(s) {
          bunSock = s;
          pump();
        },
        error(s, err) {
          bunSock = s;
          pending = null;
          handlers.error?.(handle, err);
        },
        close(s) {
          bunSock = s;
          // A connection that dies mid-write drops its remainder here; the close handler is what
          // rejects the caller, exactly as for any other transport failure.
          pending = null;
          handlers.close?.(handle);
        },
      },
    });
    // Bun.connect exposes no pre-open handle; best available cancellation is closing the socket
    // the moment the connect resolves. Callers already tolerate a late open followed by close.
    handlers.onDial?.(() => {
      void (async () => {
        try {
          (await promise).end();
        } catch {
          /* connect failed (nothing to close), or end() threw — either way we are done */
        }
      })();
    });
    return promise.then((s) => {
      bunSock = s;
      return handle;
    });
  }

  // node:net addresses a named pipe by name on win32 and an AF_UNIX path on POSIX — only the
  // former needs the `\\.\pipe\` mapping, so forcing `net` off Windows dials the socket directly.
  const address = process.platform === "win32" ? toPipeName(socketPath) : socketPath;
  return new Promise<SockHandle>((resolve, reject) => {
    const sock = net.connect(address);
    // node:net needs no drain bookkeeping: `write()` here is all-or-nothing at the API level — it
    // queues whatever the kernel won't take and returns a BOOLEAN (false = "buffered, back off"),
    // never a partial byte count, and flushes the queue itself. The Bun branch's short-write hazard
    // (see write-drain.ts) simply does not exist on this transport. Failures still surface through
    // the 'error'/'close' handlers below, which is what rejects a request that dies mid-write.
    const handle: SockHandle = {
      write: (data) => {
        sock.write(data);
      },
      flush: () => {},
      end: () => sock.destroy(),
    };
    let opened = false;
    handlers.onDial?.(() => sock.destroy());
    sock.on("connect", () => {
      opened = true;
      handlers.open?.(handle);
      resolve(handle);
    });
    sock.on("data", (chunk: Buffer) => handlers.data?.(handle, chunk));
    sock.on("error", (err) => {
      if (!opened) reject(err);
      handlers.error?.(handle, err);
    });
    sock.on("close", () => {
      // A dial destroyed while still connecting emits close without error; settle the promise so
      // no caller is left awaiting forever. Guarded rejects/finishes upstream make this a no-op
      // when the caller already timed out.
      if (!opened) reject(new Error("dial closed before connect"));
      handlers.close?.(handle);
    });
  });
}
