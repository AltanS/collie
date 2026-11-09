import { useEffect, useRef } from "react";

import { basePath } from "@/lib/base-path";
import { cacheStorage } from "@/lib/env";
import { paneRowKey } from "@/lib/hosts";
import type { HomeData } from "@/lib/loaders";
import { sweepNotificationsIn, type SweepSource, type SweepView } from "@/lib/notification-sweep";
import { needsYou } from "@/lib/triage";

// The page's half of the bridge's clear budget (lib/notification-sweep.ts says why). Mounted at the
// data root, so it runs on every screen that holds the snapshot.
//
// WHEN. On the first live snapshot after the page becomes visible: the snapshot it held before is
// from before the phone was put away, and judging by it could close a notification that arrived
// since. Polls stop while the page is hidden (hooks/use-polling.ts), so the next snapshot to land
// after a return is a fresh one. Then again whenever the snapshot changes what needs you, which is
// the only way a notification already on screen becomes stale while the page is open. Nothing else
// can add one meanwhile: the service worker suppresses a pane's push while a Collie tab is visible.

/** What the snapshot says needs you, row by row, and which rows exist. Equal key, same verdicts. */
export function sweepKey(data: Pick<HomeData, "agents" | "scope" | "viewAll">): string {
  const rows = data.agents.map((a) => `${paneRowKey(a)}${needsYou(a) ? "!" : ""}`);
  return `${data.scope.host ?? ""}|${data.scope.session ?? ""}|${data.viewAll ? "all" : ""}|${rows.join(",")}`;
}

/** Whether this render's snapshot is a fresh read of a bridge whose multiplexer answered. */
export function liveSnapshot(data: HomeData): boolean {
  return data.bridge === "connected" && !data.error && data.stale !== true && data.lastSeenAt === undefined;
}

/** The registration's notifications, or none when this browser has no service worker. */
async function registration(): Promise<SweepSource | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export function useNotificationSweep(data: HomeData): void {
  // The key of the last sweep, cleared when the page is hidden so the next live snapshot sweeps.
  const last = useRef<string | null>(null);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") last.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (document.visibilityState !== "visible" || !liveSnapshot(data)) return;
    const key = sweepKey(data);
    if (key === last.current) return;
    last.current = key;
    const view: SweepView = {
      agents: data.agents,
      scope: data.scope,
      viewAll: data.viewAll,
      servers: data.servers,
      sessions: data.sessions,
    };
    void registration().then((source) =>
      source === null
        ? 0
        : sweepNotificationsIn(source, view, {
            caches: cacheStorage(),
            origin: location.origin,
            mount: basePath(),
            target: navigator,
          }),
    );
  }, [data]);
}
