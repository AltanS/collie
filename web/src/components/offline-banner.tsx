import { RotateCw, WifiOff } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { useOnline } from "@/hooks/use-online";

// Global connectivity banner. PWA-style: watches navigator.onLine (online/offline events) and, when
// the device has no connection, shows a row at the very top of the app until the connection returns.
// It takes LAYOUT SPACE (an in-flow flex row, not a fixed overlay) so it sits ABOVE each route's own
// sticky header rather than covering the top of it — RootLayout stacks it over the Outlet in a
// viewport-height flex column, so the route shrinks to fit beneath it. As the top-most element it
// owns the safe-area inset, consistent with how each route header handles it when there's no banner.
// Renders nothing while online.
//
// Two stages, on the same wall-clock threshold the online prompt uses (useConnectionLost): a brief
// drop shows the quiet "waiting for connection…" row (a blip shouldn't shout); once the device has
// been offline past the threshold it ESCALATES this same banner — copy to "Not connected" plus an
// actionable Retry/Reload — so a phone left offline stops looking busy and becomes actionable. It's
// this banner (not a second one) because ConnectionLostPrompt is gated ONLINE: exactly one escalated
// banner per cause, offline here and bridge/Herdr there.
export function OfflineBanner() {
  const online = useOnline();
  const lost = useConnectionLost(!online);
  const revalidator = useRevalidator();
  if (online) return null;

  if (!lost) {
    return (
      <div
        role="status"
        className="flex shrink-0 items-center justify-center gap-2 border-b border-status-blocked/40 bg-status-blocked px-4 py-1.5 text-xs font-medium text-white [padding-top:calc(env(safe-area-inset-top)_+_0.375rem)]"
      >
        <WifiOff className="size-3.5" />
        <span>Disconnected — waiting for connection…</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-status-blocked/40 bg-status-blocked/15 px-4 py-2.5 text-sm [padding-top:calc(env(safe-area-inset-top)_+_0.625rem)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <WifiOff className="size-4 shrink-0 text-status-blocked" />
        <span className="font-medium text-foreground">Not connected — you appear to be offline.</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Retry re-runs the loaders (harmless while still offline; recovers the instant the browser's
            onLine flag was merely stale). Reload is the full escape hatch. Either way, going back
            online unmounts this banner on its own — no reload required to recover. */}
        <Button size="sm" className="h-8 gap-1.5" onClick={() => revalidator.revalidate()}>
          <RotateCw className="size-3.5" />
          Retry
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    </div>
  );
}
