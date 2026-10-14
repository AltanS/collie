// Wire types of the durable socket wire, version 1. They follow WIRE.md section 4 shape for shape.
// A local copy: the SDK stays free of the collie/ import chain, which a published package could not carry.

/**
 * A JSON value, as `JSON.parse` returns it. A request body is read as one, and so is what a model hands a program
 * untyped (a tool call's arguments). The readers in rules.ts turn it into the types below.
 */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
/** A JSON object. A key it does not have reads as undefined. */
export interface JsonObject {
  readonly [key: string]: Json | undefined;
}

export type PaneState = "working" | "waiting" | "idle";
/** The old name, kept for the program side. */
export type AgentState = PaneState;

export interface ProtocolRange {
  min: number;
  max: number;
}
export const PROTOCOL_RANGE: Readonly<ProtocolRange> = { min: 1, max: 1 };

/**
 * A version refusal (WIRE.md section 2): what each side speaks, as `[min, max]`. A program puts it in the 409
 * `incompatible` it answers to a version it does not speak; `collie` is then the one version the caller sent.
 */
export interface VersionRefusal {
  code: "version";
  collie: [number, number];
  program: [number, number];
}

/** What the program can do. An absent cap is false. */
export interface Caps {
  asks?: boolean;
  starters?: boolean;
  send?: boolean;
  steer?: boolean;
  abort?: boolean;
  /** It takes a new title for a workspace or a tab (WIRE.md 7.8). */
  rename?: boolean;
  /** It closes a workspace, a tab or a pane when the phone asks (WIRE.md 7.9). */
  close?: boolean;
  /** It lists actions on a pane and runs one when the phone taps it (WIRE.md 7.10). */
  actions?: boolean;
  /** It lists its conversations, open and closed, and serves the items of any of them (WIRE.md 7.16). */
  history?: boolean;
  /** It puts a closed conversation back into its layout when the phone asks (WIRE.md 7.16). */
  reopen?: boolean;
  /** Always false in version 1. */
  terminal?: boolean;
}

export interface Hello {
  /** MUST be exactly "collie-durable". Without it the adapter refuses the program (WIRE.md section 2). */
  service: "collie-durable";
  protocol: ProtocolRange;
  host: { name: string };
  epoch: string;
  /** False while the program lays out its panes after a start. */
  ready: boolean;
  caps: Caps;
}

/** A tool call, as minimal as the `other` branch of a chat tool call. */
export interface ToolCall {
  kind: "other";
  name: string;
  summary: string;
  output?: string;
}

export type ToolStatus = "running" | "done" | "failed" | "denied";

/**
 * An item with a known id replaces the earlier one (a tool changes status). Ids are unique per pane.
 *
 * A reply that grows (WIRE.md 7.15): write the same id again as the text grows, with `partial: true`, and once more
 * with the final text and no `partial`. A `user` item may carry the `requestId` of the send that made it, so the
 * phone shows its own line at once and swaps it for this one.
 */
export type Item =
  | { id: string; ts?: string; kind: "user"; text: string; requestId?: string }
  | { id: string; ts?: string; kind: "reply" | "thinking" | "notice"; text: string; partial?: true }
  /** Rendered as markdown by the phone (WIRE.md 7.13): headings, lists, emphasis, code spans and links. At most 32 KiB. */
  | { id: string; ts?: string; kind: "markdown"; text: string; partial?: true }
  /** A fenced code block. `lang` is a plain name such as "ts" or "c++" (at most 24 characters). At most 32 KiB. */
  | { id: string; ts?: string; kind: "code"; lang?: string; text: string }
  /** A link. `href` is an `https://` address (at most 2048 characters). `label` is what the phone shows, at most 120 characters. */
  | { id: string; ts?: string; kind: "link"; href: string; label?: string }
  | { id: string; ts?: string; kind: "tool"; tool: ToolCall; status: ToolStatus };

export type OptionEffect = "allow" | "allow-always" | "deny" | "cancel";

/** An option of a `permission` ask. It has an effect. */
export interface PermissionOption {
  id: string;
  label: string;
  effect: OptionEffect;
}

/** An option of a `choice` ask or of a choice field. It has no effect (WIRE.md 7.14). */
export interface PlainOption {
  id: string;
  label: string;
}

/** What an ask option is on the wire: an `effect` only on a `permission`. */
export interface Option {
  id: string;
  label: string;
  effect?: OptionEffect;
}

/** One field of a `form` ask (WIRE.md 7.14). */
export interface Field {
  /** Unique inside the ask. The key of its value in the answer. */
  id: string;
  label: string;
  kind: "text" | "choice" | "toggle";
  required?: boolean;
  /** A `choice` field: 1 to 8 options. A pick answers with the option's id. */
  options?: PlainOption[];
  /** A `text` field: 1 to 2000 characters. Default 500. */
  maxLength?: number;
}

export type AskKind = "permission" | "choice" | "text" | "form";

export interface Ask {
  /**
   * 128 bits. The SDK derives it from the pane id and the tool call id, so the same tool call keeps its ask id
   * across a restart, and an answer that crosses the restart lands (WIRE.md section 6).
   */
  id: string;
  kind: AskKind;
  /**
   * The program's id for what the ask is about. The same across a restart. A tool call's id for a `permission`;
   * for any other kind any id of the program's own that is stable across a restart (WIRE.md 7.14).
   */
  toolCallId: string;
  /** Starts at 1. Rises when the program changes this ask in place. */
  revision: number;
  /** One line the card leads with. */
  title: string;
  /** The item this ask belongs to, usually the tool item. */
  itemId: string;
  /** A `permission`: 1 to 6, each with an effect. A `choice`: 1 to 8, none with an effect. A `text` and a `form`: none. */
  options: Option[];
  /** A `choice` only. */
  multiple?: boolean;
  /** A `text` only: at most 60 characters. */
  placeholder?: string;
  /** A `text` only: 1 to 2000 characters. Absent reads as 500. */
  maxLength?: number;
  /** A `form` only: 1 to 6 fields. */
  fields?: Field[];
  reason?: string;
  tool?: ToolCall;
  /** True when the title or the reason was shortened or cleaned. The phone then offers no `allow-always`. */
  cleaned?: true;
  /**
   * The words for a notification about this ask (WIRE.md section 6): a title of at most 60 characters and a line of
   * at most 120. The bridge MAY use them and falls back to its own text. The pane's name stays in front.
   */
  push?: { title?: string; line?: string };
  /**
   * When the ask stops waiting, ISO 8601 with a zone (WIRE.md 7.3). Past it the SDK closes the ask as decided by
   * `timeout`, and a reader no longer lists it as open.
   */
  expiresAt?: string;
}
/** What every ask input has. The SDK derives the id (when missing) and sets the revision. */
interface AskInputBase {
  id?: string;
  toolCallId: string;
  title: string;
  itemId: string;
  reason?: string;
  tool?: ToolCall;
  cleaned?: true;
  /** The words for a notification about this ask (WIRE.md section 6). See {@link Ask.push}. */
  push?: { title?: string; line?: string };
  /** When the ask stops waiting: an ISO 8601 stamp or a Date. Past it the ask closes as `timeout`. See {@link Ask.expiresAt}. */
  expiresAt?: string | Date;
}

/** A tool call that needs the phone's yes. */
export interface PermissionAskInput extends AskInputBase {
  kind: "permission";
  options: PermissionOption[];
}
/** Pick one (or, with `multiple`, several) of 1 to 8 options. */
export interface ChoiceAskInput extends AskInputBase {
  kind: "choice";
  options: PlainOption[];
  multiple?: boolean;
}
/** One line of text. */
export interface TextAskInput extends AskInputBase {
  kind: "text";
  placeholder?: string;
  maxLength?: number;
}
/** A short form of 1 to 6 fields. */
export interface FormAskInput extends AskInputBase {
  kind: "form";
  fields: Field[];
}
/** What a program passes to `pane.ask()` (WIRE.md 7.14). */
export type AskInput = PermissionAskInput | ChoiceAskInput | TextAskInput | FormAskInput;

export type PermissionAnswer = { optionId: string; note?: string };
export type ChoiceAnswer = { optionIds: string[] };
export type TextAnswer = { text: string };
export type FormAnswer = { values: Record<string, string | string[] | boolean> };
/** What the phone answered, in the shape of the ask's kind. */
export type Answer = PermissionAnswer | ChoiceAnswer | TextAnswer | FormAnswer;
export type AnswerResult = "taken" | "too-late";

/** "phone": answered. "stopped": the turn ended without an answer. */
export type ClosedBy = "phone" | "stopped";

/** Who decided an ask (WIRE.md 7.3): the person on the phone, the program itself, or the clock past `expiresAt`. */
export type DecidedBy = "phone" | "program" | "timeout";

/**
 * The receipt of an ask's decision (WIRE.md 7.3): who decided and when. A `permission` the phone decided also names
 * the option it took and that option's effect. A 409 `decided` carries it, so a second answer shows the first one.
 */
export interface AskOutcome {
  decidedBy: DecidedBy;
  /** ISO 8601 with a zone. */
  decidedAt: string;
  optionId?: string;
  effect?: OptionEffect;
}

export type SessionEvent =
  | { type: "item"; item: Item }
  | { type: "remove"; id: string }
  | { type: "ask"; ask: Ask }
  /** `decidedBy` and `decidedAt` are the receipt of the decision (WIRE.md 7.3). */
  | { type: "ask-closed"; askId: string; by: ClosedBy; waitedMs?: number; decidedBy?: DecidedBy; decidedAt?: string }
  | { type: "state"; state: PaneState }
  /** An input reached its end. `requestId` is present when the input came with one. */
  | { type: "settled"; inputId: string; requestId?: string; status: "answered" | "unanswered"; reason?: string }
  | { type: "reset" }
  | { type: "synced" };

/** The events a program may append itself. The SDK writes `ask`, `ask-closed` and `state`. */
export type ProgramEvent = Exclude<SessionEvent, { type: "ask" | "ask-closed" | "state" }>;

/** The icon names the phone knows (WIRE.md section 4, `PaneAction`). Any other name draws no icon. */
export const ACTION_ICONS = ["play", "pause", "check", "x", "refresh", "archive", "flag", "star", "send", "note", "search", "more"] as const;
export type ActionIcon = (typeof ACTION_ICONS)[number];

/** One button in the program's section of the belt. At most 4 per pane, label at most 16 characters. */
export interface PaneAction {
  /** The id the phone sends back. Follows the id rule. */
  id: string;
  label: string;
  icon?: ActionIcon;
  /** The action is running: the button shows a spinner and takes no tap. */
  busy?: boolean;
  /** The action is not available now: the button is dimmed and takes no tap. */
  disabled?: boolean;
}

export interface Starter {
  id: string;
  label: string;
  run: () => Promise<{ paneId: string }>;
}
export interface StarterRow {
  id: string;
  label: string;
}

export interface Workspace {
  id: string;
  title: string;
  cwd?: string;
}
export interface Tab {
  id: string;
  workspaceId: string;
  title: string;
}

/** A small mark next to a pane's title: a count (an integer, 0 to 9999) or a short word (at most 12 characters). */
export type Badge = { count: number } | { text: string };

/** One step of a progress list. */
export interface ProgressStep {
  label: string;
  state: "done" | "running" | "todo";
}

/** How far a working pane is: up to 12 steps, or a percent from 0 to 100 with an optional label (WIRE.md 7.12). */
export type Progress = { kind: "steps"; steps: ProgressStep[] } | { kind: "percent"; value: number; label?: string };

export interface PaneInfo {
  id: string;
  workspaceId: string;
  tabId: string;
  title: string;
  harness: string;
  state: PaneState;
  lastActiveAt: number;
  /** The newest turn: the one running now, or the last one that ran. Changes when a new turn starts. */
  turnId: string;
  /** Every open ask, oldest first, at most 50. */
  openAsks: Ask[];
  /** The pane's belt actions, in order. Absent when it has none. */
  actions?: PaneAction[];
  /**
   * The conversation id this pane's history is served under (WIRE.md section 3 and 7.16). Null when the program
   * cannot keep it the same across a restart.
   */
  sessionId: string | null;
  cwd?: string;
  /** One line under the title (WIRE.md 7.11). Absent until the program sets one. */
  subtitle?: string;
  /** A count or a short mark next to the title (WIRE.md 7.11). Absent until the program sets one. */
  badge?: Badge;
  /** How far a working conversation is (WIRE.md 7.12). Absent until the program sets one. */
  progress?: Progress;
}

export interface Snapshot {
  rev: number;
  epoch: string;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: PaneInfo[];
  starters?: StarterRow[];
}

export interface EventsReply {
  epoch: string;
  events: SessionEvent[];
  /** The cursor after the last event in `events`. */
  next: number;
  /** The caller's epoch was not current, or its cursor fell outside the tail. */
  reset?: boolean;
  /** More events are ready past `next`. */
  more?: boolean;
  /** In a reset reply: how many older items were left out. */
  trimmed?: number;
}

// Requests and replies.

export interface AnswerRequest {
  requestId: string;
  askId: string;
  revision: number;
  answer: Answer;
}
export interface AnswerReply {
  result: AnswerResult;
  replayed?: true;
}
/** Exactly one of `turnId` and `askId`. */
export interface SendRequest {
  requestId: string;
  text: string;
  steer?: boolean;
  turnId?: string;
  askId?: string;
}
/** Exactly one of `turnId` and `askId`. */
export interface AbortRequest {
  requestId: string;
  turnId?: string;
  askId?: string;
}
export interface ControlReply {
  ok: true;
  replayed?: true;
}
/** A new title for a workspace or a tab. A pane's title is the conversation's and is not renamed here. */
export interface RenameRequest {
  requestId: string;
  kind: "workspace" | "tab";
  id: string;
  title: string;
}
/** Close a workspace, a tab or a pane. What "close" means (archive, delete, end) is the program's call. */
export interface CloseRequest {
  requestId: string;
  kind: "pane" | "tab" | "workspace";
  /** The pane id, the tab id as the snapshot lists it (`<workspace>:<tab>`), or the workspace id. */
  id: string;
}
/** Run one of a pane's actions. `turnId`, when sent, is the turn the phone saw; a turn that moved is 409 `stale`. */
export interface ActionRequest {
  requestId: string;
  actionId: string;
  turnId?: string;
}
export interface StarterRequest {
  requestId: string;
}
export interface StarterReply {
  paneId: string;
  replayed?: true;
}

/** Put a closed conversation back into the layout (WIRE.md 7.16). `id` is the conversation id of the history. */
export interface ReopenRequest {
  requestId: string;
  id: string;
}

// ── History (WIRE.md 7.16) ────────────────────────────────────────────────────

/** One conversation in the program's list, open or closed. */
export interface ConversationRow {
  /** The conversation id: the pane's `sessionId` while it is open. Follows the id rule. */
  id: string;
  /** What the program calls the conversation. At most 256 bytes. */
  title: string;
  /** One line under the title, at most 120 characters. */
  subtitle?: string;
  workspaceId?: string;
  tabId?: string;
  /** ISO 8601 with a zone. */
  startedAt: string;
  /** ISO 8601 with a zone. A closed conversation MAY carry it. */
  endedAt?: string;
  state: "open" | "closed";
  /** How many items the conversation holds. */
  items: number;
}

/** `GET /conversations`: newest first, at most 100 rows. `next` is absent on the last page. */
export interface ConversationsReply {
  items: ConversationRow[];
  next?: string;
}

/** `GET /conversation/:id/items`: oldest first, at most 1000 items or 8 MiB. `more` is true when `next` leads on. */
export interface ConversationItemsReply {
  items: Item[];
  next?: string;
  more: boolean;
}

/**
 * Where a program's history comes from: its own store, never the SDK's 500-event tail. The SDK pages, cleans and
 * caps what comes back. A cursor is the provider's own opaque string, at most 512 bytes of printable ASCII.
 */
export interface HistoryProvider {
  /** Conversations, newest first, open and closed. At most `limit` rows. `next` is absent on the last page. */
  list(after: string | undefined, limit: number): Promise<{ items: ConversationRow[]; next?: string }>;
  /**
   * The items of one conversation, oldest first, in their latest version (an item that changed comes once). At most
   * `limit`. `undefined` when there is no such conversation (404 `no-such-conversation`).
   */
  items(id: string, after: string | undefined, limit: number): Promise<{ items: Item[]; next?: string } | undefined>;
}

export interface Problem {
  code: string;
  message?: string;
  range?: ProtocolRange;
  /** With `incompatible`, when the caller named a version: both sides of the refusal. */
  refusal?: VersionRefusal;
  /** With `decided`: the ask's first decision (WIRE.md 7.3). */
  outcome?: AskOutcome;
  turnId?: string;
  askIds?: string[];
  ask?: Ask;
}

// ── Program hooks ─────────────────────────────────────────────────────────────

/** A pane as a hook sees it: who it is, and the turn it is on. Read only; look the pane up by `id` to act on it. */
export interface PaneRef {
  id: string;
  workspaceId: string;
  tabId: string;
  title: string;
  harness: string;
  cwd?: string;
  /** The pane's newest turn when the hook runs. */
  turnId: string;
}

/** What the phone sent with a send: the text, the steer switch, and the ids that name this act. */
export interface SendHookRequest {
  text: string;
  /** Join the running turn (true) or wait for the next one (false). On an idle pane: no effect. */
  steer: boolean;
  /** The pane's newest turn when the hook runs. */
  turnId: string;
  requestId: string;
}

/** What the phone sent with a stop. */
export interface AbortHookRequest {
  /** The pane's newest turn when the hook runs. */
  turnId: string;
  requestId: string;
}

/** The workspace or the tab a rename names, with the title already trimmed and cleaned. */
export interface RenameTarget {
  kind: "workspace" | "tab";
  /** The workspace id, or the tab id as the snapshot lists it (`<workspace>:<tab>`). */
  id: string;
  title: string;
}

/** What a tap on a belt action carries to the program. */
export interface ActionContext {
  actionId: string;
  /** The turn the phone saw, when it named one. The SDK has already checked it is still the newest. */
  turnId?: string;
  requestId: string;
}

/** The workspace, tab or pane a close names, and every pane that goes with it (the pane itself, or the ones inside). */
export interface CloseTarget {
  kind: "pane" | "tab" | "workspace";
  id: string;
  /** The ids of the panes this close takes out of the layout, in layout order. For a pane: just its own id. */
  paneIds: string[];
}

/**
 * One named place for every act the phone can send. A hook runs only when the act is allowed (its cap is on) and
 * its request id is new; a repeat answers from the receipt and never reaches a hook. A hook that throws makes the
 * act fail (500 `internal`, outcome unknown to the phone).
 *
 * The per-pane handlers (`pane.onSend`, `pane.onAbort`) stay the first choice: a hook is the fallback for a pane
 * that has none, and it is also what makes a pane without a handler take the act at all.
 */
export interface ProgramHooks {
  /** Text for a pane that has no `pane.onSend` handler. */
  onSend?(pane: PaneRef, req: SendHookRequest): Promise<void> | void;
  /** A stop for a pane that has no `pane.onAbort` handler. */
  onAbort?(pane: PaneRef, req: AbortHookRequest): Promise<void> | void;
  /**
   * A new title for a workspace or a tab. Return `false` to refuse it (422 `rename-refused`, nothing changes, the
   * same request id may try again); persist the title here if it should outlive the process. Not called for a
   * target that does not exist.
   */
  onRename?(target: RenameTarget, requestId: string): Promise<boolean> | boolean;
  /**
   * The phone closes a workspace, a tab or a pane (WIRE.md 7.9). Decide what that means on your side (archive it,
   * delete it, end it) and persist it here, so a restart does not show it again. Return `false` to refuse (422
   * `close-refused`, nothing changes, the same request id may try again); returning nothing accepts. After an
   * accepting hook the SDK removes the target and everything inside it from the layout, raises `rev`, and closes
   * every open ask on those panes as `stopped`. Not called for a target that does not exist.
   */
  onClose?(target: CloseTarget, requestId: string): Promise<boolean | void> | boolean | void;
  /**
   * The phone taps one of a pane's belt actions (WIRE.md 7.10). Run it. Return `false` to refuse (422
   * `action-refused`, the same request id may try again); returning nothing accepts. A pane's own handler
   * (`pane.onAction`) is asked first, and this hook is the fallback for a pane that has none. Not called for an
   * action the pane does not list, nor for one it lists as `disabled` or `busy`.
   */
  onAction?(pane: PaneRef, action: ActionContext): Promise<boolean | void> | boolean | void;
  /**
   * The phone reopens a closed conversation (WIRE.md 7.16). Show it again (for example with the same call that
   * showed it at start), so its pane is in the layout under the same pane id, and take it off your closed list.
   * Return `false` to refuse (422 `reopen-refused`, the same request id may try again). Without this hook the SDK
   * puts back a pane it closed in this process; a conversation closed before a restart needs the hook.
   */
  onReopen?(target: ReopenTarget, requestId: string): Promise<boolean | void> | boolean | void;
}

/** The conversation a reopen names. `paneId` is the pane the SDK closed for it in this process, when it knows one. */
export interface ReopenTarget {
  id: string;
  paneId?: string;
}
