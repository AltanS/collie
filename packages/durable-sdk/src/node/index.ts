// The SDK for a Node program (`@colliepwa/durable-sdk/node`, Node 22.19 or later). The root import picks this entry on
// any runtime but Bun. The same `openCollie` as the Bun entry, served by node:http on the private Unix socket
// (WIRE.md 1A): the folder 0700, the socket 0600, a stale socket cleared, a live one refused.
//
// ONE THING IS MISSING ON NODE: the descendant check. It reads the peer's process id off the socket (SO_PEERCRED),
// and Node has no way to read it. So any process of this user can act through the socket, including a tool the
// agent runs. The entry writes one line saying so at start. Run the agent's tools in a sandbox that cannot reach the
// socket, or run the program on Bun (`../bun/index.ts`), where the check runs.

import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { wireListener } from "../http.ts";
import { collieOf, coreOf, type Collie, type OpenOptions, socketOf } from "../open.ts";
import { assertPrivateSocket, checkSocketPath, clearStaleSocket, preparePrivateDir, withNarrowUmask } from "../socket.ts";

export * from "../core/index.ts";
export { SOCKET_ENV, type Collie, type OpenOptions } from "../open.ts";
export { wireListener, type WireListener } from "../http.ts";

/** The line the Node entry writes at start (WIRE.md 1A, "What the socket does not protect against"). */
export const NO_DESCENDANT_CHECK =
  "collie: Node cannot read the caller of a Unix socket (SO_PEERCRED), so the descendant check is off: any process of this user, a tool the agent runs included, can act through the socket. Sandbox the tools, or run on Bun.";

export async function openCollie(o: OpenOptions): Promise<Collie> {
  const path = checkSocketPath(socketOf(o, process.env));
  const core = coreOf(o);
  (o.warn ?? ((line: string) => console.warn(line)))(NO_DESCENDANT_CHECK);
  const wire = wireListener(core);
  const server: Server = createServer(wire.listener);

  // The folder is 0700 and ours, or the start stops. A dead socket file goes; a live one is another instance.
  preparePrivateDir(dirname(path));
  await clearStaleSocket(path);
  await withNarrowUmask(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );
  try {
    assertPrivateSocket(path);
  } catch (e) {
    server.close();
    throw e;
  }
  return collieOf(core, {
    address: path,
    close: async () => {
      // No new connection from here on; a reply on its way still goes out, for at most 2 s.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await wire.drained();
      server.closeAllConnections();
      await closed;
      rmSync(path, { force: true });
    },
  });
}
