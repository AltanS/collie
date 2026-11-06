// ── THE COUNT ON THE HOME SCREEN ICON ────────────────────────────────────────────────────────────
//
// The installed app's icon carries the number of alerts waiting on you: a blocked pane, and a finished
// one you have not opened when finished panes notify. Two writers keep it, because neither is always
// awake. The page sets it from its own snapshot while it is open. The service worker sets it on every
// herd push, whose `badge` field is that slot's count, and a retraction is a slot with none.
//
// A worker holds no state between two pushes, and each push names one slot (one session on one
// machine), so the worker keeps every slot's last count in Cache Storage and shows their sum. Cache
// Storage for the reason `push-title-store` gives: one small JSON value under a key both sides reach.
//
// Imported by both sides, so this module holds no state and has no side effect at load.

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "./json";

/** The Badging API's two calls, optional because most browsers have neither. */
export interface BadgeTarget {
  setAppBadge?(count?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

/** Show `count` on the icon, or nothing at zero. A browser that refuses is not an error. */
export async function showBadge(target: BadgeTarget | undefined, count: number): Promise<void> {
  try {
    if (count > 0) await target?.setAppBadge?.(count);
    else await target?.clearAppBadge?.();
  } catch {
    // Permission not granted, or not an installed app: the icon simply keeps no count.
  }
}

/** Every herd slot's tag starts with this (bridge/crew/tags.ts); an update or machine push does not. */
const HERD_TAG = "collie:herd";

/** What a push says about its slots. Only the fields read here. */
export interface BadgePush {
  type?: string;
  tag?: string;
  badge?: number;
  /** A clear's other slots (bridge/push.ts, one clear per burst): each one goes to zero. Read off
   *  the wire, so typed as what it may be, not as what it should be. */
  tags?: JsonValue;
  /** Counts this worker missed while its device was looking at the app (bridge/push.ts § payloadFor). */
  badgeSlots?: JsonValue;
}

/**
 * The slot's count a push carries, or `undefined` when it says nothing about one: another
 * kind of push, or a herd push from a bridge that predates the field, which must not zero a slot.
 */
export function slotCount(push: BadgePush): number | undefined {
  // A push body is parsed JSON, so `tag` can be any type: only a string can name a herd slot.
  const tag = asJsonString(push.tag);
  if (tag === undefined || !tag.startsWith(HERD_TAG)) return undefined;
  if (push.type === "clear") return 0;
  if (push.type !== undefined) return undefined;
  const n = push.badge;
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Every slot count a push carries, in the order to apply them: the counts owed from pushes this
 * worker never saw, then the push's own slot, then a clear's other slots at zero. Only herd slots,
 * and only whole counts, as {@link slotCount} reads them. Empty when the push says nothing.
 */
export function slotUpdates(push: BadgePush): [string, number][] {
  const out: [string, number][] = [];
  for (const [tag, value] of Object.entries(asJsonObject(push.badgeSlots) ?? {})) {
    const n = asJsonNumber(value);
    if (tag.startsWith(HERD_TAG) && n !== undefined && Number.isInteger(n) && n >= 0) out.push([tag, n]);
  }
  const own = slotCount(push);
  const ownTag = asJsonString(push.tag);
  if (own !== undefined && ownTag !== undefined) out.push([ownTag, own]);
  if (push.type !== "clear" || !Array.isArray(push.tags)) return out;
  for (const extra of push.tags) {
    const tag = asJsonString(extra);
    if (tag !== undefined && tag !== ownTag && tag.startsWith(HERD_TAG)) out.push([tag, 0]);
  }
  return out;
}

/** Each slot's last count, keyed by its tag. A slot at zero is absent. */
export interface BadgeSlots {
  [tag: string]: number;
}

/** Read the stored slots back, keeping only whole positive counts. */
export function parseBadgeSlots(text: string): BadgeSlots {
  const out: BadgeSlots = {};
  for (const [tag, value] of Object.entries(parseJsonObject(text) ?? {})) {
    const n = asJsonNumber(value);
    if (n !== undefined && Number.isInteger(n) && n > 0) out[tag] = n;
  }
  return out;
}

/** The slots with one slot's count replaced. */
export function withSlot(slots: BadgeSlots, tag: string, count: number): BadgeSlots {
  const { [tag]: _replaced, ...rest } = slots;
  return count > 0 ? { ...rest, [tag]: count } : rest;
}

/** The icon's number: every slot's count added up. */
export function badgeTotal(slots: BadgeSlots): number {
  return Object.values(slots).reduce((sum, n) => sum + n, 0);
}

/** The Cache the slots live in, per mount for the reason `pushTitlesCacheName` gives. */
export function badgeCacheName(mount: string): string {
  return mount === "/" ? "collie-badge" : `collie-badge:${mount}`;
}

/** The entry's key: a URL under the mount, never requested. */
export function badgeKey(origin: string, mount: string): string {
  return `${origin}${mount}badge.json`;
}

/** The one slice of Cache Storage this module needs, so a test can fake it. */
export interface BadgeCaches {
  open(cacheName: string): Promise<Pick<Cache, "match" | "put">>;
}

/** Store one slot's new count and answer the new total. */
export function recordSlot(
  caches: BadgeCaches,
  origin: string,
  mount: string,
  tag: string,
  count: number,
): Promise<number> {
  return recordSlots(caches, origin, mount, [[tag, count]]);
}

/** Store several slots' new counts in one write, in order, and answer the new total. */
export async function recordSlots(
  caches: BadgeCaches,
  origin: string,
  mount: string,
  updates: readonly (readonly [string, number])[],
): Promise<number> {
  const cache = await caches.open(badgeCacheName(mount));
  const key = badgeKey(origin, mount);
  const hit = await cache.match(key);
  let slots = hit === undefined ? {} : parseBadgeSlots(await hit.text());
  for (const [tag, count] of updates) slots = withSlot(slots, tag, count);
  await cache.put(key, new Response(JSON.stringify(slots), { headers: { "content-type": "application/json" } }));
  return badgeTotal(slots);
}
