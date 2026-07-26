// Platform dial shim. On Unix the herdr API socket is a real AF_UNIX socket and Bun.connect
// handles it. On Windows (herdr Windows beta) the ".sock" path is a pointer file — the actual
// transport is a named pipe whose name is the full socket path (\\.\pipe\C:\...\herdr.sock).
// Bun.connect({unix}) cannot open named pipes, but Bun's node:net can, so we adapt it to the
// same handler shape the two call sites in herdr-client.ts use (write/flush/end only).
import net from "node:net";

export type SockHandle = {
  write(data: string): unknown;
  flush(): void;
  end(): void;
};

export type DialHandlers = {
  open?(s: SockHandle): void;
  data?(s: SockHandle, chunk: Uint8Array): void;
  error?(s: SockHandle, err: Error): void;
  close?(s: SockHandle): void;
};

export function dialHerdr(socketPath: string, handlers: DialHandlers): Promise<SockHandle> {
  if (process.platform !== "win32") {
    return Bun.connect({
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
  }

  const pipeName = "\\\\.\\pipe\\" + socketPath;
  return new Promise<SockHandle>((resolve, reject) => {
    const sock = net.connect(pipeName);
    const handle: SockHandle = {
      write: (data) => sock.write(data),
      flush: () => {},
      // destroy(), not end(): herdr's one-shot RPC is done once we have the reply line, and the
      // callers rely on close being prompt and re-entrant-safe (they guard with a settled flag).
      end: () => sock.destroy(),
    };
    let opened = false;
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
    sock.on("close", () => handlers.close?.(handle));
  });
}
