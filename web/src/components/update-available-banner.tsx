import { ArrowUpCircle } from "lucide-react";

import { checkForUpdate } from "@/lib/pwa";
import { useSelfUpdate } from "@/lib/self-update";

// Slim persistent "New version — tap to update" row, the fallback for when the self-updater is
// confirmed-stale but can't auto-update right now — the user has unsent work (an open composer draft,
// an in-flight upload, an open action sheet) or we already auto-updated once for this build. An
// in-flow row (not an overlay), idiom-matched to OfflineBanner so it stacks above the route in
// RootLayout's flex column rather than covering the sticky header.
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
      className="flex w-full shrink-0 items-center justify-center gap-2 border-b border-status-working/40 bg-status-working/15 px-4 py-1.5 text-xs font-medium text-foreground [padding-top:calc(env(safe-area-inset-top)_+_0.375rem)]"
    >
      <ArrowUpCircle className="size-3.5 text-status-working" />
      <span>New version — tap to update</span>
    </button>
  );
}
