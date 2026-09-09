// The Tier 2 harness: one extended `test`, and the reads every live case shares.
//
// SELECTORS ARE THE APP'S OWN STRINGS. `message()` below fills a template out of
// `src/lib/i18n/messages/en.ts`, the same dictionary the app renders from, so a copy edit moves
// these cases with it instead of breaking them. No CSS class is ever addressed here, and no
// `data-testid` is added to the app for this suite.
//
// ENGLISH IS FORCED BEFORE THE FIRST NAVIGATION. The locale lives in `localStorage` under
// `collie:locale:v1` (`src/lib/i18n/index.ts`) and there is no URL parameter for it. An operator
// who left the dev lane's browser in German must not turn this suite red, so every context writes
// the bare string `en` before the app boots.
//
// NOTHING HERE PAIRS. No device token is written, no `Authorization` header is sent, and no case
// below performs a write. Reads are ungated on both device gates (collie/CLAUDE.md), so a plain
// browser sees everything these cases assert.
import { expect, test as base, type APIRequestContext } from "@playwright/test";

import { en } from "../../src/lib/i18n/messages/en";

/** The storage key `src/lib/i18n/index.ts` reads the locale from. The value is the bare code. */
const LOCALE_STORAGE_KEY = "collie:locale:v1";

/**
 * The same dictionary, reached by a runtime key.
 *
 * A plain widening assignment, not a type assertion: every value in `en` is a string, so this is
 * checked by the compiler rather than promised in a comment. It exists because `plural()` builds
 * its key from a count and cannot know at compile time which half of the pair it will want.
 */
const dictionary: Record<string, string> = en;

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [LOCALE_STORAGE_KEY, "en"],
    );
    await use(page);
  },
});

export { expect };

function fill(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const [slot, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${slot}}`, String(value));
  }
  return out;
}

function read(key: string): string {
  const template = dictionary[key];
  // Loud, and at the first case that asks. A missing key would otherwise render as the word
  // "undefined" and match nothing on screen, which reads as an app bug rather than a stale test.
  if (template === undefined) throw new Error(`no English message for key "${key}"`);
  return template;
}

/**
 * Fill one English message's `{slot}`s, exactly as `t()` does at runtime. The key is checked by the
 * compiler, so a renamed key is a build error here and not a red run later.
 */
export function message(key: keyof typeof en, vars: Record<string, string | number> = {}): string {
  return fill(read(key), vars);
}

/** Fill an English `.one`/`.other` pair, exactly as `tn()` does at runtime. */
export function plural(pluralBase: string, count: number): string {
  return fill(read(`${pluralBase}.${count === 1 ? "one" : "other"}`), { count });
}

/** What `GET /api/health` answers (`bridge/server.ts:1215`). */
export interface LiveHealth {
  readonly ok: boolean;
  readonly version: string;
  readonly mode: string;
}

/** One machine in the live census, as `GET /api/crew` reports it. */
export interface LiveMember {
  readonly id: string;
  readonly name: string;
  readonly isLead: boolean;
  readonly health: string;
}

/** What `GET /api/crew` answers, narrowed to what these cases read. */
export interface LiveCrew {
  readonly crew: { readonly id: string; readonly name: string };
  readonly deputy: { readonly id: string } | null;
  readonly members: readonly LiveMember[];
}

export async function readHealth(request: APIRequestContext): Promise<LiveHealth> {
  const response = await request.get("/api/health");
  expect(response.ok(), "GET /api/health did not answer — is the dev lane up?").toBeTruthy();
  const body: LiveHealth = await response.json();
  return body;
}

export async function readCrew(request: APIRequestContext): Promise<LiveCrew> {
  const response = await request.get("/api/crew");
  expect(response.ok(), "GET /api/crew did not answer — is the dev lane up?").toBeTruthy();
  const body: LiveCrew = await response.json();
  return { ...body, deputy: body.deputy ?? null };
}

/**
 * The semver the app PRINTS, out of the `<semver>+<sha>` a build answers `/api/health` with.
 *
 * The two strings are not the same, and neither is wrong. `/api/health` reports the exact build
 * (`bridge/index.ts:1658`), while the update card prints `update.current` from the snapshot, which
 * is the release version with no sha — a card reading `1.7.0+35b60df7` would be comparing an
 * operator's build stamp against GitHub's tag list.
 */
export function releaseVersion(healthVersion: string): string {
  const [semver] = healthVersion.split("+");
  return semver ?? healthVersion;
}
