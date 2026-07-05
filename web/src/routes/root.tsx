import { Outlet, useLoaderData, useParams, useRouteError } from "react-router";

import { usePolling } from "@/hooks/use-polling";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { OfflineBanner } from "@/components/offline-banner";
import { DogGallop } from "@/components/dog-gallop";
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

  return (
    <>
      <OfflineBanner />
      <Outlet />
    </>
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
        onClick={() => window.location.assign("/")}
        className="text-sm underline underline-offset-4"
      >
        Reload
      </button>
    </div>
  );
}
