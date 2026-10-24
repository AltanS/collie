// Domain model for the bridge. These are OUR types, decoupled from Herdr's wire shapes
// (which live only in mux/herdr/client.ts). The rest of the app talks in these terms.

import type { HeldRow } from "../web/src/lib/surface/send.ts";
import type { Surface } from "../web/src/lib/surface/surface.ts";
import type { HoldNote } from "../web/src/lib/surface/hold.ts";
import type { Confidence } from "./cache/claims.ts";
import type { PaneCache } from "./cache/engine.ts";
import type { ApiErrorDetail, ErrorCode } from "./error-codes.ts";
import type { GitHead } from "./git-head.ts";
import type { PaneUsage } from "./usage.ts";
import type { ChatBody } from "./journal/live.ts";
import type { AgentSessionRef, TranscriptEntry } from "./journal/types.ts";
import type { MuxCapability, MuxSpaceCapacity, MuxTopologyLatency } from "./mux/capabilities.ts";
import type { SttWireIdentity } from "./stt/config.ts";
import type { PaneSubagent } from "./subagents.ts";
import type { PaneTodo } from "./todos.ts";
import type { UpdateRun } from "./update-run.ts";

// Re-exported so the wire surface has ONE import site: a consumer of PaneHistoryResponse gets the
// entry shape from here too, without reaching into an adapter module. `PaneCache` rides along for the
// same reason — it is a pane field now, so a reader of this module needs no second import.
export type { TranscriptEntry, TranscriptPart } from "./journal/types.ts";
export type { ChatBody, ChatEntry, ChatOlderBody, ChatWindowBody } from "./journal/live.ts";
export type { CacheStateName, PaneCache } from "./cache/engine.ts";
export type { Confidence } from "./cache/claims.ts";
export type { GitHead } from "./git-head.ts";
export type { PaneTodo, PaneTodoStatus } from "./todos.ts";
export type { PaneSubagent } from "./subagents.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** A small mark next to a pane's title: a count, or a short word. Exactly one key (WIRE.md section 3). */
export type PaneBadge = { count: number } | { text: string };

/** How far a working pane is: a list of steps, or a percent with an optional label (WIRE.md section 7.12). */
export type PaneProgress =
  | { readonly kind: "steps"; readonly steps: readonly { readonly label: string; readonly state: "done" | "running" | "todo" }[] }
  | { readonly kind: "percent"; readonly value: number; readonly label?: string };

/**
 * A single pane the user might want to monitor or drive. Usually an agent-bearing pane (the
 * triage home), but also a bare **shell** pane (`kind:"shell"`, `agent:"shell"`) once we surface
 * those so a freshly-created tab/space is reachable and you can launch your own agent in it.
 */
export interface AgentView {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId: string;
  agent: string;
  status: AgentStatus;
  cwd: string;
  focused: boolean;
  /** "agent" for an agent-bearing pane, "shell" for a bare shell. Defaults to "agent" when absent. */
  kind?: "agent" | "shell";
  /** User-set pane label (herdr `pane.rename`), when one is set; absent when the pane is unlabelled. */
  paneLabel?: string;
  /**
   * The harness's OWN session name, set in-agent by the operator: Claude's via `/rename`, read
   * out of the pane's rendered text (see `extractClaudeSessionName` in state-engine.ts), and
   * Muse's user-given name, read out of its journal's `session.name.changed` rows (see
   * `museSessionNameReader` in journal/muse.ts) — never Muse's automatic session name, which
   * every session carries and the operator never chose. Derived, not a wire field — absent for
   * unnamed sessions and every other harness. Display priority is `paneLabel` first.
   */
  sessionName?: string;
  /**
   * How the agent named its session (Herdr `agent_session`), when it named one at all.
   *
   * SERVER-SIDE ONLY — stripped before this pane goes on the wire (see {@link PaneWire}), because
   * pi reports a kind-`path` ref whose value is an absolute filesystem path, and the client has no
   * use for it: the history endpoint re-derives the ref from the pane id and never trusts a
   * client-supplied one. What the client gets is the presence flag `hasSession`.
   */
  agentSession?: AgentSessionRef;
  /**
   * Which harness wrote {@link agentSession}, when the pane no longer names one — the pane whose
   * agent EXITED (its beacon expired, so it reads as a plain shell again). SERVER-SIDE ONLY, and
   * carried for one consumer: the history route's journal lookup, which is keyed by harness name.
   *
   * Deliberately invisible. Nothing on the wire is derived from it, so a pane holding one is
   * byte-identical to any other shell pane (see `bridge/beacon/decorate.ts` § decoratePane).
   */
  sessionAgent?: string;
  /**
   * Upper bound on the lines a `recent` read of this pane can return — Herdr's scrollback depth plus
   * the viewport. This is the ONLY reliable "is there more scrollback" signal: `PaneRead.truncated`
   * is always false even when a read cut history off, which is why the mirror's "Load older" button
   * never used to appear. A pane on the alternate screen (any Claude agent) reports just its viewport
   * here, because the alt screen keeps no scrollback ring at all. Absent on older Herdr servers.
   */
  readableLines?: number;
  /**
   * The pane's tab label, denormalised from `tab.list` exactly as `workspaceLabel` already is — so
   * every client surface (card, sidebar, palette, space view) gets it without joining `tabs[]`.
   * Absent when the label carries no information: an unlabelled tab is named positionally by Herdr
   * ("1") and by zellij (`Tab #1`), which would render as `project › 1`. See `meaningfulTabLabel`,
   * and `isUnnamedTab` in pane-name.ts, which is the one rule underneath it.
   */
  tabLabel?: string;
  /**
   * The tab's name, when the operator named that tab and this pane is alone in it. The bridge decides
   * (bridge/state-engine.ts) because only the multiplexer adapter knows whether a label was chosen
   * (`MuxPane.tabNamed`: tmux's automatic window name is not). The name rule reads it: a one-pane tab
   * is how most operators name a pane, and that name outranks the title Claude rewrites every turn.
   * Absent from an older peer, which keeps the title.
   */
  soleTabName?: string;
  /**
   * The pane's 0-based position inside its tab, in the multiplexer's own order. The dashboard's fixed
   * order reads it, since a pane id's alphabetical order is not the order on screen. Absent from an
   * older peer.
   */
  tabPosition?: number;
  /**
   * What the pane's own process says it is doing — its OSC title, glyph-stripped and dropped when
   * uninformative (see `meaningfulTerminalTitle`). Claude rewrites this per turn, so unlike
   * `paneLabel` and `sessionName` — both set once, by hand — it tracks the work as it moves, which
   * is what tells several agents in ONE project apart in the herd list.
   *
   * Absent when the title says nothing, and on Herdr servers too old to report it.
   */
  terminalTitle?: string;
  /**
   * True when {@link terminalTitle} was left behind by a program that has already EXITED — a
   * multiplexer keeps a pane's title after the program that printed it is gone, so a bare shell can
   * sit under a finished agent's sentence for hours (see `terminalTitleIsStale` in state-engine.ts).
   *
   * PRESENTATION, and set only when true. The title is still sent, unedited: a stale one is rendered
   * quietly rather than as the pane's name, because a title is evidence about the past and deleting
   * it would lose that. It changes no status, no capability and no sort. Absent on every older
   * bridge, which reads exactly as it did before — as "not known to be stale".
   */
  terminalTitleStale?: boolean;
  /**
   * One line the program shows under this pane's title (WIRE.md section 3, `Pane.subtitle`). Text only,
   * trimmed and capped at 120 characters by the adapter that read it.
   *
   * ONE PRODUCER, like {@link PaneWire.asks}: only a pane from an adapter whose panes have no screen
   * carries it (the `durable` adapter). Absent on every other pane and from every older bridge or crew
   * member, which all read as "no subtitle", so a solo body stays byte-identical.
   */
  subtitle?: string;
  /**
   * A small mark next to the title: a count (an integer, 0 to 9999) or a short word (at most 12
   * characters). Same producer and same absence rule as {@link subtitle}.
   */
  badge?: PaneBadge;
  /**
   * How far a working conversation is (WIRE.md section 7.12). Same producer and same absence rule as
   * {@link subtitle}. The phone draws it only while the pane works or waits.
   */
  progress?: PaneProgress;
  /**
   * A finished English sentence about this pane, composed in the bridge and rendered as text the
   * client does not interpret. Absent on almost every pane.
   *
   * PRESENTATION AND NOTHING ELSE. It never carries a harness name or a multiplexer name, it never
   * implies the pane's `agent` or `status`, and no control may be armed, hidden or shown by it. The
   * module that composes it sits beside the mux decorator and is the only thing that writes one.
   */
  hint?: string;
  /**
   * Epoch ms of this agent's last observed status transition (bridge/activity.ts). The only thing
   * that can make a pane read as unseen. Absent until the ledger has an entry, and on the very
   * first poll after a fresh install.
   */
  lastActiveAt?: number;
  /**
   * Epoch ms you last opened or drove this pane through Collie. `lastActiveAt > lastSeenAt` on a
   * `done` agent IS the "finished while you weren't looking" state — there is no stored seen flag.
   */
  lastSeenAt?: number;
  /**
   * How long this pane's prompt cache stays warm, read from the harness's own transcript
   * (bridge/cache/tracker.ts). Attached at serialise time exactly as {@link lastActiveAt} is, so it
   * rides `toPaneWire`'s rest spread onto the wire.
   *
   * ABSENT, NEVER A PLACEHOLDER. A pane with no journal adapter, no session, or an agent that has not
   * taken a turn yet carries no key at all — the bridge cannot read the agent's environment, so it
   * does not guess ([ADR 0041](../.adr/0041-cache-rules-are-sourced-claims.md)). That is what keeps a
   * solo body byte-identical to 1.8.2's for every non-agent pane (`solo-baseline.test.ts`).
   */
  cache?: PaneCache;
  /**
   * The pane's active todo list, read from the session's task files or journal by the todo tracker
   * (bridge/todos.ts). Attached at serialise time and ABSENT, NEVER A PLACEHOLDER: a pane with no
   * tasks carries no key at all.
   */
  todos?: PaneTodo[];
  /**
   * The subagents of this pane's session that have not finished yet, read from the session's
   * subagent meta files by the subagent tracker (bridge/subagents.ts). Claude Code only in this
   * release. Attached at serialise time and ABSENT, NEVER A PLACEHOLDER: a pane with none running
   * carries no key at all, never `[]`.
   */
  subagents?: PaneSubagent[];
  /**
   * The model this pane's agent is on, as its harness names it: a `/model` chosen since the last turn
   * first (Claude), else the model that turn ran on (`claude-opus-5-5`, `provider:model` for opencode
   * and pi). Read by the cache tracker's probe and attached at serialise time exactly as {@link cache}
   * is. Display only: the phone draws it small above the belt and nothing decides on it.
   *
   * ABSENT, NEVER A PLACEHOLDER: no journal adapter, no session, no turn yet, or an older bridge.
   */
  model?: string;
  /**
   * The effort this pane's agent runs at, in its harness's own word: pi's thinking level, Claude's
   * `/effort`, Codex's reasoning effort, opencode's variant (`high`, `xhigh`, `max`). A level set
   * since the last turn first, as {@link model} does. Rides only beside {@link model}, from the same
   * probe. Display only: the phone draws it after the model and nothing decides on it.
   *
   * ABSENT, NEVER A PLACEHOLDER: no model, a log that names no level, or an older bridge.
   */
  effort?: string;
  /**
   * How full this pane's context is and how much of the subscription's windows the account has used,
   * as the harness's own statusLine reported them (bridge/usage.ts, .adr/0115). Numbers only; the
   * phone draws them as dots beside the model and nothing decides on them.
   *
   * ABSENT, NEVER A PLACEHOLDER: a harness that reports none, an operator with no statusLine to
   * wrap, a window that has reset, or an older bridge.
   */
  usage?: PaneUsage;
  /**
   * What the checkout holding this pane's folder is on: a branch, or a detached head at a full
   * object name. Read off disk by `bridge/git-head.ts` (two small files, no git process, no lock) and
   * attached at serialise time exactly as {@link cache} is.
   *
   * ABSENT, NEVER A PLACEHOLDER. A folder in no checkout, one that is gone or unreadable, a reading
   * not taken yet (the first snapshot after a folder appears) and every older bridge carry no key at
   * all, and the phone then draws exactly what it drew before the field existed.
   */
  gitHead?: GitHead;
}

/**
 * A pane as the BROWSER sees it: every {@link AgentView} field except the session ref, which is
 * replaced by a presence flag.
 *
 * The two shapes differ on purpose. `agentSession.value` is either an opaque id (Claude, Codex) or an
 * absolute path (pi) — the client needs neither, and shipping the path would hand out filesystem
 * layout for nothing. All the UI ever asked of that field was "may this pane have history?", which is
 * what `hasSession` answers, so the History affordance still shows without a speculative fetch.
 *
 * NOTE the `Omit` is opt-OUT: a future server-only field on AgentView goes on the wire unless it is
 * added to the omit list here. If you add one, strip it here in the same change.
 */
export type PaneWire = Omit<AgentView, "agentSession" | "sessionAgent"> & {
  /** True when this pane's history is actually offerable: the agent named a session AND its harness
   *  has a journal adapter. Says nothing about whether the log is readable — a named session whose
   *  file is missing still answers `available:false` with reason `no-log`. */
  hasSession?: boolean;
  /**
   * The pane's walky talky instance token (bridge/walky/instances.ts): four characters of [a-z0-9]
   * that name the session holding this pane id now. A multiplexer reuses a pane id once the pane
   * closes; the token does not carry over, so `<member>/<pane>#<token>` reaches this pane only.
   * Absent from a bridge built without walky talky, and from an older member (CREW_PROTOCOL §21).
   */
  instance?: string;
  /**
   * Which member of the crew this pane lives on — the `?h=` value completing the `(host, session,
   * paneId)` address (CREW_PROTOCOL.md §4). Present exactly when {@link SnapshotResponse.servers}
   * is; absent on every solo snapshot (§11). Pane ids are only unique per machine, which is why a
   * merged list must carry this and why the phone's per-pane cache keys on it.
   */
  host?: string;
  /**
   * Which Herdr session on {@link host} this pane lives in — the `?s=` half of the same address.
   *
   * Present exactly when the snapshot was asked to WIDEN (`?sessions=all`), and then on EVERY pane
   * in the body including the primary session's. Absent otherwise, which is every request that has
   * ever been made until now, so a solo body is unchanged to the byte.
   *
   * Tagging all of them rather than only the non-primary ones is deliberate. The alternative rule —
   * "absent means primary" — makes an untagged pane mean two different things depending on whether
   * the body was widened, and the client's `findPane` deliberately lets an untagged pane match ANY
   * scope so that solo lookups stay exactly today's. Those two rules together would let a primary
   * pane answer a lookup for a named session's identically-numbered pane. Every pane tagged, or
   * none: there is no third state to get wrong.
   */
  session?: string;
  /**
   * The open asks a person may answer on this pane, as data, oldest first (ADR 0100).
   *
   * ONE PRODUCER: only a pane from an adapter that raises asks as data carries the key (the
   * `durable` adapter, `MuxAdapter.openAsks`). The screen reader never fills it, so every ask has
   * one owner. Absent on every other pane, and absent from every older bridge, which the phone reads
   * as "no asks as data here". An empty list is a real answer: this pane takes answers by id and
   * has none open.
   *
   * EVERY open ask is listed, up to the adapter's cap of 50 per pane (WIRE.md section 6). The push
   * guard caps pushes, never this list; the phone draws the first five and opens the rest on a tap.
   */
  asks?: Ask[];
  /**
   * The newest turn of this pane: the one running now, or the last one that ran (ADR 0101).
   *
   * ONE PRODUCER, like {@link asks}: only a pane from an adapter that takes guarded controls carries
   * it (the `durable` adapter, `MuxAdapter.paneTurn`). The phone sends it back unchanged as the
   * `turnId` of a send or an abort, so the bridge can refuse a control aimed at a turn the person did
   * not see. Absent on every other pane and from every older bridge.
   */
  turnId?: string;
  /**
   * The belt buttons this pane's program lists, in its order (WIRE.md section 4, `PaneAction`).
   *
   * ONE PRODUCER, like {@link asks}: only a pane from an adapter that takes program actions carries
   * the key (the `durable` adapter, `MuxAdapter.paneActions`, when the program declared `caps.actions`).
   * At most 4, each cleaned by the adapter. Absent on every other pane and from every older bridge,
   * which the phone reads as "no program buttons here".
   */
  actions?: PaneAction[];
  /**
   * The pane's input surface as the bridge reads it from the screen (M56 spec 04): turn, modal,
   * composer and the reason a claim is unknown, with the revision of the read.
   *
   * Present only while Surface shadow mode is on (`COLLIE_SURFACE_SHADOW=1`) and the shadow has read
   * the pane; absent on every other pane and from every older bridge. Nothing on the phone decides a
   * send by it yet (spec 06 turns it into the composer's input).
   */
  surface?: Surface;
  /**
   * Whether the pane's hook source is live (M56 spec 11): `live` while the harness's own hooks send
   * edges from the pane's process, `holds` when those hooks also hold permissions (M56 spec 12),
   * `none` otherwise (hooks not installed, or the pane started before the install). Present only with `surface`, on a session whose adapter can place edges. Absent from
   * an older bridge.
   */
  hooks?: "live" | "holds" | "none";
  /**
   * The pane's hook-held permission (M56 spec 12): the tool, the input shown and the state (held,
   * sent, answered at the desk, voided). Present only while a hold waits or a short while after it
   * ended. The input is masked like the mirror under redaction. Absent from an older bridge.
   */
  hold?: HoldNote;
  /**
   * Present (and `true`) when this bridge runs the Send Protocol (`COLLIE_SEND_PROTOCOL=1`, M56 spec
   * 05) and the pane carries a Surface: the phone's composer then sends through `POST /api/send`.
   * Absent otherwise, so a bridge without the flag sends the same bytes as before.
   */
  sendProtocol?: true;
  /**
   * Present (and `true`) when a Stop (M68) has a key to press on this pane: it has a screen Surface and
   * its profile names an interrupt key (`keys.interrupt`) and is not revoked at the binary's version.
   * The phone draws the belt's Stop only with it, and only while the turn runs. Absent otherwise, on a
   * program pane and from every older bridge.
   */
  canStop?: true;
  /**
   * Present (and `true`) when a send on this pane may steer the running turn (M69): the pane carries
   * `sendProtocol`, its harness's profile names a steer key (`keys.steer`), the binary's version may be
   * trusted with a turn, and the pane is no program's (a durable pane never steers). The phone offers
   * Steer on the Send button's long press only then. Absent otherwise, and from an older bridge.
   */
  canSteer?: true;
  /**
   * The pane's held sends (M56 spec 15), oldest first: what the harness could not take during its turn
   * and Collie sends once the pane reads free, plus ended ones whose text waits for a Resend. Present
   * only when there is at least one; the text takes the mirror's mask like a title does.
   */
  held?: HeldRow[];
};

/** The icon names a program may give a belt action. The phone maps each to one of its own glyphs. */
export const PANE_ACTION_ICONS = ["play", "pause", "check", "x", "refresh", "archive", "flag", "star", "send", "note", "search", "more"] as const;
export type PaneActionIcon = (typeof PANE_ACTION_ICONS)[number];

/** One button of a durable program's section of the belt. `label` is at most 16 characters. */
export interface PaneAction {
  id: string;
  label: string;
  icon?: PaneActionIcon;
  /** Running now: the phone shows a spinner and sends no second tap. */
  busy?: true;
  /** Not available now: the phone dims it and sends no tap. */
  disabled?: true;
}

/** What a person may choose on an ask (WIRE.md section 4). */
export interface AskOption {
  /** Unique inside its ask. Sent back unchanged as `optionId` (or in `optionIds`, or as a form value). */
  id: string;
  label: string;
  /** On a `permission` option only. A `choice` option, and an option of a form field, has none. */
  effect?: "allow" | "allow-always" | "deny" | "cancel";
}

/** One field of a `form` ask (WIRE.md section 7.14). */
export interface AskField {
  /** Unique inside its ask. The key of the field's value in the answer. */
  id: string;
  label: string;
  kind: "text" | "choice" | "toggle";
  required?: true;
  /** A `choice` field: 1 to 8 options. A pick answers with the option's id. */
  options?: AskOption[];
  /** A `text` field: 1 to 2000 characters. */
  maxLength?: number;
}

/** The tool call an ask is about, when the program wants it drawn. */
export interface AskTool {
  name: string;
  /** One line: the arguments, shortened. */
  summary: string;
  output?: string;
}

/**
 * One open ask, as the phone draws it (ADR 0100). Every string was cleaned and capped by the adapter
 * that read it (WIRE.md section 6), and every id is sent back unchanged, never shown.
 */
export interface Ask {
  /** New after every restart of the program, even for the same tool call. */
  id: string;
  /**
   * `permission`, `choice`, `text` or `form` (WIRE.md section 7.14). A card for any other kind (a program
   * newer than this build) is not answerable.
   */
  kind: string;
  /** The program's id for the tool call. The same across a restart; the push guard keys on it. */
  toolCallId: string;
  /** Starts at 1 and rises when the program changes this ask in place. Sent back as `revision`. */
  revision: number;
  /** One line the card leads with. */
  title: string;
  /** The item the card sits under, usually the tool item. */
  itemId: string;
  /**
   * A `permission` ask: one to six, each with an effect. A `choice` ask: one to eight, none with an effect.
   * A `text` and a `form` ask: none. An ask that needs options and has none is shown as not answerable.
   */
  options: AskOption[];
  /** A `choice` ask only: more than one option may be picked. */
  multiple?: true;
  /** A `text` ask only: the hint in the empty field. */
  placeholder?: string;
  /** A `text` ask only: 1 to 2000 characters (500 when the program named none). */
  maxLength?: number;
  /** A `form` ask only: one to six fields. A form with none is shown as not answerable. */
  fields?: AskField[];
  reason?: string;
  tool?: AskTool;
  /**
   * Present when the adapter's cleaning cut or changed the title or the reason (WIRE.md section 6).
   * The card says the text was shortened and offers no `allow-always` on such an ask.
   */
  cleaned?: true;
  /**
   * The words the program chose for a notification about this ask (WIRE.md section 6). The bridge MAY use
   * them for a push and falls back to its own text. Cleaned by the adapter; a lead cleans them again.
   */
  push?: AskPushText;
  /**
   * When the ask stops waiting, ISO 8601 (WIRE.md 7.3), as the program sent it. Absent: it waits for a person.
   * The phone shows the time left; past it the program decides the ask by `timeout`.
   */
  expiresAt?: string;
}

/**
 * Who decided an ask first, and when (WIRE.md 7.3, the 409 `decided` body). `phone`: an answer from a phone,
 * `program`: the program itself, `timeout`: the ask's `expiresAt` passed. `at` is ISO 8601.
 */
export interface AskDecided {
  by: "phone" | "program" | "timeout";
  at: string;
}

/** A push title (60 characters at most) and line (120 at most) a program chose for an ask. */
export interface AskPushText {
  title?: string;
  line?: string;
}

/**
 * `POST /api/pane/:id/answer`'s body, as the bridge reads it (ADR 0100). `requestId` is a UUID the
 * phone mints per tap; a retry of the same tap sends the same one.
 */
export type AnswerRequest = AnswerBase & AnswerPayload;

interface AnswerBase {
  requestId: string;
  askId: string;
  /** The revision the phone saw. */
  revision: number;
}

/** What a form answers: a field's id to its value, a string for a text or choice field and a boolean for a toggle. */
export type AnswerValues = Record<string, string | string[] | boolean>;

/**
 * What the person chose, by the kind of the ask (WIRE.md section 7.14). Exactly one key names the shape:
 * `optionId` for a `permission`, `optionIds` for a `choice` (one when it is not `multiple`), `text` for a
 * `text` ask and `values` for a `form`.
 */
export type AnswerPayload =
  | { optionId: string; note?: string }
  | { optionIds: string[] }
  | { text: string }
  | { values: AnswerValues };

/**
 * What `POST /api/pane/:id/answer` answers, one shape for every outcome (ADR 0100).
 *
 *  • `taken` (200): the program took the answer and closed the ask.
 *  • `too-late` (200): the ask is not open any more (answered, stopped, or from before a restart).
 *    `decided` says who decided it first and when, when the program said so (a 409 `decided`).
 *  • `stale` (409): the ask changed since the phone read it. `ask` is its current form when the
 *    program sent one. Nothing ran.
 *  • `unknown` (504): the answer may or may not have reached the program. The receipt stays, so
 *    "Try again" with the SAME request id replays rather than answers twice.
 *  • `maybe-applied` (200): an earlier try with this request id had an unknown outcome, and this
 *    retry found the ask closed or changed. The first try may be what closed it, so the phone says
 *    "may already be applied, check the chat" instead of an error.
 *  • `refused` (409): nothing ran, and the same request would be refused again. `reason` is the
 *    mux refusal's word (ADR 0022): `unsupported` when this pane takes no answers at all, or
 *    `request-id-reused` when this request id was already used for another answer.
 *
 * `replayed: true` marks an answer read off the receipt of an earlier request with this id.
 */
export type AnswerResponse =
  | { ok: true; outcome: "taken"; replayed?: true }
  | { ok: false; outcome: "too-late"; decided?: AskDecided; replayed?: true }
  | { ok: false; outcome: "stale"; ask?: Ask; replayed?: true }
  | { ok: false; outcome: "unknown"; detail: string }
  | { ok: false; outcome: "maybe-applied"; replayed?: true }
  | { ok: false; outcome: "refused"; reason: "unsupported" | "refused" | "request-id-reused"; detail: string; replayed?: true };

/**
 * `POST /api/pane/:id/send`'s body (ADR 0101). Exactly one of `turnId` and `askId`: the turn the
 * phone last showed, or an open ask it answers inside. `requestId` is a UUID the phone mints per
 * intent; a retry of the same intent sends the same one. `text` is 1 to 32768 UTF-8 bytes.
 */
export interface SendRequest {
  requestId: string;
  text: string;
  /** While a turn runs: join it (true) or wait for the next turn (false, the default). */
  steer?: boolean;
  turnId?: string;
  askId?: string;
}

/** `POST /api/pane/:id/abort`'s body (ADR 0101). Exactly one of `turnId` and `askId`. */
export interface AbortRequest {
  requestId: string;
  turnId?: string;
  askId?: string;
}

/**
 * `POST /api/pane/:id/action`'s body (M53 spec 07). `turnId` is optional: a button belongs to the pane,
 * and a phone that names the turn it saw gets `stale` when the turn has moved.
 */
export interface ActionRequest {
  requestId: string;
  actionId: string;
  turnId?: string;
}

/** What a control names: the turn the phone saw, or an open ask. Never both, never neither. */
export type ControlTarget = { readonly kind: "turn"; readonly id: string } | { readonly kind: "ask"; readonly id: string };

/** A send, an abort or a belt action, as the bridge reads it off the phone's body and hands it to the adapter. */
export type ControlRequest =
  | { readonly act: "send"; readonly requestId: string; readonly target: ControlTarget; readonly text: string; readonly steer: boolean }
  | { readonly act: "abort"; readonly requestId: string; readonly target: ControlTarget }
  | { readonly act: "action"; readonly requestId: string; readonly actionId: string; readonly turnId?: string };

/**
 * What `POST /api/pane/:id/send` and `/abort` answer, one shape for both (ADR 0101).
 *
 *  • `ok` (200): the program accepted the act. It answers when it took it, not when the turn ends.
 *  • `stale` (409): the turn named is not the newest one, or the ask is not open. Nothing ran.
 *    `turnId` and `askIds` are what is current, so the phone can reload and show what changed.
 *  • `unknown` (504): the act may or may not have reached the program. The receipt stays, so
 *    "Try again" with the SAME request id replays rather than acts twice.
 *  • `maybe-applied` (200): an earlier try with this request id had an unknown outcome, and this
 *    retry found the turn moved on. The first try may be what moved it, so the phone says "may
 *    already be applied, check the chat" instead of an error.
 *  • `refused` (409): nothing ran, and the same request would be refused again. `reason` is the
 *    mux refusal's word (ADR 0022): `unsupported` when this pane or program cannot take the act, or
 *    `request-id-reused` when this request id was already used for another send or stop.
 *
 * `replayed: true` marks an outcome read off the receipt of an earlier request with this id, or a
 * program that said it saw this request id before.
 */
export type ControlResponse =
  | { ok: true; outcome: "ok"; replayed?: true }
  | { ok: false; outcome: "stale"; turnId: string; askIds: string[]; replayed?: true }
  | { ok: false; outcome: "unknown"; detail: string }
  | { ok: false; outcome: "maybe-applied"; replayed?: true }
  | { ok: false; outcome: "refused"; reason: "unsupported" | "refused" | "request-id-reused"; detail: string; replayed?: true };

/**
 * Strip a pane down to its wire shape. The one place the session ref leaves the bridge's hands.
 *
 * `hasJournal` is asked rather than assumed: a harness can name a session while having no adapter to
 * read it (Herdr detects more agents than Collie has journals for). Keying the flag on the ref alone
 * would advertise a History affordance that always comes back empty, so the registry gets a vote.
 */
/**
 * Which harness's journal adapter reads THIS pane's transcript.
 *
 * The pane's own agent, all but one time. The exception is the pane whose agent EXITED: it reads as
 * a shell again (its beacon expired — `bridge/beacon/decorate.ts`), and the conversation it left is
 * still on disk under the harness that wrote it. Asking `agent` alone would answer `"shell"` and
 * lose a readable log the moment the process ended.
 *
 * It is a LOOKUP KEY and nothing else. Nothing display-facing may be derived from it — `toPaneWire`
 * deliberately keys `hasSession` off `agent`, so a dead agent's pane offers no History affordance
 * and reads exactly like every other shell pane.
 */
export function journalAgentOf(pane: AgentView): string {
  return pane.sessionAgent ?? pane.agent;
}

/**
 * The wire form of one pane: server-only fields stripped, the History affordance decided.
 *
 * `hasSession` answers "may this pane have history": its harness has a journal adapter AND a
 * session is addressable — reported on the pane record, or discoverable by an adapter that finds
 * its own (`JournalAdapter.discover`). Keyed off the live `agent` either way, so an exited
 * agent's pane still offers no affordance and reads like every other shell pane.
 *
 * `instance` is the pane's walky talky instance token, from the bridge's instance registry; absent,
 * the wire carries no `instance` key.
 */
export function toPaneWire(
  pane: AgentView,
  hasJournal: (agent: string) => boolean,
  discoversSessions: (agent: string) => boolean = () => false,
  instance?: string,
): PaneWire {
  const { agentSession, sessionAgent: _sessionAgent, ...rest } = pane;
  const addressable = agentSession !== undefined || discoversSessions(pane.agent);
  const wire: PaneWire = addressable && hasJournal(pane.agent) ? { ...rest, hasSession: true } : rest;
  return instance === undefined ? wire : { ...wire, instance };
}

/** A Herdr workspace ("space") — a project-scoped container of tabs. From `workspace.list`. */
export interface WorkspaceView {
  workspaceId: string;
  number: number;
  label: string;
  /** Whether this is the focused workspace in the desktop TUI (read-only; we never set focus). */
  focused: boolean;
  activeTabId: string;
  tabCount: number;
  paneCount: number;
  /**
   * The Git repo this space sits in, when the multiplexer reports one (MuxSpace.repoRoot).
   *
   * Absent means "no repo here, or this multiplexer does not keep the mapping" — the phone reads
   * absence as "no worktree rows", which is the fail-closed direction and needs no extra call.
   */
  repoRoot?: string;
  /**
   * Whether this space is a linked worktree of `repoRoot` rather than the repo's own checkout.
   *
   * Travels with `repoRoot` and is absent wherever that is. It is what lets the spaces list nest a
   * worktree under the space showing the repo itself.
   */
  isWorktree?: boolean;
  /**
   * The space's own folder, when the multiplexer keeps one (MuxSpace.folder): herdr's worktree
   * checkout, tmux's `session_path`. Absent otherwise. The Changes view prefers it as its root
   * (bridge/changes-root.ts); without it the root is the panes' common folder.
   */
  folder?: string;
  /**
   * Which member of the crew this space lives on — the same tag panes and sessions carry.
   *
   * **Present exactly when {@link SnapshotResponse.servers} is**, and absent otherwise (§11), so a
   * solo body is unchanged to the byte. It is not decoration: Herdr numbers spaces PER MACHINE, so
   * two default installs both call theirs `w1` and a merged list keyed on `workspaceId` alone
   * collapses them into one row carrying one machine's counts. The identity of a space in a crew is
   * `(host, workspaceId)`, and every join against a pane must use both halves.
   */
  host?: string;
}

/** A tab within a workspace (a layout/view holding one or more panes). From `tab.list`. */
export interface TabView {
  tabId: string;
  workspaceId: string;
  number: number;
  label: string;
  focused: boolean;
  paneCount: number;
  /**
   * Which member of the crew this tab lives on — see {@link WorkspaceView.host}, which this mirrors
   * exactly. A tab id is `w1:t1` on every default install, so `(host, tabId)` is the identity, and
   * `(host, workspaceId)` is the parent it belongs to.
   */
  host?: string;
}

export type BridgeStatus = "connected" | "disconnected";

/**
 * Why the multiplexer refused the last read, when the phone can say it in words (M50 spec 14). Only one
 * today: a durable program over HTTPS that answered 401 or 403 to the peer's bearer token. Every other
 * failure stays the plain `disconnected`, which the phone already words.
 */
export type MuxFault = "token-refused";

/**
 * The fault a failed read's message names, or undefined. The durable HTTPS client starts the detail of a
 * refused token with `token-refused` (bridge/mux/durable/http-client.ts `TOKEN_REFUSED`), and the
 * adapter throws that detail as the message of a failed `snapshot()`.
 */
export function muxFaultOf(message: string): MuxFault | undefined {
  return message.startsWith("token-refused") ? "token-refused" : undefined;
}

/**
 * One entry in the snapshot's `sessions` list — a herdr session this bridge fronts. Additive: a
 * single-session deployment reports exactly one (the primary), so nothing about the UI changes.
 */
export interface SessionSummary {
  /** Registry name, e.g. "default" or "collie-demo". Client passes this back as `?session=`. */
  name: string;
  /**
   * The operator's display label from `sessions.toml` (bridge/operator-session-labels.ts), already
   * cleaned of controls and capped. Display-only: {@link name} stays the identity. Absent when the
   * operator gave this session none, so an install without the file sends the bytes it always did.
   */
  label?: string;
  /** The session cfg.socketPath points at — all pre-multi-session behaviour maps to it. */
  isPrimary: boolean;
  /** Whether this session's last poll succeeded (a stale/unreachable socket reads false). */
  reachable: boolean;
  /** Agent-pane count (0 when unreachable). */
  agents: number;
  /** Agent panes currently working / blocked (0 when unreachable). */
  working: number;
  blocked: number;
  /**
   * Which member of the crew fronts this session — the `?h=` value (CREW_PROTOCOL.md §4).
   *
   * **Present exactly when {@link SnapshotResponse.servers} is**, and absent otherwise. A solo
   * instance emits neither (§11: "no `host` field is added to sessions or panes"), so a session name
   * on a solo snapshot means what it has always meant. The lead stamps this from the registry key it
   * dialled; a peer never asserts its own (see `parsePeerSnapshot`).
   */
  host?: string;
}

/** Whether a session answers (M55): a program says `starting` until it is ready. */
export type SessionState = "ready" | "starting" | "unreachable";

/**
 * One session's card (M55, the shared contract). Carried on every entry of the snapshot's `sessions`
 * on an instance that runs a durable program (`sources.json`), and on the crew `hello` as
 * `sessions`. An instance with no program carries none, so its bytes are what they were.
 */
export interface SessionCard {
  name: string;
  kind: "terminal" | "program";
  /** herdr, tmux, zellij, tuios, tern, or the program's hello `host.name` cleaned, else "durable". */
  mux: string;
  /** The capability set of this session, the same shape `/api/config` answers today. */
  caps: Record<string, boolean>;
  where: "local" | "remote";
  state: SessionState;
  experimental: boolean;
  /**
   * A program only, and only while it is refused for its wire version (WIRE.md section 2): the one sentence
   * that says why, for example "The durable agent speaks wire v2, this Collie speaks v1. Update Collie, or the agent's SDK." Absent
   * everywhere else.
   */
  notice?: string;
}

/** One entry of the snapshot's `sessions`: the summary, with the card when the instance runs a program. */
export type SessionEntry = SessionSummary | (SessionSummary & SessionCard);

/**
 * Per-device authorisation state for the requesting client (see `deviceAuth()` in server.ts).
 * Reported in the snapshot so the UI can show a read-only state. Optional on the wire so an older
 * bridge (or a response from before the feature existed) simply reads as "not enforced".
 */
export interface DeviceAuth {
  /** Whether per-device authorisation is enforced at all (COLLIE_DEVICE_HEADER is set). */
  enforced: boolean;
  /** The opaque device identifier from the trusted header, or null if absent / feature off. */
  device: string | null;
  /** Whether this device may perform sensitive (terminal-driving / structural) actions. */
  authorized: boolean;
}

// ── REST response shapes (the browser polls these; see server.ts) ──────────────

/** GET /api/snapshot — the current herd view. */
export interface SnapshotResponse {
  bridge: BridgeStatus;
  /**
   * Why the multiplexer is down, when the phone can say it (M50 spec 14). Present only while `bridge`
   * is `disconnected` for that cause, so every other body, and its ETag, is unchanged.
   */
  muxFault?: MuxFault;
  /** Per-device authorisation for the requesting client; absent when the feature is off. */
  device?: DeviceAuth;
  /** Agent-bearing panes, in place order: space, tab, position in the tab. Never by status (ADR 0063). */
  agents: PaneWire[];
  /** Bare shell panes (no agent) — surfaced so freshly-created tabs/spaces are reachable. */
  shellPanes: PaneWire[];
  /** All spaces (workspaces) and their tabs, for the space/tab navigator. */
  workspaces: WorkspaceView[];
  tabs: TabView[];
  /**
   * Every herdr session this bridge fronts (primary first, then alphabetical). Always present; a
   * single-session deployment lists just the primary, so the switcher UI can stay hidden.
   */
  sessions: SessionEntry[];
  /**
   * Every member of the crew, the lead's own entry included (CREW_PROTOCOL.md §9.2).
   *
   * **Optional-and-absent, following `update?` rather than the always-present `sessions`** — and the
   * choice is forced, not stylistic (§11). An always-present field, even an empty array, changes
   * every solo snapshot body and therefore every solo snapshot ETag exactly once: one forced refetch
   * for every solo user, bought for a uniformity nothing needs. Absent means "no crew", which is
   * precisely true. Present ⇒ `host` is stamped on every session and every pane; absent ⇒ on none.
   */
  servers?: ServerSummary[];
  /** Notification quiet-hours: the active snooze deadline (epoch ms) or null. */
  notifications?: { snoozedUntil: number | null };
  /** Update-availability signal. Optional — a stale bridge that predates the field simply omits it,
   *  which the client reads as "no info" (see bridge/update.ts). */
  update?: UpdateStatus;
  ts: number;
}

/**
 * One member of the crew in the merged snapshot (CREW_PROTOCOL.md §9.2) — the row `crew status` and
 * the phone's host list render.
 *
 * `reachable` is not an invention: {@link SessionSummary.reachable} already models an unreachable
 * member as a *rendered state* with zeroed counts rather than a failed response. This is that
 * precedent one level up — a down peer degrades its entry, never the response (§10.2).
 */
export interface ServerSummary {
  /** Member id — the `?h=` value. The lead's own entry is present too. */
  id: string;
  /** Operator-chosen label. Today the member id itself, which is the `join` label slugified (§8.2). */
  name: string;
  isLead: boolean;
  /** Whether the lead's last poll of this member succeeded. Always true for the lead's own entry. */
  reachable: boolean;
  /** Version negotiation state (§7). `incompatible` is retried on a slow backoff, not the cadence. */
  protocol: "ok" | "incompatible" | "unknown";
  /** The peer's refusal reason, verbatim, when incompatible. */
  protocolDetail?: string;
  /**
   * §10.2's presentation split for a member that is not answering, exactly as
   * {@link CrewMemberStatus.linkState} carries it: `reconnecting` needs nothing of the operator,
   * `attention` does.
   *
   * Additive and optional (§7.1): omitted for a reachable member, and omitted by a lead that predates
   * the field. An absent value beside `reachable: false` therefore means "no distinction offered",
   * and the chip renders today's word.
   */
  linkState?: "reconnecting" | "attention";
  /**
   * Epoch ms, **stamped by the lead on receipt — never the peer's clock** (§10.2). The client
   * derives "stale since …" from it (stale once older than 3 × pollMs or 15 s, whichever is first);
   * `0` means this member has never answered.
   */
  lastSeenAt: number;
}

/**
 * GET /api/crew — what the RUNNING lead already knows about its own crew, for the phone's Crew
 * overview page. The read-only browser spelling of `collie crew status` (cli/crew.ts).
 *
 * **It is a report, never a probe.** Every field below is answered from state this process already
 * holds: the trust store it read at startup (`TrustStore.current()`, no disk touched per request)
 * and the {@link PeerState} the lead's existing sweep maintains (bridge/crew/registry.ts). Nothing
 * in this shape can make the lead dial a member — which is what lets a phone poll it beside the
 * snapshot without adding a second call rate to every peer (CREW_PROTOCOL.md §10.1, §11).
 *
 * **Only a lead answers it.** A solo instance and a peer 404 (`crew.not_lead`): a peer is not a
 * front door (ADR 0013), and a solo instance has no crew to describe.
 *
 * Nothing here is a secret. Fingerprints, certificates, the crew secret and pairing credentials are
 * absent by construction, exactly as {@link ServerSummary} keeps them off the snapshot.
 */
export interface CrewStatusResponse {
  /** The crew itself, as the trust store records it (`CrewIdentity`). */
  crew: { id: string; name: string; secretGeneration: number; rotatedAt: number };
  /** This lead. `version` per bridge/version.ts, the same string `hello` answers with. */
  self: { id: string; name: string; version: string };
  /**
   * The named deputy (ADR 0027), or null when none is named.
   *
   * The DESIGNATION is the source, never the warrant: after a takeover the new lead keeps a warrant
   * naming itself, so reading the deputy off it reports a lead as its own deputy (cli/
   * crew-status-deputy.ts says so at length). `warrantGeneration` is the generation of the warrant
   * this lead currently holds, and it is **nullable rather than omitted**: a designation with no
   * warrant behind it is a state the operator has to see, not a key to go missing.
   */
  deputy: { id: string; warrantGeneration: number | null } | null;
  /** The lead's own entry FIRST, then peers by member id — the exact order of `servers[]` (§9.2). */
  members: CrewMemberStatus[];
  /** The LEAD's clock, like every other timestamp the lead publishes (§10.2). */
  ts: number;
}

/**
 * One member's row on the Crew overview page.
 *
 * Mostly {@link PeerState} re-spelled for the browser, plus the three roster facts the registry does
 * not carry (`address`, `enrolledAt`, `secretBehind`). Optional keys are OMITTED when absent and
 * never sent as null (CREW_PROTOCOL.md §11) — the lead's own entry therefore carries no `address`
 * and no `enrolledAt`, because a lead is not in its own roster.
 */
export interface CrewMemberStatus {
  /** Member id — the same value `?h=` takes and `servers[].id` reports. */
  id: string;
  name: string;
  isLead: boolean;
  /** The enrolled address as stored — never re-derived, never probed. Omitted for the lead itself. */
  address?: string;
  /** Omitted for the lead, for the reason `address` is. */
  enrolledAt?: number;
  /** {@link PeerState.health} verbatim (§10.2, §18.10). The lead's own entry is always `reachable`. */
  health: "reachable" | "unreachable" | "incompatible" | "conflicted";
  /** {@link PeerState.reason}, verbatim and unparaphrased, when there is one. */
  reason?: string;
  /** The lead's receipt time of the last successful call; `0` = never (§10.2). */
  lastSeenAt: number;
  /** What this member last reported, over the sweep or over `hello` (§7.1, §19), when it has. */
  version?: string;
  /** This member has not picked up the current crew secret (§8.4). False for the lead. */
  secretBehind: boolean;
  /** Enrolled but never once reachable — the shape a half-finished join takes (§8.2). */
  provisional: boolean;
  /** Who a `conflicted` member says it follows instead (§18.10). Present only in that state. */
  conflict?: { leadMemberId: string; warrantGeneration: number | null };
  /**
   * {@link PeerState.linkState} — §10.2's **presentation split**, and NOT a fifth value of `health`.
   *
   * `reconnecting` says the lead is retrying inside its budget and the operator does nothing.
   * `attention` says re-dialling cannot fix this and the operator must look.
   *
   * **Omitted whenever there is nothing to say**, which is every reachable member — and omitted by a
   * lead older than this field, so an absent value on a member that is NOT reachable means "this lead
   * does not make the distinction" and the page renders today's single word (§7.1).
   */
  linkState?: "reconnecting" | "attention";
}

// ── Machines: every machine's load, kept by the lead (ADR 0084) ──────────────────
//
// The wire of `GET /api/machines`, `GET /api/machines/:id/history` and `POST /api/machines/:id/alerts`,
// and of the `machineStats` sibling a peer adds to its `/crew/v1/snapshot` answer (CREW_PROTOCOL.md
// §5). Fractions are 0..1, bytes are plain numbers, and every time is epoch ms on the clock of the
// bridge that answered. Optional keys are OMITTED when absent, never sent as null.

/** One reading of one machine. See `bridge/machine-stats.ts` for where each number comes from. */
export interface MachineSample {
  /** Busy fraction of all cores since the previous reading. */
  cpu: number;
  cores: number;
  /** Bytes in use, not counting reclaimable cache where the platform says how much that is. */
  memUsed: number;
  memTotal: number;
  /** The one-minute load average. Absent on Windows, where there is none. */
  load1?: number;
  /**
   * Received bytes per second over the physical interfaces (`isSkippedInterface` in
   * bridge/machine-stats.ts leaves out loopback, bridges, veth ends and tunnels). Absent without counters.
   */
  rxBps?: number;
  txBps?: number;
  /**
   * The filesystems that hold the home folder, the root (on Windows the system drive) and Collie's
   * state folder, one per device, at most four, read at most once a minute (bridge/machine-disks.ts).
   * Absent: not reported (an older member, or no filesystem qualified).
   */
  disks?: MachineDisk[];
}

/**
 * One filesystem. `used` is `df`'s Used and `total` is `used` plus the space an unprivileged process
 * can still write, so `used / total` is `df`'s Use%. Bytes. `mount` is the label to show: `/var/home`,
 * `/`, `C:`.
 */
export type MachineDisk = {
  mount: string;
  used: number;
  total: number;
};

/** The metrics an alert can watch. CPU is judged on the minute's average, disk on the fullest filesystem. */
export type AlertMetric = "cpu" | "mem" | "disk";

/** Push when the metric stays at or above `above` (0.5..0.99) for `forMin` minutes (5..120). */
export interface AlertRule {
  above: number;
  forMin: number;
}

/** One machine's rules. A missing key is no rule for that metric. */
export interface MachineAlerts {
  cpu?: AlertRule;
  mem?: AlertRule;
  disk?: AlertRule;
}

/** One machine on `GET /api/machines`. The lead first, then members in member-id order. */
export interface MachineRow {
  /** Member id, the value `?h=` takes. A solo collie that never enrolled is `local`. */
  id: string;
  name: string;
  /** True for the machine answering. A solo collie's one row is `isLead: true`. */
  isLead: boolean;
  /** {@link CrewMemberStatus.health}, the same four words. */
  health: "reachable" | "unreachable" | "incompatible" | "conflicted";
  /** The last sample held. Absent: not reported yet, or a member older than the field. */
  sample?: MachineSample;
  /** When the answering bridge took or received that sample. Present exactly when `sample` is. */
  sampledAt?: number;
  alerts: MachineAlerts;
  /** The metrics whose alert episode is open now. */
  firing: AlertMetric[];
  /**
   * The last complete minutes of CPU and memory, for a small chart. Present only when the request
   * asked for it (`GET /api/machines?spark=N`) and the lead holds at least one of those minutes.
   */
  spark?: MachineSpark;
}

/**
 * A small chart's data: one value per complete minute, oldest first, the newest being the minute
 * before the one the answer's `ts` falls in. Fractions to two places, `null` for a minute with no
 * reading. At most the minutes asked for; minutes before the first reading are left out.
 */
export interface MachineSpark {
  stepMs: 60000;
  cpu: (number | null)[];
  mem: (number | null)[];
}

/** `GET /api/machines`. */
export interface MachinesResponse {
  ts: number;
  machines: MachineRow[];
}

/**
 * One minute of history: `[t, cpuAvg, cpuMax, memFrac, rxBps | null, txBps | null, diskFrac | null]`.
 * `t` is the minute's start, the fractions are rounded to three places and the rates to whole bytes
 * per second. `diskFrac` is the fullest filesystem's fraction, `null` where no disk was reported; a
 * reader older than the field sees six elements and ignores the seventh. A minute with no reading is
 * simply missing from the list.
 */
export type MachineHistoryPoint = [number, number, number, number, number | null, number | null, number | null];

/**
 * `GET /api/machines/:id/history`. Oldest first, at most 1440 points, one per minute. With
 * `?since=<ms>`, only the minutes starting at or after it.
 */
export interface MachineHistoryResponse {
  ts: number;
  stepMs: 60000;
  points: MachineHistoryPoint[];
}

/** `POST /api/machines/:id/alerts`. The rules as stored after the write. */
export interface MachineAlertsResponse {
  alerts: MachineAlerts;
}

/**
 * The crew wire version this release moves to, and the one this install speaks (M27/06).
 *
 * `from` is this install's own `CREW_PROTOCOL_VERSION`; `to` is the number the newest release
 * published in its `collie-release.json` asset. Both are present or the whole field is null: the
 * notice is about a DIFFERENCE, and half of one says nothing.
 */
export interface UpdateLinkChange {
  from: number;
  to: number;
}

/**
 * A release in the delta that asked to reach operators today (ADR 0046).
 *
 * `version` is the NEWEST release in the delta that carried the marker, and `reason` is that
 * release's own sentence, written by the person who cut it and read from its `collie-release.json`.
 * The reason is the release's English and is never translated: it is a quotation, not a label.
 */
export interface UpdateUrgent {
  version: string;
  reason: string;
}

/**
 * GET /api/snapshot `update` — whether the running plugin is behind (see bridge/update.ts). Both a
 * newer upstream RELEASE (`releaseAvailable` + `latest`) and a rebuilt-but-not-restarted bridge
 * PROCESS (`bridgeStale`) surface here; the client shows one banner, `bridgeStale` taking precedence.
 */
export interface UpdateStatus {
  /** The running bridge/plugin version, captured at process start. */
  current: string;
  /** Newest upstream release (dotted `X.Y.Z`, no leading `v`), or null if unknown/none yet. */
  latest: string | null;
  /** GitHub release page for `latest` (the banner links to it), or null when `latest` is unknown. */
  latestUrl: string | null;
  /** `latest` is strictly newer than `current`. */
  releaseAvailable: boolean;
  /**
   * Newest release of a major ABOVE the running one (dotted `X.Y.Z`), or null. Reported apart from
   * `latest` because a routine `update` never crosses a major — the crossing is consented to by
   * `update --major` (ADR 0020), and the banner names that command instead.
   */
  majorAvailable: string | null;
  /** GitHub release page for `majorAvailable`, or null when there is none. */
  majorUrl: string | null;
  /**
   * How this Collie is installed (`cli/install-kind.ts`'s classifier, flattened to its kind) — the
   * banner's command spelling is a function of it: Herdr actions reach only a Herdr-managed
   * (detached) checkout; every other kind is told the `collie` verbs (M14/01 §5.3).
   */
  installKind: "linked-clone" | "detached-checkout" | "binary" | "packaged" | "unknown";
  /**
   * The package manager's own upgrade command for this machine, when the resolved root names a
   * manager Collie recognises (`cli/package-command.ts`). Absent on every other kind, and absent on
   * a packaged install under a prefix nobody recognises — there the boundary sentence stands alone.
   *
   * **Resolved on the HOST, once, at boot.** The prefix is a fact about this machine, and a second
   * derivation on the phone would be a second thing to drift.
   */
  packageCommand?: string;
  /**
   * The release whose OFFER the operator closed, or null when none was closed.
   *
   * It is the BRIDGE's fact, not a browser's: a dismissal is a decision about this machine's
   * update, so it holds on every screen that polls this snapshot (M17/08). Keyed by version — a
   * newer release is a different fact and raises the band again.
   */
  dismissedVersion: string | null;
  /**
   * The version whose quiet CREW notice the operator closed, or null.
   *
   * Two decisions, two fields. "A release is available here" and "that machine is standing behind,
   * and a package manager owns it" are about different machines, so putting one down must not put
   * the other down with it, even when both name the same version.
   */
  dismissedCrewVersion: string | null;
  /**
   * When the crew notice above was closed, epoch ms on this machine's clock (1.21.1). Absent when
   * none was, or when the close was written before the stamp existed.
   *
   * It is what lets a close cover ONE run: a crew run that settles after it is a new run of the
   * same version, and the band may name its failure again. Absent reads as "covers every run of
   * that version", which is what a close made before the stamp meant.
   */
  dismissedCrewAt?: number;
  /** The running process is behind the on-disk bridge source — needs `systemctl --user restart collie`. */
  bridgeStale: boolean;
  /**
   * The collie on disk is no longer the collie this process is running.
   *
   * Only a package manager can produce it: every other kind swaps files through Collie's own
   * updater, which restarts the service as its last act. `pacman -Syu` replaces the root under a
   * live process, and `collieVersion()` re-reads from disk on every call — so without this the
   * bridge would answer with the NEW version while running the OLD code, on `/api/health`, on
   * `hello` and therefore on the crew wire, where a lead reads it as "that peer already levelled".
   *
   * TWO witnesses, either of which raises it: the version files stopped naming what this process
   * runs, and — on a single-file install under Linux — the executable behind `/proc/self/exe` was
   * replaced (`bridge/exe-replaced.ts`). The second is what catches a package REBUILD of the same
   * version, where no version string moves at all and the first sees nothing.
   *
   * While it is raised, what this process puts ON THE CREW WIRE stays the version captured at boot:
   * stale but true, never new but false.
   */
  restartNeeded: boolean;
  /** The command that clears {@link restartNeeded}, spelled for the install kind. Absent when
   *  nothing needs restarting. */
  restartCommand?: string;
  /** When the upstream check last completed (epoch ms), or null if it hasn't run yet. */
  checkedAt: number | null;
  /**
   * Every release newer than the running one, oldest first — the same list the daily digest names.
   *
   * The update card lists them so the operator can see WHAT they are about to fold in, rather than
   * only the top of the pile. Versions and nothing else: the phone never fetches release notes from
   * GitHub. The HOST reads each release's small `collie-release.json` sidecar — that is where
   * {@link linkChange} and {@link urgent} come from — and what is not already on this wire is not
   * shown (M15/05, ADR 0046).
   */
  newerVersions?: string[];
  /**
   * This machine's release line (M60 spec 01, ADR 0110): `stable`, ADR 0020's strict releases, or
   * `edge`, which adds the `-edge.N` pre-releases. Absent on an older bridge, which is Stable.
   */
  line?: "stable" | "edge";
  /**
   * BACK TO STABLE, case 2 (M60 spec 01): this machine is on Stable, runs an Edge build, and no
   * Stable release is at or above it. `to` is the newest Stable below it, the target of "Go back
   * now". `exceptions` names every state file that build cannot read (ADR 0110; empty by rule), which
   * the page shows before the button. Absent in every other case.
   */
  back?: { to: string; exceptions: string[] };
  /**
   * The detached updater's run record (`<state dir>/update.json`, M15/04) — read from disk on every
   * snapshot, so a bridge that has just been restarted BY an update reports the run it is part of
   * instead of coming up with nothing to say. Absent when this install has never updated through the
   * runner. The staleness rule is applied before it gets here: a run nobody is driving reads as
   * `interrupted`, never as still in flight.
   */
  run?: UpdateRun;
  /**
   * The newest release changes the CREW LINK, and by how much — or null when it does not (M27/06).
   *
   * Null on a solo install (there is no link to change), null when the release speaks the wire this
   * install already speaks, and null when the release says nothing about it: every release before
   * 1.8.0 published no `collie-release.json`, and a release that cannot be read reads as no change
   * rather than as a warning nobody can act on.
   *
   * It is a generic reading of a NUMBER, never a hard-coded release name, so the release after the
   * next one says it too without a line of code moving.
   *
   * OPTIONAL, and absent rather than null when there is nothing to say — the reason `run` and
   * `packageCommand` are: a solo instance's snapshot must stay byte-identical to what it always was
   * (`bridge/solo-baseline.test.ts`), and a solo instance never has a link change.
   */
  linkChange?: UpdateLinkChange | null;
  /**
   * The newest release in the delta that called itself urgent, and why (ADR 0046).
   *
   * An urgent release is an ordinary release on every axis but one: it keeps the DAILY digest
   * cadence even when the delta is patches only. The surfaces print a short label and the sentence,
   * so the operator reads why before they decide.
   *
   * OPTIONAL and ABSENT when there is nothing to say, the rule `run` and `linkChange` follow: no
   * release in the delta carried the marker, the sidecars could not be read, or no check has run.
   */
  urgent?: UpdateUrgent;
}

/** GET /api/pane/:id — recent terminal output for one agent (ANSI/SGR, rendered colored). */
export interface PaneReadResponse {
  paneId: string;
  text: string;
  truncated: boolean;
  /** Herdr's monotonic pane revision — passed through for the client's prompt-select race guard. */
  revision: number;
  /**
   * The same rows with soft wraps undone, present only when the grid shows a URL the pane's width
   * cut in two (`hasSplitUrl`). The mirror keeps rendering `text`; the client uses this to give the
   * fragments of one URL the href of the whole URL. ABSENT rather than empty when there is nothing
   * to repair — the payload stays byte-identical to what it was for every other pane.
   */
  logicalText?: string;
}

/**
 * GET /api/pane/:id/history — real conversation history for a pane, read from the agent's own
 * session log. This is NOT terminal scrollback: a Claude pane runs on the alternate screen, so no
 * scrollback exists to page (see transcript.ts). `available:false` is the normal answer for a pane
 * with no agent session, a non-Claude agent, or a bridge with the feature switched off.
 */
export type PaneHistoryResponse =
  | { paneId: string; available: false; reason: "disabled" | "no-session" | "no-log" }
  | {
      paneId: string;
      available: true;
      /** Oldest-first, ready to render top-down. */
      entries: TranscriptEntry[];
      /** Older turns exist before `entries[0]` — page with `?before=<its uuid>`. */
      hasMore: boolean;
      /** Turns available in the parsed window. */
      total: number;
      /** The log exceeded the read cap, so only its tail was parsed. */
      fileTruncated: boolean;
    };

/**
 * One conversation of a durable program's own list (M53 spec 11, WIRE.md 7.16). `paneId` is set on an open
 * conversation that is in the live layout: the pane that shows it.
 */
export interface DurableConversationRow {
  id: string;
  title: string;
  subtitle?: string;
  workspaceId?: string;
  tabId?: string;
  startedAt: string;
  endedAt?: string;
  state: "open" | "closed";
  items: number;
  paneId?: string;
}

/**
 * GET /api/durable/conversations?after=&limit=: the program's conversations, newest first, open and closed, at
 * most 100 a page; `next` absent is the last page. `available: false` is an ordinary answer: a multiplexer with
 * no program history (`unsupported`), or a program that cannot be asked now (`unreachable`).
 */
export type DurableConversationsResponse =
  | { available: true; items: DurableConversationRow[]; next?: string }
  | { available: false; reason: "unsupported" | "unreachable"; detail?: string };

/**
 * GET /api/durable/conversation/:id/items?after=&limit=: one conversation, oldest first, at most 1000 items a
 * page, read from the program and never from the bridge's log. `more: true` means ask again with `after=next`.
 * `gone` is a conversation the program does not know.
 */
export type DurableConversationItemsResponse =
  | { available: true; id: string; entries: TranscriptEntry[]; next?: string; more: boolean }
  | { available: false; reason: "unsupported" | "unreachable" | "gone"; detail?: string };

/** POST /api/durable/conversation/:id/reopen: the pane that shows the conversation again, when the next listing has it. */
export type ReopenConversationResponse =
  | { ok: true; paneId?: string }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };

/**
 * GET /api/pane/:id/chat — the same conversation as `history`, asked the other way round.
 *
 * `history` answers "show me this session" and pays a bounded whole-window read for it. This answers
 * "anything after this?", every poll, and costs the change: a session that gained one turn costs one
 * turn (bridge/journal/live.ts). The two share the grammar, the containment rule and the
 * `available:false` vocabulary, and they differ in exactly that question.
 *
 * The body is one of two shapes, told apart by `page`. `page:"live"` is the tail plus its three
 * positions; `page:"older"` is a backwards page off disk. Both carry `upserts`, because both are
 * "turns to put in the thread at their `seq`".
 *
 * **A member one release behind answers 404 to this route, and that is not an empty session.** The
 * route is additive-optional over the crew link (CREW_PROTOCOL.md §7.1), so a lead that has it and a
 * peer that does not is an ordinary version skew: the client must read a 404 here as "update this
 * member" and never as "this pane has nothing to show". `available:false` is the answer for a pane
 * with no session; a 404 is the answer for a bridge with no route.
 */
export type PaneChatResponse =
  | {
      paneId: string;
      available: false;
      reason: "disabled" | "no-session" | "no-log";
      /**
       * Why a `no-session` answer has no session, when the bridge knows a reason the person can act
       * on. `shared-folder`: another pane runs the same harness in the same folder, and this pane's
       * command line names no session, so Collie will not guess which log is this pane's (#508).
       * Additive-optional (CREW_PROTOCOL.md §7.1): absent on every other answer and from an older
       * member, and a phone that predates it reads the plain `no-session`.
       */
      detail?: "shared-folder";
    }
  | ({ paneId: string; available: true } & ChatBody);

/**
 * One changed file in a Changes list (ADR 0065). `status` is the file's state against HEAD, staged
 * and unstaged together: Modified, Added, Deleted, Renamed, or `?` untracked. An untracked FOLDER
 * (git lists one entry for a new folder under `--untracked-files=normal`) keeps its trailing `/`.
 */
export type ChangeStatus = "M" | "A" | "D" | "R" | "?";

export interface ChangedFile {
  /** Relative to the repo's top level, `/`-separated, exactly as git spelled it. */
  path: string;
  /** The old path of a rename. Absent otherwise. */
  oldPath?: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface ChangedRepo {
  /** Where the repo sits relative to the pane's folder: `.` (the folder itself), `..` style for a
   *  repo that contains the folder, or `sub/dir` for one found below it. The id a diff names. */
  relPath: string;
  /** The repo folder's own name, for display. */
  name: string;
  files: ChangedFile[];
}

/**
 * Why a Changes request has nothing to show. Ordinary answers, never errors. `no-workspace` is the
 * workspace route's `no-pane`: the id names no workspace in the snapshot.
 */
export type ChangesUnavailableReason = "no-pane" | "no-workspace" | "no-folder" | "no-git";

/**
 * The uncommitted changes under a workspace's folder, read-only (ADR 0065). Only repos with changes
 * are listed. `root` is the folder the list was read from; `truncated` means a discovery or listing
 * cap was reached, so the list may be incomplete. `depthLimited` means discovery stopped at the
 * asked depth with a repo one level further down, so a deeper setting would find more. Optional:
 * a bridge from before it sends none, which reads as false.
 */
export type ChangesList =
  | { available: false; reason: ChangesUnavailableReason }
  | {
      available: true;
      root: string;
      repos: ChangedRepo[];
      truncated: boolean;
      depthLimited?: boolean;
      /**
       * The discovered repos with nothing uncommitted and at least one commit: what the view offers
       * "Show last commit" for. Absent when there are none, and from a bridge that predates it.
       */
      clean?: CleanRepo[];
    };

/** A repo discovery found with no uncommitted changes and a HEAD commit to show. */
export interface CleanRepo {
  relPath: string;
  name: string;
}

/**
 * One file's diff against HEAD, as raw unified-diff text. The phone parses it. `diff` is empty for
 * a binary file and for an untracked folder.
 */
export type ChangeDiff =
  | { available: false; reason: ChangesUnavailableReason | "unknown-repo" | "unknown-path" }
  | {
      available: true;
      repo: string;
      path: string;
      oldPath?: string;
      status: ChangeStatus;
      binary: boolean;
      /** An untracked folder: git lists it as one entry and there is no single file to show. */
      directory: boolean;
      /** The diff hit a line or byte cap and was cut at a line boundary. */
      truncated: boolean;
      diff: string;
    };

/** The commit a commit view shows: always the repo's HEAD at the time of the read. */
export interface CommitInfo {
  /** The full object id. The view compares it across re-reads to notice a newer commit. */
  hash: string;
  shortHash: string;
  /** The message's first paragraph on one line, as `git log --format=%s` prints it. */
  subject: string;
  author: string;
  /** Author time, Unix seconds. */
  time: number;
}

/**
 * The last commit of one discovered repo, read-only (ADR 0065, the commit view): HEAD against its
 * first parent, or against the empty tree for a root commit. `files` carry `M`, `A`, `D` or `R`.
 * `no-commit` is a repo whose HEAD names no commit yet.
 */
export type ChangeCommit =
  | { available: false; reason: ChangesUnavailableReason | "unknown-repo" | "no-commit" }
  | { available: true; repo: string; name: string; commit: CommitInfo; files: ChangedFile[]; truncated: boolean };

/**
 * One file of the last commit. `hash` names the commit the diff was read from, so a view still
 * showing an older commit can tell the answer belongs to a newer one.
 */
export type ChangeCommitDiff =
  | { available: false; reason: ChangesUnavailableReason | "unknown-repo" | "unknown-path" | "no-commit" }
  | (Extract<ChangeDiff, { available: true }> & { hash: string });

/**
 * Which workspace a Changes answer covers, so the screen can say so. Present whenever the workspace
 * was found, including when the pane route fell back to the pane's own folder.
 */
export interface ChangesWorkspace {
  workspaceId?: string;
  workspaceLabel?: string;
}

/**
 * GET /api/pane/:id/changes — the list for the pane's WORKSPACE (bridge/changes-root.ts). `paneRepo`
 * is the `relPath` of the listed repo that holds the asking pane's folder, absent when that repo has
 * no changes; the view marks that group "this pane".
 */
export type PaneChangesResponse = { paneId: string; paneRepo?: string } & ChangesWorkspace & ChangesList;
/** GET /api/pane/:id/changes?repo=&path= — one file's diff in the pane's workspace. */
export type PaneChangeDiffResponse = { paneId: string } & ChangesWorkspace & ChangeDiff;
/** GET /api/workspace/:id/changes — the same list, asked by workspace. */
export type WorkspaceChangesResponse = { workspaceId: string; workspaceLabel?: string } & ChangesList;
/** GET /api/workspace/:id/changes?repo=&path= — the same diff, asked by workspace. */
export type WorkspaceChangeDiffResponse = { workspaceId: string; workspaceLabel?: string } & ChangeDiff;
/** GET /api/pane/:id/changes?view=commit&repo= — the last commit of one repo in the pane's workspace. */
export type PaneChangeCommitResponse = { paneId: string } & ChangesWorkspace & ChangeCommit;
/** GET /api/pane/:id/changes?view=commit&repo=&path= — one file of that commit. */
export type PaneChangeCommitDiffResponse = { paneId: string } & ChangesWorkspace & ChangeCommitDiff;
/** GET /api/workspace/:id/changes?view=commit&repo= — the same commit, asked by workspace. */
export type WorkspaceChangeCommitResponse = { workspaceId: string; workspaceLabel?: string } & ChangeCommit;
/** GET /api/workspace/:id/changes?view=commit&repo=&path= — the same file, asked by workspace. */
export type WorkspaceChangeCommitDiffResponse = { workspaceId: string; workspaceLabel?: string } & ChangeCommitDiff;

// ── The Files view (ADR 0083): one folder, or one text file, under the Changes root ──────────────

/**
 * One row of a Files listing. `link` is any symlink: it is listed and never followed by the listing.
 * `size` is present for a file only (the bytes on disk, from `lstat`). `ignored` is present, and
 * `true`, when git says the entry is ignored in the repository that holds the folder; absent means
 * not ignored OR not known (no repository, no git, a timeout, an older member). A view filter, never
 * a gate: an ignored file still reads.
 */
export interface FileEntry {
  name: string;
  kind: "dir" | "file" | "link";
  size?: number;
  ignored?: true;
}

/** Why a Files request has nothing to show: the Changes reasons, minus `no-git` (Files needs no git). */
export type FilesUnavailableReason = Exclude<ChangesUnavailableReason, "no-git">;

/**
 * One folder under the root, not recursive. `dir` is the folder relative to `root`, `/`-separated,
 * `""` for the root itself. Order: folders first, then by name, case-insensitive. `truncated` means
 * the folder held more than the entry cap.
 */
export type FilesListing =
  | { available: false; reason: FilesUnavailableReason }
  | { available: true; root: string; dir: string; entries: FileEntry[]; truncated: boolean };

/**
 * One file under the root, as UTF-8 text cut at the byte cap. `text` is `""` when `binary` (a NUL in
 * the first 8000 bytes, git's rule). `size` is the whole file's size, which `truncated` compares
 * against the cap.
 */
export type FileReadAnswer =
  | { available: false; reason: FilesUnavailableReason }
  | {
      available: true;
      root: string;
      path: string;
      size: number;
      /**
       * The file's modification time, epoch ms, off the same open handle as `size`. With `size` it is
       * the file's version: the phone holds a picture in memory under it (ADR 0090). Absent from a
       * bridge that predates it, and then nothing is held.
       */
      mtimeMs?: number;
      binary: boolean;
      truncated: boolean;
      text: string;
    };

/**
 * GET /api/pane/:id/files — the pane's workspace root, the Changes view's own. The subject fields are
 * the Changes answer's, on every answer. A refused path is not one of these: it is
 * `404 { error: "unknown-path" }`.
 */
export type PaneFilesResponse = { paneId: string } & ChangesWorkspace & (FilesListing | FileReadAnswer);
/** GET /api/workspace/:id/files — the same, asked by workspace. */
export type WorkspaceFilesResponse = { workspaceId: string; workspaceLabel?: string } & (FilesListing | FileReadAnswer);

/**
 * POST /api/pane/:id/{reply,keys} — result of a send. Discriminated on `ok`: a failure always
 * carries the reason Herdr rejected it. `textDelivered` distinguishes the reply partial-failure case
 * (text was typed but the submit keypress failed) so the client knows NOT to resend — resending would
 * duplicate the already-typed text. Absent/false ⇒ nothing landed, so a resend is safe.
 *
 * `error` is English prose and stays the thing a client displays when it has nothing better;
 * `code` + `detail` are the machine half, so the phone can say the same thing in the operator's
 * language (bridge/error-codes.ts). `code` was once only ever `"prompt_changed"` — it now names any
 * catalogued refusal, which is why a client must fall back on a code it does not recognise rather
 * than treat it as a bug.
 */
export type ActionResponse =
  | { ok: true }
  | {
      ok: false;
      error: string;
      textDelivered?: boolean;
      code?: ErrorCode;
      detail?: ApiErrorDetail;
      /** On a 409 `prompt_changed` only: which check refused (`not_found`, `not_in_tail`, `empty`,
       *  `style_empty`, `style_not_found`, `style_misaligned`). A reason code, never pane content. */
      reason?: string;
    };

/** POST /api/pane/:id/upload — image saved to a host file; `path` is the absolute path to ref. */
export type UploadResponse =
  | { ok: true; path: string }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };

/** A freshly-created shell pane — enough for the client to navigate into before the next poll. */
export interface CreatedPane {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  cwd: string;
}

/**
 * POST /api/tab | /api/workspace — created a new tab/space with a fresh shell. On success `pane`
 * is that shell, so the client can navigate straight into it before the next poll lands.
 */
export type CreateResponse =
  // `noPrompts`: a one-off run's line carries a flag known to skip permission prompts (ADR 0095).
  // Present only on the answer to a fresh `run`; a replay answers the stored pane alone.
  | { ok: true; pane: CreatedPane; replayed?: true; noPrompts?: boolean }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };

/**
 * POST /api/worktree — the new worktree's space, plus what happened to the launcher
 * (ADR 0089).
 *
 * `launcherStarted` is false when no launcher was asked for AND when one was asked for and could not
 * be typed; `launcherError` says why in the second case. Either way the worktree EXISTS and `pane` is
 * where it is, so a launcher failure is a 200: the recovery is "open it", never "create it again"
 * (ADR 0032). `replayed` marks an answer read back from the receipt of an earlier request with the
 * same `requestId`, so nothing ran this time.
 */
export type WorktreeCreateResponse =
  | {
      ok: true;
      pane: CreatedPane;
      alreadyOpen: false;
      launcherStarted: boolean;
      launcherError?: string;
      replayed?: true;
    }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };


/**
 * GET /api/worktree/plan — what a branch from a folder would be, before Start (M48, ADR 0093).
 *
 * `repoRoot` is the repo's main checkout, as a real path. `defaultBranch` is what a create with
 * `base: { kind: "default" }` starts from, `currentBranch` the branch the folder itself is on, each
 * `null` when there is none to name. `remembered` is this repo's last choices on this machine.
 * `branchValid`, `defaultTarget` and `parentTarget` answer only when the query named a branch (and a
 * parent): `defaultTarget` is where Herdr will put the folder when no path is sent, a prediction from
 * Herdr's own rule; `parentTarget` is the folder rule's verdict on the parent the phone named.
 */
export type WorktreePlanResponse =
  | {
      ok: true;
      repoRoot: string;
      defaultBranch: string | null;
      currentBranch: string | null;
      remembered?: { base: "default" | "current"; folder: "default" | "parent"; parent?: string };
      branchValid?: boolean;
      defaultTarget?: { path: string; exists: boolean };
      parentTarget?:
        | { ok: true; path: string }
        | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };
    }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };

/**
 * Which role this collie plays in a crew (CREW_PROTOCOL.md §3). `solo` is a lead with zero peers —
 * today's Collie, exactly — and is the only mode that needs no configuration whatsoever.
 */
export type CrewMode = "solo" | "lead" | "peer";

/**
 * One operator-declared slash command (a `[[commands]]` row in their `commands.toml`). A pane any of
 * these rows address shows them INSTEAD of the shipped Agent-commands catalog; a pane none of them
 * address keeps it (ADR 0018). This is the escape hatch for commands the shipped catalog cannot know
 * about — plugin- or user-registered ones like omp's `/fork-in-herdr` — which exist only on THIS
 * operator's machine and so must never be hard-coded into `web/src/lib/agent-commands.ts`.
 */
export interface OperatorCommand {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** Includes the leading slash. */
  command: string;
  /** One-line description shown in the palette (also searched). */
  description: string;
  /** True when tapping should insert `/cmd ` into the composer instead of submitting it. */
  takesArg: boolean;
  /** Placeholder shown after insert, e.g. `<name>`. Empty when {@link takesArg} is false. */
  argHint: string;
  /**
   * The operator marking their own row dangerous — it then gets the same two-tap confirmation a
   * shipped dangerous command gets. Only ever ADDS: a row naming a shipped command inherits that
   * command's confirm regardless (rule 3 in agent-commands.ts), and `false` cannot lift it.
   */
  confirm: boolean;
  /**
   * The operator putting this row on the HARNESS BAR, the row of the running agent's own commands
   * above the key rail. It is the only way onto that bar, and a bar row is still an ordinary palette
   * row. Replacement is per surface: bar rows replace the shipped BAR for the panes they address and
   * leave the Agent palette alone (ADR 0043, which applies ADR 0018's rule to one surface).
   */
  bar: boolean;
  /**
   * The bar button's text. Absent means the command name without its slash. Over 12 characters it
   * arrives already shortened — the bridge truncates rather than dropping the row, so a label two
   * characters too long never costs the operator their button.
   */
  barLabel?: string;
}

/**
 * One operator-declared Keys-tray preset (a `[[keys]]` row in their `keys.toml`). A pane any of
 * these rows address shows them INSTEAD of the shipped Ctrl presets; a pane none of them address
 * keeps the shipped ones (ADR 0018, the same rule `commands.toml` follows). Only the PRESETS are
 * configurable — the tray's keyboard (Esc/arrows/Enter/Tab/Space, modifiers, digits, F1–F12) is
 * fixed.
 */
export interface OperatorKeyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The button's text, and its identity within one scope. */
  label: string;
  /**
   * The chords to send, already normalised to Herdr's `pane.send_keys` spelling. More than one is
   * sent as ONE batch, in order — the same call a composed key queue makes.
   */
  keys: string[];
  /** The operator putting their own row behind the tray's existing two-tap confirm. */
  danger: boolean;
}

/**
 * What the phone is told about the multiplexer underneath — the config surface's half of M10/06.
 *
 * THE UI READS `capabilities`, NEVER `name`. `name` rides so the app can SAY which multiplexer it is
 * (a support question, and the subject of a sentence like "zellij keeps no agent session log") and
 * for nothing else: a component that branches on it has re-welded Collie to one multiplexer, which
 * is the whole thing this milestone exists to undo. `scripts/check-mux-names.sh` enforces that.
 *
 * `capabilities` is TOTAL — every capability answered true or false, the same shape the adapter
 * declares (bridge/mux/capabilities.ts). Total rather than a list of the supported ones so a client
 * that knows a capability this bridge has never heard of can tell "absent" from "not answered": an
 * unanswered capability reads as CAPABLE on the phone, because the alternative is a mid-upgrade
 * Herdr operator watching controls vanish for the length of a page cache.
 */
export interface MuxConfig {
  /** Registry name of the multiplexer. For display and support, never a branch. */
  name: string;
  /** Every capability, answered. Mirrors the adapter's own declaration. */
  capabilities: Record<MuxCapability, boolean>;
  /** Neutral key spellings (bridge/mux/keys.ts) this multiplexer refuses, canonicalised. */
  unsupportedKeys: string[];
  /**
   * The adapter's own operator-facing reason, for the capabilities it does NOT have.
   *
   * Only the absent ones: a note explaining a capability the adapter HAS is developer
   * documentation, and the phone has nothing to render it on. This is where an explanation's words
   * come from — the adapter wrote them, they name the multiplexer, and they never blame Collie.
   */
  notes: Partial<Record<MuxCapability, string>>;
  /**
   * How many spaces this multiplexer can hold — `"one"` or `"many"`, straight off the adapter's
   * declaration (bridge/mux/capabilities.ts).
   *
   * Not a capability and not a count of what exists right now: it is what the multiplexer CAN have.
   * The phone drops the space strip on `"one"`, so an ABSENT value (an older bridge) must read as
   * `"many"` — the fail-open direction, where at worst a strip shows one chip, instead of hiding
   * navigation the operator needs.
   */
  spaces?: MuxSpaceCapacity;
  /**
   * Where this multiplexer's mark is served — {@link MUX_LOGO_PATH}, or absent.
   *
   * A URL and not the SVG source: the bytes are cacheable, revalidated by ETag, and never touch the
   * JSON every page load re-reads. Present ONLY when the active adapter supplied a logo
   * (bridge/mux/types.ts `MuxAdapter.logo`) — absent means "this bridge has no picture for you",
   * which the header answers by rendering exactly the text it always did.
   */
  logoUrl?: string;
  /**
   * How soon this bridge sees a topology change nobody announced. Mirrors the adapter's declaration
   * (bridge/mux/capabilities.ts § MuxTopologyLatency).
   *
   * **Absent on any bridge older than the field**, and the phone reads that absence as `push` — the
   * fail-open direction the whole mux block already uses (web/src/lib/mux-capability.ts). The cost
   * of guessing wrong that way is one line of reassurance not shown; guessing the other way would
   * put "synced 4s ago" under a multiplexer that is never stale, which is noise that means nothing.
   */
  topologyLatency?: MuxTopologyLatency;
}

/**
 * The one path the mark is served from, spelled once.
 *
 * A CONSTANT rather than a literal at each end, because the bridge both routes it and publishes it
 * in {@link MuxConfig.logoUrl}; two spellings of one path is one release away from a broken image.
 * It is deliberately not per-multiplexer — a collie drives exactly one, so the path names the
 * question ("this bridge's mux") and the answer changes with the bridge, never with the URL.
 */
export const MUX_LOGO_PATH = "/api/mux/logo.svg";

/**
 * Where an operator's own font files are served — one file per request, appended:
 * `/api/fonts/<basename>`.
 *
 * A CONSTANT for the reason {@link MUX_LOGO_PATH} is one, and a PREFIX rather than a whole path
 * because the last segment is the only variable the surface has. It carries a basename the bridge
 * already declared in {@link BridgeConfig.operatorFonts} and nothing else — the client builds the
 * URL, the bridge looks the name up, and no path is built from either (ADR 0033).
 *
 * It lives under `/api/` deliberately: the service worker registers no runtime route there, so
 * these files are never precached and never swept, unlike the shipped faces under `/fonts/`.
 */
export const OPERATOR_FONTS_PATH = "/api/fonts/";

/**
 * One operator-declared Quick-dock group (a `[[replies]]` row in their `quick-replies.toml`). A
 * pane any of these rows address shows them INSTEAD of the shipped groups; a pane none of them
 * address keeps the shipped ones (ADR 0018, the same rule `commands.toml` and `keys.toml` follow).
 *
 * The shipped phrases are English, which is a content choice rather than a technical one — an
 * operator working in another language, or one whose harness wants "approve" over "yes", has no
 * route to that today.
 */
export interface OperatorQuickReplyRow {
  /** Herdr agent name this applies to, lowercased. Omitted = every agent. */
  agent?: string;
  /** The group's heading, and its identity within one scope. */
  title: string;
  /** The literal strings sent — each is typed into the pane and submitted verbatim. */
  items: string[];
}

/**
 * One operator-declared UI typeface (a `[[font]]` row in their `theme.toml`, the fourth operator
 * file beside `commands.toml`). The Typeface setting offers these UNDER the shipped faces — fonts
 * ADD to the shipped list, they never replace it, which is where this file parts company with the
 * ADR 0018 trio (ADR 0033: a font cannot fire an action, so there is nothing to shadow).
 *
 * Every field here enters CSS on the phone, so every field is validated on BOTH sides — the bridge
 * skips a bad row and the web re-validates and drops one. See {@link OPERATOR_FONT_FAMILY_PATTERN}.
 */
export interface OperatorFontRow {
  /** Display name AND the CSS family name. Quoted at the point it enters CSS text. */
  family: string;
  /**
   * The file's BARE NAME inside `<config-dir>/fonts`, never a path — `GET /api/fonts/<basename>`
   * looks this up in the declared set and builds nothing from the request (ADR 0033).
   */
  basename: string;
  /** `font-weight` for the `@font-face`, e.g. `400` or `400 700`. Omitted = the browser's default. */
  weight?: string;
}

/**
 * One operator-declared launcher row (`launchers.toml`). A phone tap creates a new herdr workspace
 * (a Space) labelled with the row's label, running in the row's cwd, and types the command into its
 * fresh shell — the whole security story of `POST /api/launch` is that the bridge matches the client's
 * `command` string EXACTLY against this list and 400s anything else before herdr is touched.
 */
export interface Launcher {
  /** The shell line typed into the new Space's shell, verbatim. Also the allowlist key /api/launch matches. */
  command: string;
  /** Button label. Defaults to the command's first whitespace-separated token. */
  label: string;
  /**
   * Absolute directory the new Space (or tab) opens in. Absent means "here": from the dashboard,
   * the session's `[folders]` entry in sessions.toml, else the operator's home dir; from a pane,
   * that pane's own cwd. Present, it is pinned and wins
   * either way.
   */
  cwd?: string;
  /**
   * Where the row comes from (ADR 0094): the operator's `launchers.toml`, or a phone (this machine's
   * `launchers-added.json`). Absent from an older bridge, which only had the first.
   */
  source?: "operator" | "added";
  /** An added row's id: the request id of the add. Absent on an operator row. */
  id?: string;
  /** `agent` when a harness reads the row; absent or `command` for a plain line. */
  kind?: "agent" | "command";
  /** The harness id that reads an agent row. */
  harness?: string;
  /** True when the line skips permission prompts: the phone badges it and asks once per device. */
  noPrompts?: boolean;
  /** The pairing label of the device that added the row. Added rows only. */
  addedBy?: string;
  /** Epoch ms of the add. Added rows only. */
  addedAt?: number;
  /** How the row was added: built from a recipe, or a line typed by hand. Added rows only. */
  addedAs?: "recipe" | "text";
}

/** One option chip of a recipe, as the phone draws it (bridge/launcher-recipes.ts). */
export interface RecipeOptionWire {
  id: string;
  label: string;
  /** The words the option appends, so the phone can show the line before the bridge builds it. */
  args: string;
  group?: string;
  noPrompts?: true;
}

/** One harness's recipe: its binary and the option chips this bridge's table lists for it. */
export interface RecipeWire {
  harness: string;
  label: string;
  binary: string;
  options: RecipeOptionWire[];
}

/** An added row that does not start here now, and why (ADR 0094). */
export interface AddedOffWire {
  id: string;
  label: string;
  command: string;
  kind: "agent" | "command";
  harness?: string;
  /** `adds_off`: the operator turned phone rows off. `free_text_off`: free lines are off. */
  reason: "adds_off" | "free_text_off";
}

/** What "Add your own" needs to know about THIS machine (ADR 0094). */
export interface LaunchersAdding {
  /** `[phone] adds`: whether a phone may add rows here, and its rows may start. */
  adds: boolean;
  /** `[phone] free_text`: whether a phone may add a line typed by hand. */
  freeText: boolean;
  /** `[phone] run`: whether a phone may run a one-off line here, and run a `recentRuns` entry again (ADR 0095). */
  run: boolean;
  /** The absolute path of this machine's `launchers.toml`, written or not. */
  file: string;
  /** Rows stored now, and the most there may be. */
  count: number;
  max: number;
  recipes: RecipeWire[];
  off: AddedOffWire[];
}

/**
 * GET /api/launchers — this HOST's own launcher rows, read live off its `launchers.toml`. Session-
 * scoped so a `?host=` call forwards to the peer that runs the rows, exactly like `/api/launch`
 * (CREW_PROTOCOL.md §5): rows must come from the machine that will run them, never from the lead's
 * own file. `home` is that host's operator home dir, so the client can shorten a pinned `cwd` with a
 * leading `~` without knowing which machine answered.
 */
export interface LaunchersResponse {
  launchers: Launcher[];
  home: string;
  /**
   * The agents this host can start by id, and whether each binary is there (ADR 0091). Absent from a
   * bridge that predates the New sheet, which is how the phone tells an older crew member apart.
   */
  harnesses?: HarnessInfo[];
  /**
   * What "Add your own" needs (ADR 0094). Absent from a bridge older than 1.19.0, which takes no
   * phone-added rows: the phone then offers no add.
   */
  adding?: LaunchersAdding;
  /**
   * Every agent, row and the shell, in the order the page lists them, each with its availability on
   * THIS machine and the reason code when it is off (ADR 0094). Absent from an older bridge.
   */
  items?: LauncherItem[];
  /**
   * The one-off lines a phone ran on THIS machine, newest first, at most twelve (ADR 0095). Listed
   * while `[phone] run` is off too, each then unavailable with `run_off`. Absent from an older bridge.
   */
  recentRuns?: RecentRunWire[];
}

/** One line in this machine's one-off command history (ADR 0095, `bridge/recent-runs.ts`). */
export interface RecentRunWire {
  /** The line, exactly as it ran. Running it again is `POST /api/launch` with `{ run: line }`. */
  line: string;
  /** The folder it last ran in, absolute, or `null` for "here" (the session's folder, else home). */
  cwd: string | null;
  /** Epoch ms of the last run. */
  at: number;
  /** The line carries a flag known to skip permission prompts: badge it, and confirm once per device. */
  noPrompts: boolean;
  /** Whether it may run here now. */
  available: boolean;
  /** Why not: `run_off`, the operator turned one-off runs off (`[phone] run = false`). */
  reason?: "run_off";
}

/** POST /api/launch/recent/remove and /clear (ADR 0095). `removed` is how many entries went. */
export type RecentRunsResponse =
  | { ok: true; removed: number }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };

// ── Sent: the shell lines a person sent through Collie, per machine (ADR 0107, bridge/sent.ts) ──

/** `GET /api/sent`. One answer per bridge asked; a lead's `scope=all` merges its members' into it. */
export interface SentAnswer {
  /** Newest first, at most `limit`. */
  entries: SentEntry[];
  /** A later page exists on at least one machine: ask again with `before` set to the last `at`. */
  more: boolean;
  /** This bridge records nothing (`COLLIE_SENT=off`). */
  off: boolean;
  /** One per machine asked; a solo bridge lists itself. */
  machines: SentMachine[];
}

/** One distinct line on one machine: its newest record, and how many records it has. */
export interface SentEntry {
  /** Stable per line on its machine: the first 16 hex characters of the line's sha256. */
  id: string;
  line: string;
  /** Absolute, or `null` for "here" (the session's folder, else home). */
  cwd: string | null;
  /** Epoch ms of the newest record. */
  at: number;
  /** A line sent to a shell pane, or a one-off run from the New page. Never a harness name. */
  kind: "shell" | "run";
  count: number;
  /** The machine id the crew already uses; `local` on a bridge that never enrolled. */
  host: string;
}

/** One machine a `GET /api/sent` asked. */
export interface SentMachine {
  host: string;
  label: string;
  ok: boolean;
  /** That machine records nothing (`COLLIE_SENT=off`). */
  off?: boolean;
  /** Why it did not answer: a Collie that predates Sent, no connection, or no answer in 2 s. */
  reason?: "old_version" | "unreachable" | "timeout";
}

/** `POST /api/sent/remove` and `/api/sent/clear`. `removed` is how many records went. */
export interface SentRemoveResponse {
  ok: true;
  removed: number;
}

/**
 * POST /api/launch/check `{ run }` (ADR 0095, amendment): what a one-off line would be, before it runs.
 * A READ: it runs nothing and stores nothing. `noPrompts` is {@link scanNoPrompts}'s answer on the
 * cleaned line; `problem` is the character rule's refusal, in which case `noPrompts` is false.
 */
export interface LaunchCheckResponse {
  ok: true;
  noPrompts: boolean;
  problem?: "empty" | "too_long" | "forbidden_character";
}

/**
 * One thing the New page may start on THIS machine, with whether it can start here now and why not
 * (ADR 0094). The page draws every item; an unavailable one is a disabled option with its reason.
 * Machine-wide reasons (the machine is not taking writes, an older Collie) are the phone's own, from
 * the crew health and from this list's absence; these are the reasons only this machine knows.
 */
export interface LauncherItem {
  /** Stable per machine: `harness:<id>`, `row:<command>`, or `shell`. */
  key: string;
  /** What `POST /api/launch` (and `POST /api/worktree`) names to start it. A starter is run by `POST /api/launch` alone (ADR 0102). */
  start: { harness: string } | { command: string } | { shell: true } | { starter: string };
  /** Agents: Collie reads the pane as that harness. Commands: a plain line, no agent status. */
  group: "agents" | "commands";
  label: string;
  /** The harness that reads it: a built-in agent, or an agent row. */
  harness?: string;
  /** The line a row types. */
  command?: string;
  /** A row's pinned folder. */
  cwd?: string;
  /** `program`: a starter the durable program offers (ADR 0102). */
  source: "builtin" | "operator" | "added" | "program";
  /** True when the line skips permission prompts: badge it, and confirm once per device. */
  noPrompts: boolean;
  /**
   * False on a starter: it takes no text of any kind, so the page shows no prompt field and a launch
   * body carrying text is refused. Absent on every other item (ADR 0102). This is NOT `noPrompts`,
   * which marks a line that skips an agent's permission prompts.
   */
  takesPrompt?: false;
  /** Whether it may start on a new branch: agents and the shell, never a command row. */
  branch: boolean;
  available: boolean;
  /**
   * Why not, when `available` is false. `not_found`: the binary is not on this machine's login PATH.
   * `adds_off`: the operator turned phone rows off. `free_text_off`: free lines are off.
   */
  reason?: "not_found" | "adds_off" | "free_text_off";
  /** Added rows: the id (for rename and remove), who added it, when, and how. */
  id?: string;
  addedBy?: string;
  addedAt?: number;
  addedAs?: "recipe" | "text";
}

/** POST /api/launchers/added and /rename's answer. */
export type AddedLauncherResponse =
  | { ok: true; row: Launcher; replayed?: true }
  | { ok: false; error: string; code?: ErrorCode; detail?: ApiErrorDetail };

/** One agent a host can start by id (`bridge/harness-launch.ts`). */
export interface HarnessInfo {
  /** The id `POST /api/launch` takes as `harness`. */
  id: string;
  /** The harness's own name for itself. */
  label: string;
  /** Whether the binary is on this host's login PATH. A launch of one that is not still runs. */
  found: boolean;
}

/**
 * GET /api/folders, and the answer to POST /api/folders/star — THIS host's own folder list for the
 * new-space sheet (#289), read from its `folders.json` (bridge/folders.ts). Session-scoped only so a
 * `?host=` call forwards to the peer whose folders they are (CREW_PROTOCOL.md §5); the list itself is
 * one per machine, never per session. `recent` is newest first, at most eight, and holds only folders
 * a space was created in; `favourites` is in starred order, at most twelve, and never overlaps it.
 * `home` is that host's home dir, never an entry, so the client can shorten a folder with a leading
 * `~` without knowing which machine answered — `LaunchersResponse.home`'s reason.
 */
export interface FoldersResponse {
  recent: string[];
  favourites: string[];
  home: string;
}

/** One sub-folder in a browse answer: its name only, and whether it holds a `.git` entry (#467). */
export interface FolderBrowseEntry {
  name: string;
  git: boolean;
}

/**
 * GET /api/folders/browse — the New page's folder browser (#467, bridge/folder-browse.ts). `path` is
 * the nearest folder that exists at or above the asked text, spelled under home as the text was;
 * `filter` is the rest of the text after it ("" when the text named a folder); `folders` are the
 * sub-folders of `path` whose names start with `filter`, case-insensitive, sorted by name, at most
 * 200; `parent` is the folder above `path`, or `null` at home, the bound.
 */
export interface FolderBrowseResponse {
  path: string;
  parent: string | null;
  folders: FolderBrowseEntry[];
  filter: string;
  truncated: boolean;
}

/**
 * One rule as the pane sheet reads it — the catalog entry behind a pane's `cache.ruleId`.
 *
 * The source title and the retrieved date do NOT ride every pane: seven small fields do, and the sheet
 * fetches this catalog once per boot, lazily, on the first time it is opened. A rule the operator moved
 * carries `overridden` with their OWN url and date, because an override may move a number and may not
 * remove its provenance (ADR 0041).
 */
export interface CacheRuleWire {
  id: string;
  /** Another vendor's words for their own product, so it is not translated (ADR 0030's carve-out). */
  label: string;
  ttlSeconds: number;
  confidence: Confidence;
  sourceTitle: string;
  sourceUrl: string;
  retrievedAt: string;
  slidingWindow: boolean;
  automatic: boolean;
  /** One line a reader needs in order to not misread the number. Absent when the rule carries none. */
  note?: string;
  /** Present only when `cache-rules.toml` moves this rule, and then it is the operator's own source. */
  overridden?: { ttlSeconds: number; sourceUrl: string; retrieved: string; note?: string };
}

/**
 * GET /api/cache-rules — the catalog behind every cache chip on THIS host, plus its applied overrides.
 *
 * A read, gated as `/api/config` is, ETagged through `bridge/http-cache.ts`. It is this host's own
 * catalog and is not forwarded across the crew link: a peer may hold its own override, so quoting the
 * lead's catalog for a peer's number would cite a page that peer never read. The sheet on a peer's pane
 * says so in a sentence instead.
 */
export interface CacheRulesResponse {
  rules: CacheRuleWire[];
}

/**
 * GET/POST /api/notifications/cache-watch — one pane's place in the prompt-cache watch list.
 *
 * A PREFERENCE, which is why it sits in the `notifications` family and is query-addressed rather than
 * hung off `PANE_ROUTE`: that route is mirrored onto the crew wire, and a forwarded preference would be
 * stored on the peer that owns the pane, where no push subscription lives (ADR 0042).
 */
export interface CacheWatchResponse {
  /** This pane's own entry in the list. */
  on: boolean;
  /** `prefs.cache`, so the sheet can say the global switch already covers this pane. */
  global: boolean;
  /** False when the pane names no harness session, carries no `cache` key, or reads `unknown`. */
  watchable: boolean;
  /** The resolved `COLLIE_CACHE_WARN_SECONDS`, so the copy quotes the bridge's number. */
  warnSeconds: number;
}

/** One row of the watched-pane list. `id` is an opaque handle; the stored ref never leaves the bridge. */
export interface CacheWatchEntryWire {
  id: string;
  label: string;
  /** Present only for a peer's pane, omitted for a local one. */
  host?: string;
  session?: string;
  /** Present when the entry's pane is in the current snapshot. Absent means it lists but cannot link. */
  paneId?: string;
}

/** GET /api/notifications/cache-watch/list — the whole bridge's list, not one pane's. */
export interface CacheWatchListResponse {
  entries: CacheWatchEntryWire[];
}

/** GET /api/config — bridge capabilities and the build id (push setup + stale-cache detection). */
export interface BridgeConfig {
  push: boolean;
  vapidPublicKey: string;
  /** Build id of the bundle the bridge is currently serving (for stale-cache detection). */
  build?: string;
  /**
   * This collie's crew mode, so `crew status` and the UI can render it without probing behaviour.
   * **Omitted when the mode is `solo`** — absent means "no crew", which is precisely true, and keeps
   * a solo `/api/config` body byte-identical to today's (the `servers` reasoning, CREW_PROTOCOL.md
   * §11). Read it as `mode ?? "solo"`.
   */
  mode?: CrewMode;
  /** The operator's own palette rows. Absent/empty when there is no `commands.toml`. */
  operatorCommands?: OperatorCommand[];
  /** The operator's own Keys-tray presets. Absent/empty when there is no `keys.toml`. */
  operatorKeys?: OperatorKeyRow[];
  /** The operator's own Quick-dock groups. Absent/empty when there is no `quick-replies.toml`. */
  operatorQuickReplies?: OperatorQuickReplyRow[];
  /**
   * The operator's own UI typefaces. Absent/empty when there is no `theme.toml`. Carries the
   * BASENAME and never a URL: the client builds `/api/fonts/<basename>` itself, so no path this
   * bridge resolved is ever echoed to a phone (ADR 0033).
   */
  operatorFonts?: OperatorFontRow[];
  /**
   * The multiplexer this collie drives, and what it can do. Absent only on a bridge older than
   * M10/06 — which a client reads as "every capability present", i.e. exactly today's Herdr app.
   */
  mux?: MuxConfig;
  /**
   * Speech-to-text, when a provider is configured. **Absent is the feature being off**, which is
   * also exactly what an older bridge sends — so a client reads "no key" as "no microphone" and a
   * collie whose operator configured nothing ships the byte-identical body it always did.
   *
   * It carries a label and a yes/no, and never the endpoint, the model or the credential: the phone
   * decides whether to draw a button, not where the audio goes.
   */
  stt?: SttCapability;
  /**
   * The Whistle model on this host (ADR 0096), so Settings can offer the setup tap. Present on every
   * lead and solo collie that knows the feature; absent on an older bridge, and on a crew member's
   * own answer, because speech is lead-only (ADR 0029). A `?host=<member>` read carries the lead's,
   * like `stt`.
   */
  whistle?: WhistleStatus;
  /**
   * What this collie accepts as an attachment. **Absent is a bridge older than this field**, which
   * a client reads as the contract that shipped before it: 10 MB, images only. Present, it is the
   * whole answer — the phone builds its file picker's `accept` list from it and refuses an oversize
   * file before spending an uplink on a refusal it can already predict.
   *
   * Per HOST, not per crew: `?h=peer` reads the LEAD's config body, so a member with a different
   * `COLLIE_MAX_UPLOAD_MB` still answers for itself when the bytes arrive. See docs/configure.md.
   */
  upload?: UploadCapability;
  /**
   * Whether this bridge masks secret shapes before text leaves the machine (`cfg.redact`,
   * `COLLIE_REDACT`). Read-only on the phone: Settings shows it and never sets it. **Absent is an
   * older bridge, or a `?host=<member>` answer**, which the phone shows as unknown. Mirrors
   * `BridgeConfig` in web/src/lib/types.ts.
   */
  redact?: boolean;
}

/**
 * What `/api/config` says about attachments — the two facts a client needs to ask a sensible
 * question before it uploads. Both are the host's own settings (`COLLIE_MAX_UPLOAD_MB`,
 * `COLLIE_UPLOAD_EXTRA_TYPES` + the shipped list in bridge/uploads.ts).
 */
export interface UploadCapability {
  /** Largest attachment accepted, decoded, in bytes. */
  maxBytes: number;
  /** Image extensions accepted, bare and lowercase — sniffed from the bytes, never from the name. */
  imageTypes: string[];
  /** Text extensions accepted, bare and lowercase — taken from the name, with a binary veto. */
  textTypes: string[];
}

/**
 * What `/api/config` says about speech-to-text. The whole of what leaves the bridge on this subject.
 *
 * The provider's own status lives behind `SttProvider.status()` (bridge/stt/provider.ts); this is
 * its wire shape.
 */
export interface SttCapability {
  /** The provider's id — a label the UI may show, e.g. `openai-compatible`. */
  provider: string;
  /** Whether it could serve a request right now. */
  available: boolean;
  /** Operator-facing prose when it could not. Absent when it could. */
  reason?: string;
  /**
   * What the phone must upload. Present only for the `whistle` provider (ADR 0096 Decision 4):
   * `wav-16k` is 16 kHz mono 16-bit little-endian PCM WAV, and nothing else is accepted. Absent means
   * the recording as the browser made it.
   */
  input?: "wav-16k";
  /**
   * The longest recording this provider takes, in milliseconds. Present only when it differs from
   * the phone's 5-minute default: the `whistle` provider takes 4 minutes, because a WAV is about four
   * times the size of a compressed recording and the 8 MiB upload cap stays.
   */
  maxDurationMs?: number;
}

/**
 * Why Settings may not switch the host to one choice (ADR 0097), as a code the phone translates:
 *
 *  - `env`               the deployment's environment names the speech settings; it wins, and no phone changes it
 *  - `terminal`          a provider set up in a terminal with a key, an endpoint or a command
 *  - `unreadable`        `stt.json` is there and cannot be read; it is the operator's to fix
 *  - `not-ready`         Whistle: the model is not on the host yet
 *  - `codex-missing`     Codex: no `codex` binary was found on the host
 *  - `codex-signed-out`  Codex: `codex login status` says it is not signed in
 *  - `codex-other-login` Codex: signed in, but not with ChatGPT (an API key, say)
 *  - `codex-unknown`     Codex: the sign-in could not be checked (a timeout, an answer not understood)
 */
export type SttHostSwitchReason =
  | "env"
  | "terminal"
  | "unreadable"
  | "not-ready"
  | "codex-missing"
  | "codex-signed-out"
  | "codex-other-login"
  | "codex-unknown";

/** Whether one choice may be made from Settings, and if not, why. */
export interface SttHostSwitch {
  ok: boolean;
  /** Absent when `ok`. */
  reason?: SttHostSwitchReason;
}

/**
 * What the host's speech settings name, by name only (Settings → Voice titles its card with it).
 * Every field is optional and is dropped when it holds a hidden character. Never a path, an argument
 * other than the one model file's name, a key, an environment value, or a URL's path or query.
 * Mirrors `SttHostSetup` in web/src/lib/types.ts.
 */
export interface SttHostSetup {
  /** `local-cli`: the command's basename (`whistle-stt`, `whisper-cli`). */
  command?: string;
  /**
   * `local-cli`: the basename of the first argument that names a model file (`ggml-base.bin`).
   * `openai-compatible`: the configured model (`whisper-large-v3`). `whistle`: the pinned model's
   * version, the first seven characters of its revision.
   */
  model?: string;
  /** `openai-compatible`: the service's host, with its port when it has one (`api.groq.com`, `127.0.0.1:8080`). */
  endpoint?: string;
}

/**
 * The host's speech provider, as `GET /api/stt/host` and `PUT /api/stt/host` report it (ADR 0097).
 * Mirrors `SttHostStatus` in web/src/lib/types.ts.
 */
export interface SttHostStatus {
  /** `whistle`, `codex`, `openai-compatible`, `local-cli`, or `none`. A name this build does not know is passed through. */
  provider: string;
  /** Whether it could serve a request right now. False for `none`. */
  available: boolean;
  /** Operator-facing prose when it could not: the provider's own words, or why the settings do not resolve. */
  reason?: string;
  /** For `codex` only: the identity recorded at setup. `codex-cli` is the fallback that wears the Codex CLI's headers. */
  identity?: SttWireIdentity;
  /** Where the provider is named: `stt.json` in the state dir, the bridge's environment, or nowhere. */
  configuredBy: "file" | "env" | "none";
  /** The three choices Settings offers, each with whether it may be made now. */
  switchable: { whistle: SttHostSwitch; codex: SttHostSwitch; off: SttHostSwitch };
  /** The `codex` binary whose sign-in would pay, for the consent's words. Present when one was found. */
  codexBin?: string;
  /**
   * The paired device that last changed the option from Settings, by its pairing label. Absent when
   * the option was last set in a terminal, by the environment, or by a device the bridge could not
   * name. Never a token, an address or a header value.
   */
  changedBy?: string;
  /** When that device changed it, an ISO 8601 time. Present exactly when `changedBy` is. */
  changedAt?: string;
  /** What the settings name: the command, the model, the service's host. Absent when they name nothing, or do not resolve. */
  setup?: SttHostSetup;
}

/** Where the host's copy of the Whistle model stands (ADR 0096 Decision 2). */
export type WhistleState = "absent" | "downloading" | "ready" | "failed";

/**
 * The Whistle model on the host and the host engine's switch, as `GET /api/stt/whistle` and
 * `/api/config` report them. Mirrors `WhistleStatus` in web/src/lib/types.ts.
 */
export interface WhistleStatus {
  state: WhistleState;
  /** Exact size of the pinned model, for the button and the bar. Always present. */
  bytes: number;
  /** Present while downloading: the bytes received so far. */
  received?: number;
  /** Present only when state is "ready": the held file's sha256, lowercase hex, a hash this build accepts. */
  sha256?: string;
  /** Present only when state is "ready" and the manifest names it: the Hugging Face revision the file came from. */
  revision?: string;
  /** Present only when state is "ready" and the manifest names it: when the host fetched the file, an ISO 8601 time. */
  fetchedAt?: string;
  /** Present when state is "failed": operator-facing prose, no paths. */
  reason?: string;
  /** True when the host STT provider is `whistle`. */
  hostEngine: boolean;
  /** True when another provider is configured, so Settings cannot turn the host engine on. */
  hostTaken: boolean;
}

/**
 * Urgency rank per status, lower is more urgent. It ranks a MARK, never a row: no list is sorted by
 * it (ADR 0063). The merge also reads its keys as the set of valid status words.
 */
export const STATUS_RANK = {
  blocked: 0,
  working: 1,
  unknown: 2,
  idle: 3,
  done: 4,
} satisfies Record<AgentStatus, number>;
