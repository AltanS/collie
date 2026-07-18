import { Outlet, useLoaderData, useParams, useRouteError } from "react-router";

import { usePolling } from "@/hooks/use-polling";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { OfflineBanner } from "@/components/offline-banner";
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

  // A viewport-height flex column: the offline banner (when shown) is an in-flow row at the top and
  // the active route fills the rest (each route root is `min-h-0 flex-1`). This is what keeps the
  // banner from covering the route's sticky header — it reserves real space instead of overlaying.
  return (
    <div className="flex h-[100dvh] flex-col">
      <OfflineBanner />
      <Outlet />
    </div>
  );
}

// Shown once, on the very first load, while the snapshot loader resolves (SPA hydration).
export function BootSplash() {
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 text-muted-foreground">
      <DogGallop running size="4rem" label="Loading" />
      <span className="text-sm">Connecting to the herd…</span>
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
