import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page, Route } from "@playwright/test";

import type { Locale } from "@/lib/i18n/locale";
import type { MachineAlerts, PaneChatResponse, PaneHistoryResponse, SnapshotResponse } from "@/lib/types";
import { TOUR_STORAGE_KEY, TOUR_VERSION } from "@/lib/tour";
import {
  fixtureChangeDiff,
  fixtureChanges,
  fixtureCommit,
  fixtureCommitDiff,
  fixtureCrewSnapshot,
  fixtureCrewStatus,
  fixtureFileImage,
  fixtureFileRead,
  fixtureFilesDir,
  FIXTURE_FILES_UNKNOWN,
  fixtureNewSpace,
  fixtureNewTab,
  fixtureSnapshot,
  fixtureTranscript,
  paneTextWithDraft,
  recordReply,
} from "@/test/handlers";
import { censusFor, fixtureMachines, fixtureMachinesSolo, historyFor } from "@/test/machine-fixtures";

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

/** `POST /api/workspace`'s body, as `lib/api.ts`'s `createWorkspace` posts it. */
interface CreateSpaceBody {
  readonly label?: string;
  readonly cwd?: string;
}

/** The home the stub's multiplexer opens a blank create in — the fixture new space's own folder. */
const STUB_HOME = fixtureNewSpace.pane.cwd;

/**
 * Answer the one request. Split out of the route so the dispatch reads as a table and so an
 * unmatched path is a loud 501 rather than a silent fall-through to the static server, which would
 * hand the app `index.html` for a JSON fetch and fail somewhere far away from the cause.
 */
async function answer(route: Route, path: string): Promise<void> {
  const method = route.request().method();

  if (path === "/api/snapshot") return fulfillJson(route, fixtureSnapshot);

  // The Changes view (ADR 0065): the list, or with `?repo=&path=` one file's diff. Asked by pane or
  // by workspace, the answer is the same list.
  if (/^\/api\/(?:pane|workspace)\/[^/]+\/changes$/.test(path)) {
    const q = new URL(route.request().url()).searchParams;
    const repo = q.get("repo");
    const file = q.get("path");
    if (q.get("view") === "commit") {
      return fulfillJson(route, repo !== null && file !== null ? fixtureCommitDiff(repo, file) : fixtureCommit);
    }
    if (repo !== null && file !== null) return fulfillJson(route, fixtureChangeDiff(repo, file));
    return fulfillJson(route, fixtureChanges);
  }

  // The Files view (ADR 0083): a folder (`?dir=`, none for the root) or one file (`?path=`).
  if (/^\/api\/(?:pane|workspace)\/[^/]+\/files$/.test(path)) {
    const q = new URL(route.request().url()).searchParams;
    const file = q.get("path");
    const found = file !== null ? fixtureFileRead(file) : fixtureFilesDir(q.get("dir") ?? "");
    return found === null ? fulfillJson(route, FIXTURE_FILES_UNKNOWN, 404) : fulfillJson(route, found);
  }

  // One picture under the Files root, as bytes (ADR 0090).
  if (/^\/api\/(?:pane|workspace)\/[^/]+\/files\/image$/.test(path)) {
    const bytes = fixtureFileImage(new URL(route.request().url()).searchParams.get("path") ?? "");
    if (bytes === null) return fulfillJson(route, FIXTURE_FILES_UNKNOWN, 404);
    return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(bytes) });
  }

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
  if (/^\/api\/pane\/[^/]+\/subagent\/[^/]+$/.test(path)) {
    return fulfillJson(route, { paneId: "w1:p1", agentId: "a000000", available: false });
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
  // Walky talky (M62): no messages, and a send answers an accepted receipt for the one address.
  if (/^\/api\/pane\/[^/]+\/walky$/.test(path)) return fulfillJson(route, { messages: [] });
  if (path === "/api/walky/who") return fulfillJson(route, { targets: [] });
  if (path === "/api/walky" && method === "POST") {
    // SAFETY: the body is the app's own, `lib/api.ts`'s `postWalky` is the only caller and it posts `{ id, to, body, replyTo? }`.
    const posted = route.request().postDataJSON() as { id: string; to: string };
    return fulfillJson(route, { receipt: { id: posted.id, state: "accepted", verified: "local", at: Date.now(), by: "solo", target: posted.to } });
  }
  if (/^\/api\/pane\/[^/]+$/.test(path)) {
    return fulfillJson(route, {
      paneId: "w1:p1",
      text: paneTextWithDraft(),
      truncated: false,
      revision: 1,
    });
  }

  // A new tab (the tab strip's "+", a workspace heading's "+"): the fresh shell pane, whichever
  // machine the `?host=` names. A case that cares where the create went reads the request itself.
  if (path === "/api/tab" && method === "POST") return fulfillJson(route, fixtureNewTab);

  // A new space: the fixture's fresh shell pane, opened where the create asked — a blank field is
  // home, and reported back the way a multiplexer reports it.
  if (path === "/api/workspace" && method === "POST") {
    // SAFETY: the body is the app's own — `lib/api.ts`'s `createWorkspace` is the only caller and it
    // posts `{ label?, cwd? }`. Both fields are optional there, so a body with neither is a create in
    // home, which is what the bridge reads it as too.
    const body = route.request().postDataJSON() as CreateSpaceBody;
    const typed = body.cwd ?? "";
    const reported = typed.trim() === "" ? STUB_HOME : typed.trim();
    return fulfillJson(route, { ...fixtureNewSpace, pane: { ...fixtureNewSpace.pane, cwd: reported } });
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
  // The machines census: a solo lead with one row, its day of history, and the alert POST echoing the
  // body it was given (the bridge answers the rules as stored). A case that wants a crew, or that
  // wants the rules to stick, registers its own route after `installApiStub` (see `installMachinesWorld`).
  if (path === "/api/machines") return fulfillJson(route, censusFor(fixtureMachinesSolo, new URL(route.request().url())));
  if (/^\/api\/machines\/[^/]+\/history$/.test(path)) return fulfillJson(route, historyFor(new URL(route.request().url())));
  if (/^\/api\/machines\/[^/]+\/alerts$/.test(path) && method === "POST") {
    // SAFETY: as in `installMachinesWorld`, the body is the app's own `MachineAlerts`.
    return fulfillJson(route, { alerts: route.request().postDataJSON() as MachineAlerts });
  }
  if (path === "/api/config") return fulfillJson(route, { push: false, vapidPublicKey: "" });
  if (path === "/api/launchers") return fulfillJson(route, { launchers: [], home: "" });
  // Nothing paired on a fresh install, and pairing is always on (ADR 0086). The stub answers every
  // other read without a token, so the cases need not pair first: it stands in for a paired phone.
  if (path === "/api/devices" || path === "/api/devices/revoke") {
    return fulfillJson(route, { enforced: true, current: null, devices: [] });
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
 * It also pre-spends the first-launch tour, which is what keeps every `app` spec working unedited:
 * the sheet is full-height, so an unseeded origin would put it over the screen a case looks at.
 *
 * Call it before the first `page.goto`.
 */
export async function installApiStub(page: Page): Promise<void> {
  await seedTourSeen(page);
  await page.route("**/api/**", async (route) => {
    await answer(route, new URL(route.request().url()).pathname);
  });
}

/**
 * Tell the origin it has already seen this bundle's tour, before the first script runs. The key and
 * the version both come from `src/lib/tour.ts` — neither is re-typed here, so a bumped
 * `TOUR_VERSION` seeds the new number without this file changing.
 */
export async function seedTourSeen(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [TOUR_STORAGE_KEY, String(TOUR_VERSION)],
  );
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
 * Turn the default solo machines census into the crew's four machines, with alert rules that STICK:
 * a POST to a machine's alerts replaces that machine's rules in the census the next read returns, the
 * way the bridge stores them. Returns the bodies posted, in order, for a case that asserts on them.
 *
 * Call it AFTER {@link installApiStub}: Playwright checks the newest handler first.
 */
export async function installMachinesWorld(page: Page): Promise<{ posted: { id: string; body: unknown }[] }> {
  const posted: { id: string; body: unknown }[] = [];
  const machines = structuredClone(fixtureMachines);
  await page.route(
    (url) => url.pathname === "/api/machines",
    (route) => fulfillJson(route, censusFor(machines, new URL(route.request().url()))),
  );
  await page.route(
    (url) => /^\/api\/machines\/[^/]+\/alerts$/.test(url.pathname),
    async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3] ?? "");
      // SAFETY: the body is the app's own: `lib/api.ts`'s `setMachineAlerts` is the only caller and it
      // posts a `MachineAlerts` object.
      const body = route.request().postDataJSON() as MachineAlerts;
      posted.push({ id, body });
      const row = machines.machines.find((m) => m.id === id);
      if (row) row.alerts = body;
      return fulfillJson(route, { alerts: body });
    },
  );
  return { posted };
}

/** A `POST /api/pane/:id/keys` body, as `lib/api.ts`'s `sendKeys` posts it. */
export interface SentKeys {
  readonly keys: readonly string[];
  readonly expected_prompt?: string;
  readonly expected_styled?: string;
}

/** A terminal transition: on screen `on`, the keys `keys` turn the pane into screen `to`. */
export interface PaneStep {
  readonly on: string;
  readonly keys: readonly string[];
  readonly to: string;
}

/** What {@link installPaneWorld} draws: one agent pane, its journal, and its screens by name. */
export interface PaneWorldOptions {
  readonly paneId: string;
  readonly snapshot: SnapshotResponse;
  readonly chat: PaneChatResponse;
  /** The History answer. The default stub's own transcript when absent. */
  readonly history?: PaneHistoryResponse;
  readonly screens: Readonly<Record<string, string>>;
  readonly start: string;
  readonly script?: readonly PaneStep[];
}

/** What a case reads back from {@link installPaneWorld}. */
export interface PaneWorld {
  /** Every keys body the app posted, in order. */
  readonly sent: SentKeys[];
  /** The path of every write the app made to the pane, keys included, in order. */
  readonly writes: string[];
  /** Change the screen the next read returns, as the terminal would change on its own. */
  show(name: string): void;
}

/** A pane screen from the corpus the unit layer reads, `src/fixtures/panes/<name>.txt`, for the
 *  `screens` of {@link installPaneWorld}. */
export function paneCapture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/fixtures/panes/${name}.txt`, import.meta.url)), "utf8");
}

/**
 * A pane whose screen follows the keys the app sends. A static screen would refuse a guarded walk,
 * because each read after the arrows must show where they landed. The stub accepts every keys POST
 * and records it; whether a binding is right is the unit layer's to check
 * (`src/lib/harness/prompt-binding-contract.test.ts` and the bridge's prompt-binding tests).
 *
 * Call it AFTER {@link installApiStub}: Playwright checks the newest handler first.
 */
export async function installPaneWorld(page: Page, world: PaneWorldOptions): Promise<PaneWorld> {
  const pane = `/api/pane/${encodeURIComponent(world.paneId)}`;
  const sent: SentKeys[] = [];
  const writes: string[] = [];
  let showing = world.start;

  await page.route((url) => url.pathname === "/api/snapshot", (route) => fulfillJson(route, world.snapshot));
  await page.route((url) => url.pathname === `${pane}/chat`, (route) => fulfillJson(route, world.chat));
  const history = world.history;
  if (history !== undefined) await page.route((url) => url.pathname === `${pane}/history`, (route) => fulfillJson(route, history));
  await page.route(
    (url) => url.pathname === pane,
    (route) => fulfillJson(route, { paneId: world.paneId, text: world.screens[showing], truncated: false, revision: 1 }),
  );
  await page.route(
    (url) => url.pathname.startsWith(`${pane}/`),
    async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fallback();
      const path = new URL(request.url()).pathname;
      writes.push(path);
      if (path !== `${pane}/keys`) return route.fallback();
      // SAFETY: the body is the app's own: `lib/api.ts`'s `sendKeys` is the only caller of this
      // endpoint, and it posts exactly `{ keys, expected_prompt?, expected_styled?, … }`.
      const body = request.postDataJSON() as SentKeys;
      sent.push(body);
      const step = world.script?.find((s) => s.on === showing && s.keys.join("+") === body.keys.join("+"));
      if (step !== undefined) showing = step.to;
      return fulfillJson(route, { ok: true });
    },
  );
  return {
    sent,
    writes,
    show: (name) => {
      showing = name;
    },
  };
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

/**
 * Turn the device's Changes segment (the changesOnly pref) on before the first navigation, so the Changes screen's body
 * is the list of changes rather than the folder tree, its default since 2026-10-06 (ADR 0083). For a
 * case that tests the list itself. Written only while nothing is stored, so a reload keeps whatever
 * the page wrote since.
 */
export async function seedChangesOnly(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, JSON.stringify({ changesOnly: true }));
  }, "collie:dash-prefs:v1");
}
