import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { checkForUpdates } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { UpdateInfo } from "@/lib/types";

// "Check for updates" — a manual, on-demand upstream check. The bridge only polls upstream every few
// hours, so this forces a fresh look (which can take ~10s). It reads the current version + last-checked
// time from the snapshot's `update` (via the root loader), then after a check revalidates so the footer
// UpdateBanner reflects the new state. The actionable "available"/"restart needed" lines live in that
// banner; here we only confirm an up-to-date result or surface a check failure.

function describe(update: UpdateInfo | undefined): string {
  if (!update) return "Check whether a new Collie version is available.";
  const checked = update.checkedAt ? ` · checked ${timeAgo(update.checkedAt)}` : "";
  return `Running v${update.current}${checked}`;
}

export function UpdateCheckControl() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  const update = data?.update;
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function check() {
    setBusy(true);
    setError(false);
    const priorCheckedAt = update?.checkedAt ?? null;
    try {
      const result = await checkForUpdates();
      // The bridge is fail-soft: a GitHub fetch error keeps prior state and STILL returns 200. If
      // `checkedAt` didn't advance (or never ran), the check silently failed — surface that rather
      // than let the stale state read as an authoritative "Up to date".
      if (result.checkedAt === null || result.checkedAt === priorCheckedAt) {
        setError(true);
        return;
      }
      revalidator.revalidate(); // pull the fresh snapshot so the footer UpdateBanner updates
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const upToDate = Boolean(update && !update.releaseAvailable && !update.bridgeStale);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <RefreshCw className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Updates</div>
            <p className="text-sm text-muted-foreground">{describe(update)}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-border/60 p-3">
        <Button variant="outline" size="sm" disabled={busy} onClick={check}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Checking…
            </>
          ) : (
            "Check for updates"
          )}
        </Button>
        {/* Lightweight result — the actionable "available"/"restart" case is left to the UpdateBanner. */}
        {!busy && error && <span className="text-xs text-status-blocked">Couldn't check.</span>}
        {!busy && !error && upToDate && (
          <span className="text-xs text-muted-foreground">Up to date</span>
        )}
      </div>
    </Card>
  );
}
