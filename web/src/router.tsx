import { createBrowserRouter, replace } from "react-router";

import { basePath } from "@/lib/base-path";
import { pairLandingPath } from "@/lib/nav";
import { listenForInAppOpen, markBooted, openPendingTarget, probeStandalone, seedColdEntry, type OpenGate } from "@/lib/nav-entry";
import { isReloadInFlight } from "@/lib/pwa";
import { UPDATE_MODE_HOLD, isReloadHeldBy, subscribeReloadHeld } from "@/lib/reload-guard";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { HomeRoute } from "@/routes/home";
import { SlotRoute } from "@/routes/slot";
import { SpaceRoute } from "@/routes/space";
import { TrickSessionRoute } from "@/routes/trick-session";
import { NewRoute } from "@/routes/new";
import { NewAddRoute } from "@/routes/new-add";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { ConversationRoute, ConversationsRoute } from "@/routes/conversations";
import { ChangesRoute } from "@/routes/changes";
import { SettingsRoute } from "@/routes/settings";
import { SettingsLayout } from "@/components/settings-shell";
import {
  OldSettingsRedirect,
  SettingsCharacterRoute,
  SettingsChatRoute,
  SettingsDashboardRoute,
  SettingsDevicesRoute,
  SettingsInstallCountRoute,
  SettingsKeysRoute,
  SettingsLookRoute,
  SettingsMachineLoadRoute,
  SettingsNotificationsRoute,
  SettingsPrivacyRoute,
  SettingsTricksRoute,
  SettingsVoiceHostRoute,
  SettingsVoiceModelRoute,
  SettingsVoiceRoute,
} from "@/routes/settings-sections";
import { SettingsAccountAddRoute, SettingsAccountRoute, SettingsAccountsRoute } from "@/routes/settings-accounts";
import { SettingsTrickRoute } from "@/routes/settings-trick";
import { SettingsChangeLoginRoute } from "@/routes/settings-change-login";
import { CrewRoute } from "@/routes/crew";
import { MachineRoute } from "@/routes/machine";
import { MachinesRoute } from "@/routes/machines";
import { UpdatesRoute } from "@/routes/updates";
import { HillRoute } from "@/routes/hill";
import { TrickCardRoute } from "@/routes/trick-card";
import { PairApproveRoute } from "@/routes/pair-approve";
import {
  devicesLoader,
  historyLoader,
  crewLoader,
  machinesListLoader,
  machinesLoader,
  rootLoader,
  paneLoader,
  PANE_ROUTE_ID,
  ROOT_ROUTE_ID,
} from "@/lib/loaders";

// We don't use React Router's view transitions (the glides start their own, by hand, and never
// touch this map: lib/glide.ts). React Router persists an "applied view transitions" map to
// sessionStorage ("remix-router-transitions") and replays a phantom same-location transition on every
// revalidation for any path it once saw a `viewTransition: true` navigation from. A device that ran an
// older Collie build (which did use them) can carry a stale entry that fires
// document.startViewTransition on every poll. Clear it on boot — our code never repopulates it. The
// `:root { view-transition-name: none }` in index.css is the belt to this: even a stray transition
// then captures nothing, so there's no visible flicker regardless of this key's name.
try {
  sessionStorage.removeItem("remix-router-transitions");
} catch {
  // sessionStorage access can throw in locked-down / private contexts — ignore.
}

// A cold deep link gets its parents put behind it BEFORE the router reads the entry it boots on, so
// the phone's first edge swipe goes up one level instead of doing nothing (ADR 0067, lib/nav-entry).
seedColdEntry({
  location: window.location,
  history: window.history,
  sessionStorage: safeSessionStorage(),
  standalone: probeStandalone,
});

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

// Created once at module scope so the idle-lock in App can unmount/remount RouterProvider without
// losing the current location (the router instance retains it; loaders re-run fresh on remount).
export const router = createBrowserRouter([
  {
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: rootLoader,
    element: <RootLayout />,
    // Catches render-phase errors and loader throws (e.g. a missing :paneId) so a component bug
    // shows a recoverable screen instead of React Router's blank default.
    errorElement: <RootError />,
    HydrateFallback: BootSplash,
    children: [
      { index: true, element: <HomeRoute /> },
      // A permanent address for one browser tab; it replaces itself with that tab's last pane (lib/slots.ts).
      { path: "slot/:slot", element: <SlotRoute /> },
      { path: "space/:spaceId", element: <SpaceRoute /> },
      // A trick's own session (M94 slice 03). No loader: it reads the root snapshot (the Tricks Space) and
      // the tricks store, which the root loader keeps at the snapshot's `tricksRev`.
      { path: "trick/:paneId", element: <TrickSessionRoute /> },
      // The New page (M48), a page since 1.19.0 and a bottom sheet before. No loader: it reads the root
      // snapshot (for a pane's folder and branch) and asks the chosen machine's bridge for its own lists.
      // Where it was opened from rides in the query (`?machine=`, `?pane=`, `?s=`), so a reload keeps it.
      // The hill (M96): the Decisions agents posted, one level below the Dashboard. No loader: its
      // lists live in lib/hill/store.ts, kept current by the root loader.
      { path: "hill", element: <HillRoute /> },
      // One card of Collie's own about a trick (M96 spec 14), with the Hill on or off. No loader: the card
      // lives in lib/hill/store.ts, kept current by the root loader.
      { path: "trick-card/:decisionId", element: <TrickCardRoute /> },
      // A paired browser answers another device's pairing request here (ADR 0139). Reached only from the
      // QR the new device shows (`?r=<public id>`); nothing in the app links to it. No loader: the page
      // reads the request itself, and a browser that is not paired is told so without a read.
      { path: "pair/approve", element: <PairApproveRoute /> },
      { path: "new", element: <NewRoute /> },
      // "Add your own" (ADR 0094): a page below New, for a launcher this phone adds on one machine.
      { path: "new/add", element: <NewAddRoute /> },
      // SETTINGS, one layout route around every address below it (components/settings-shell.tsx). On a phone, a tablet
      // and with Large-screen layout Off it draws only its outlet; on the large screen it draws the header, the section
      // list and the chosen section beside it (ADR 0158, addendum 2026-11-21). The addresses are what they were.
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          // Settings is an INDEX of eleven pages (routes/settings.tsx). Its only loader is the pairing
          // forward: the QR `collie pair` prints still names `/settings?pair=<code>`, and the form now
          // lives on Devices and machines. `replace`, as for `/pack` below, so Back does not land on the index and
          // bounce forward again. No `pair`, no redirect, and the registry stays on Devices and machines' loader.
          {
            index: true,
            loader: ({ request }) => {
              const target = pairLandingPath(new URL(request.url).search);
              return target === null ? null : replace(target);
            },
            element: <SettingsRoute />,
          },
          // The eleven pages (ADR 0168), in the index's order. Each draws the registry's page (lib/settings/pages.ts).
          { path: "look", element: <SettingsLookRoute /> },
          // One level below Look and feel, like Voice's two pages: which character the header draws.
          { path: "look/character", element: <SettingsCharacterRoute /> },
          { path: "chat", element: <SettingsChatRoute /> },
          { path: "keys", element: <SettingsKeysRoute /> },
          // Notifications carries the machines census for its Machine load group, and one machine's alerts sit below it.
          { path: "notifications", loader: machinesLoader, element: <SettingsNotificationsRoute /> },
          { path: "notifications/load/:machine", loader: machinesLoader, element: <SettingsMachineLoadRoute /> },
          { path: "voice", element: <SettingsVoiceRoute /> },
          // Two pages below Voice: the host's option for every device, and the Whistle model's copies.
          { path: "voice/host", element: <SettingsVoiceHostRoute /> },
          { path: "voice/model", element: <SettingsVoiceModelRoute /> },
          { path: "dashboard", element: <SettingsDashboardRoute /> },
          // Profiles (M101): a second login for an agent. The list, the Add form and one profile's page. The row in
          // the index is offered only while GET /api/accounts answers 200; the pages are routable always and
          // say so when the machine offers none.
          { path: "accounts", element: <SettingsAccountsRoute /> },
          { path: "accounts/add", element: <SettingsAccountAddRoute /> },
          { path: "accounts/:id", element: <SettingsAccountRoute /> },
          { path: "accounts/:id/login", element: <SettingsChangeLoginRoute /> },
          // Tricks and the Hill: both switches, and the list while tricks are on.
          { path: "tricks", element: <SettingsTricksRoute /> },
          // One trick's details (2026-11-21, a bottom sheet before): `<host>:<id>`, or an official entry's bare id
          // (lib/nav.ts `trickDetailPath`). No loader: it reads the tricks store and the official list, as the list does.
          { path: "tricks/:key", element: <SettingsTrickRoute /> },
          // Devices and machines carries the paired-device registry, so a revoke or a pair is the app's standard
          // mutation shape (api call, then revalidate), with no second data path.
          { path: "devices", loader: devicesLoader, element: <SettingsDevicesRoute /> },
          { path: "privacy", element: <SettingsPrivacyRoute /> },
          // One level below Privacy and data: the install count's switch and its explanation.
          { path: "privacy/install-count", element: <SettingsInstallCountRoute /> },
          // Updates and about. No loader of its own: everything on it is either the snapshot (root loader) or the
          // card's own read of /api/update/check, and it is ON the poll loop, so a run in progress shows without a reload.
          { path: "updates", element: <UpdatesRoute /> },
          // THE OLD ADDRESSES (before 2026-11-21): each opens the page that holds most of what it held, the query and
          // the fragment carried (routes/settings-sections.tsx `OldSettingsRedirect`). An element, not a loader,
          // because a loader's request has no fragment, and `#changes` decides the page.
          { path: "appearance", element: <OldSettingsRedirect from="appearance" /> },
          { path: "appearance/character", element: <OldSettingsRedirect from="appearance" below="character" /> },
          { path: "harnesses", element: <OldSettingsRedirect from="harnesses" /> },
          { path: "device", element: <OldSettingsRedirect from="device" /> },
          { path: "alerts", element: <OldSettingsRedirect from="alerts" /> },
          { path: "experiments", element: <OldSettingsRedirect from="experiments" /> },
          { path: "system", element: <OldSettingsRedirect from="system" /> },
          { path: "system/install-count", element: <OldSettingsRedirect from="system" below="install-count" /> },
        ],
      },
      // The crew census, likewise on its own loader — and deliberately ON the poll loop: the payload
      // is one small object per machine, and the whole point of the page is that a member going
      // quiet shows up here without the operator reloading. (History opts out; this one wants in.)
      { path: "crew", loader: crewLoader, element: <CrewRoute /> },
      // The machines list and one machine's page. Both read the census through the same loader and
      // both stay ON the poll loop: a value moving and an alert firing should show without a reload.
      // The detail page's history is its own timed read (hooks/use-machine-history.ts), because every
      // active loader is refetched on each tick and 1440 points a tick would be pure waste.
      { path: "machines", loader: machinesListLoader, element: <MachinesRoute /> },
      { path: "machines/:id", loader: machinesLoader, element: <MachineRoute /> },
      // The path was `crew` until 1.7.0 (M24 renamed the word a person reads). The service worker
      // caches the app shell, so a client sitting on /crew when the new bundle arrives, a bookmark
      // and an installed PWA's start URL all still ask for the old spelling. `replace` rather than
      // a push, so Back does not bounce the operator between the two names. The query string rides
      // along, because the scope (`?h=`) is what makes "back" return to the right machine.
      {
        path: "pack",
        loader: ({ request }) => replace(`/crew${new URL(request.url).search}`),
      },
      // Named, so RootLayout can ask for THIS route's data by id (react-router hands back undefined
      // whenever it isn't the active route) — see the "last seen" note there.
      //
      // `zoom` is the pane's output, zoomed (components/output-zoom.tsx): a level below the pane, so
      // the phone's back closes it (ADR 0067), and a CHILD of this route rather than a sibling like
      // History, so the pane route stays matched and mounted under it: the same loader keeps the
      // text live, and the composer, its draft and the mirror's place are all still there when the
      // view closes. The child draws nothing itself; AgentChat reads the match and draws the view.
      {
        id: PANE_ROUTE_ID,
        path: "pane/:paneId",
        loader: paneLoader,
        element: <DetailRoute />,
        children: [{ path: "zoom", element: null }],
      },
      {
        path: "pane/:paneId/history",
        loader: historyLoader,
        element: <HistoryRoute />,
        // Opt OUT of the poll loop. revalidate() re-runs every active loader, and a transcript can be
        // hundreds of turns — re-pulling it every 1.5s would be pure waste, and it would fight the
        // view's own "load older" paging by resetting the page under it. History is fetched on
        // navigation; the view pages back through it with direct api calls.
        shouldRevalidate: () => false,
      },
      // A durable program's own history (M53 spec 11): its list of conversations, and one of them read
      // only. Neither has a loader. Each reads on open and on its Load more tap, so the poll loop's
      // revalidate() fetches nothing for them; `shouldRevalidate` states the same opt-out as History's.
      { path: "conversations", element: <ConversationsRoute />, shouldRevalidate: () => false },
      { path: "conversations/:id", element: <ConversationRoute />, shouldRevalidate: () => false },
      {
        // The Changes view (ADR 0065). No loader: the view reads the list and an open file's diff
        // itself, on open, on its own 5 s beat while visible and on its refresh button, so the poll
        // loop's revalidate() fetches nothing for it. `shouldRevalidate` states the same opt-out as
        // History's, should a loader ever be added.
        // `/*` so the commit view below the list (`changes/commit`, ADR 0065) is the same route
        // and the same mounted component: the list keeps its state under the commit. A folder or a
        // file of the folder tree (`changes/files`, ADR 0083) is matched here too, the same screen.
        path: "pane/:paneId/changes/*",
        element: <ChangesRoute />,
        shouldRevalidate: () => false,
      },
      {
        // The same view asked by workspace: every pane of a space shows one list (ADR 0065), and
        // this form lets a dashboard entry open it without naming a pane. Host-aware through the
        // scope query like every other route.
        path: "space/:spaceId/changes/*",
        element: <ChangesRoute />,
        shouldRevalidate: () => false,
      },
    ],
  },
], {
  // The mount the bridge served this document under (ADR 0052): `/` at the root, `/collie/` behind
  // a proxy that gives Collie a path. Every route path above stays root-relative; the router puts
  // the mount in front of them and takes it off what it reads from the address bar.
  basename: basePath(),
});

// This tab has booted: a later fresh entry in it is a reload (iOS evicting the installed app drops
// `history.state`), never a cold start to seed (ADR 0067).
markBooted(safeSessionStorage());

// A notification tapped while the app is on screen opens its pane in THIS router, as a push from
// wherever the operator was (ADR 0067). The service worker asks and waits for the answer; an app
// that does not answer gets the old full-document navigate. While update mode holds the reload, or
// a reload is already on its way, the target waits in sessionStorage for the fresh page, which opens
// it right here at boot.
const openGate: OpenGate = {
  busy: () => isReloadHeldBy(UPDATE_MODE_HOLD) || isReloadInFlight(),
  subscribe: subscribeReloadHeld,
  storage: safeSessionStorage(),
};
openPendingTarget(router, openGate);
listenForInAppOpen(router, openGate);
