// ── THE PUSH TITLE CATALOGUE — every notification headline the bridge sends, named ──────────────
//
// A push is rendered by the phone's service worker, not by the bridge, and the phone knows the
// operator's language where the bridge does not (the locale is a per-device choice, ADR 0030). So a
// push title follows the rule `error-codes.ts` set for error bodies: a STABLE MACHINE CODE travels
// beside the English sentence. A service worker with a translation for the code shows it; one without
// — an older build, or a code invented after it shipped — shows the English, which stays true.
//
// THE SENTENCE AND THE CODE CANNOT DRIFT, because a caller never writes the words: it names a code and
// {@link pushTitle} renders the sentence from THIS table.
//
// ONLY THE TITLE. A body is the pane's place, the names in a digest, or a release's own notes — the
// operator's words and Collie's history, not Collie's UI — so it travels as it always has.
//
// THE CLIENT MIRROR is `web/src/lib/push-title-codes.ts`. The two trees are type-checked separately,
// so the code list is restated there rather than imported; `bridge/push-titles.test.ts` reads both
// files off disk and fails when they disagree (ADR 0074).

import { renderTemplate, type TemplateDetail } from "./template.ts";

/** The named values a title was built from, echoed on the wire for a translated title to reuse. */
export type PushTitleDetail = TemplateDetail;

/**
 * Every code a push title can carry, mapped to the English it ships with.
 *
 * The sentences are byte-for-byte what the bridge sent before codes existed. Changing one is a
 * user-visible change; adding a code is not.
 */
export const PUSH_TITLES = {
  // ── The herd's single notification (`notifications.ts`) ────────────────────────────
  /** One outstanding agent, waiting on the operator. */
  "agent.blocked": "{agent} needs you",
  /** One outstanding agent, finished. */
  "agent.done": "{agent} is done",
  /** A digest of two or more agents, every one waiting. `{count}` is never below 2. */
  "herd.blocked": "{count} agents need you",
  /** A digest of two or more agents, every one finished. */
  "herd.done": "{count} agents done",
  /** A digest of two or more agents, some waiting and some finished. */
  "herd.mixed": "{count} agents need attention",

  // ── Everything else the bridge pushes ──────────────────────────────────────────────
  /** A newer release is available (`index.ts`). The title never moves, not even when urgent (ADR 0046). */
  "update.available": "Collie update available",
  /** A watched pane's prompt cache is about to expire (`cache/warn.ts`). */
  "cache.cold_soon": "Cache goes cold in about {minutes} min",
} as const;

/** Every code a push title can carry. The client mirror restates this union verbatim. */
export type PushTitleCode = keyof typeof PUSH_TITLES;

/**
 * The same set as a runtime list, so the drift guard can compare what the module EXPORTS against what
 * it reads out of the two source files — a regex that quietly stopped matching would otherwise pass
 * by comparing two empty sets.
 */
export const PUSH_TITLE_CODE_LIST: readonly PushTitleCode[] = Object.keys(PUSH_TITLES).filter(
  (key): key is PushTitleCode => key in PUSH_TITLES,
);

/**
 * The title half of a push message: the English sentence, its stable code, and the named values the
 * sentence was built from. Spread into a `PushMessage`.
 */
export interface PushTitle {
  title: string;
  titleCode: PushTitleCode;
  titleDetail?: PushTitleDetail;
}

/**
 * Build the title fragment for `code`, rendering its catalogued sentence with `detail`.
 *
 * `titleDetail` is assigned only when there is one, never as an empty object — the same
 * omitted-not-null discipline `apiError` and the push payload's `session`/`host` follow.
 */
export function pushTitle(code: PushTitleCode, detail?: PushTitleDetail): PushTitle {
  const title: PushTitle = { title: renderTemplate(PUSH_TITLES[code], detail), titleCode: code };
  if (detail !== undefined) title.titleDetail = detail;
  return title;
}
