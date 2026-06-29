import { WifiOff } from "lucide-react";

import { useOnline } from "@/hooks/use-online";

// Global connectivity banner. PWA-style: watches navigator.onLine (online/offline events) and, when
// the device has no connection, pins a fixed row to the very top of the app — above every route's
// own header and any open sheet — until the connection returns. Renders nothing while online.
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 border-b border-status-blocked/40 bg-status-blocked px-4 py-1.5 text-xs font-medium text-white [padding-top:calc(env(safe-area-inset-top)_+_0.375rem)]"
    >
      <WifiOff className="size-3.5" />
      <span>Disconnected — waiting for connection…</span>
    </div>
  );
}
