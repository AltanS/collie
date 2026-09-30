// ── THE PHONE'S MIRROR OF THE PUSH TITLE CATALOGUE — which headline codes this build can say ──────
//
// The bridge sends a notification's English title AND a stable code beside it (`bridge/push-titles.ts`).
// This file restates the code list, because the two trees are type-checked separately and cannot
// import each other — the same arrangement `lib/api-error-codes.ts` has with `bridge/error-codes.ts`.
// `bridge/push-titles.test.ts` reads both files off disk and fails when they disagree.
//
// Imported by the SERVICE WORKER as well as the page, so it holds no state and imports nothing with a
// side effect: a push wakes a worker that has no DOM, no `localStorage`, and no i18n store (ADR 0074).

/** Every code a push title can carry, in the bridge's own order. */
export const PUSH_TITLE_CODES = [
  "agent.blocked",
  "agent.done",
  "herd.blocked",
  "herd.done",
  "herd.mixed",
  "update.available",
  "cache.cold_soon",
] as const;

/** Every code a push title can carry. Derived from the list, so there is exactly one place to edit. */
export type PushTitleCode = (typeof PUSH_TITLE_CODES)[number];

/** The values the bridge filled its English title with, for a translated title to reuse. */
export type PushTitleDetail = Readonly<Record<string, string | number>>;

/**
 * Whether a code off the wire is one THIS build can translate. A `false` is ordinary: a newer bridge
 * named a headline this build has no words for, and the worker shows that push's English instead.
 */
export function isPushTitleCode(value: string | undefined): value is PushTitleCode {
  return PUSH_TITLE_CODES.some((code) => code === value);
}
