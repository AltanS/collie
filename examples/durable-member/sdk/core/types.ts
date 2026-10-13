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
