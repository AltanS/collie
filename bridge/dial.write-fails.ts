// Test support only, not imported by a production module. Stands in for `Bun.connect` with a socket
// whose `write()` answers the given counts in turn, so a test can make Bun refuse a write (a negative
// count) after a chosen number of bytes. A real socket cannot be made to do that on demand.
import { spyOn } from "bun:test";

interface FakeHandlers {
  open?(socket: FakeSocket): void;
  close?(socket: FakeSocket): void;
}

interface FakeSocket {
  write(data: Uint8Array, byteOffset?: number, byteLength?: number): number;
  flush(): void;
  end(): void;
}

/**
 * Replace `Bun.connect` until the returned function runs. Each `write()` answers the next count of
 * `answers` (the last one repeats); `end()` fires the close handler once, as a real socket does.
 */
export function bunWritesAnswer(answers: readonly number[]): () => void {
  const spy = spyOn(Bun, "connect");
  // SAFETY: dial.ts calls Bun.connect only as `{ unix, socket: { open, data, drain, error, close } }` and
  // uses only write, flush and end on the socket it gets; the stand-in covers exactly that slice.
  spy.mockImplementation(((options: { socket: FakeHandlers }) => {
    let call = 0;
    let ended = false;
    const socket: FakeSocket = {
      write: () => answers[Math.min(call++, answers.length - 1)] ?? 0,
      flush: () => {},
      end: () => {
        if (ended) return;
        ended = true;
        options.socket.close?.(socket);
      },
    };
    options.socket.open?.(socket);
    return Promise.resolve(socket);
  }) as never);
  return () => spy.mockRestore();
}
