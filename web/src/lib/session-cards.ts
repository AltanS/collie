import { useSyncExternalStore } from "react";

import { leadHost } from "@/lib/hosts";
import { normalizeHost, normalizeSession, scopeKey, type Scope } from "@/lib/scope";
import type { ServerSummary, SessionState, SessionSummary } from "@/lib/types";

// THE SESSION CARDS (M55): what the snapshot's `sessions` array says about each session, held per
// (host, session) so a control anywhere in the app can ask "what is this session?" without the
// snapshot in its props.
//
// One session is either a terminal session (a multiplexer) or a program session (a durable program),
// and since M55 one Collie can carry both. The card says which, and carries that session's own
// capability set, so lib/mux-capability.ts can answer a capability per (host, session) with no
// second request.
//
// ── WHO WRITES IT ───────────────────────────────────────────────────────────────────────────────
//
// The root loader, on every snapshot it hands the routes (lib/loaders.ts `toHomeData`), the saved copy
// included. A card is replaced only when what it says changed, so the getter below hands back the
// same object between polls, the stability `useSyncExternalStore` asks of every getter.
//
// ── THE KEY ─────────────────────────────────────────────────────────────────────────────────────
//
// `scopeKey`, the same (host, session) key every other per-scope cache uses. The lead's own sessions
// carry the lead's id on a crew snapshot and no host on a solo one; both normalise to "no host", the
// spelling a scope on the lead has. The primary session is filed twice: under its name and under "no
// session", because a scope on the primary names no session (lib/hosts.ts `paneScope`).
//
// ── ABSENT IS TODAY ─────────────────────────────────────────────────────────────────────────────
//
// A bridge older than M55 sends rows with no card fields. Such a row reads as a terminal session with
// no capability set of its own, which is what every session was before: lib/mux-capability.ts then
// asks `/api/config` as it always did.

const cards = new Map<string, SessionSummary>();
// The lead's member id on a crew, as the last snapshot named it, so a scope that spells the lead by its
// id (a lead pane's own `host`) finds the cards filed under "no host". Undefined on a solo install.
let lead: string | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** What a card says, as one comparable string. The counts are left out: they move on every poll. */
function signature(s: SessionSummary): string {
  const caps = s.caps === undefined ? "" : JSON.stringify(Object.entries(s.caps).toSorted(([a], [b]) => a.localeCompare(b)));
  return [s.name, s.isPrimary, s.reachable, s.kind ?? "", s.mux ?? "", s.where ?? "", s.state ?? "", s.experimental ?? "", caps, s.notice ?? ""].join("\n");
}

/** A host as the cards are filed under it: none for the lead, whether it is spelled or not. */
function fileHost(host: string | undefined): string | undefined {
  const h = normalizeHost(host);
  return h === undefined || h === lead ? undefined : h;
}

/**
 * File a snapshot's sessions. Called by the root loader on every snapshot. A card that says what it
 * said before keeps its object, so nothing re-renders on a poll that changed only the counts.
 */
export function noteSessionCards(
  sessions: readonly SessionSummary[] | undefined,
  servers: readonly ServerSummary[] | undefined,
): void {
  if (sessions === undefined || sessions.length === 0) return;
  lead = leadHost(servers);
  let changed = false;
  const file = (key: string, s: SessionSummary) => {
    const held = cards.get(key);
    if (held !== undefined && signature(held) === signature(s)) return;
    cards.set(key, s);
    changed = true;
  };
  for (const s of sessions) {
    const host = fileHost(s.host);
    file(scopeKey({ host, session: s.name }), s);
    if (s.isPrimary) file(scopeKey({ host }), s);
  }
  if (changed) emit();
}

/** The card for the session a scope names, or `null` when no snapshot has described it. */
export function getSessionCard(scope?: Scope): SessionSummary | null {
  return cards.get(scopeKey({ host: fileHost(scope?.host), session: normalizeSession(scope?.session) })) ?? null;
}

export function subscribeSessionCards(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** {@link getSessionCard}, as a hook that re-renders when the card changes. */
export function useSessionCard(scope?: Scope): SessionSummary | null {
  const get = () => getSessionCard(scope);
  return useSyncExternalStore(subscribeSessionCards, get, get);
}

/** Whether a card describes a program session. A row with no card is a terminal session, as before. */
export function isProgramSession(card: Pick<SessionSummary, "kind"> | null | undefined): boolean {
  return card?.kind === "program";
}

/**
 * Whether a session wears the Experimental mark: a program session does, unless its card says it does
 * not. A terminal session never does.
 */
export function wearsExperimental(card: Pick<SessionSummary, "kind" | "experimental"> | null | undefined): boolean {
  return isProgramSession(card) && card?.experimental !== false;
}

/**
 * Whether a session answers yet. The card says it; a card without the word reads off `reachable`, the
 * field every bridge has always sent.
 */
export function sessionState(card: Pick<SessionSummary, "state" | "reachable">): SessionState {
  return card.state ?? (card.reachable ? "ready" : "unreachable");
}

/**
 * The program sessions the dashboard's Programs section lists (M55 spec 13): every one in the snapshot,
 * on this machine and on each member of a crew, in the snapshot's order (the lead's own first). One
 * section for all machines. Empty on every snapshot with no program session, which is every snapshot a
 * bridge older than M55 sends, and the section then draws nothing.
 */
export function programSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.filter((s) => isProgramSession(s));
}

/**
 * The address a program row opens: the session by name, on the machine that runs it. The lead's own
 * programs carry the lead's id on a crew snapshot and no host on a solo one; both open with no host, the
 * bare URL a scope on the lead has.
 */
export function programScope(session: Pick<SessionSummary, "name" | "host">, servers: readonly ServerSummary[] | undefined): Scope {
  const host = normalizeHost(session.host);
  return { host: host === undefined || host === leadHost(servers) ? undefined : host, session: session.name };
}

/** A program session's two counts on the dashboard (M55 spec 13). */
export interface ProgramCounts {
  /** Its open conversations: the live panes the program holds. */
  open: number;
  /** Its conversations that wait on you with a question. */
  waiting: number;
}

/**
 * A program session's counts, read off the summary the snapshot already carries for every session, so
 * the dashboard asks nothing more of the bridge. `agents` is the session's live panes, which are the open
 * conversations the conversation list draws first (lib/conversation-list.ts). `blocked` is the panes that
 * wait on a person, and the durable adapter reads a pane with an open question as blocked
 * (bridge/mux/durable/protocol.ts), so it is the list's "waiting" rows. Both are zero unless the session
 * is ready: an unreachable session's last poll failed, and a starting one has said nothing yet.
 */
export function programCounts(card: Pick<SessionSummary, "agents" | "blocked" | "state" | "reachable">): ProgramCounts {
  if (sessionState(card) !== "ready") return { open: 0, waiting: 0 };
  return { open: card.agents, waiting: card.blocked };
}

/**
 * Whether the Programs section sits above the spaces (M55 spec 13): yes when any program has at least
 * one conversation that waits on you, else it sits below them. Read off the counts the rows draw, so the
 * section moves on the snapshot that changes a count, and only when a row says why.
 */
export function programsAbove(programs: readonly SessionSummary[]): boolean {
  return programs.some((s) => programCounts(s).waiting > 0);
}

/**
 * The programs the needs-you filter keeps: those with at least one conversation that waits on you, read
 * off the same counts the rows draw. Empty when nothing waits, and the section then draws nothing.
 */
export function waitingPrograms(programs: readonly SessionSummary[]): SessionSummary[] {
  return programs.filter((s) => programCounts(s).waiting > 0);
}

/** Test seam: forget every card. */
export function __resetSessionCards(): void {
  cards.clear();
  lead = undefined;
  emit();
}
