import { ArrowUpCircle } from "lucide-react";

import { checkForUpdate } from "@/lib/pwa";
import { useSelfUpdate } from "@/lib/self-update";

// Slim persistent "New version — tap to update" row, the fallback for when the self-updater is
// confirmed-stale but can't auto-update right now — the user has unsent work (an open composer draft,
// an in-flight upload, an open action sheet) or we already auto-updated once for this build. An
// in-flow row (not an overlay) that stacks above the route in RootLayout's flex column rather than
// covering the sticky header. Shares the OutageBanner metrics — text-xs, py-1.5, one truncating row —
// so every top-of-app row reads as one consistent band.
//
// Mounted unconditionally so useSelfUpdate() runs the controller for its whole lifetime — the
// auto-update path runs even while this returns null (banner hidden). Tapping takes the same update
// path as the footer button and the auto-path: checkForUpdate() reloads onto the fresh bundle
// (SW update→activate→reload, or a plain reload when no SW controls the page).
export function UpdateAvailableBanner() {
  const show = useSelfUpdate();
  if (!show) return null;

  return (
    <button
      type="button"
      onClick={() => void checkForUpdate()}
      className="flex w-full shrink-0 items-center gap-2 border-b border-status-working/40 bg-status-working/15 px-4 py-1.5 text-left text-xs font-medium text-foreground [padding-top:calc(env(safe-area-inset-top)_+_0.375rem)]"
    >
      <ArrowUpCircle className="size-3.5 shrink-0 text-status-working" />
      <span className="min-w-0 flex-1 truncate">New version — tap to update</span>
    </button>
  );
}
