// The SDK's one import, `@colliepwa/durable-sdk`, for Node and Bun alike (ADR 0105). `openCollie` picks the server at
// run time: on Bun the Bun entry (./bun/index.ts), with the descendant check; elsewhere the Node entry
// (./node/index.ts), which serves the same socket without that check and writes one line at start that says so.
// The two servers stay two files, and a program that wants one of them imports `./bun` or `./node` instead.
// A Pi Durable program adds `./pi`; a program with its own transport takes `./core`.
// No Pi Durable import here or in core/.

import type { Collie, OpenOptions } from "./open.ts";

export * from "./core/index.ts";
export { SOCKET_ENV, type Collie, type OpenOptions } from "./open.ts";
export { wireListener, type WireListener } from "./http.ts";

/** Open the socket on the runtime this program runs on: the Bun server on Bun, the node:http server elsewhere. */
export async function openCollie(o: OpenOptions): Promise<Collie> {
  // Each server loads only on its own runtime, so Node never reads the Bun server's file.
  const entry = "Bun" in globalThis ? await import("./bun/index.ts") : await import("./node/index.ts");
  return entry.openCollie(o);
}
