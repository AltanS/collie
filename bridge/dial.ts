// Platform dial shim. On Unix the herdr API socket is a real AF_UNIX socket and Bun.connect
// handles it. On Windows (herdr Windows beta) the ".sock" path is a pointer file — the actual
// transport is a named pipe whose name is the full socket path (\\.\pipe\C:\...\herdr.sock).
// Bun.connect({unix}) cannot open named pipes, but Bun's node:net can, so we adapt it to the
// same handler shape the two call sites in herdr-client.ts use (write/flush/end only).
import net from "node:net";

export type SockHandle = {
  write(data: string): unknown;
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
 * herdr's Windows beta names its pipe after the full socket path. Pass through a value that is
 * already a pipe name (either slash direction) so an explicit HERDR_SOCKET_PATH=\\.\pipe\… works.
 */
export function toPipeName(socketPath: string): string {
  if (socketPath.startsWith("\\\\.\\pipe\\") || socketPath.startsWith("//./pipe/")) {
    return socketPath;
  }
  return "\\\\.\\pipe\\" + socketPath;
}

export function dialHerdr(socketPath: string, handlers: DialHandlers): Promise<SockHandle> {
  if (process.platform !== "win32") {
    const promise = Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          handlers.open?.(s as unknown as SockHandle);
        },
        data(s, chunk) {
          handlers.data?.(s as unknown as SockHandle, chunk);
        },
        error(s, err) {
          handlers.error?.(s as unknown as SockHandle, err);
        },
        close(s) {
          handlers.close?.(s as unknown as SockHandle);
        },
      },
    }) as unknown as Promise<SockHandle>;
    // Bun.connect exposes no pre-open handle; best available cancellation is closing the socket
    // the moment the connect resolves. Callers already tolerate a late open followed by close.
    handlers.onDial?.(() => {
      promise
        .then((s) => {
          try {
            s.end();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {
          /* connect failed — nothing to close */
        });
    });
    return promise;
  }

  const pipeName = toPipeName(socketPath);
  return new Promise<SockHandle>((resolve, reject) => {
    const sock = net.connect(pipeName);
    const handle: SockHandle = {
      write: (data) => sock.write(data),
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
      handlers.error?.(handle, err as Error);
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
