import { WifiOff } from "lucide-react";

import { useOnline } from "@/hooks/use-online";

// Global connectivity banner. PWA-style: watches navigator.onLine (online/offline events) and, when
// the device has no connection, shows a row at the very top of the app until the connection returns.
// It takes LAYOUT SPACE (an in-flow flex row, not a fixed overlay) so it sits ABOVE each route's own
// sticky header rather than covering the top of it — RootLayout stacks it over the Outlet in a
// viewport-height flex column, so the route shrinks to fit beneath it. As the top-most element it
// owns the safe-area inset, consistent with how each route header handles it when there's no banner.
// Renders nothing while online.
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
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
