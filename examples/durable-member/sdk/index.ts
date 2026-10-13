// The SDK for a Bun program. A program calls `openCollie`, lays out workspaces, tabs and panes, and the durable
// socket wire (version 1) shows them to the Collie that dials it. The layout and the wire are the core
// (core/, no runtime import); this file adds the private Unix socket and the descendant check (server.ts).
// No Pi Durable import in sdk/.

import { type CollieCore, createCore } from "./core/index.ts";
import { startServer } from "./server.ts";
import type { Caps, Starter } from "./core/types.ts";
import type { WorkspaceHandle } from "./core/layout.ts";

export * from "./core/index.ts";

/** The variable both sides read to find the socket. */
export const SOCKET_ENV = "COLLIE_DURABLE_SOCKET";

export interface OpenOptions {
  /** An absolute path, at most 103 bytes. Its folder is made 0700, or must already be a real folder of this user with mode 0700. Default: the `COLLIE_DURABLE_SOCKET` variable. */
  socket?: string;
  hostName: string;
  /** How many raw events each pane keeps. At most 1000. Default 500. */
  tailLimit?: number;
  /** Turn a cap off. Everything the SDK can do is on by default. */
  caps?: Partial<Caps>;
  /** `descendant` (default) or `off`. See `ServerOptions.callerCheck`. */
  callerCheck?: "descendant" | "off";
}

export interface Collie {
  /** The socket path it listens on. */
  readonly address: string;
  readonly epoch: string;
  /** The core behind the socket. A test, or a second transport, can call `core.handle` directly. */
  readonly core: CollieCore;
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  /** Call once the layout is complete (after a restart: after every pane is shown again). Until then the caller gets 503 `starting`. */
  ready(): void;
  close(): Promise<void>;
}

export async function openCollie(o: OpenOptions): Promise<Collie> {
  const socket = o.socket ?? process.env[SOCKET_ENV];
  if (!socket) throw new Error(`openCollie needs a socket path: pass socket or set ${SOCKET_ENV}`);
  const core = createCore({ hostName: o.hostName, tailLimit: o.tailLimit, caps: o.caps });
  const running = await startServer(socket, { core, callerCheck: o.callerCheck });
  return {
    address: running.address,
    epoch: core.epoch,
    core,
    workspace: (id, w) => core.workspace(id, w),
    starters: (list) => core.starters(list),
    ready: () => core.ready(),
    // Stops the server only. Open asks stay open on purpose: a shutdown is not an answer, and the
    // program decides what happens to the work that waits on one.
    close: () => running.close(),
  };
}
