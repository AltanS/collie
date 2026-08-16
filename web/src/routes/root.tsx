import { useEffect, useState } from "react";
import { Outlet, useLoaderData, useParams, useRouteError } from "react-router";

import { usePolling } from "@/hooks/use-polling";
import { usePollBusy } from "@/hooks/use-poll-busy";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { UpdateAvailableBanner } from "@/components/update-available-banner";
import { FreshnessBanner } from "@/components/freshness-banner";
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
    <div className="flex h-[100dvh] flex-col">
      {/* API-observed self-update: mounted unconditionally so its controller runs (and can
          auto-update) for the app's lifetime; renders the slim "tap to update" row only when a fresh
          build is confirmed but auto-update is held off (unsent work) or already spent. */}
      <UpdateAvailableBanner />
      {/* Root-snapshot freshness has its own surface. Pane reads and generic loading never alter it. */}
      <FreshnessBanner
        bridge={data.bridge}
        snapshotStale={data.snapshotStale}
        snapshotAuthError={data.snapshotAuthError}
        snapshotHasLastGood={data.snapshotHasLastGood}
      />
      <Outlet />
    </div>
  );
}

// Shown once while the first root loader resolves. It intentionally reports only elapsed loading
// time: this route has no loader result yet, so it cannot truthfully diagnose network or Herdr state.
export const BOOT_LOADING_DELAY_MS = 4_000;

export function BootSplash() {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setDelayed(true), BOOT_LOADING_DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
      <DogGallop running size="4rem" label="Loading" />
      <p className="text-sm">{delayed ? "Collie is taking longer than expected" : "Loading Collie…"}</p>
      {delayed && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="text-sm underline underline-offset-4"
        >
          Retry
        </button>
      )}
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
