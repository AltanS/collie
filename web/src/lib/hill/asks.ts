// ASKS, AS THE PHONE GROUPS AND READS THEM (2026-11-23). An ask is a Decision with the `ask` field (wire.ts); this file
// holds the pure rules the three pages share: which Decisions are asks, how they group by session, in what order the
// sessions stand, what a session's header says, where one ask sits among its session's, what an answer marked on this
// phone comes to, and how the asks a Send closed fold into one line. No I/O, no React: the pages and the tests call it.

import { cacheChipView } from "../cache-view";
import { paneGitHead } from "../git-head";
import { paneScope } from "../hosts";
import { t } from "../i18n";
import { panePath } from "../nav";
import { panePlace, paneName } from "../pane-name";
import { activityAt } from "../pane-order";
import type { Scope } from "../scope";
import type { AgentStatus, AgentView, ServerSummary, SessionSummary } from "../types";
import { livePaneAt, type WalkyLivePanes } from "../walky-names";
import { NO_DRAFT, type AskDraft } from "./asks-drafts";
import { answersMessage, answersMessageLength, answersMessageOver, type MarkedAnswer } from "./answers-message";
import { HILL_ASK_CLEARED, HILL_OWN_ANSWER, HILL_OWN_ANSWER_LABEL } from "./asks-standin";
import { askTakenBackBecause, HILL_ANSWERS_MAX, HILL_ANSWERS_MESSAGE_MAX, HILL_ASK_ANSWERED_HERE, HILL_MORE_CONTEXT, HILL_MORE_CONTEXT_LABEL, isAsk, type HillAsk, type HillAskFile, type HillDecision } from "./wire";

/** A Decision known to be an ask: the `ask` field is there. */
export type AskDecision = HillDecision & { ask: HillAsk };

/** The open asks of a list, in the list's order. */
export function openAsksOf(open: readonly HillDecision[]): AskDecision[] {
  return open.filter((decision): decision is AskDecision => isAsk(decision));
}

/** Every open Decision that is no ask: a trick's card, Collie's own cards, a Decision an agent posted with the old verb. */
export function openCardsOf(open: readonly HillDecision[]): HillDecision[] {
  return open.filter((decision) => !isAsk(decision));
}

/** The key of an ask's session: the sender's address, which the bridge keeps one Send to (`mixed_sessions`). */
export function sessionKeyOf(decision: Pick<HillDecision, "from">): string {
  return decision.from.address ?? decision.from.label;
}

/** One session's asks, oldest first: the order "2 of 4" counts in and "Later" walks. */
export interface AskSession {
  key: string;
  /** The name the sender gave itself (walky's label), for a session Collie no longer lists. */
  label: string;
  asks: AskDecision[];
  /** When the newest of them arrived, ms. */
  newest: number;
}

/** The asks of a list grouped by session. The sessions come in the order of their first ask; `orderSessions` stands them. */
export function groupAsks(asks: readonly AskDecision[]): AskSession[] {
  const byKey = new Map<string, AskSession>();
  for (const ask of asks.toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    const key = sessionKeyOf(ask);
    const held = byKey.get(key);
    if (held === undefined) byKey.set(key, { key, label: ask.from.label, asks: [ask], newest: ask.at });
    else {
      held.asks.push(ask);
      held.newest = Math.max(held.newest, ask.at);
    }
  }
  return [...byKey.values()];
}

/**
 * When the person last worked with a session: the pane's activity (the later of its last status change and the last
 * time they opened or drove it, `activityAt`, the reading the Dashboard's activity order takes), or for a session Collie
 * no longer lists, or one that reports no activity, the time of its newest ask.
 */
export function recencyOf(session: AskSession, live: WalkyLivePanes): number {
  const pane = livePaneAt(session.key, live);
  const at = pane === null ? 0 : activityAt(pane);
  return at > 0 ? at : session.newest;
}

/**
 * The sessions in the order the page draws them: the ones the person worked with last first. `held` is the order the
 * page drew before: a session in it keeps its place, so a session that finishes a turn while the list is on screen
 * does not climb past the row under a thumb (the rule of lib/pane-order.ts); a session new to the list goes on top, the
 * freshest first; one with no ask left drops out. The first draw has no `held` and takes the plain order.
 */
export function orderSessions(sessions: readonly AskSession[], live: WalkyLivePanes, held: readonly string[] = []): AskSession[] {
  const rank = new Map(held.map((key, index) => [key, index]));
  const fresh = (a: AskSession, b: AskSession): number => recencyOf(b, live) - recencyOf(a, live) || b.newest - a.newest || a.key.localeCompare(b.key);
  const known = sessions.filter((session) => rank.has(session.key)).toSorted((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  const added = sessions.filter((session) => !rank.has(session.key)).toSorted(fresh);
  return [...added, ...known];
}

/** What a session's header says. */
export interface SessionFacts {
  /** The name the Dashboard's row gives the pane (`paneName`), else the sender's own label. */
  name: string;
  /** What the session works on: the Dashboard row's second line (`panePlace`, `space › tab`), then the branch when the folder is on one. Null for a gone session. */
  line: string | null;
  /** The pane's status as the Dashboard says it, null for a gone session. */
  status: AgentStatus | null;
  /** The state in one word, as the Dashboard says it ("working", "needs you"), null for a gone session. */
  stateWord: string | null;
  /** Collie no longer lists the session (or its pane id went to another instance). No link opens it. */
  gone: boolean;
  /** The live pane, null when `gone`. */
  pane: AgentView | null;
}

/** The Dashboard's word for each status (`status.label.*`). */
function statusWordOf(status: AgentStatus): string {
  switch (status) {
    case "blocked":
      return t("status.label.blocked");
    case "working":
      return t("status.label.working");
    case "idle":
      return t("status.label.idle");
    case "done":
      return t("status.label.done");
    case "unknown":
      return t("status.label.unknown");
  }
}

/** A session's header facts, read from the live panes. */
export function sessionFacts(session: Pick<AskSession, "key" | "label">, live: WalkyLivePanes): SessionFacts {
  const pane = livePaneAt(session.key, live);
  if (pane === null) return { name: session.label, line: null, status: null, stateWord: null, gone: true, pane: null };
  const head = paneGitHead(pane);
  const parts = [panePlace(pane), head?.kind === "branch" ? head.name : null].filter((part): part is string => part !== null && part !== "");
  return { name: paneName(pane), line: parts.length === 0 ? null : parts.join(" \u00b7 "), status: pane.status, stateWord: statusWordOf(pane.status), gone: false, pane };
}

/**
 * The route that opens the session's pane, the way the switcher and the Walky name chip open one: the pane's own host
 * and session in the scope, never the ambient one (`paneScope`). `scope`, `servers` and `sessions` are the root data's.
 */
export function sessionOpenPath(pane: Pick<AgentView, "paneId" | "host" | "session">, scope: Scope, servers: readonly ServerSummary[] | undefined, sessions?: readonly SessionSummary[]): string {
  return panePath(pane.paneId, paneScope(scope, pane, servers, sessions));
}

/** One session's prompt cache as the alert "Cache about to go cold" and the chip read it (`AgentView.cache`). */
export type SessionCache = { state: "warm" | "cold" | "unknown"; msLeft?: number };

/**
 * The cache of a session's pane: `warm` with the time left (an `expiring` reading counts as warm, the chip's amber is a
 * tone), `cold`, or `unknown` (no pane, no reading, an `unknown` state, no adapter for the harness, a reading with no
 * expiry). Decided by `cacheChipView`, the one rule the Dashboard chip uses, so this and the chip never disagree.
 */
export function cacheOf(pane: Pick<AgentView, "cache"> | null, now: number): SessionCache {
  const view = pane === null ? null : cacheChipView(pane.cache, now);
  if (view === null) return { state: "unknown" };
  if (view.tone === "cold") return { state: "cold" };
  const expiresAt = pane?.cache?.expiresAt;
  return expiresAt === undefined ? { state: "warm" } : { state: "warm", msLeft: Math.max(0, expiresAt - now) };
}

/** Where an ask sits among its session's open asks: 1-based, and how many there are. Null when it is not among them. */
export function positionOf(asks: readonly Pick<HillDecision, "id">[], id: string): { index: number; count: number } | null {
  const at = asks.findIndex((ask) => ask.id === id);
  return at === -1 ? null : { index: at + 1, count: asks.length };
}

/** The ask after `id` in the session's order, or null on the last one (or an id that is not there). */
export function nextAsk<T extends Pick<HillDecision, "id">>(asks: readonly T[], id: string): T | null {
  const at = asks.findIndex((ask) => ask.id === id);
  return at === -1 ? null : (asks[at + 1] ?? null);
}

/** The words of a `--words` answer for a row: its first words, ended with an ellipsis when there are more. */
export function wordsPreview(text: string, max = 6): string {
  const words = text.trim().split(/\s+/u).filter((word) => word !== "");
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")}…`;
}

/**
 * What the draft comes to as an answer, or null when it is none. An ask with options is answered by a marked option or
 * by `more-context`; a note alone is no answer. A `--words` ask is answered while its field is not empty. A mark that
 * names an option the ask no longer has is no answer.
 */
export function markedAnswer(ask: AskDecision, draft: AskDraft): MarkedAnswer | null {
  const text = draft.text.trim();
  if (ask.ask.words) return text === "" ? null : { ask, intent: "answer", text };
  if (draft.intent === null) return null;
  // "Your own answer" is its text: with no words it is no answer.
  if (draft.intent === HILL_OWN_ANSWER) return text === "" ? null : { ask, intent: HILL_OWN_ANSWER, text };
  const known = draft.intent === HILL_MORE_CONTEXT || ask.options.some((option) => option.intent === draft.intent);
  if (!known) return null;
  return { ask, intent: draft.intent, text: text === "" ? null : text };
}

/** The label of a marked answer, as the row and the review say it: the option's label, "I need more context", or the first words. */
export function answerLabel(answer: MarkedAnswer): string {
  if (answer.intent === HILL_MORE_CONTEXT) return HILL_MORE_CONTEXT_LABEL;
  if (answer.intent === HILL_OWN_ANSWER) return HILL_OWN_ANSWER_LABEL;
  if (answer.intent === "answer") return wordsPreview(answer.text ?? "");
  return answer.ask.options.find((option) => option.intent === answer.intent)?.label ?? answer.intent;
}

/** The marked answers of a session's open asks, in the session's order. */
export function markedAnswersOf(asks: readonly AskDecision[], drafts: ReadonlyMap<string, AskDraft>): MarkedAnswer[] {
  return asks.flatMap((ask) => {
    const answer = markedAnswer(ask, drafts.get(ask.id) ?? NO_DRAFT);
    return answer === null ? [] : [answer];
  });
}

/** The option the poster recommends, or undefined. */
export function recommendedOption(ask: Pick<HillDecision, "options" | "recommends">): HillDecision["options"][number] | undefined {
  const intent = ask.recommends?.intent;
  return intent === undefined ? undefined : ask.options.find((option) => option.intent === intent);
}

/** The asks one Send closed, as one line: they share the answer's request id (`answer.rid`). */
export interface AskFold {
  /** The session's key. */
  key: string;
  rid: string;
  /** The closed asks, the first answered first. */
  asks: AskDecision[];
  /** When the Send answered the last of them, ms. */
  at: number;
}

/**
 * The folds of the closed asks the bridge still serves: one per Send of one session. A closed ask that was not answered
 * (taken back, replaced, answered in the session) has no answer and no fold; it is not a sent answer. Newest first.
 */
export function foldsOf(closed: readonly HillDecision[]): AskFold[] {
  const folds = new Map<string, AskFold>();
  for (const decision of closed) {
    if (!isAsk(decision) || decision.state !== "answered" || decision.answer === null) continue;
    const key = sessionKeyOf(decision);
    const id = `${key}\n${decision.answer.rid}`;
    const held = folds.get(id);
    if (held === undefined) folds.set(id, { key, rid: decision.answer.rid, asks: [decision], at: decision.answer.at });
    else {
      held.asks.push(decision);
      held.at = Math.max(held.at, decision.answer.at);
    }
  }
  for (const fold of folds.values()) fold.asks.sort((a, b) => (a.answer?.at ?? 0) - (b.answer?.at ?? 0) || a.at - b.at);
  return [...folds.values()].toSorted((a, b) => b.at - a.at);
}

/**
 * Why an ask is closed, in the cases the page words differently. `replaced.by` is the id of the ask that took its place, so
 * the page can link to it; `takenBack.because` is the agent's own reason when it gave one.
 */
export type ClosedAskWhy =
  | { kind: "answered"; label: string | null }
  | { kind: "answeredHere" }
  | { kind: "cleared" }
  | { kind: "takenBack"; because: string | null }
  | { kind: "replaced"; by: string | null }
  | { kind: "gone" }
  | { kind: "closed" };

/** Why a closed ask closed, or null for an open one. */
export function closedAskWhy(ask: Pick<HillDecision, "state" | "closedReason" | "supersededBy" | "answer">): ClosedAskWhy | null {
  switch (ask.state) {
    case "open":
      return null;
    case "answered":
      return { kind: "answered", label: ask.answer?.label ?? null };
    case "superseded":
      return { kind: "replaced", by: ask.supersededBy };
    case "undeliverable":
      return { kind: "gone" };
    case "withdrawn":
      if (ask.closedReason === HILL_ASK_ANSWERED_HERE) return { kind: "answeredHere" };
      if (ask.closedReason === HILL_ASK_CLEARED) return { kind: "cleared" };
      if (ask.closedReason?.includes("session ended") === true) return { kind: "gone" };
      return { kind: "takenBack", because: askTakenBackBecause(ask.closedReason) };
    case "dismissed":
    case "expired":
      return { kind: "closed" };
  }
}

/** What the review of one session's marks comes to. */
export interface AsksReview {
  /** The marked answers, in the session's order. */
  answers: MarkedAnswer[];
  count: number;
  /** The exact text the bridge types (`answersMessage`): the answers, then a line for each open ask left out. */
  message: string;
  length: number;
  max: number;
  /** How many characters over the limit; 0 when it fits. */
  over: number;
  tooLong: boolean;
  /** No answer marked, or more than a Send takes (`HILL_ANSWERS_MAX`): Send is disabled. */
  canSend: boolean;
}

/** The review of a session's open asks and the marks on this phone. Never builds the text itself. */
export function reviewOf(open: readonly AskDecision[], drafts: ReadonlyMap<string, AskDraft>): AsksReview {
  const answers = markedAnswersOf(open, drafts);
  const message = answersMessage(answers, open);
  const over = answersMessageOver(message);
  return { answers, count: answers.length, message, length: answersMessageLength(message), max: HILL_ANSWERS_MESSAGE_MAX, over, tooLong: over > 0, canSend: answers.length > 0 && answers.length <= HILL_ANSWERS_MAX && over === 0 };
}

/** The Files request a linked file needs, and whether this device can make it. */
export interface AskFileRequest {
  /** The pane id Files hangs the path under (`ask.root`). */
  paneId: string;
  /** The scope of that pane: the crew member's id as `host`, absent for the lead's own pane. */
  scope: Scope;
  path: string;
  heading?: string;
  line?: number;
}

/**
 * The Files request of one linked file, or null when none can be made: the ask has no `root` (the poster's pane had no
 * Files root, or a crew member forwarded the ask and the lead cannot see its disk). `lead` is the lead's member id, so
 * a file on the lead's own machine gets the bare scope. The caller adds the device's own check, `mayOpenFile`.
 */
export function askFileRequest(ask: Pick<HillDecision, "from"> & { ask: HillAsk }, file: HillAskFile, lead: string | undefined): AskFileRequest | null {
  if (ask.ask.root === null) return null;
  const member = ask.from.memberId;
  const scope: Scope = member === null || member === lead ? {} : { host: member };
  const request: AskFileRequest = { paneId: ask.ask.root, scope, path: file.path };
  if (file.heading !== undefined) request.heading = file.heading;
  if (file.line !== undefined) request.line = file.line;
  return request;
}

/**
 * Whether this device may open a linked file in Files: the ask names a root, the session's pane is live (Files reads
 * through a live pane), that pane reports a folder (the Files button's own check, `agent?.cwd`), and the machine has a
 * screen (`paneGrid`, the Dashboard's `screenless` is false). `screenless` comes from `useMuxCapability` in the caller.
 */
export function mayOpenFile(ask: Pick<HillAsk, "root">, facts: Pick<SessionFacts, "pane">, screenless: boolean): boolean {
  return ask.root !== null && !screenless && facts.pane !== null && facts.pane.cwd !== "";
}
