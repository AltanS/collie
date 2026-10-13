// Wire types of the durable socket wire, version 1. They follow WIRE.md section 4 shape for shape.
// A local copy: the SDK stays free of the collie/ import chain, which a published package could not carry.

export type PaneState = "working" | "waiting" | "idle";
/** The old name, kept for the program side. */
export type AgentState = PaneState;

export interface ProtocolRange {
  min: number;
  max: number;
}
export const PROTOCOL_RANGE: Readonly<ProtocolRange> = { min: 1, max: 1 };

/** What the program can do. An absent cap is false. */
export interface Caps {
  asks?: boolean;
  starters?: boolean;
  send?: boolean;
  steer?: boolean;
  abort?: boolean;
  /** It takes a new title for a workspace or a tab (WIRE.md 7.8). */
  rename?: boolean;
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

/** An item with a known id replaces the earlier one (a tool changes status). Ids are unique per pane. */
export type Item =
  | { id: string; ts?: string; kind: "user" | "reply" | "thinking" | "notice"; text: string }
  | { id: string; ts?: string; kind: "tool"; tool: ToolCall; status: ToolStatus };

export interface Option {
  id: string;
  label: string;
  effect: "allow" | "allow-always" | "deny" | "cancel";
}

export interface Ask {
  /**
   * 128 bits. The SDK derives it from the pane id and the tool call id, so the same tool call keeps its ask id
   * across a restart, and an answer that crosses the restart lands (WIRE.md section 6).
   */
  id: string;
  kind: "permission";
  /** The program's id for the tool call. The same across a restart. */
  toolCallId: string;
  /** Starts at 1. Rises when the program changes this ask in place. */
  revision: number;
  /** One line the card leads with. */
  title: string;
  /** The item this ask belongs to, usually the tool item. */
  itemId: string;
  /** At least one, at most 6. */
  options: Option[];
  reason?: string;
  tool?: ToolCall;
  /** True when the title or the reason was shortened or cleaned. The phone then offers no `allow-always`. */
  cleaned?: true;
}
/** What a program passes to `pane.ask()`. The SDK derives the id (when missing) and sets the revision. */
export type AskInput = Omit<Ask, "id" | "revision"> & { id?: string };

export type Answer = { optionId: string; note?: string };
export type AnswerResult = "taken" | "too-late";

/** "phone": answered. "stopped": the turn ended without an answer. */
export type ClosedBy = "phone" | "stopped";

export type SessionEvent =
  | { type: "item"; item: Item }
  | { type: "remove"; id: string }
  | { type: "ask"; ask: Ask }
  | { type: "ask-closed"; askId: string; by: ClosedBy; waitedMs?: number }
  | { type: "state"; state: PaneState }
  /** An input reached its end. `requestId` is present when the input came with one. */
  | { type: "settled"; inputId: string; requestId?: string; status: "answered" | "unanswered"; reason?: string }
  | { type: "reset" }
  | { type: "synced" };

/** The events a program may append itself. The SDK writes `ask`, `ask-closed` and `state`. */
export type ProgramEvent = Exclude<SessionEvent, { type: "ask" | "ask-closed" | "state" }>;

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
  /** Reserved for the machine-scoped session id (WIRE.md section 3). Null until a later version defines it. */
  sessionId: string | null;
  cwd?: string;
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
export interface StarterRequest {
  requestId: string;
}
export interface StarterReply {
  paneId: string;
  replayed?: true;
}

export interface Problem {
  code: string;
  message?: string;
  range?: ProtocolRange;
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
}
