import { Outlet, useLoaderData, useParams, useRouteError, useRouteLoaderData } from "react-router";

import { intervalFor, usePolling } from "@/hooks/use-polling";
import { usePollBusy } from "@/hooks/use-poll-busy";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { UpdateAvailableBanner } from "@/components/update-available-banner";
import { ConnectionBanner } from "@/components/connection-banner";
import { PackProvider } from "@/components/pack-provider";
import { DogGallop } from "@/components/dog-gallop";
import { describeThrownError } from "@/lib/api-error-message";
import { homePath } from "@/lib/nav";
import { scopeFromUrl } from "@/lib/session";
import { PANE_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * The "last seen" stamp the ONE connection surface should show — the stamp of the data actually on
 * screen, which is not always the snapshot's.
 *
 * A cold boot straight into a pane re-renders that pane's mirror from the write-through cache, and
 * the two stamps can be hours apart: the operator last opened the pane at 12:05 and left the
 * dashboard polling until 14:32. Dating that 12:05 terminal text "last seen 14:32" is the same
 * dishonesty this whole change removes, one level down — so while a stale mirror is the thing being
 * read, the mirror's own stamp wins, undated included (an undatable mirror says nothing rather than
 * borrowing a number that isn't about it).
 *
 * A stale pane with NO text is not a case: nothing old is on screen, so the herd's stamp is the
 * honest one. Live pane data likewise falls through — the pane is current, and the banner is then
 * describing whatever the snapshot is doing.
 */
export function shownLastSeenAt(home: HomeData, pane: PaneData | undefined): number | undefined {
  if (pane?.error && pane.text) return pane.lastSeenAt;
  return home.lastSeenAt;
}

// The data root: owns the snapshot loader, drives polling, and fans the herd out to the child
// routes (home + pane detail) via the router's loader data. Mounted only while unlocked (the
// idle-lock in App swaps the whole RouterProvider out), so polling pauses when the app is locked.
export function RootLayout() {
  // SAFETY: this component IS the root route's element, and `rootLoader` — the loader `router.tsx`
  // pairs with it — returns `HomeData`. React Router types `useLoaderData()` as `unknown` in data
  // mode; the element does not mount until its own loader has resolved.
  const data = useLoaderData() as HomeData;
  // useParams accumulates params from matched child routes, so `paneId` is set when the
  // `/pane/:paneId` child is active. useAgentTransitions uses it to suppress a notification for the
  // pane you're already looking at.
  const { paneId } = useParams();
  // The active pane's loader data, or undefined when a pane isn't the active route — the router
  // already carries both stamps, so dating the bar by what's on screen needs no store of its own.
  // SAFETY: PANE_ROUTE_ID names the route whose `loader` is paneLoader (router.tsx pairs the two),
  // so the only value that can appear under that id is the PaneData that loader returned.
  const pane = useRouteLoaderData(PANE_ROUTE_ID) as PaneData | undefined;

  // The scope rides along so a "look now" on foreground lands on the machine and session the page is
  // actually showing — a refresh aimed at the lead would leave a peer's herd exactly as stale.
  usePolling(data, paneId, data.scope);
  // Surface the busy bar when a navigation or a poll runs slow, each against its own threshold —
  // routine fast polls/navigations stay invisible. Mounted here so the whole app shares one
  // detector inside the router context.
  usePollBusy();
  useAgentTransitions(data.agents, paneId ?? null);
  usePushSetup();

  // A viewport-height flex column: the top banners (when shown) are in-flow rows at the top and the
  // active route fills the rest (each route root is `min-h-0 flex-1`). This is what keeps a banner
  // from covering the route's sticky header — it reserves real space instead of overlaying.
  return (
    // The pack roster is published here, at the data root, so every surface below — including sheets
    // portalled out to document.body — can answer "which machine?" without a prop chain. With no pack
    // the provider publishes the solo value and nothing downstream renders any host chrome.
    //
    // `ts` and the poll cadence ride along for tier-2 (lead↔peer) health: §10.2 presents a member
    // stale once the lead's last receipt from it is older than `3 × pollMs` (capped at 15s), and
    // `intervalFor` is the same pure resolver `usePolling` above is running on — read here rather
    // than re-derived, so the tolerance can never be computed against a cadence we aren't using.
    <PackProvider servers={data.servers} ts={data.ts} pollMs={intervalFor(data, paneId)}>
      <div className="flex h-[100dvh] flex-col">
        {/* API-observed self-update: mounted unconditionally so its controller runs (and can
            auto-update) for the app's lifetime; renders the slim "tap to update" row only when a fresh
            build is confirmed but auto-update is held off (unsent work) or already spent. */}
        <UpdateAvailableBanner />
        {/* The app's ONE connection surface: a thin, animated bar that stays hidden while healthy, fades
            in amber "reconnecting…" only after ≥4s of sustained trouble (the flicker fix), escalates to a
            red "not connected" cause + Retry/Reload at ≥15s, and flashes green on recovery. Reads the
            same shared-clock signals as the header dog, so the two always agree. */}
        <ConnectionBanner
          bridge={data.bridge}
          error={data.error}
          authError={data.authError}
          lastSeenAt={shownLastSeenAt(data, pane)}
        />
        <Outlet />
      </div>
    </PackProvider>
  );
}

// Shown once, on the very first load, while the snapshot loader resolves (SPA hydration). This is the
// router's HydrateFallback, so it stays mounted until the FIRST loader run settles — and over a dead
// tailnet that initial fetch can hang well past its timeout (or forever on a WebView without
// AbortSignal.timeout). Left as-is, a PWA reopened while the host is unreachable would gallop the dog
// on "Connecting to the herd…" indefinitely, with no way to retry. So once we've been stuck here for
// CONNECTION_LOST_MS (the same wall-clock threshold as the in-app prompt — `connecting` is trivially
// true the whole time we're mounted), the splash escalates to an honest, actionable "Not connected"
// state: the dog rests, the copy says we can't reach Collie, and a Retry re-runs the loaders from
// scratch (a full reload clears most transient failures). Below the threshold it's unchanged.
export function BootSplash() {
  useLocale();
  const stuck = useConnectionLost(true);
  if (!stuck) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <DogGallop running size="4rem" label={t("error.boot.loadingAria")} />
        <span className="text-sm">{t("error.boot.connecting")}</span>
      </div>
    );
  }
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      {/* Rest = the static app icon, muted (grayscale + dimmed) to read asleep — NOT a gallop
          rest-frame, whose full-stretch mid-stride pose looks frozen mid-run. The "Not connected"
          copy below carries the accessible meaning, so the icon is decorative. */}
      <img src="/favicon.svg" alt="" className="size-16 opacity-40 grayscale" />
      <p className="font-medium text-foreground">{t("error.boot.title")}</p>
      <p className="max-w-xs text-sm text-muted-foreground">{t("error.boot.body")}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="text-sm underline underline-offset-4"
      >
        {t("error.boot.retry")}
      </button>
    </div>
  );
}

// Last-resort recovery screen for a render-phase error or a loader throw — a full reload re-runs the
// loaders from scratch, which clears most transient failures.
export function RootError() {
  useLocale();
  const error = useRouteError();
  // An ApiError knows the bridge's code and can therefore say the refusal in the operator's
  // language; anything else (a render-phase throw, a router error) keeps its own message.
  const message = error instanceof Error ? describeThrownError(error) : t("error.root.unknown");
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium text-destructive">{t("error.root.title")}</p>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => {
          // Reload home, but stay on the machine and in the session you were in (read from the
          // live URL, since the router context may be the throwing one). Lead + primary → "/".
          window.location.assign(homePath(scopeFromUrl(window.location.href)));
        }}
        className="text-sm underline underline-offset-4"
      >
        {t("error.root.reload")}
      </button>
    </div>
  );
}
