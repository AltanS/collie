import type { Page, Route } from "@playwright/test";

import type { Locale } from "@/lib/i18n/locale";
import {
  fixtureCrewSnapshot,
  fixtureCrewStatus,
  fixtureSnapshot,
  fixtureTranscript,
  paneTextWithDraft,
  recordReply,
} from "@/test/handlers";

// The `app` target's API. The shipped bundle is served off disk by a static server, so nothing
// answers `/api/*` unless this module does.
//
// ONE fixture tree feeds both tiers. Every payload of substance here comes from
// `src/test/handlers.ts`, the same module the 194 vitest files read, so a fixture that drifts
// breaks both layers at once instead of leaving this one asserting a world that no longer exists.
//
// MSW is deliberately NOT used in the browser. It installs a service worker of its own and this app
// ships one; two workers on one scope is a fight, not a fixture. The MSW handler array stays the
// unit layer's, and this module re-states the ROUTING (nine lines of it) rather than the data.

/** The locale pin. A BARE string under this key, not JSON — `src/lib/i18n/index.ts:44`. */
const LOCALE_STORAGE_KEY = "collie:locale:v1";

/** `/api/update/check` reports the bridge's own version, which `SnapshotResponse` does not carry.
 *  It is level with `latest` in the default world, so the two only ever have to agree with each
 *  other, never with the real build stamp. */
const STUB_VERSION = "0.0.0-e2e";

function fulfillJson<T>(route: Route, body: T, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

interface ReplyBody {
  readonly text?: string;
  readonly submit?: boolean;
}

/**
 * Answer the one request. Split out of the route so the dispatch reads as a table and so an
 * unmatched path is a loud 501 rather than a silent fall-through to the static server, which would
 * hand the app `index.html` for a JSON fetch and fail somewhere far away from the cause.
 */
async function answer(route: Route, path: string): Promise<void> {
  const method = route.request().method();

  if (path === "/api/snapshot") return fulfillJson(route, fixtureSnapshot);

  if (/^\/api\/pane\/[^/]+\/history$/.test(path)) {
    return fulfillJson(route, {
      paneId: "w1:p1",
      available: true,
      entries: fixtureTranscript,
      hasMore: false,
      total: fixtureTranscript.length,
      fileTruncated: false,
    });
  }
  if (/^\/api\/pane\/[^/]+\/reply$/.test(path)) {
    // The fake pane stays honest: the draft the POST carried is what the next mirror read renders,
    // exactly as the unit layer's handler does it.
    //
    // SAFETY: the body is the app's own, not a client's — `lib/api.ts` is the only caller of this
    // endpoint and it posts exactly `{ text, submit }`. `postDataJSON()` is typed `any` by
    // Playwright, so the assertion narrows it to the shape `recordReply` already accepts, and both
    // fields are optional there: a body that somehow carried neither reads as an empty draft rather
    // than throwing.
    recordReply(route.request().postDataJSON() as ReplyBody);
    return fulfillJson(route, { ok: true });
  }
  if (/^\/api\/pane\/[^/]+\/(keys|close|rename)$/.test(path)) {
    return fulfillJson(route, { ok: true });
  }
  if (/^\/api\/pane\/[^/]+$/.test(path)) {
    return fulfillJson(route, {
      paneId: "w1:p1",
      text: paneTextWithDraft(),
      truncated: false,
      revision: 1,
    });
  }

  // The DEFAULT world is solo, so the census refuses exactly as a non-lead bridge does. A case that
  // wants a crew overrides this route with `fixtureCrewStatus`.
  if (path === "/api/crew") {
    return fulfillJson(
      route,
      { error: "this collie is not the lead of a crew", code: "crew.not_lead" },
      404,
    );
  }
  if (path === "/api/config") return fulfillJson(route, { push: false, vapidPublicKey: "" });
  if (path === "/api/launchers") return fulfillJson(route, { launchers: [], home: "" });
  // Nothing paired, nothing enforced — a fresh install.
  if (path === "/api/devices" || path === "/api/devices/revoke") {
    return fulfillJson(route, { enforced: false, current: null, devices: [] });
  }
  if (path === "/api/notifications/prefs") {
    return fulfillJson(route, { blocked: true, done: false, updates: true });
  }
  if (path === "/api/notifications/snooze") {
    return fulfillJson(route, { snoozedUntil: null });
  }
  if (path === "/api/update/check") {
    // Level with itself: nothing on offer, so the ribbon has nothing to say on any route.
    return fulfillJson(route, {
      current: STUB_VERSION,
      latest: STUB_VERSION,
      latestUrl: null,
      releaseAvailable: false,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: Date.now(),
    });
  }

  return fulfillJson(
    route,
    { error: `e2e: no API stub for ${method} ${path}`, code: "e2e.unstubbed" },
    501,
  );
}

/**
 * Install the stub. ONE `page.route` for the whole `/api/**` surface, so there is no registration
 * order to reason about: a case that wants a different answer for one endpoint registers its own
 * `page.route` AFTER this call and Playwright checks the newest handler first.
 *
 * Call it before the first `page.goto`.
 */
export async function installApiStub(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    await answer(route, new URL(route.request().url()).pathname);
  });
}

/**
 * Turn the default solo world into a CREW: three machines in the roster and a census to match.
 *
 * `fixtureCrewSnapshot` and `fixtureCrewStatus` describe the same three machines
 * (`src/test/handlers.ts` § the crew fixtures), so the roster the host chrome reads and the census
 * the crew page reads never disagree about who is out there. Two routes are replaced and nothing
 * else is: call it AFTER {@link installApiStub}, whose 501 fall-through still covers everything
 * these two do not name.
 *
 * The roster is what the crew chrome is gated on (`components/crew-provider.tsx:118`, `isMultiHost`),
 * so this is also what makes the footer line and the Settings row exist at all.
 */
export async function installCrewWorld(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => fulfillJson(route, fixtureCrewSnapshot),
  );
  await page.route(
    (url) => url.pathname === "/api/crew",
    (route) => fulfillJson(route, fixtureCrewStatus),
  );
}

/**
 * Fill a message's `{slot}`s, the way the app's own `t()` does.
 *
 * The runtime's `interpolate` (`lib/i18n/index.ts`) is module-private and reads the locale out of
 * `localStorage`, which does not exist in the runner's Node process — so a case that needs an
 * expected string with a slot in it imports the TEMPLATE from the dictionary and fills it here.
 * split/join for the same reason the app uses it: a value carrying `$&` must not become a capture
 * reference.
 */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  let out = template;
  for (const [slot, value] of Object.entries(vars)) {
    out = out.split(`{${slot}}`).join(String(value));
  }
  return out;
}

/**
 * Pin the locale before the first navigation. There is no URL parameter and no `Accept-Language`
 * path in this app; the storage key is the only mechanism, and it has to be written before the
 * bundle's first script runs, which is what `addInitScript` is for.
 */
export async function pinLocale(page: Page, locale: Locale): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [LOCALE_STORAGE_KEY, locale],
  );
}
