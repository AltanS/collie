// The SDK core: the layout a program shows, and the wire that serves it, as `handle(request)`. It imports no
// runtime module (no Bun, no Node, no Cloudflare), so it runs wherever a web `Request` does. A server hands each
// request to `core.handle`: `../server.ts` does it over a private Unix socket, and
// `examples/durable-member-cloudflare` does it in a Durable Object. No Pi Durable import here either.

import { type CallInfo, type CoreState, handle } from "./handle.ts";
import { Store, type WorkspaceHandle } from "./layout.ts";
import type { ReceiptStore } from "./receipts.ts";
import type { Caps, Starter } from "./types.ts";

export type { CallInfo, CoreState } from "./handle.ts";
export { handle, hello } from "./handle.ts";
export type { PaneHandle, SendContext, TabHandle, WorkspaceHandle } from "./layout.ts";
export { AskClosed, askIdFor, mintId, Store } from "./layout.ts";
export {
  digestOf,
  type DroppedReceipt,
  HttpError,
  isDropped,
  MemoryReceiptStore,
  RECEIPTS_PER_GROUP,
  type ReceiptRecord,
  Receipts,
  type ReceiptStore,
  STARTER_GROUP,
} from "./receipts.ts";
export { assertId, bytes, CAPS, cut, idOk, LIMITS, safeId } from "./rules.ts";
export * from "./types.ts";

export interface CoreOptions {
  hostName: string;
  /** How many raw events each pane keeps. At most 1000. Default 500. */
  tailLimit?: number;
  /** Turn a cap off. Everything the SDK can do is on by default. `terminal` is always false. */
  caps?: Partial<Caps>;
  /** Where finished request ids are kept. Default: in memory. A store that outlives the process keeps them across a restart. */
  receipts?: ReceiptStore;
  /**
   * False for a program behind TLS with a token (WIRE.md 1B): an ask option with effect `allow-always` is then
   * a TypeError when the ask is raised or changed, because the token is the only gate. Default true (the socket).
   */
  allowAlways?: boolean;
}

export interface CollieCore {
  /** New and random for every core. A program makes one core per start. */
  readonly epoch: string;
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  /** Call once the layout is complete (after a restart: after every pane is shown again). Until then every route but hello is 503 `starting`. */
  ready(): void;
  readonly isReady: boolean;
  /** Serve one request of the wire. The path starts with `/session/v1`. */
  handle(request: Request, call?: CallInfo): Promise<Response>;
}

export function createCore(o: CoreOptions): CollieCore {
  const store = new Store(o.tailLimit, o.receipts, o.allowAlways ?? true);
  const state: CoreState = {
    store,
    hostName: o.hostName,
    caps: { asks: true, starters: true, send: true, steer: true, abort: true, ...o.caps, terminal: false },
  };
  return {
    epoch: store.epoch,
    workspace: (id, w) => store.workspace(id, w),
    starters: (list) => store.setStarters(list),
    ready() {
      store.ready = true;
      store.rev++;
    },
    get isReady() {
      return store.ready;
    },
    handle: (request, call) => handle(request, state, call),
  };
}
