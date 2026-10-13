// The SDK core: the layout a program shows, and the wire that serves it, as `handle(request)`. It imports no
// runtime module (no Bun, no Node, no Cloudflare), so it runs wherever a web `Request` does. A server hands each
// request to `core.handle`: `../server.ts` does it over a private Unix socket, and
// `examples/durable-member-cloudflare` does it in a Durable Object. No Pi Durable import here either.

import { type CallInfo, type CoreState, handle } from "./handle.ts";
import { Store, type WorkspaceHandle } from "./layout.ts";
import type { ReceiptStore } from "./receipts.ts";
import type { Caps, HistoryProvider, ProgramHooks, RenameTarget, Starter } from "./types.ts";

export type { CallInfo, CoreState } from "./handle.ts";
export { handle, hello } from "./handle.ts";
export type { PaneHandle, SendContext, TabHandle, WorkspaceHandle } from "./layout.ts";
export { AskClosed, askIdFor, cleanConversationRow, cleanItem, mintId, Store } from "./layout.ts";
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
  CLOSE_GROUP,
  RENAME_GROUP,
  REOPEN_GROUP,
  STARTER_GROUP,
} from "./receipts.ts";
export {
  ACTION_LABEL_MAX,
  actionLabelOf,
  ANSWER_TEXT_BYTES,
  ANSWER_TEXT_DEFAULT,
  ANSWER_TEXT_MAX,
  assertId,
  BADGE_COUNT_MAX,
  BADGE_TEXT_MAX,
  badgeOf,
  bytes,
  CAPS,
  cursorOk,
  cut,
  hrefOf,
  idOk,
  langOf,
  LIMITS,
  PROGRESS_LABEL_MAX,
  PROGRESS_STEPS_MAX,
  LINK_LABEL_MAX,
  maxLengthOf,
  PLACEHOLDER_MAX,
  progressOf,
  PUSH_LINE_MAX,
  PUSH_TITLE_MAX,
  pushTextOf,
  RENAME_TITLE_MAX,
  renameTitleOf,
  safeId,
  SUBTITLE_MAX,
  subtitleOf,
} from "./rules.ts";
export * from "./types.ts";

export interface CoreOptions {
  hostName: string;
  /** How many raw events each pane keeps. At most 1000. Default 500. */
  tailLimit?: number;
  /**
   * Turn a cap off. Everything the SDK can do is on by default, except `history`, which is on once `history()` has a
   * provider. `terminal` is always false.
   */
  caps?: Partial<Caps>;
  /** Where finished request ids are kept. Default: in memory. A store that outlives the process keeps them across a restart. */
  receipts?: ReceiptStore;
  /**
   * False for a program behind TLS with a token (WIRE.md 1B): an ask option with effect `allow-always` is then
   * a TypeError when the ask is raised or changed, because the token is the only gate. Default true (the socket).
   */
  allowAlways?: boolean;
  /** One named place for each act the phone can send. See `ProgramHooks`. */
  hooks?: ProgramHooks;
  /**
   * The old name of `hooks.onRename`, kept for one release as an alias. It takes the target and no request id.
   * When both are set, `hooks.onRename` wins.
   * @deprecated Use `hooks: { onRename }`.
   */
  onRename?: (target: RenameTarget) => boolean | Promise<boolean>;
}

export interface CollieCore {
  /** New and random for every core. A program makes one core per start. */
  readonly epoch: string;
  workspace(id: string, o: { title: string; cwd?: string }): WorkspaceHandle;
  starters(list: Starter[]): void;
  /**
   * Serve the program's own history (WIRE.md 7.16): every conversation, open and closed, and the items of any of them,
   * read from the program's store by `provider`. It turns `caps.history` on, unless the options turned it off, and
   * each pane's `sessionId` becomes its pane id unless the pane named its own.
   */
  history(provider: HistoryProvider): void;
  /** Call once the layout is complete (after a restart: after every pane is shown again). Until then every route but hello is 503 `starting`. */
  ready(): void;
  readonly isReady: boolean;
  /** Serve one request of the wire. The path starts with `/session/v1`. */
  handle(request: Request, call?: CallInfo): Promise<Response>;
}

export function createCore(o: CoreOptions): CollieCore {
  const store = new Store(o.tailLimit, o.receipts, o.allowAlways ?? true);
  // The alias fills `onRename` only when the hooks do not set it.
  const alias = o.onRename;
  const hooks: ProgramHooks = { ...(alias ? { onRename: (target: RenameTarget) => alias(target) } : {}), ...o.hooks };
  store.hooks = hooks;
  const state: CoreState = {
    store,
    hostName: o.hostName,
    caps: { asks: true, starters: true, send: true, steer: true, abort: true, rename: true, close: true, actions: true, history: false, reopen: true, ...o.caps, terminal: false },
    hooks,
  };
  return {
    epoch: store.epoch,
    workspace: (id, w) => store.workspace(id, w),
    starters: (list) => store.setStarters(list),
    history(provider) {
      store.history = provider;
      state.caps.history = o.caps?.history !== false;
      store.rev++;
    },
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
