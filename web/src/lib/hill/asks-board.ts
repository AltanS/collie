// THE ASKS BOARD AND THE ASK SCREEN, AS PURE RULES (Asks build 2, 2026-11-23). What `asks.ts` leaves open: the cache
// clock a session is ordered by, the order of one session's asks (the ones the agent has not checked sink), the deck the
// Previous and Next buttons walk, and every short line the three pages print about a session or an ask. No I/O and no
// React; the words come through `t()`, so a test reads them without a render.

import { cacheOf } from "./asks";
import type { AskDecision, AskSession } from "./asks";
import { ageWords } from "./words";
import type { HillAskMark } from "./wire";
import { clockTime } from "../format";
import { t, tn } from "../i18n";
import type { AgentView } from "../types";
import { livePaneAt, type WalkyLivePanes } from "../walky-names";

/** What a session's prompt cache is doing, as the board orders and names it. */
export type SessionClock = { kind: "warm"; msLeft?: number } | { kind: "working" } | { kind: "unknown" } | { kind: "cold" };

/**
 * The clock of a session's pane at `now`. A pane that works is `working` whatever its cache says: its next turn is
 * already running. Otherwise the cache decides (`cacheOf`, the Dashboard chip's rule): warm with the time left, cold,
 * or unknown (a session Collie no longer lists, a harness with no cache reading).
 */
export function sessionClock(pane: Pick<AgentView, "status" | "cache"> | null, now: number): SessionClock {
  if (pane !== null && pane.status === "working") return { kind: "working" };
  const cache = cacheOf(pane, now);
  if (cache.state === "warm") return cache.msLeft === undefined ? { kind: "warm" } : { kind: "warm", msLeft: cache.msLeft };
  return { kind: cache.state };
}

/** Warm first, then working, then unknown, then cold. */
function clockRank(clock: SessionClock): number {
  switch (clock.kind) {
    case "warm":
      return 0;
    case "working":
      return 1;
    case "unknown":
      return 2;
    case "cold":
      return 3;
  }
}

/** The order of two clocks: by kind, and among warm ones the fewest minutes left first (no reading last). */
function compareClocks(a: SessionClock, b: SessionClock): number {
  const byKind = clockRank(a) - clockRank(b);
  if (byKind !== 0 || a.kind !== "warm" || b.kind !== "warm") return byKind;
  return (a.msLeft ?? Number.POSITIVE_INFINITY) - (b.msLeft ?? Number.POSITIVE_INFINITY);
}

/** An ask the agent has not checked since the person wrote in the session. */
export function isUnchecked(ask: AskDecision): boolean {
  return ask.ask.mark === "unchecked";
}

/** One session's asks, oldest first, the unchecked ones moved to the end of the group (each part keeps its age order). */
export function sortSessionAsks(asks: readonly AskDecision[]): AskDecision[] {
  const byAge = asks.toSorted((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return [...byAge.filter((ask) => !isUnchecked(ask)), ...byAge.filter(isUnchecked)];
}

/**
 * The sessions in board order: warm with the fewest minutes left, then working, then unknown, then cold; the same clock
 * breaks ties by the session's newest ask. `held` is the order the board drew before: a session in it keeps its place
 * (a clock that turns while the list is on screen must not move the row under a thumb, the rule of lib/pane-order.ts),
 * a session new to the list takes its place by the clock among the new ones and goes on top, one with no ask left
 * drops out. Each session's asks come sorted by {@link sortSessionAsks}.
 */
export function orderByClock(sessions: readonly AskSession[], live: WalkyLivePanes, now: number, held: readonly string[] = []): AskSession[] {
  const rank = new Map(held.map((key, index) => [key, index]));
  const clockOf = (session: AskSession): SessionClock => sessionClock(livePaneAt(session.key, live), now);
  const fresh = (a: AskSession, b: AskSession): number => compareClocks(clockOf(a), clockOf(b)) || b.newest - a.newest || a.key.localeCompare(b.key);
  const known = sessions.filter((session) => rank.has(session.key)).toSorted((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
  const added = sessions.filter((session) => !rank.has(session.key)).toSorted(fresh);
  return [...added, ...known].map((session) => Object.assign({}, session, { asks: sortSessionAsks(session.asks) }));
}

/** Every ask the Previous and Next buttons walk: the sessions in board order, each one's asks in their order. */
export function deckOf(sessions: readonly AskSession[]): AskDecision[] {
  return sessions.flatMap((session) => session.asks);
}

/** The asks beside one ask in the deck. */
export interface AskNeighbours {
  previous: string | null;
  next: string | null;
}

/** The Previous and Next neighbours of an ask in the deck: null at an end, and both null for an id that is not in it. */
export function neighboursOf(deck: readonly Pick<AskDecision, "id">[], id: string): AskNeighbours {
  const at = deck.findIndex((ask) => ask.id === id);
  if (at === -1) return { previous: null, next: null };
  return { previous: deck[at - 1]?.id ?? null, next: deck[at + 1]?.id ?? null };
}

/**
 * What the board's cache clock draws for a session: the prompt cache itself (`cacheOf`), whether or not the pane works. A
 * working pane keeps its reading, as the Dashboard chip does; `sessionClock` hides it behind `working` for the order.
 * `none` is a session with no reading (a gone pane, a harness with no cache adapter): the clock draws nothing.
 */
export type CacheClock = { kind: "warm"; msLeft?: number } | { kind: "cold" } | { kind: "none" };

/** The cache clock of a session's pane at `now`. */
export function cacheClockOf(pane: Pick<AgentView, "cache"> | null, now: number): CacheClock {
  const cache = cacheOf(pane, now);
  if (cache.state === "cold") return { kind: "cold" };
  if (cache.state === "unknown") return { kind: "none" };
  return cache.msLeft === undefined ? { kind: "warm" } : { kind: "warm", msLeft: cache.msLeft };
}

/** The cache's whole life, as the clock's bar reads it: minutes left are shown out of this many. */
export const CACHE_BAR_MINUTES = 60;

/** How full the clock's bar is, in percent: whole minutes left out of {@link CACHE_BAR_MINUTES}, never past either end. */
export function cacheBarPercent(msLeft: number): number {
  const minutes = Math.floor(Math.max(0, msLeft) / 60_000);
  return Math.min(100, (minutes / CACHE_BAR_MINUTES) * 100);
}

/** The words of the board's cache clock ("12 min left", "cold"), or null when it draws nothing. */
export function cacheClockWords(clock: CacheClock): string | null {
  switch (clock.kind) {
    case "none":
      return null;
    case "cold":
      return t("asks.clock.cold");
    case "warm": {
      if (clock.msLeft === undefined) return t("asks.clock.warm");
      const minutes = Math.floor(clock.msLeft / 60_000);
      return minutes < 1 ? t("asks.board.underMin") : t("asks.board.minLeft", { minutes });
    }
  }
}

/** The muted line beside "Answer", from the cache and from how many sessions wait: null when it has nothing to say. */
export function nextUpLine(sessionCount: number, clock: SessionClock): string | null {
  if (sessionCount < 2) return null;
  if (clock.kind === "warm") return t("asks.board.lineWarm");
  if (clock.kind === "working") return t("asks.board.lineWorking");
  return null;
}

/** The header's sub line, "5 open in 3 sessions". */
export function headerAsksWords(asks: number, sessions: number): string {
  return sessions === 1 ? t("asks.header.inOne", { count: asks }) : t("asks.header.inMany", { count: asks, sessions });
}

/** The right end of the section line: "5 open · 1 answered", the answered part only when there is one. */
export function sectionCountWords(open: number, answered: number): string {
  return answered > 0 ? t("asks.board.sectionCount", { open, answered }) : t("asks.board.sectionOpen", { open });
}

/** The cache in words a session's header and its board card say, or null when there is nothing to say (unknown). */
export function clockWords(clock: SessionClock): string | null {
  switch (clock.kind) {
    case "working":
      return t("asks.clock.working");
    case "cold":
      return t("asks.clock.cold");
    case "unknown":
      return null;
    case "warm": {
      if (clock.msLeft === undefined) return t("asks.clock.warm");
      const minutes = Math.floor(clock.msLeft / 60_000);
      return minutes < 1 ? t("asks.clock.warmUnder") : t("asks.clock.warmLeft", { minutes });
    }
  }
}

/** "asked 14 h ago", from the ask's time. */
export function askedWords(at: number, now: number): string {
  return t("asks.asked", { age: ageWords(at, now) });
}

/** What the header's second line holds: when it was asked, then the cache in words when there are some. */
export function headerLine(at: number, clock: SessionClock, now: number): string {
  const cache = clockWords(clock);
  return cache === null ? askedWords(at, now) : `${askedWords(at, now)} · ${cache}`;
}

/** The words of a Markdown background, counted the way a person counts them: runs of non-space characters. */
export function wordCount(body: string): number {
  const words = body.trim().split(/\s+/u).filter((word) => word !== "");
  return words.length;
}

/** What an ask carries for its Context page. */
export interface ContextFacts {
  words: number;
  images: number;
  files: number;
}

/** The Context page's contents of an ask. */
export function contextFacts(ask: Pick<AskDecision, "body" | "media" | "ask">): ContextFacts {
  return { words: wordCount(ask.body), images: ask.media.length, files: ask.ask.files.length };
}

/** The Context row's summary, "165 words · 2 images · 1 file", or null when the ask has nothing behind it (no row). */
export function contextSummary(facts: ContextFacts): string | null {
  const parts = [
    facts.words > 0 ? tn("asks.context.words", facts.words) : null,
    facts.images > 0 ? tn("asks.context.images", facts.images) : null,
    facts.files > 0 ? tn("asks.context.files", facts.files) : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The line under the question that says what the bridge knows of the ask's freshness. */
export function markWords(mark: HillAskMark, ask: Pick<AskDecision, "at"> & { ask: { confirmedAt?: number } }): string {
  switch (mark) {
    case "fresh":
      return t("asks.mark.fresh", { time: clockTime(ask.at) });
    case "carried":
      return ask.ask.confirmedAt === undefined ? t("asks.mark.carriedNoTime") : t("asks.mark.carried", { time: clockTime(ask.ask.confirmedAt) });
    case "unchecked":
      return t("asks.mark.unchecked");
  }
}

/** The words of the send line: what it says, and the action it offers (null when there is none). */
export interface SendLine {
  words: string;
  action: string | null;
}

/** The send line above the bottom bar: it always holds its place, with words for none, or "2 of 4 answered · Send 2". */
export function sendLineWords(answered: number, total: number): SendLine {
  if (answered === 0) return { words: t("asks.send.none"), action: null };
  return { words: t("asks.send.progress", { answered, total }), action: t("asks.send.action", { count: answered }) };
}

/** The name of a card on the board: how many questions it holds, how many of them are answered here, how many are not checked. */
export function boardCountWords(count: number, answered: number, unchecked: number): string {
  const base = answered > 0 ? t("asks.board.countAnswered", { answered, count }) : tn("asks.board.count", count);
  return unchecked > 0 ? `${base} · ${t("asks.board.unchecked", { count: unchecked })}` : base;
}
