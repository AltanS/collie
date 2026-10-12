// The neutral core. A program calls `openCollie`, lays out workspaces, tabs and panes, and the
// durable socket wire (version 1) shows them to the Collie that dials it. No Pi Durable import in sdk/.

import { type PaneHandle, Store, type TabHandle, type WorkspaceHandle } from "./layout.ts";
import { startServer } from "./server.ts";
import type { Caps, Starter } from "./types.ts";

export type { PaneHandle, SendContext, TabHandle, WorkspaceHandle } from "./layout.ts";
export { AskClosed } from "./layout.ts";
export { assertId, CAPS, cut, idOk, LIMITS, safeId } from "./rules.ts";
export * from "./types.ts";

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
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  /** Call once the layout is complete (after a restart: after every pane is shown again). Until then the caller gets 503 `starting`. */
  ready(): void;
  close(): Promise<void>;
}

export async function openCollie(o: OpenOptions): Promise<Collie> {
  const socket = o.socket ?? process.env[SOCKET_ENV];
  if (!socket) throw new Error(`openCollie needs a socket path: pass socket or set ${SOCKET_ENV}`);
  const store = new Store(o.tailLimit);
  const running = await startServer(socket, { store, hostName: o.hostName, caps: o.caps, callerCheck: o.callerCheck });
  return {
    address: running.address,
    epoch: store.epoch,
    workspace: (id, w) => store.workspace(id, w),
    starters: (list) => store.setStarters(list),
    ready() {
      store.ready = true;
      store.rev++;
    },
    // Stops the server only. Open asks stay open on purpose: a shutdown is not an answer, and the
    // program decides what happens to the work that waits on one.
    close: () => running.close(),
  };
}
