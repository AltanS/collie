// "Report a problem" (ADR 0123): one failure streak per pane, the small log of past episodes, and the
// one sheet the card, the pane menu, Settings and the unread-dialog card all open.
//
// ── THE STREAK LIVES IN MEMORY ───────────────────────────────────────────────
// Keyed by `paneScopeKey`, like the unread marks, and gone with the page, like the composer's own
// state. A reload forgets a streak; a new one starts from the next failure.
//
// ── THE LOG IS SHAPE ONLY, AND STAYS ON THIS DEVICE ──────────────────────────
// Each streak that reaches the threshold leaves one entry in `collie:report-episodes:v1`: when, which
// pane, and each failing send's request id, outcome and reason. No text, no screen, no harness answer.
// At most {@link EPISODE_MAX} entries, none older than {@link EPISODE_MAX_AGE_MS}. Nothing reads it but
// the report sheet opened from Settings, and nothing sends it: a report leaves only by the person's
// taps (Open on GitHub, Copy report).

import { useSyncExternalStore } from "react";

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../json";
import { SEND_OUTCOMES, SEND_REASONS, type SendOutcome, type SendReason } from "../surface/send";
import type { DetectorVerdict, UnreadDialogModel } from "../harness/unread-dialog-model";
import type { Scope } from "../scope";
import { closeOffer, NO_TROUBLE, noteSettled, offersReport, type SettledSend, type Trouble } from "./trouble";

const EPISODES_KEY = "collie:report-episodes:v1";
/** The most episodes the log keeps, newest last. */
export const EPISODE_MAX = 20;
/** The oldest an episode may be before the next write drops it. */
export const EPISODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One past streak, as the log keeps it. */
export interface Episode {
  readonly at: number;
  readonly paneId: string;
  readonly sends: readonly Pick<SettledSend, "requestId" | "outcome" | "reason">[];
}

const streaks = new Map<string, Trouble>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A pane's streak now. */
export function troubleOf(key: string): Trouble {
  return streaks.get(key) ?? NO_TROUBLE;
}

/**
 * One settled send on a pane. Returns the streak after it. When this send made the streak reach the
 * threshold, the episode goes into the on-device log.
 */
export function noteSend(key: string, paneId: string, send: SettledSend, now: number = send.at): Trouble {
  const before = troubleOf(key);
  const after = noteSettled(before, send);
  if (after === before) return before;
  if (after === NO_TROUBLE) streaks.delete(key);
  else streaks.set(key, after);
  if (after.offered && !before.offered) logEpisode({ at: send.at, paneId, sends: after.sends.map(({ requestId, outcome, reason }) => ({ requestId, outcome, reason })) }, now);
  emit();
  return after;
}

/** The person closed the card on this pane: quiet until the streak ends. */
export function closeTrouble(key: string): void {
  const before = troubleOf(key);
  const after = closeOffer(before);
  if (after === before) return;
  streaks.set(key, after);
  emit();
}

/** How many failures in a row the card names on this pane, or 0 while it shows no card. Reactive. */
export function useTroubleOffer(key: string): number {
  return useSyncExternalStore(subscribe, () => {
    const trouble = troubleOf(key);
    return offersReport(trouble) ? trouble.sends.length : 0;
  });
}

/** Test seam: forget every streak and close the sheet. */
export function __resetReport(): void {
  streaks.clear();
  target = null;
  emit();
}

// ── The episode log ──────────────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked or partitioned storage
  }
}

function readEpisode(value: JsonValue): Episode | null {
  const node = asJsonObject(value);
  if (node === undefined || !Array.isArray(node.sends)) return null;
  const at = asJsonNumber(node.at);
  const paneId = asJsonString(node.paneId);
  if (at === undefined || paneId === undefined) return null;
  const sends: Episode["sends"][number][] = [];
  for (const raw of node.sends) {
    const fields = asJsonObject(raw);
    const requestId = asJsonString(fields?.requestId);
    const outcome = SEND_OUTCOMES.find((word): word is SendOutcome => word === fields?.outcome);
    const reason = SEND_REASONS.find((word): word is SendReason => word === fields?.reason) ?? null;
    if (requestId === undefined || outcome === undefined) continue;
    sends.push({ requestId, outcome, reason });
  }
  return { at, paneId, sends };
}

/** The log, oldest first, with anything past its age or its count dropped. */
export function readEpisodes(now: number = Date.now()): Episode[] {
  const raw = storage()?.getItem(EPISODES_KEY) ?? null;
  if (raw === null) return [];
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return [];
  return doc
    .flatMap((item) => {
      const episode = readEpisode(item);
      return episode === null ? [] : [episode];
    })
    .filter((episode) => now - episode.at <= EPISODE_MAX_AGE_MS)
    .slice(-EPISODE_MAX);
}

function logEpisode(episode: Episode, now: number): void {
  const store = storage();
  if (store === null) return;
  const next = [...readEpisodes(now), episode].slice(-EPISODE_MAX);
  try {
    store.setItem(EPISODES_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store loses the log entry, never the card.
  }
}

// ── The sheet ────────────────────────────────────────────────────────────────

/**
 * What the unread-dialog card knew when its Report a problem was tapped (ADR 0123, amendment
 * 2026-10-28): the agent whose adapter read the screen, the key the card offers, and what each of the
 * adapter's dialog detectors answered on that screen. Names and results only, never the screen.
 */
export interface DialogTrouble {
  readonly agent: string;
  readonly key: string;
  readonly verdicts: readonly DetectorVerdict[];
}

/**
 * What the sheet reports on. With a pane: that pane's recent sends (and, from the card, the streak's
 * request ids first). With none (Settings): this machine's setup and the episode log. From the
 * unread-dialog card, `kind: "unread-dialog"` and what the card knew.
 */
export type ReportTarget = {
  readonly paneId?: string | undefined;
  readonly scope?: Scope | undefined;
  /** The streak's request ids, from the card; the sheet lists these sends. */
  readonly requestIds?: readonly string[] | undefined;
} & ({ readonly kind?: "send" | undefined } | { readonly kind: "unread-dialog"; readonly dialog: DialogTrouble });

/** The target the unread-dialog card opens: its pane, and what its reader said about the screen. */
export function unreadDialogReport(paneId: string, scope: Scope | undefined, cancel: UnreadDialogModel): ReportTarget {
  return { paneId, scope, kind: "unread-dialog", dialog: { agent: cancel.agent, key: cancel.key, verdicts: cancel.verdicts ?? [] } };
}

let target: ReportTarget | null = null;

/** Open the report sheet. The one mounted host shows it. */
export function openReport(next: ReportTarget): void {
  target = next;
  emit();
}

export function closeReport(): void {
  if (target === null) return;
  target = null;
  emit();
}

/** The sheet's target, or null while it is closed. */
export function useReportTarget(): ReportTarget | null {
  return useSyncExternalStore(subscribe, () => target);
}

/** The streak's request ids on a pane, for the card's Report. */
export function streakIds(key: string): string[] {
  return troubleOf(key).sends.map((send) => send.requestId);
}
