import { Loader2 } from "lucide-react";
import { Outlet, useLoaderData, useParams } from "react-router-dom";

import { usePolling } from "@/hooks/use-polling";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { OfflineBanner } from "@/components/offline-banner";
import type { HomeData } from "@/lib/loaders";

// The data root: owns the snapshot loader, drives polling, and fans the herd out to the child
// routes (home + pane detail) via the router's loader data. Mounted only while unlocked (the
// idle-lock in App swaps the whole RouterProvider out), so polling pauses when the app is locked.
export function RootLayout() {
  const data = useLoaderData() as HomeData;
  const { paneId } = useParams();

  usePolling(data);
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
      <Loader2 className="size-6 animate-spin" />
      <span className="text-sm">Connecting to the herd…</span>
    </div>
  );
}
