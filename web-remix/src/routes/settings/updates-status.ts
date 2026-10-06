// The status line of the System page's one Updates row (web/src/components/updates-settings-card.tsx,
// M16/01), pure so its precedence is pinned by a test. The first two cases are the row's own, a run in
// flight and then a peer left behind; past those the order is web's `updateNotice` (a package swap
// under a live process, a stale process, a release, a major), so the row and the page never disagree
// about which matters most. The words are shorter than the banner's: the row already carries the
// title "Updates".
import { t, tn } from "@web/lib/i18n";
import type { UpdateInfo } from "@web/lib/types";

export type UpdateKind = "restart-needed" | "restart" | "release" | "major";

/** What the snapshot's update block says is waiting, in `updateNotice`'s order; null when current. */
export function pendingUpdate(update: UpdateInfo | undefined): UpdateKind | null {
  if (!update) return null;
  if (update.restartNeeded === true && update.restartCommand !== undefined) return "restart-needed";
  if (update.bridgeStale) return "restart";
  if (update.releaseAvailable && update.latest) return "release";
  if (update.majorAvailable) return "major";
  return null;
}

export function isRunning(update: UpdateInfo | undefined): boolean {
  const state = update?.run?.state;
  return state === "preflight" || state === "staging" || state === "restarting" || state === "verifying";
}

export function updatesStatusLine(update: UpdateInfo | undefined, behind: number): string {
  if (isRunning(update)) return t("updates.entry.status.updating");
  if (behind > 0) return tn("updates.entry.status.peersBehind", behind);
  const kind = pendingUpdate(update);
  if (kind === null) return t("updates.entry.status.upToDate");
  // A stale process names a different remedy and must not be flattened into "a version is available".
  if (kind === "restart-needed") return t("settings.updateBanner.restartNeeded");
  if (kind === "restart") return t("settings.updateBanner.restart");
  const version = update?.latest ?? update?.majorAvailable ?? "";
  return t("updates.entry.status.available", { version });
}
