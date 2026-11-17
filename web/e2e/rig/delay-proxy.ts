// A delaying proxy for the rig's Herdr socket (the chaos leg's case C6, "the multiplexer answers slowly").
// Test rig only: nothing in bridge/, cli/ or web/src/ knows it exists.
//
// The bridge dials the Herdr API socket named by HERDR_SOCKET_PATH (bridge/config.ts), and the rig sets
// that name itself (rig.ts bridgeEnv). So a slow multiplexer needs no switch in the product: the rig
// binds this proxy on a second socket path in the same folder as the real one, forwards every connection
// to the real socket, and starts the bridge with HERDR_SOCKET_PATH pointing at the proxy. Every chunk
// the bridge writes and every chunk Herdr answers waits `delayMs` first, so one API call costs at least
// twice the delay. Chunks keep their order (timers of one delay fire in the order they were made), and
// a connection's end is delayed by the same amount, behind its last chunk.
//
// Node builtins only, so the rig CLI (bun) and the type check of web/ read the same file.
import { rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

export interface DelayProxy {
  /** The socket path the proxy listens on: what the bridge's HERDR_SOCKET_PATH names. */
  readonly path: string;
  /** Stop listening, drop every open connection and remove the socket file. */
  close(): Promise<void>;
}

/** Forward `from` to `to`, each chunk and the end of the stream after `ms`. */
function relay(from: Socket, to: Socket, ms: number): void {
  from.on("data", (chunk) => {
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, ms);
  });
  from.on("end", () => {
    setTimeout(() => {
      if (!to.destroyed) to.end();
    }, ms);
  });
}

/**
 * Listen on `listen` and forward each connection to the Unix socket `upstream`, with `delayMs` of delay in
 * each direction. Resolves once the proxy accepts. A stale file at `listen` is removed first.
 */
export async function startDelayProxy(listen: string, upstream: string, delayMs: number): Promise<DelayProxy> {
  if (!Number.isInteger(delayMs) || delayMs < 1) throw new Error(`the delay is a whole number of ms, at least 1, not ${String(delayMs)}`);
  rmSync(listen, { force: true });
  const open = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (client) => {
    const back = createConnection({ path: upstream, allowHalfOpen: true });
    open.add(client);
    open.add(back);
    relay(client, back, delayMs);
    relay(back, client, delayMs);
    const drop = (): void => {
      client.destroy();
      back.destroy();
    };
    client.on("error", drop);
    back.on("error", drop);
    // A peer that closed leaves the other one a moment to take its last delayed bytes, then both go.
    const closing = (): void => {
      setTimeout(drop, delayMs * 2 + 1000);
    };
    client.on("close", closing);
    back.on("close", closing);
    client.on("close", () => open.delete(client));
    back.on("close", () => open.delete(back));
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(listen, () => {
      server.off("error", fail);
      done();
    });
  });
  return {
    path: listen,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(listen, { force: true });
    },
  };
}
