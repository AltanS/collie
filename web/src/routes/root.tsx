import { Outlet, useLoaderData, useParams, useRouteError } from "react-router";

import { usePolling } from "@/hooks/use-polling";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { UpdateAvailableBanner } from "@/components/update-available-banner";
import { ConnectionBanner } from "@/components/connection-banner";
import { DogGallop } from "@/components/dog-gallop";
import { homePath } from "@/lib/nav";
import { SESSION_PARAM, normalizeSession } from "@/lib/session";
import type { HomeData } from "@/lib/loaders";

// The data root: owns the snapshot loader, drives polling, and fans the herd out to the child
// routes (home + pane detail) via the router's loader data. Mounted only while unlocked (the
// idle-lock in App swaps the whole RouterProvider out), so polling pauses when the app is locked.
export function RootLayout() {
  const data = useLoaderData() as HomeData;
  // useParams accumulates params from matched child routes, so `paneId` is set when the
  // `/pane/:paneId` child is active. useAgentTransitions uses it to suppress a notification for the
  // pane you're already looking at.
  const { paneId } = useParams();

  usePolling(data, paneId);
  useAgentTransitions(data.agents, paneId ?? null);
  usePushSetup();

  // A viewport-height flex column: the top banners (when shown) are in-flow rows at the top and the
  // active route fills the rest (each route root is `min-h-0 flex-1`). This is what keeps a banner
  // from covering the route's sticky header — it reserves real space instead of overlaying.
  return (
    <div className="flex h-[100dvh] flex-col">
      {/* API-observed self-update: mounted unconditionally so its controller runs (and can
          auto-update) for the app's lifetime; renders the slim "tap to update" row only when a fresh
          build is confirmed but auto-update is held off (unsent work) or already spent. */}
      <UpdateAvailableBanner />
      {/* The app's ONE connection surface: a thin, animated bar that stays hidden while healthy, fades
          in amber "reconnecting…" only after ≥4s of sustained trouble (the flicker fix), escalates to a
          red "not connected" cause + Retry/Reload at ≥15s, and flashes green on recovery. Reads the
          same shared-clock signals as the header dog, so the two always agree. */}
      <ConnectionBanner bridge={data.bridge} error={data.error} />
      <Outlet />
    </div>
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
  const stuck = useConnectionLost(true);
  if (!stuck) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 text-muted-foreground">
        <DogGallop running size="4rem" label="Loading" />
        <span className="text-sm">Connecting to the herd…</span>
      </div>
    );
  }
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      {/* Rest = the static app icon, muted (grayscale + dimmed) to read asleep — NOT a gallop
          rest-frame, whose full-stretch mid-stride pose looks frozen mid-run. The "Not connected"
          copy below carries the accessible meaning, so the icon is decorative. */}
      <img src="/favicon.svg" alt="" className="size-16 opacity-40 grayscale" />
      <p className="font-medium text-foreground">Not connected</p>
      <p className="max-w-xs text-sm text-muted-foreground">
        Can&rsquo;t reach Collie — check your connection to the host, then try again.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="text-sm underline underline-offset-4"
      >
        Retry
      </button>
    </div>
  );
}

// Last-resort recovery screen for a render-phase error or a loader throw — a full reload re-runs the
// loaders from scratch, which clears most transient failures.
export function RootError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium text-destructive">Something went wrong</p>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => {
          // Reload home, but stay in the session you were in (read from the live URL, since the
          // router context may be the throwing one). Primary → plain "/".
          const session = normalizeSession(
            new URLSearchParams(window.location.search).get(SESSION_PARAM),
          );
          window.location.assign(homePath(session));
        }}
        className="text-sm underline underline-offset-4"
      >
        Reload
      </button>
    </div>
  );
}
