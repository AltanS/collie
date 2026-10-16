// The SDK for a Bun program (`@colliepwa/durable-sdk/bun`). A program calls `openCollie`, lays out workspaces, tabs
// and panes, and the durable socket wire (version 1) shows them to the Collie that dials it. The layout and the wire
// are the core (core/, no runtime import); this file adds the private Unix socket and the descendant check
// (../server.ts). The root import picks this entry on Bun by itself; import `./bun` to force it.
// No Pi Durable import here or in core/.

import { collieOf, coreOf, type Collie, type OpenOptions, socketOf } from "../open.ts";
import { startServer } from "../server.ts";

export * from "../core/index.ts";
export { SOCKET_ENV, type Collie, type OpenOptions } from "../open.ts";
export { wireListener, type WireListener } from "../http.ts";

export async function openCollie(o: OpenOptions): Promise<Collie> {
  const socket = socketOf(o, process.env);
  const core = coreOf(o);
  const running = await startServer(socket, { core, callerCheck: o.callerCheck });
  return collieOf(core, running);
}
