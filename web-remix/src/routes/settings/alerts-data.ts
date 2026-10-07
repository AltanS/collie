// The reads and writes behind Settings → Alerts, as stores the cards render from. Port of web's
// useNotifyPrefs and useCacheWatchList, without the hooks.
//
//   GET/POST /api/notifications/prefs               bridge-wide: which lifecycle events push
//   GET      /api/notifications/cache-watch/list    the panes watched one by one (ADR 0042)
//   POST     /api/notifications/cache-watch/forget  drop one entry by its opaque id
//   POST     /api/notifications/snooze              the global quiet hours
//
// A toggle is optimistic: the switch flips under the thumb, the single-key partial goes out, the
// server's merged view is the last word, and a failure puts the switch back WITH a sentence on the
// status channel (`mutate`): a silent revert is the one that costs, because the operator has already
// stopped looking at the row.
import type { JsonObject } from "@web/lib/json";
import type { CacheWatchListEntry, CacheWatchListResponse, NotifyPrefs } from "@web/lib/types";

import { bridgeGet, bridgeSend } from "../../lib/api";
import { snapshot } from "../../lib/data";
import { kick } from "../../lib/polling";
import { createStore } from "../../lib/store";
import { mutate } from "./mutate";
import { cacheWatchForgetUrl, cacheWatchListUrl, notificationPrefsUrl, snoozeUrl } from "../../lib/urls";

export const notifyPrefs = createStore<NotifyPrefs | null>(null);
export const notifyBusy = createStore<boolean>(false);
export const watchList = createStore<CacheWatchListEntry[] | null>(null);
export const watchBusy = createStore<boolean>(false);
export const snoozeBusy = createStore<boolean>(false);

export async function loadNotifyPrefs(signal: AbortSignal): Promise<void> {
  try {
    const body = await bridgeGet<NotifyPrefs>(notificationPrefsUrl(), undefined, signal);
    if (!signal.aborted) notifyPrefs.set(body);
  } catch {
    // no prefs: the rows stay disabled, the card keeps its shape
  }
}

export async function loadWatchList(signal: AbortSignal): Promise<void> {
  try {
    const body = await bridgeGet<CacheWatchListResponse>(cacheWatchListUrl(), undefined, signal);
    if (!signal.aborted) watchList.set(body.entries);
  } catch {
    // no list: the heading still renders, with nothing under it
  }
}

export async function toggleNotify(key: keyof NotifyPrefs, next: boolean): Promise<void> {
  notifyPrefs.update((prev) => (prev === null ? prev : { ...prev, [key]: next }));
  notifyBusy.set(true);
  const patch: JsonObject = { [key]: next };
  const res = await mutate(() => bridgeSend<NotifyPrefs>("POST", notificationPrefsUrl(), patch));
  if (res.ok) notifyPrefs.set(res.value);
  else notifyPrefs.update((prev) => (prev === null ? prev : { ...prev, [key]: !next }));
  notifyBusy.set(false);
}

export async function forgetWatched(id: string): Promise<void> {
  const before = watchList.get();
  watchList.update((prev) => prev?.filter((entry) => entry.id !== id) ?? prev);
  watchBusy.set(true);
  const res = await mutate(() => bridgeSend<CacheWatchListResponse>("POST", cacheWatchForgetUrl(), { id }));
  if (res.ok) watchList.set(res.value.entries);
  else watchList.set(before);
  watchBusy.set(false);
}

/** Set or clear the global snooze. The snapshot carries the deadline, so it is written straight back. */
export async function applySnooze(snoozedUntil: number | null): Promise<void> {
  snoozeBusy.set(true);
  const res = await mutate(() => bridgeSend<{ snoozedUntil: number | null }>("POST", snoozeUrl(), { snoozedUntil }));
  if (res.ok) {
    const until = res.value.snoozedUntil;
    snapshot.update((prev) =>
      prev.data === undefined ? prev : { ...prev, data: { ...prev.data, notifications: { snoozedUntil: until } } },
    );
    kick();
  }
  snoozeBusy.set(false);
}

/** The snooze deadline the last snapshot named, or null. */
export function snoozedUntilOf(): number | null {
  return snapshot.get().data?.notifications?.snoozedUntil ?? null;
}
