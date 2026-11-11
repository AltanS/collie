// Agent views: a view of an agent session beside Terminal and Chat that the session's own agent draws,
// added by a trick whose manifest lists the place `agent-view` (contract 2). The person turns one view on
// per session from the phone; the agent answers a send from it by drawing ONE screen with
// `collie trick view <id> show <file.json>`, in a trick part's node vocabulary. A tap on a button in that
// screen goes to the bridge as `view: { trick, session, rev, control }` on `POST /api/send`, and the
// BRIDGE builds the line from its own stored screen ({@link AgentViewService.prepareSend}). Nothing here
// types into a pane, and nothing here knows a harness or a multiplexer.
//
// A VIEW IS KEYED BY (TRICK, SESSION). The session is its walky address with the instance token, as the
// hill names a session. The phone's switch is resolved through the same probe the hill uses (walkyPlace),
// so `local/` and this bridge's own member id name the same pane, and an address that names no live
// agent session here is refused.
//
// THE GATE, AT EVERY USE (agent views SECURITY rule 1). Every agent write and every view send checks:
// the trick is approved at its current hash, on, with no new version waiting, and its manifest lists
// `agent-view` (the tricks service answers that, bridge/tricks/service.ts `viewGate`); the view is on for
// this session (only the person's switch turns it on, N9); the session is on this lead (a crew member
// answers `not_on_lead`). A trick that goes off, is removed or has a version waiting turns every one of its
// views off on the next read, and its sends are refused `trick_off`.
//
// THE RULES HANDSHAKE. A send from a view carries a head that names the trick and the session,
// `[view:<id> <address>] from operator:`, and, while the session is not known to hold the trick's rules,
// a tail that points at them, `[rules: <bin> trick view <id> help --session <address>]`. A session proves
// it holds them with `trick view <id> start --rules <rid>`: the rules id is a hash of Collie's core view
// help and the trick's approved rules (cli/trick-view-help.ts `viewRulesIdOf`). The proof is held in
// memory with the pane's mark at that start, and it goes when the mark changes, on `clear`, and when the
// view goes off. A bridge restart forgets every proof: the next send then carries the tail once more.
//
// STALE SCREENS (SECURITY S3, rule 6). Each screen is stored with the pane's mark at its write: the
// harness and the conversation the bridge knows of the pane (bridge/agent-view/mark.ts). Another mark
// now serves it `stale` and refuses its taps. A harness that reports no conversation has a mark of the
// harness alone: for it the screen goes stale at the first person turn that did not come from the view
// (`notePersonTurn`).
//
// CAPS AND RECORD (rule 12). Per (trick, session) at most 120 agent writes a minute (`rate`); per session
// one view send in flight and 20 a minute. Each switch, send and refusal writes one audit line.
//
// PRUNING. A view is dropped at the next write when it says nothing (off, no screen, no show counted, no
// drawing, no sent line), and so is one whose session is gone, once the bridge lists sessions at all.
//
// THIS MACHINE ONLY, as the hill: a crew member refuses every write and the switch (its phone reads the
// lead), and the lead's routes refuse `?host=` (server.ts). The deputy copies carry no views.

import { isAbsolute } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { LOCAL_MEMBER, parseAddress } from "../walky/address.ts";
import {
  BAD_HEAD,
  cleanViewLine,
  hasViewHead,
  VIEW_CHOICE_BLOCK,
  VIEW_DRAWING_MAX_MS,
  VIEW_HEAD_MAX,
  VIEW_HINT_MAX,
  VIEW_MEDIA_ID_RE,
  VIEW_MEDIA_MAX,
  VIEW_NO_PROFILE,
  VIEW_NOTE_MAX,
  VIEW_NOTES_MAX,
  VIEW_SENDS_PER_MINUTE,
  VIEW_SENT_MAX,
  VIEW_SET_RE,
  VIEW_TITLE_MAX,
  VIEW_WRITES_PER_MINUTE,
  parseAgentView,
  parseViewChoice,
  viewShellWord,
  viewTapWords,
  type TrickViewKey,
  type TrickViewsAnswer,
  type TrickViewSession,
  type TrickViewSwitchBody,
  type ViewBlock,
  type ViewChoice,
  type ViewDrawing,
  type ViewScreen,
  type ViewSendField,
  type ViewSent,
  type ViewSentOutcome,
} from "../../web/src/lib/agent-view/wire.ts";
import { isCommand } from "../../web/src/lib/send-protocol.ts";
import type { Refusal } from "../../web/src/lib/tricks/schema.ts";
import { keepPictures, VIEW_MINTERS, VIEW_TOO_MANY_IMAGES, readImageFields, type ViewFieldError, type ViewImageInput, type ViewMediaKeep, type ViewMinters, type ViewPictureSet } from "./media.ts";
import { draftOf, keptBlocks, PENDING_NODE, placed, removed, shownBlocks, type ViewDraft, type ViewPendingFields, type ViewSetFields } from "./blocks.ts";
import { markHasConversation } from "./mark.ts";
import { viewEntry, viewKey, type AgentViewStore, type ViewEntry } from "./store.ts";

/** How the bridge sits in a crew. A member (`peer`) refuses every write: the phone reads the lead. */
export type ViewCrewMode = "solo" | "lead" | "peer";

/** Why the bridge refuses an operation, an agent's write or a person's send. */
export type ViewRefusalCode =
  | "bad_view"
  | "bad_title"
  | "bad_note"
  | "not_on_lead"
  | "unsaved"
  | "wrong_session"
  | "bad_image"
  | "too_many_images"
  | "image_too_large"
  | "bad_choice"
  | "bad_block"
  | "no_screen"
  // The gate (rule 1): the trick is not known here, not approved and on (or a version waits), or lists no agent view.
  | "no_trick"
  | "trick_off"
  | "not_a_view"
  // The person's switch for this session is off: only the person turns a view on.
  | "view_off"
  // Caps (rule 12).
  | "rate"
  | "busy"
  // A tap on a screen the bridge no longer holds at that rev, or one drawn in an earlier conversation.
  | "stale_view"
  // A tap that names no button or option a tap could reach on the stored screen.
  | "bad_control"
  // A tap while a question, a dialog or an answer box shows (rule 5).
  | "question"
  // The pane's program has no profile: Collie types there blind and cannot keep rule 5 (review 9 M1).
  | "no_profile"
  // Typed text that holds a view head on any line (rule 7, review 9 R1): the view's request skips the protocol's check.
  | "bad_head";

/** One refused agent write's audit line per reason per (trick, session) in this time (review 9 R5). */
export const VIEW_REFUSAL_AUDIT_MS = 60_000;
/** How many (trick, session, reason) keys the refusal line cap remembers at most. */
export const VIEW_REFUSAL_KEYS_MAX = 1024;

/**
 * How long after a view's own send a turn start is taken as the turn that send started, not a person's
 * (rule 6, review 9 R3). The bridge sees a turn start on its next poll, at most 12 s apart when idle.
 */
export const VIEW_OWN_TURN_MS = 30_000;

/** The words a second tap on a screen whose tap was sent gets (review 9 R6). */
export const VIEW_PICKED_WORDS = "this screen was answered already; wait for the agent's next screen";

/** The sentence a crew member answers a write or a switch with. */
export const VIEW_NOT_ON_LEAD = "agent views work on the lead machine only; run it in a session on the lead";
/** The sentence when the state could not be written. */
export const VIEW_UNSAVED = "the bridge could not save the view's state; nothing changed";
/** The sentence the phone's switch gets for an address that names no live agent session here. */
export const VIEW_NO_SESSION = "that address names no live agent session on this machine";
/** The sentence of a write while the person's switch is off. */
export const VIEW_OFF_WORDS = "this view is off for this session; only the person turns it on, on the phone";
/** The sentence of a write past the cap. */
export const VIEW_RATE_WORDS = "too many writes to this view in one minute; wait, then draw again";
/** The sentence of a send while another one of this session is in flight. */
export const VIEW_BUSY_WORDS = "a send from this view is still going out; wait for it";
/** The sentence of a send past the session's cap. */
export const VIEW_SEND_RATE_WORDS = "too many sends from this view in one minute; wait a moment";
/** The sentence of a tap on a screen that moved or is stale. */
export const VIEW_STALE_WORDS = "this screen changed or belongs to an earlier conversation; look at the new screen, then tap again";
/** The sentence of a tap that names no button on the screen. */
export const VIEW_BAD_CONTROL_WORDS = "that tap names no button on this screen";
/** The sentence of a tap while a question waits in the session. */
export const VIEW_QUESTION_WORDS = "a question waits in this session; answer it first";

/** The most refusals a write answers with, so a view that is wrong everywhere stays readable. */
export const VIEW_REFUSALS_SHOWN = 8;
export { VIEW_SENDS_PER_MINUTE, VIEW_WRITES_PER_MINUTE };
const MINUTE_MS = 60_000;

/** The live agent session a walky address names now: its address with the instance token. */
export interface ViewSessionPlace {
  readonly address: string;
}

/** What the tricks service answers of one trick for the gate (bridge/tricks/service.ts `viewGate`). */
export type ViewGate =
  | {
      readonly ok: true;
      /** The trick's name, as the approved copy's manifest gives it. */
      readonly name: string;
      /** The approved copy's rules text: printable ASCII and line breaks only (schema `rulesTextProblems`). */
      readonly rules: string;
    }
  | { readonly ok: false; readonly code: "no_trick" | "trick_off" | "not_a_view"; readonly error: string };

/** The gate as the service reads it. */
export interface ViewGatePort {
  /** The gate of one trick as the bridge knows it now: for reads, which must not wait on a scan. */
  check(trick: string): ViewGate;
  /** The gate after a fresh look at the trick (a scan inside the tricks' own cadence): for writes and sends. */
  fresh(trick: string): Promise<ViewGate>;
  /** A fresh look at every trick, inside the tricks' own cadence, before a read of every view. Absent: none. */
  settle?(): Promise<void>;
}

/** One audit line: a switch, a send, or a refusal, with the trick and the session. */
export interface ViewAuditEntry {
  readonly action: "trick.view.switch" | "trick.view.send" | "trick.view.refused";
  readonly session: string;
  readonly device: string | null;
  readonly detail: { readonly [key: string]: string | number | boolean };
}

export interface AgentViewServiceDeps {
  readonly store: AgentViewStore;
  /** The probe the hill uses (hill/walky.ts `walkyPlace`): null for a scope, a shell, a gone pane. */
  readonly place: (address: string) => ViewSessionPlace | null;
  /** False until the bridge lists any session: pruning waits for it. */
  readonly sessionsKnown: () => boolean;
  readonly crewMode: () => ViewCrewMode;
  /** The absolute path of this bridge's own `collie` binary, named in the tail. */
  readonly binary: string;
  /** The trick gate. */
  readonly gate: ViewGatePort;
  /** The rules id of a trick's rules text (cli/trick-view-help.ts `viewRulesIdOf`). */
  readonly rulesIdOf: (trick: string, rules: string) => string;
  /** The help one session gets: Collie's core view help, then the trick's own rules, framed (cli/trick-view-help.ts `viewHelpWithRules`). */
  readonly helpOf: (input: { readonly binary: string; readonly trick: string; readonly name: string; readonly session: string; readonly rules: string; readonly rulesId: string }) => string[];
  readonly now?: () => number;
  /** Where pictures are kept: a second instance of the hill's media store. Absent, a picture is refused. */
  readonly media?: ViewMediaKeep;
  /** How set and picture ids are minted. A test pins them. */
  readonly mint?: ViewMinters;
  /**
   * What the pane a session names runs now, as one opaque word: its harness and its conversation, as far
   * as the bridge knows them (bridge/agent-view/mark.ts). Null when the pane is not live. Absent: no mark,
   * so no screen goes stale by a mark and a proof ends only on clear or off.
   */
  readonly paneMark?: (session: string) => string | null;
  /** Whether a question, a dialog or an answer box shows in the session now. Absent: never. */
  readonly question?: (session: string) => boolean;
  /**
   * Whether the session's pane runs a program Collie has a profile for, so the Send Protocol reads it
   * before a key (review 9 M1). False refuses the switch on. Absent: every session reads.
   */
  readonly readable?: (session: string) => Promise<boolean>;
  /** Whether a turn runs in the session now. Typed text then goes plain, as the person's own send. Absent: never. */
  readonly working?: (session: string) => boolean;
  /** One audit line per switch, send and refusal. Absent: none. */
  readonly audit?: (entry: ViewAuditEntry) => void;
}

/** An operation's refusal. */
export interface ViewRefused {
  readonly ok: false;
  readonly error: string;
  readonly code: ViewRefusalCode;
  readonly refusals?: readonly Refusal[];
}

/** A socket operation's answer: the caller's view as served, or a refusal with its code. */
export type ViewOpAnswer = { readonly ok: true; readonly session: TrickViewSession } | ViewRefused;

/** The phone's switch: the view as served, or an HTTP status with a sentence and a code. */
export type ViewSwitchAnswer = { readonly ok: true; readonly session: TrickViewSession } | { readonly ok: false; readonly status: 400 | 404 | 409 | 503; readonly error: string; readonly code: ViewRefusalCode };

/** A show's fields, read from the socket: the view and the choice as raw JSON (checked here), the title and the pictures. */
export interface ViewShowFields {
  readonly view: JsonValue | undefined;
  readonly title: string | null;
  /** Absolute paths on this machine; the bridge reads the files. Absent or empty for none. */
  readonly images?: readonly ViewImageInput[];
  /** The decision block, absent for none. */
  readonly choice?: JsonValue;
}

/** One picture's bytes and type, for the media route. */
export interface ViewMediaFile {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mime: string;
}

/** The head of a session whose address cannot ride the head (no shell word, or too long): the trick alone. */
export function viewHeadBare(trick: string): string {
  return `[view:${trick}] from operator:`;
}

/**
 * The head the bridge puts in front of a send from a view: who wrote it, the trick and the session it is
 * for, `[view:<id> <address>] from operator:`, so an agent that holds the rules copies the address from it.
 */
export function viewHead(trick: string, session: string): string {
  const word = viewShellWord(session);
  const head = word === null ? viewHeadBare(trick) : `[view:${trick} ${word}] from operator:`;
  return head.length <= VIEW_HEAD_MAX ? head : viewHeadBare(trick);
}

/**
 * The tail a send from a view carries for ONE session: where the rules are, with the trick and the
 * session's own address filled in, so the agent copies the line and never invents an address. It names
 * this bridge's own binary by its absolute path. Throws when the path is so long that even the fallback
 * does not fit on one line under the cap: the caller then runs without agent views.
 */
export function viewHint(binary: string, trick: string, session: string): string {
  // eslint-disable-next-line no-control-regex
  if (!isAbsolute(binary) || /[\u0000-\u001f\u007f']/u.test(binary)) throw new Error(`trick-views: the binary path is not an absolute path a shell line can carry: ${binary}`);
  // A path with a blank is quoted, so the line still runs as one command.
  const bin = /\s/u.test(binary) ? `'${binary}'` : binary;
  const word = viewShellWord(session);
  const lines = [...(word === null ? [] : [`[rules: ${bin} trick view ${trick} help --session ${word}]`]), `[rules: ${bin} trick view ${trick} help]`];
  const fits = lines.find((line) => line.length < VIEW_HINT_MAX);
  if (fits === undefined) throw new Error(`trick-views: the binary path is too long for a one-line tail: ${binary}`);
  return fits;
}

/** An address and a trick id a tail is probed with at boot: a pane id of the usual length, the longest id. */
const PROBE_SESSION = "workshop-hc/terminal_12345#ab12";
const PROBE_TRICK = "a".repeat(32);

/**
 * Whether the address a request names is the session the markers placed. Canonical, as the hill's probe
 * reads an address: `local/` and this bridge's own member id name the same machine, and an address
 * without the `#token` names whatever session holds the pane id now. A given token that is not the
 * session's own is another session in the same pane.
 */
export function sameSession({ own, given }: { own: string; given: string }): boolean {
  const mine = parseAddress(own);
  const named = parseAddress(given);
  if (mine?.kind !== "pane" || named?.kind !== "pane") return false;
  if (named.memberId !== mine.memberId && named.memberId !== LOCAL_MEMBER) return false;
  return named.paneId === mine.paneId && (named.instance === null || named.instance === mine.instance);
}

/** The sentence a request that names another session than its pane's own is refused with. */
export function wrongSessionWords({ own, given }: { own: string; given: string }): string {
  return `this pane is ${own}, the command names ${given}; copy the session from the request line, or leave --session out`;
}

function refusalWords(refusals: readonly Refusal[]): string {
  const shown = refusals.slice(0, VIEW_REFUSALS_SHOWN).map((refusal) => `${refusal.path || "/"}: ${refusal.reason}`);
  const more = refusals.length - shown.length;
  return more > 0 ? `${shown.join("; ")}; and ${String(more)} more` : shown.join("; ");
}

/** A session's proof that it holds a trick's rules: the pane's mark and the rules id when its start carried it. */
interface RulesProof {
  readonly mark: string | null;
  readonly rulesId: string;
}

/** Times within the last minute, per key: a sliding window, in memory only. */
export class MinuteWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly now: () => number,
  ) {}

  /** Count one hit for `key`, or false when the key already made `max` in the last minute. */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < MINUTE_MS);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/**
 * A send the service admitted: the exact line, and the check the Send Protocol runs under the pane lock
 * right before the first key. `done` MUST be called once with how the send ended: it frees the session's
 * one send in flight, keeps the line, and writes the audit line.
 */
export interface ViewSendPlan {
  readonly ok: true;
  readonly trick: string;
  readonly session: string;
  readonly kind: "tap" | "text";
  /** The exact text the bridge hands to the session: head, words and tail, or typed text alone. */
  readonly line: string;
  /** True when the line goes as the person's own text with no head: typed text while a question waits, or a command. */
  readonly plain: boolean;
  /** Under the pane lock: null while the stored screen still yields this exact line, else the sentence why not. */
  readonly check: () => string | null;
  /**
   * How the send ended: `sent`, or `landed` when the keys reached the pane but the send ended
   * `typed_not_submitted` or `unknown` (review 9 R7), else a refusal with its reason.
   */
  readonly done: (end: { readonly rid: string; readonly sent: boolean; readonly reason: string | null; readonly landed?: ViewSentOutcome }) => void;
}

/** A send's refusal before anything was typed. */
export interface ViewSendRefused {
  readonly ok: false;
  readonly code: ViewRefusalCode;
  readonly error: string;
}

export class AgentViewService {
  private readonly now: () => number;
  private readonly mint: ViewMinters;
  /** Sessions whose last start for a trick carried that trick's current rules id, in memory only. */
  private readonly proofs = new Map<string, RulesProof>();
  /** What each view last served beside its entry (gate, stale, question, tail): a change moves its rev. */
  private readonly derived = new Map<string, string>();
  private readonly writes: MinuteWindow;
  private readonly sends: MinuteWindow;
  /** Sessions with a view send going out now: one at a time per session. */
  private readonly sending = new Set<string>();
  /** When each (trick, session, reason) last wrote a refused agent write's audit line (review 9 R5). */
  private readonly refusalLines = new Map<string, number>();
  /** Whether a turn ran in each session with a screen at the last look (rule 6, review 9 R3). */
  private readonly turnSeen = new Map<string, boolean>();
  /** Sessions a view's own send went to, until when the turn it starts is the view's and not a person's. */
  private readonly ownTurns = new Map<string, number>();

  constructor(private readonly deps: AgentViewServiceDeps) {
    // Probed once, so a path that fits no wording leaves the bridge without agent views at boot, not at a serve.
    viewHint(deps.binary, PROBE_TRICK, PROBE_SESSION);
    this.now = deps.now ?? Date.now;
    this.mint = deps.mint ?? VIEW_MINTERS;
    this.writes = new MinuteWindow(VIEW_WRITES_PER_MINUTE, this.now);
    this.sends = new MinuteWindow(VIEW_SENDS_PER_MINUTE, this.now);
  }

  /** The tail one session carries for one trick. */
  hint(trick: string, session: string): string {
    return viewHint(this.deps.binary, trick, session);
  }

  /** A fresh look at the tricks before every view is read, so a trick switched off reads off at once. */
  async settle(): Promise<void> {
    await this.deps.gate.settle?.();
  }

  /** The revision for the snapshot's `trickViewsRev`, undefined while no view was ever written. */
  rev(): number | undefined {
    return this.deps.store.rev();
  }

  /**
   * What `GET /api/trick-views[?since=<rev>][&session=<address>...]` serves. Without `since`, every view.
   * With it, only the views that moved after it, and the keys of every view held. With `sessions`, the
   * same, narrowed to those sessions. Rev 0 while no view was ever written.
   */
  answer(since: number | null = null, sessions: readonly string[] | null = null): TrickViewsAnswer {
    // Served first: a gate, a mark or a question that moved while they are served moves the views' revs.
    // With `sessions`, only the views of those sessions (the ones the phone shows), by the canonical
    // rule of `sameSession`; their keys alone, so the phone forgets only what it asked for.
    const asked = (entry: ViewEntry) => sessions === null || sessions.some((given) => sameSession({ own: entry.session, given }));
    const served = this.deps.store.all().filter(asked).map((entry) => ({ entry, session: this.servedNoting(entry) }));
    const rev = this.deps.store.rev() ?? 0;
    if (since === null || since > rev) return { rev, views: served.map((s) => s.session) };
    if (since === rev) return { rev, unchanged: true, views: [] };
    const keys: TrickViewKey[] = served.map((s) => ({ trick: s.entry.trick, session: s.entry.session }));
    const moved = served.filter((s) => (this.deps.store.revOf(s.entry.trick, s.entry.session) ?? 0) > since).map((s) => s.session);
    return { rev, views: moved, keys };
  }

  /** One view as served. A view the store does not hold is off by its switch, with no screen. */
  status(trick: string, session: string): TrickViewSession {
    const entry = this.deps.store.get(trick, session);
    return entry === undefined ? this.served(viewEntry({ trick, session, on: false, shows: 0, changedAt: 0 })) : this.served(entry);
  }

  /**
   * The bridge's look at every view on its refresh timer: a proof whose pane runs another harness or
   * conversation, or is gone, ends; a gate, a stale mark or a question that moved moves the view's rev.
   */
  noteMarks(): void {
    this.noteTurnStarts();
    for (const entry of this.deps.store.all()) this.servedNoting(entry);
  }

  /**
   * A turn that started in a session with a screen since the last look, and that no send of the view
   * started, is a person turn (rule 6, review 9 R3): the person typed at the desk, or something else
   * prompted the agent. The view's own send excuses the first turn start within {@link VIEW_OWN_TURN_MS}.
   * The first look at a session only learns its state.
   */
  private noteTurnStarts(): void {
    const working = this.deps.working;
    if (working === undefined) return;
    const sessions = new Set(this.deps.store.all().filter((entry) => entry.view !== undefined).map((entry) => entry.session));
    for (const session of this.turnSeen.keys()) if (!sessions.has(session)) this.turnSeen.delete(session);
    for (const session of sessions) {
      const now = working(session);
      const before = this.turnSeen.get(session);
      this.turnSeen.set(session, now);
      if (!now || before !== false) continue;
      const own = this.ownTurns.get(session);
      this.ownTurns.delete(session);
      if (own !== undefined && own >= this.now()) continue;
      this.notePersonTurn(session);
    }
  }

  /**
   * A person turn reached a session, and it did not come from a view: a phone send, an ask answer, a
   * WalkyTalky message from the person (a Hill answer or tell is one), typed text sent plain, or a turn
   * start no view send caused ({@link noteTurnStarts}). A screen of that session whose pane reports no
   * conversation goes stale (rule 6). `/clear` typed at the desk starts no turn, so on such a harness the
   * screen stays until the next turn starts; a harness that reports its conversation changes its mark.
   */
  notePersonTurn(session: string): void {
    for (const entry of this.deps.store.all()) {
      if (!sameSession({ own: entry.session, given: session }) || entry.view === undefined || entry.staleTurn === true) continue;
      if (entry.mark !== undefined && markHasConversation(entry.mark)) continue;
      this.deps.store.put(viewEntry({ ...entry, staleTurn: true }));
    }
  }

  /** Whether a view's screen is stale: drawn under another pane mark, or before a person turn. */
  private isStale(entry: ViewEntry): boolean {
    if (entry.view === undefined) return false;
    if (entry.staleTurn === true) return true;
    if (this.deps.paneMark === undefined) return false;
    return entry.mark === undefined || this.deps.paneMark(entry.session) !== entry.mark;
  }

  /** Whether the session holds the trick's current rules: its last start carried the id, under the same mark. */
  private holdsRules(entry: Pick<ViewEntry, "trick" | "session">, rules: string): boolean {
    const key = viewKey(entry.trick, entry.session);
    const proof = this.proofs.get(key);
    if (proof === undefined) return false;
    const markNow = this.deps.paneMark?.(entry.session) ?? null;
    if (proof.rulesId === this.deps.rulesIdOf(entry.trick, rules) && (this.deps.paneMark === undefined || markNow === proof.mark)) return true;
    this.proofs.delete(key);
    return false;
  }

  /** The view as served, and its rev moved when what it serves beside the entry changed since the last look. */
  private servedNoting(entry: ViewEntry): TrickViewSession {
    const served = this.served(entry);
    const key = viewKey(entry.trick, entry.session);
    const now = JSON.stringify([served.on, served.off ?? null, served.stale === true, served.question === true, served.hint ?? null, served.drawing?.at ?? null]);
    const before = this.derived.get(key);
    this.derived.set(key, now);
    if (before !== undefined && before !== now) this.deps.store.touch(entry.trick, entry.session);
    return served;
  }

  private served(entry: ViewEntry): TrickViewSession {
    const gate = this.deps.gate.check(entry.trick);
    const on = entry.on && gate.ok;
    const out: TrickViewSession = { trick: entry.trick, session: entry.session, on };
    if (entry.sent !== undefined && entry.sent.length > 0) out.sent = [...entry.sent];
    if (!on || !gate.ok) {
      out.off = entry.on ? "trick_off" : "switch";
      return out;
    }
    const head = viewHead(entry.trick, entry.session);
    out.head = head;
    if (head === viewHeadBare(entry.trick) || !this.holdsRules(entry, gate.rules)) out.hint = this.hint(entry.trick, entry.session);
    if (entry.view !== undefined) {
      out.view = entry.view;
      if (this.isStale(entry)) out.stale = true;
    }
    if (this.deps.question?.(entry.session) === true) out.question = true;
    const drawing = this.freshDrawing(entry);
    if (drawing !== undefined) out.drawing = drawing;
    return out;
  }

  /**
   * `help`: Collie's core view help and the trick's own rules, from its APPROVED copy, framed so the
   * agent sees where Collie's text ends and the author's begins (rule 10, V-A2). Only to a session whose
   * view of the trick is on and passes the gate: a session that has no view never reads a trick's rules.
   */
  async help(trick: string, session: string): Promise<{ readonly ok: true; readonly session: TrickViewSession; readonly lines: string[] } | ViewRefused> {
    if (this.deps.crewMode() === "peer") return { ok: false, error: VIEW_NOT_ON_LEAD, code: "not_on_lead" };
    const gate = await this.deps.gate.fresh(trick);
    if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
    if (this.deps.store.get(trick, session)?.on !== true) return { ok: false, error: VIEW_OFF_WORDS, code: "view_off" };
    const lines = this.deps.helpOf({ binary: this.deps.binary, trick, name: gate.name, session, rules: gate.rules, rulesId: this.deps.rulesIdOf(trick, gate.rules) });
    return { ok: true, session: this.status(trick, session), lines };
  }

  // ── the agent's writes ─────────────────────────────────────────────────────────────────────────

  /**
   * An agent's write the socket refused (rule 12, review 9 R5): one audit line per reason per minute per
   * (trick, session), so a loop of refused writes cannot flood the audit log. The device is null: an agent.
   * The memory is bounded: when {@link VIEW_REFUSAL_KEYS_MAX} keys are fresh, a new key writes no line.
   */
  noteRefusedWrite(op: string, trick: string, session: string, code: ViewRefusalCode | undefined): void {
    const reason = code ?? "refused";
    const key = `${viewKey(trick, session)}\u0000${reason}`;
    const now = this.now();
    const last = this.refusalLines.get(key);
    if (last !== undefined && now - last < VIEW_REFUSAL_AUDIT_MS) return;
    if (last === undefined && this.refusalLines.size >= VIEW_REFUSAL_KEYS_MAX) {
      for (const [held, at] of this.refusalLines) if (now - at >= VIEW_REFUSAL_AUDIT_MS) this.refusalLines.delete(held);
      if (this.refusalLines.size >= VIEW_REFUSAL_KEYS_MAX) return;
    }
    this.refusalLines.set(key, now);
    this.audit("trick.view.refused", session, null, { trick, reason, op, agent: true });
  }

  /**
   * Whether an agent write may run: the session is on this lead, the (trick, session) is under its cap, the
   * trick passes the gate, and the person's switch is on. Null when it may, else the refusal. Counted first,
   * so a write refused for any reason still counts toward the cap.
   */
  private async admit(trick: string, session: string): Promise<{ readonly entry: ViewEntry; readonly gate: Extract<ViewGate, { ok: true }> } | ViewRefused> {
    if (this.deps.crewMode() === "peer") return { ok: false, error: VIEW_NOT_ON_LEAD, code: "not_on_lead" };
    if (!this.writes.take(viewKey(trick, session))) return { ok: false, error: VIEW_RATE_WORDS, code: "rate" };
    const gate = await this.deps.gate.fresh(trick);
    if (!gate.ok) return { ok: false, error: gate.error, code: gate.code };
    const entry = this.deps.store.get(trick, session);
    if (entry?.on !== true) return { ok: false, error: VIEW_OFF_WORDS, code: "view_off" };
    return { entry, gate };
  }

  /** `start`: the agent says it is drawing, until its show, a clear, the switch going off, or ten minutes. */
  async start(trick: string, session: string, fields: ViewStartFields): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const note = fields.note === null ? null : cleanViewLine(fields.note, VIEW_NOTE_MAX);
    if (fields.note !== null && note === null) return { ok: false, error: `a note is one line of 1 to ${String(VIEW_NOTE_MAX)} characters`, code: "bad_note" };
    const at = new Date(this.now()).toISOString();
    const base = admitted.entry;
    const key = viewKey(trick, session);
    // The rules: this start's id decides, whatever an earlier start said.
    const rulesId = this.deps.rulesIdOf(trick, admitted.gate.rules);
    const before = this.proofs.get(key);
    if (fields.rules === rulesId) this.proofs.set(key, { mark: this.deps.paneMark?.(session) ?? null, rulesId });
    else this.proofs.delete(key);
    // A start inside a run adds its note to the run's list; a start with no run held begins one.
    const prior = this.freshDrawing(base)?.notes ?? [];
    const notes = note === null ? prior : [...prior, { at, note }].slice(-VIEW_NOTES_MAX);
    const drawing: ViewDrawing = note === null ? { at } : { at, note };
    if (notes.length > 0) drawing.notes = notes;
    const answer = this.commit(viewEntry({ ...base, drawing }));
    if (!answer.ok) {
      if (before === undefined) this.proofs.delete(key);
      else this.proofs.set(key, before);
    }
    return answer;
  }

  /** `clear`: the screen and the drawing go, the switch stays, and so does the rules proof's end. */
  async clear(trick: string, session: string): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    this.proofs.delete(viewKey(trick, session));
    const held = admitted.entry;
    if (held.view === undefined && held.drawing === undefined) return { ok: true, session: this.status(trick, session) };
    return this.commit(viewEntry({ trick, session, on: held.on, shows: held.shows, changedAt: this.now(), sent: held.sent }));
  }

  /**
   * `show`: one screen for the caller's view. Checked cheapest first: the title, the picture count, the
   * view and the choice, and only then are the pictures read and written. A refusal anywhere changes nothing.
   */
  async show(trick: string, session: string, fields: ViewShowFields): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const title = fields.title === null ? null : cleanViewLine(fields.title, VIEW_TITLE_MAX);
    if (fields.title !== null && title === null) return { ok: false, error: `a title is one line of 1 to ${String(VIEW_TITLE_MAX)} characters`, code: "bad_title" };
    const named = fields.images ?? [];
    const images = named.length;
    if (images > VIEW_MEDIA_MAX) return { ok: false, error: VIEW_TOO_MANY_IMAGES, code: "too_many_images" };
    const parsed = parseAgentView(fields.view, "/view", { images });
    if (parsed.view === undefined) return { ok: false, error: `the view was refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, VIEW_REFUSALS_SHOWN) };
    const choice = this.choiceOf(fields.choice, images);
    if (!choice.ok) return choice;
    const kept = images === 0 ? null : keepPictures({ keep: this.deps.media, mint: this.mint, held: null, added: named });
    if (kept !== null && !kept.ok) return { ok: false, error: kept.error, code: kept.code };
    const pictures = kept === null ? null : kept.pictures;
    const base = admitted.entry;
    const shows = base.shows + 1;
    const at = new Date(this.now()).toISOString();
    // A show stamps every block fresh and drops everything older.
    const blocks = shownBlocks(parsed.ids ?? parsed.view.map(() => null), at);
    const view = screenOf({ rev: shows, at, title, view: parsed.view, pictures, choice: choice.choice, choiceAt: at, blocks });
    const answer = this.commit(viewEntry({ trick, session, on: base.on, shows, view, mark: this.markNow(session), changedAt: this.now(), sent: base.sent }));
    if (!answer.ok && pictures !== null) this.deps.media?.remove(pictures.set);
    return answer;
  }

  /**
   * `set <id>`: replace one block, or insert it (at the end, first, or after another block). Pictures
   * named here are ADDED to the screen's set, four in all. With no screen yet, the block starts one. The
   * whole screen that results must pass `parseAgentView`, or nothing changes.
   */
  async set(trick: string, session: string, fields: ViewSetFields): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const held = this.liveScreen(admitted.entry);
    const node = singleNode(fields.node, fields.id);
    if ("error" in node) return { ok: false, error: node.error, code: "bad_view" };
    const heldPictures = picturesOf(held);
    const images = (heldPictures?.media.length ?? 0) + fields.images.length;
    if (images > VIEW_MEDIA_MAX) return { ok: false, error: VIEW_TOO_MANY_IMAGES, code: "too_many_images" };
    const at = new Date(this.now()).toISOString();
    const draft = placed(draftOf(held), { node: node.node, block: { id: fields.id, at }, place: fields.place });
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    // The screen is checked with the picture count it will have before any picture is read.
    const checked = checkDraft(draft, images);
    if (checked !== null) return checked;
    const kept = fields.images.length === 0 ? null : keepPictures({ keep: this.deps.media, mint: this.mint, held: heldPictures, added: fields.images });
    if (kept !== null && !kept.ok) return { ok: false, error: kept.error, code: kept.code };
    return this.finish(admitted.entry, { draft, held, pictures: kept === null ? heldPictures : kept.pictures, added: kept === null ? null : kept.pictures.set });
  }

  /** `pending <id> "<label>"`: a placeholder block, a `spacer` in the view and its label in `blocks`. */
  async pending(trick: string, session: string, fields: ViewPendingFields): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const held = this.liveScreen(admitted.entry);
    const block: ViewBlock = { id: fields.id, at: new Date(this.now()).toISOString(), pending: fields.label };
    const draft = placed(draftOf(held), { node: PENDING_NODE, block, place: fields.place });
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    return this.finish(admitted.entry, { draft, held, pictures: picturesOf(held), added: null });
  }

  /** `remove <id>`: one block goes; the last block stays (`clear` takes the screen). */
  async remove(trick: string, session: string, id: string): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const held = this.liveScreen(admitted.entry);
    if (held === undefined) return { ok: false, error: VIEW_NO_SCREEN, code: "no_screen" };
    const draft = removed(draftOf(held), id);
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    return this.finish(admitted.entry, { draft, held, pictures: picturesOf(held), added: null });
  }

  /** `keep <id>... | --all`: those blocks still hold for the current request, re-stamped without being sent again. */
  async keep(trick: string, session: string, ids: readonly string[] | "all"): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const held = this.liveScreen(admitted.entry);
    if (held === undefined) return { ok: false, error: VIEW_NO_SCREEN, code: "no_screen" };
    const at = new Date(this.now()).toISOString();
    if (ids !== "all" && ids.includes(VIEW_CHOICE_BLOCK) && held.choice === undefined) return { ok: false, error: "this screen has no choice to keep", code: "bad_block" };
    const draft = keptBlocks(draftOf(held), { ids, at });
    if ("error" in draft) return { ok: false, error: draft.error, code: "bad_block" };
    const keepChoice = held.choice !== undefined && (ids === "all" || ids.includes(VIEW_CHOICE_BLOCK));
    return this.finish(admitted.entry, { draft, held, pictures: picturesOf(held), added: null, choiceAt: keepChoice ? at : held.choiceAt });
  }

  /** `choice <file> | --clear`: set or drop the decision block alone. */
  async setChoice(trick: string, session: string, raw: JsonValue | null): Promise<ViewOpAnswer> {
    const admitted = await this.admit(trick, session);
    if ("ok" in admitted) return admitted;
    const held = this.liveScreen(admitted.entry);
    if (held === undefined) return { ok: false, error: VIEW_NO_SCREEN, code: "no_screen" };
    const pictures = picturesOf(held);
    if (raw === null) return this.finish(admitted.entry, { draft: draftOf(held), held, pictures, added: null, choice: null });
    const choice = this.choiceOf(raw, pictures?.media.length ?? 0);
    if (!choice.ok) return choice;
    return this.finish(admitted.entry, { draft: draftOf(held), held, pictures, added: null, choice: choice.choice ?? null, choiceAt: new Date(this.now()).toISOString() });
  }

  /** The screen an edit builds on: none when the held one is stale, so an edit never revives a stale screen's buttons. */
  private liveScreen(entry: ViewEntry): ViewScreen | undefined {
    return this.isStale(entry) ? undefined : entry.view;
  }

  /** The pane's mark now, stored with a screen. */
  private markNow(session: string): string | undefined {
    return this.deps.paneMark?.(session) ?? undefined;
  }

  /**
   * Store an edited screen: checked whole, a new rev and `at`, the title kept, the drawing kept (only a
   * show ends a drawing run). A picture set minted for this edit (`added`) is removed again on a refusal.
   * `choice` null drops the decision block, undefined keeps the held one.
   */
  private finish(
    base: ViewEntry,
    edit: { draft: ViewDraft; held: ViewScreen | undefined; pictures: ViewPictureSet | null; added: string | null; choice?: ViewChoice | null; choiceAt?: string | undefined },
  ): ViewOpAnswer {
    const images = edit.pictures?.media.length ?? 0;
    const parsed = parseAgentView([...edit.draft.nodes], "/view", { images });
    const drop = () => {
      if (edit.added !== null) this.deps.media?.remove(edit.added);
    };
    if (parsed.view === undefined) {
      drop();
      return { ok: false, error: `the screen would be refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, VIEW_REFUSALS_SHOWN) };
    }
    const shows = base.shows + 1;
    const at = new Date(this.now()).toISOString();
    const choice = edit.choice === undefined ? edit.held?.choice : (edit.choice ?? undefined);
    const choiceAt = choice === undefined ? undefined : (edit.choiceAt ?? edit.held?.choiceAt ?? at);
    const view = screenOf({ rev: shows, at, title: edit.held?.title ?? null, view: parsed.view, pictures: edit.pictures, choice, choiceAt, blocks: [...edit.draft.blocks] });
    const answer = this.commit(viewEntry({ trick: base.trick, session: base.session, on: base.on, shows, changedAt: this.now(), view, drawing: base.drawing, mark: this.markNow(base.session), sent: base.sent }));
    if (!answer.ok) drop();
    return answer;
  }

  /** The bytes of one picture of a view that is on, passes the gate, and is not stale. Every miss is null. */
  mediaFile(set: string, mediaId: string): ViewMediaFile | null {
    if (!VIEW_SET_RE.test(set) || !VIEW_MEDIA_ID_RE.test(mediaId) || this.deps.media === undefined) return null;
    const entry = this.deps.store.all().find((held) => held.view?.set === set);
    if (entry?.view === undefined || !entry.on || !this.deps.gate.check(entry.trick).ok || this.isStale(entry)) return null;
    const media = entry.view.media?.find((item) => item.id === mediaId);
    if (media === undefined) return null;
    const bytes = this.deps.media.bytesOf(set, media);
    return bytes === null ? null : { bytes, mime: media.mime };
  }

  /** Remove every picture set no held screen names: at boot, as the hill prunes its media. */
  pruneMedia(): void {
    this.deps.media?.prune(heldSets(this.deps.store.all()));
  }

  /** The decision block, read with the screen's picture count; undefined for none. */
  private choiceOf(raw: JsonValue | undefined, images: number): { readonly ok: true; readonly choice: ViewChoice | undefined } | ViewRefused {
    if (raw === undefined) return { ok: true, choice: undefined };
    const parsed = parseViewChoice(raw, "/choice", { images });
    if (parsed.choice === undefined) return { ok: false, error: `the choice was refused: ${refusalWords(parsed.refusals)}`, code: "bad_choice", refusals: parsed.refusals.slice(0, VIEW_REFUSALS_SHOWN) };
    return { ok: true, choice: parsed.choice };
  }

  // ── the person's switch ────────────────────────────────────────────────────────────────────────

  /**
   * The phone's switch: the address is resolved to the live session it names here, then switched. On needs
   * the trick's gate; it turns every other trick's view of that session off (one view on per session). Off
   * ends the drawing, the screen and the rules proof. One audit line either way.
   */
  async switch(body: TrickViewSwitchBody, device: string | null): Promise<ViewSwitchAnswer> {
    if (this.deps.crewMode() === "peer") return { ok: false, status: 400, error: VIEW_NOT_ON_LEAD, code: "not_on_lead" };
    const where = this.deps.place(body.session);
    if (where === null) return { ok: false, status: 404, error: VIEW_NO_SESSION, code: "wrong_session" };
    const session = where.address;
    if (body.on) {
      const gate = await this.deps.gate.fresh(body.trick);
      if (!gate.ok) {
        this.audit("trick.view.refused", session, device, { trick: body.trick, reason: gate.code, switch: true });
        return { ok: false, status: 409, error: gate.error, code: gate.code };
      }
      if (this.deps.readable !== undefined && !(await this.deps.readable(session))) {
        this.audit("trick.view.refused", session, device, { trick: body.trick, reason: "no_profile", switch: true });
        return { ok: false, status: 409, error: VIEW_NO_PROFILE, code: "no_profile" };
      }
    }
    this.proofs.delete(viewKey(body.trick, session));
    const held = this.deps.store.get(body.trick, session);
    const next = body.on
      ? viewEntry({ ...(held ?? { trick: body.trick, session, shows: 0, changedAt: 0 }), on: true, changedAt: this.now() })
      : viewEntry({ trick: body.trick, session, on: false, shows: held?.shows ?? 0, changedAt: this.now(), sent: held?.sent });
    const answer = this.commit(next);
    if (!answer.ok) return { ok: false, status: 503, error: answer.error, code: answer.code };
    if (body.on) {
      for (const other of this.deps.store.all()) {
        if (other.session !== session || other.trick === body.trick || !other.on) continue;
        this.proofs.delete(viewKey(other.trick, session));
        this.commit(viewEntry({ trick: other.trick, session, on: false, shows: other.shows, changedAt: this.now(), sent: other.sent }));
      }
    }
    this.audit("trick.view.switch", session, device, { trick: body.trick, on: body.on });
    return { ok: true, session: this.status(body.trick, session) };
  }

  // ── the person's send ──────────────────────────────────────────────────────────────────────────

  /**
   * Admit one send from a view, and build its line from the bridge's own stored screen (rule 2). `own` is
   * the address of the pane the send targets, from the bridge's own panes; the field's session must name
   * it. A tap needs the stored rev exactly (rule 6), a screen that is not stale, a control that names a
   * button or an option on it, and no question waiting (rule 5). Typed text gets the head only while no
   * question waits: then it goes as the person's own answer, plain (lead addition 2). A command (`/`, `!`,
   * `@`) goes plain too, as the harness reads its words as its own. One send in flight per session, 20 a minute.
   */
  async prepareSend(input: { readonly field: ViewSendField; readonly own: string; readonly typed: string | null; readonly device: string | null }): Promise<ViewSendPlan | ViewSendRefused> {
    const { field, own, device } = input;
    const refuse = (code: ViewRefusalCode, error: string): ViewSendRefused => {
      this.audit("trick.view.refused", own, device, { trick: field.trick, reason: code });
      return { ok: false, code, error };
    };
    if (this.deps.crewMode() === "peer") return refuse("not_on_lead", VIEW_NOT_ON_LEAD);
    if (!sameSession({ own, given: field.session })) return refuse("wrong_session", wrongSessionWords({ own, given: field.session }));
    const session = own;
    const gate = await this.deps.gate.fresh(field.trick);
    if (!gate.ok) return refuse(gate.code, gate.error);
    const entry = this.deps.store.get(field.trick, session);
    if (entry?.on !== true) return refuse("view_off", VIEW_OFF_WORDS);
    const tap = field.rev !== undefined && field.control !== undefined;
    const question = this.deps.question?.(session) === true;
    let line: string;
    let plain = false;
    let words: string | null = null;
    if (tap) {
      if (entry.view === undefined || this.isStale(entry) || entry.view.rev !== field.rev) return refuse("stale_view", VIEW_STALE_WORDS);
      if (entry.picked === field.rev) return refuse("stale_view", VIEW_PICKED_WORDS);
      words = viewTapWords(entry.view, field.control ?? "");
      if (words === null) return refuse("bad_control", VIEW_BAD_CONTROL_WORDS);
      if (hasViewHead(words)) return refuse("bad_head", BAD_HEAD);
      if (question) return refuse("question", VIEW_QUESTION_WORDS);
      line = this.withHeadAndTail(entry, gate.rules, words);
    } else {
      const typed = (input.typed ?? "").trim();
      if (typed === "") return refuse("bad_control", "a send from a view carries a tap or typed text");
      // The view's own request carries a head, so the Send Protocol does not read its text for one: a head
      // on any line of the typed words would be a second head typed through the one door (review 9 R1).
      if (hasViewHead(typed)) return refuse("bad_head", BAD_HEAD);
      // The person's own typing is never refused for the session's state (lead addition 2): with a
      // question open, a turn running or a command, it goes as their plain send, with no head.
      plain = question || this.deps.working?.(session) === true || isCommand(typed);
      line = plain ? typed : this.withHeadAndTail(entry, gate.rules, typed);
    }
    if (this.sending.has(session)) return refuse("busy", VIEW_BUSY_WORDS);
    if (!this.sends.take(session)) return refuse("rate", VIEW_SEND_RATE_WORDS);
    this.sending.add(session);
    const trick = field.trick;
    const rev = field.rev;
    const control = field.control ?? "";
    let ended = false;
    return {
      ok: true,
      trick,
      session,
      kind: tap ? "tap" : "text",
      line,
      plain,
      check: () => {
        // Under the pane lock, right before the first key: the gate, the switch and, for a tap, the very
        // screen the person tapped. Nothing here waits on a scan.
        const now = this.deps.store.get(trick, session);
        if (!this.deps.gate.check(trick).ok) return "the trick is off now; nothing was sent";
        if (now?.on !== true) return VIEW_OFF_WORDS;
        if (!tap) return null;
        if (now.view === undefined || now.view.rev !== rev || this.isStale(now) || viewTapWords(now.view, control) !== words) return VIEW_STALE_WORDS;
        if (now.picked === rev) return VIEW_PICKED_WORDS;
        return null;
      },
      done: (end) => {
        if (ended) return;
        ended = true;
        this.sending.delete(session);
        const landed = end.sent ? undefined : end.landed;
        if (!end.sent && landed === undefined) {
          this.audit("trick.view.refused", session, device, { trick, reason: end.reason ?? "refused", rid: end.rid });
          return;
        }
        // Keys that landed are kept with how they ended, and their screen takes no second tap: a second
        // tap would type the line again behind the first (review 9 R7).
        const kept: ViewSent = { rid: end.rid, at: new Date(this.now()).toISOString(), kind: tap ? "tap" : "text", line };
        this.keepSent(trick, session, landed === undefined ? kept : { ...kept, outcome: landed }, tap ? rev : undefined);
        // Text left in the box started no turn; `unknown` may have.
        if (landed !== "typed_not_submitted") {
          if (plain) this.notePersonTurn(session);
          else this.ownTurns.set(session, this.now() + VIEW_OWN_TURN_MS);
        }
        const detail: ViewAuditEntry["detail"] = { trick, rid: end.rid, kind: tap ? "tap" : "text", plain };
        this.audit("trick.view.send", session, device, landed === undefined ? detail : { ...detail, outcome: landed });
      },
    };
  }

  /** `<head> <words>`, and ` <tail>` while the session does not hold the trick's rules. One line for a tap. */
  private withHeadAndTail(entry: ViewEntry, rules: string, words: string): string {
    const head = viewHead(entry.trick, entry.session);
    const tail = head === viewHeadBare(entry.trick) || !this.holdsRules(entry, rules) ? ` ${this.hint(entry.trick, entry.session)}` : "";
    return `${head} ${words}${tail}`;
  }

  /** Keep one sent line on its view, newest last. A write that fails keeps the send: it went out. */
  /** Keeps a typed line; `picked` is the rev of the screen a tap went from, which then takes no second tap. */
  private keepSent(trick: string, session: string, sent: ViewSent, picked: number | undefined): void {
    const entry = this.deps.store.get(trick, session);
    if (entry === undefined) return;
    this.deps.store.put(viewEntry({ ...entry, picked: picked ?? entry.picked, sent: [...(entry.sent ?? []), sent].slice(-VIEW_SENT_MAX), changedAt: this.now() }));
  }

  private audit(action: ViewAuditEntry["action"], session: string, device: string | null, detail: ViewAuditEntry["detail"]): void {
    try {
      this.deps.audit?.({ action, session, device, detail });
    } catch (err) {
      console.warn(`[trick-views] the audit line could not be written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── the store ──────────────────────────────────────────────────────────────────────────────────

  /** Write one changed view, and drop the views that say nothing or whose session is gone. */
  private commit(changed: ViewEntry): ViewOpAnswer {
    const entry = viewEntry({ ...changed, changedAt: this.now() });
    const known = this.deps.sessionsKnown();
    const keep = this.worthKeeping(entry);
    const saved = keep ? this.deps.store.put(entry) : this.deps.store.drop(entry.trick, entry.session);
    if (!saved) return { ok: false, error: VIEW_UNSAVED, code: "unsaved" };
    for (const held of this.deps.store.all()) {
      if (held.trick === entry.trick && held.session === entry.session) continue;
      if (!this.worthKeeping(held) || (known && this.deps.place(held.session) === null)) this.deps.store.drop(held.trick, held.session);
    }
    // A set no held screen names goes with the write that dropped it, as the hill prunes on write.
    this.deps.media?.prune(heldSets(this.deps.store.all()));
    return { ok: true, session: this.status(entry.trick, entry.session) };
  }

  /** A drawing counts for ten minutes: checked when it is read, with no timer. */
  private freshDrawing(entry: ViewEntry): ViewDrawing | undefined {
    if (entry.drawing === undefined) return undefined;
    const age = this.now() - Date.parse(entry.drawing.at);
    return age < VIEW_DRAWING_MAX_MS ? entry.drawing : undefined;
  }

  /** A view says something while it is on, a screen is up, a write was counted, a drawing is fresh, or a sent line is kept. */
  private worthKeeping(entry: ViewEntry): boolean {
    return entry.on || entry.view !== undefined || entry.shows > 0 || this.freshDrawing(entry) !== undefined || (entry.sent?.length ?? 0) > 0;
  }
}

function heldSets(entries: readonly ViewEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => (entry.view?.set === undefined ? [] : [entry.view.set])));
}

/** The refusal for a draft whose whole screen does not pass, or null when it passes. */
function checkDraft(draft: ViewDraft, images: number): ViewRefused | null {
  const parsed = parseAgentView([...draft.nodes], "/view", { images });
  if (parsed.view !== undefined) return null;
  return { ok: false, error: `the screen would be refused: ${refusalWords(parsed.refusals)}`, code: "bad_view", refusals: parsed.refusals.slice(0, VIEW_REFUSALS_SHOWN) };
}

/** A `trick.view.start` request's fields, as the socket carries them: an optional `note` and an optional `rules` id. */
export interface ViewStartFields {
  readonly note: string | null;
  /** The rules id the session says it holds. Null for none; a value that is not text reads as none. */
  readonly rules?: string | null;
}

/** A `trick.view.start` request's fields: the note and the rules id, or the reason the note is not one. */
export function readStartFields(fields: JsonObject): ViewStartFields | { readonly error: string } {
  const note = fields.note === undefined || fields.note === null ? null : asJsonString(fields.note);
  if (note === undefined) return { error: "a note is text" };
  // A wrong rules id is never a refusal: the start works, and the session gets the tail.
  const rules = asJsonString(fields.rules) ?? null;
  return { note, rules };
}

/** One screen built from its parts: the pictures, the choice and the blocks are on it only when given. */
export function screenOf(parts: {
  rev: number;
  at: string;
  title: string | null;
  view: ViewScreen["view"];
  pictures: ViewPictureSet | null;
  choice: ViewChoice | undefined;
  choiceAt?: string | undefined;
  blocks?: ViewBlock[];
}): ViewScreen {
  const screen: ViewScreen = { rev: parts.rev, at: parts.at, view: parts.view };
  if (parts.title !== null) screen.title = parts.title;
  if (parts.pictures !== null) {
    screen.set = parts.pictures.set;
    screen.media = [...parts.pictures.media];
  }
  if (parts.choice !== undefined) {
    screen.choice = parts.choice;
    screen.choiceAt = parts.choiceAt ?? parts.at;
  }
  if (parts.blocks !== undefined) screen.blocks = parts.blocks;
  return screen;
}

/** The sentence an edit of a view with no screen yet is refused with. */
export const VIEW_NO_SCREEN = "this view has no screen yet; draw one with `show` first";

/** A screen's picture set, or null. */
function picturesOf(view: ViewScreen | undefined): ViewPictureSet | null {
  return view?.set === undefined || view.media === undefined ? null : { set: view.set, media: view.media };
}

/**
 * The ONE node of a `set`: a node, or a list of exactly one. A node may carry `id` only when it is the
 * block's own id (as a `show` file would spell it); it is taken off, since the schema refuses it.
 */
export function singleNode(raw: JsonValue, id: string): { readonly node: JsonValue } | { readonly error: string } {
  const one = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  const obj = asJsonObject(one);
  if (obj === undefined) return { error: "a block is ONE node, or a list of exactly one" };
  if (obj.id === undefined) return { node: obj };
  const { id: named, ...node } = obj;
  if (named !== id) return { error: `the node names the block "${asJsonString(named) ?? "?"}", the command names "${id}"` };
  return { node };
}

/** A `trick.view.show` request's fields, as the socket carries them: `view` and `choice` (any JSON), an optional `title`, and `images`. */
export function readShowFields(fields: JsonObject): ViewShowFields | ViewFieldError {
  const title = fields.title === undefined || fields.title === null ? null : asJsonString(fields.title);
  if (title === undefined) return { error: "a title is text", code: "bad_title" };
  const images = readImageFields(fields.images);
  if ("error" in images) return images;
  if (fields.choice === undefined || fields.choice === null) return { view: fields.view, title, images };
  return { view: fields.view, title, images, choice: fields.choice };
}
