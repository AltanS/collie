// The SDK core (`@colliepwa/durable-sdk/core`): the layout a program shows, and the wire that serves it, as
// `handle(request)`. It imports no runtime module (no Bun, no Node, no Cloudflare), so it runs wherever a web `Request`
// does. A server hands each request to `core.handle`: `../server.ts` does it over a private Unix socket in Bun,
// `../node/index.ts` in Node, and `experiments/durable-member-cloudflare` does it in a Durable Object. No Pi Durable
// import here either.

import { type CallInfo, type CoreState, handle } from "./handle.ts";
import { Store, type StoreSeams, type WorkspaceHandle } from "./layout.ts";
import type { ReceiptStore } from "./receipts.ts";
import type { Caps, HistoryProvider, ProgramHooks, RenameTarget, Starter } from "./types.ts";

export type { CallInfo, CoreState } from "./handle.ts";
export { handle, hello, versionLine } from "./handle.ts";
export type { AskSink, PaneHandle, PaneOptions, SendContext, SinkReply, StoreSeams, TabHandle, WorkspaceHandle } from "./layout.ts";
export { AnswerDecided, AskClosed, askIdFor, cleanConversationRow, cleanItem, mintId, Store } from "./layout.ts";
export type { FoldedJournal, FoldedReceipt, JournalAnswer, JournalAsk, JournalExpire, JournalReceipt, JournalRecord, SeededAsk } from "./journal.ts";
export { foldJournal, isTerminal, parseJournal } from "./journal.ts";
export {
  type Claim,
  digestOf,
  type DroppedReceipt,
  HttpError,
  isDropped,
  MemoryReceiptStore,
  PENDING_WAIT_MS,
  RECEIPTS_PER_GROUP,
  type ReceiptRecord,
  Receipts,
  type ReceiptsOptions,
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
export { type AskSpec, type RiskWords, type RiskWordsFor, summaryOf, toAskSpec } from "./ask-policy.ts";
export { argumentsView, type Approval, type ApprovalOptions, callSummary, requireApproval } from "./approval.ts";
export { SDK_VERSION } from "./version.ts";

/** The durable wire version this SDK speaks (WIRE.md section 2). The package's own version is {@link SDK_VERSION}. */
export const WIRE_VERSION = 1;

/** Every cap the SDK can serve, on. `history` among them, which a program serves once `history()` has a provider. */
export const ALL_CAPS: Readonly<Required<Omit<Caps, "terminal">>> = {
  asks: true,
  starters: true,
  send: true,
  steer: true,
  abort: true,
  rename: true,
  close: true,
  actions: true,
  history: true,
  reopen: true,
};

/** Every cap off: what a given `caps` list starts from, since an absent cap is false (WIRE.md section 4). */
const NO_CAPS: Required<Omit<Caps, "terminal">> = {
  asks: false,
  starters: false,
  send: false,
  steer: false,
  abort: false,
  rename: false,
  close: false,
  actions: false,
  history: false,
  reopen: false,
};

export interface CoreOptions {
  hostName: string;
  /**
   * The epoch, used as is (it must follow the id rule). For a host with no process start of its own, whose epoch
   * is a fact of its deployment and not of a start. Left out: 128 random bits per core, as always.
   */
  epoch?: string;
  /**
   * The snapshot's `rev`, read at every snapshot, for a host that derives it from its own log. A whole number from 1
   * that never goes down while the epoch stays. Left out: the core's own counter.
   */
  rev?: () => number;
  /** How many raw events each pane keeps. At most 1000. Default 500. */
  tailLimit?: number;
  /**
   * The caps this program declares (WIRE.md section 4). Left out, everything the SDK can do is on ({@link ALL_CAPS}),
   * and `history` turns on once `history()` has a provider. Given, it is the whole list: a cap it does not name is
   * false, as on the wire, so `{ asks: true }` declares asks and nothing else. To turn one off and keep the rest, spread
   * {@link ALL_CAPS}: `{ ...ALL_CAPS, steer: false }`. `terminal` is always false.
   */
  caps?: Caps;
  /** Where finished request ids are kept. Default: in memory. A store that outlives the process keeps them across a restart. */
  receipts?: ReceiptStore;
  /**
   * False for a program behind TLS with a token (WIRE.md 1B): an ask option with effect `allow-always` is then
   * a TypeError when the ask is raised or changed, because the token is the only gate. Default true (the socket).
   */
  allowAlways?: boolean;
  /** One named place for each act the phone can send. See `ProgramHooks`. */
  hooks?: ProgramHooks;
  /** Where the core writes its one-line notes, for example a Collie that speaks another wire version. Default: `console.warn`. */
  warn?: (line: string) => void;
  /**
   * The old name of `hooks.onRename`, kept for one release as an alias. It takes the target and no request id.
   * When both are set, `hooks.onRename` wins.
   * @deprecated Use `hooks: { onRename }`.
   */
  onRename?: (target: RenameTarget) => boolean | Promise<boolean>;
}

export interface CollieCore {
  /** New and random for every core, unless `CoreOptions.epoch` named one. A program makes one core per start. */
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
  const seams: StoreSeams = {};
  if (o.epoch !== undefined) seams.epoch = o.epoch;
  if (o.rev !== undefined) seams.rev = o.rev;
  const store = new Store(o.tailLimit, o.receipts, o.allowAlways ?? true, seams);
  // The alias fills `onRename` only when the hooks do not set it.
  const alias = o.onRename;
  const fromAlias: ProgramHooks = {};
  if (alias) fromAlias.onRename = (target: RenameTarget) => alias(target);
  const hooks: ProgramHooks = { ...fromAlias, ...o.hooks };
  store.hooks = hooks;
  const state: CoreState = {
    store,
    hostName: o.hostName,
    // Left out: everything on, history once a provider is set. Given: exactly the caps it names as true.
    caps: o.caps === undefined ? { ...ALL_CAPS, history: false, terminal: false } : { ...NO_CAPS, ...o.caps, terminal: false },
    hooks,
  };
  if (o.warn !== undefined) state.warn = o.warn;
  return {
    epoch: store.epoch,
    workspace: (id, w) => store.workspace(id, w),
    starters: (list) => store.setStarters(list),
    history(provider) {
      store.history = provider;
      state.caps.history = o.caps === undefined || o.caps.history === true;
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
