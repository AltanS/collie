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
  /** Rendered as markdown by the phone (WIRE.md 7.11): headings, lists, emphasis, code spans and links. At most 32 KiB. */
  | { id: string; ts?: string; kind: "markdown"; text: string }
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

/** An option of a `choice` ask or of a choice field. It has no effect (WIRE.md 7.12). */
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

/** One field of a `form` ask (WIRE.md 7.12). */
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
   * for any other kind any id of the program's own that is stable across a restart (WIRE.md 7.12).
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
/** What a program passes to `pane.ask()` (WIRE.md 7.12). */
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

/** A small mark next to a pane's title: a count (an integer, 0 to 9999) or a short word (at most 12 characters). */
export type Badge = { count: number } | { text: string };

/** One step of a progress list. */
export interface ProgressStep {
  label: string;
  state: "done" | "running" | "todo";
}

/** How far a working pane is: up to 12 steps, or a percent from 0 to 100 with an optional label (WIRE.md 7.10). */
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
  /** Reserved for the machine-scoped session id (WIRE.md section 3). Null until a later version defines it. */
  sessionId: string | null;
  cwd?: string;
  /** One line under the title (WIRE.md 7.9). Absent until the program sets one. */
  subtitle?: string;
  /** A count or a short mark next to the title (WIRE.md 7.9). Absent until the program sets one. */
  badge?: Badge;
  /** How far a working conversation is (WIRE.md 7.10). Absent until the program sets one. */
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
