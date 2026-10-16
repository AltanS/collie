// What `openCollie` takes and gives, the same for the Bun entry (bun/index.ts) and the Node entry (node/index.ts).
// No runtime import: each entry brings its own server.

import { type CollieCore, type CoreOptions, createCore } from "./core/index.ts";
import type { Caps, HistoryProvider, Starter } from "./core/types.ts";
import type { WorkspaceHandle } from "./core/layout.ts";

/** The variable both sides read to find the socket. */
export const SOCKET_ENV = "COLLIE_DURABLE_SOCKET";

export interface OpenOptions {
  /** An absolute path, at most 103 bytes. Its folder is made 0700, or must already be a real folder of this user with mode 0700. Default: the `COLLIE_DURABLE_SOCKET` variable. */
  socket?: string;
  hostName: string;
  /** How many raw events each pane keeps. At most 1000. Default 500. */
  tailLimit?: number;
  /**
   * The caps this program declares. Left out, everything the SDK can do is on. Given, a cap it does not name is false,
   * as on the wire: `{ asks: true }` is enough to declare asks alone. See `CoreOptions.caps`.
   */
  caps?: Caps;
  /** `descendant` (default) or `off`. See `ServerOptions.callerCheck`. The Node entry cannot run the check. */
  callerCheck?: "descendant" | "off";
  /** One named place for each act the phone can send: `onSend`, `onAbort`, `onRename`. See `ProgramHooks`. */
  hooks?: CoreOptions["hooks"];
  /** The old name of `hooks.onRename`, kept for one release as an alias. */
  onRename?: CoreOptions["onRename"];
  /** Where the SDK writes its one-line notes, for example a Collie that speaks another wire version. Default: `console.warn`. */
  warn?: CoreOptions["warn"];
}

export interface Collie {
  /** The socket path it listens on. */
  readonly address: string;
  readonly epoch: string;
  /** The core behind the socket. A test, or a second transport, can call `core.handle` directly. */
  readonly core: CollieCore;
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  /** Serve the program's own history (WIRE.md 7.16). See `CollieCore.history`. */
  history(provider: HistoryProvider): void;
  /** Call once the layout is complete (after a restart: after every pane is shown again). Until then the caller gets 503 `starting`. */
  ready(): void;
  /** Stop the server. Replies in flight still go out, for at most 2 s. */
  close(): Promise<void>;
}

/** The socket path the options name, or the variable's. */
export function socketOf(o: OpenOptions, env: Readonly<Record<string, string | undefined>>): string {
  const socket = o.socket ?? env[SOCKET_ENV];
  if (!socket) throw new Error(`openCollie needs a socket path: pass socket or set ${SOCKET_ENV}`);
  return socket;
}

/** The core the options describe. */
export function coreOf(o: OpenOptions): CollieCore {
  return createCore({ hostName: o.hostName, tailLimit: o.tailLimit, caps: o.caps, hooks: o.hooks, onRename: o.onRename, warn: o.warn });
}

/** A running server and its core, as the handle a program holds. */
export function collieOf(core: CollieCore, running: { address: string; close(): Promise<void> }): Collie {
  return {
    address: running.address,
    epoch: core.epoch,
    core,
    workspace: (id, w) => core.workspace(id, w),
    starters: (list) => core.starters(list),
    history: (provider) => core.history(provider),
    ready: () => core.ready(),
    // Stops the server only. Open asks stay open on purpose: a shutdown is not an answer, and the
    // program decides what happens to the work that waits on one.
    close: () => running.close(),
  };
}
