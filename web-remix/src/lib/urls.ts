// Every API URL this shell builds itself, from the bridge's own route map (`shared/routes.ts`, the
// map `bridge/http/router.ts` dispatches on). A path or a param renamed there stops `typecheck`
// here, instead of turning into a 404 on a phone.
//
// NOT HERE: the calls that go through web/'s `@web/lib/api` (pane read, chat, keys, reply, tabs,
// launch ...). That module is read-only for this project and spells its own paths.
//
// SAME BYTES AS BEFORE. A builder returns the root-relative path with no mount: `lib/api.ts` puts the
// mount on (`mounted`), as it always did. `route.href()` writes a `.` inside a param as `%2E`, because
// the bridge's matcher reads a raw path (`bridge/http/middleware/raw-path.ts`) and so takes either
// spelling. This shell has always sent `encodeURIComponent(id)`, which leaves the dot bare (`w1.p1`).
// `%2E` is put back to `.`, so a request on the wire, and any cache or log keyed on its path, is
// unchanged. A literal `%` in an id is `%25` in both, so `%2E` can only be a dot we encoded.
//
// A query string is not built here. `URLSearchParams` writes a space as `+`, the old strings wrote
// `%20`, so each caller appends its own `?...` with `encodeURIComponent`, as before.
import { routes } from "@shared/routes";

/** The route's href with dots left bare, as `encodeURIComponent` leaves them. */
function bare(href: string): string {
  return href.replaceAll("%2E", ".");
}

// ── Reads every screen makes ──
export const snapshotUrl = (): string => routes.snapshot.href();
export const configUrl = (): string => routes.config.config.href();

// ── Pairing ──
export const pairUrl = (): string => routes.pairing.pair.href();
export const devicesUrl = (): string => routes.pairing.devices.href();
export const devicesRevokeUrl = (): string => routes.pairing.revoke.href();

// ── Changes and Files, for a pane and for a space ──
export const paneChangesUrl = (paneId: string): string => bare(routes.pane.changes.href({ paneId }));
export const paneFilesUrl = (paneId: string): string => bare(routes.pane.files.href({ paneId }));
export const workspaceChangesUrl = (workspaceId: string): string => bare(routes.workspace.changes.href({ workspaceId }));
export const workspaceFilesUrl = (workspaceId: string): string => bare(routes.workspace.files.href({ workspaceId }));

// ── The pane's transcript ──
export const paneHistoryUrl = (paneId: string): string => bare(routes.pane.history.href({ paneId }));

// ── The crew and its machines ──
export const crewUrl = (): string => routes.crew.status.href();
export const machinesUrl = (): string => routes.crew.machines.href();
export const machineHistoryUrl = (machineId: string): string => bare(routes.crew.machineHistory.href({ machineId }));
export const machineAlertsUrl = (machineId: string): string => bare(routes.crew.machineAlerts.href({ machineId }));

// ── Launch ──
export const launchersUrl = (): string => routes.launch.launchers.href();

// ── Notifications ──
export const notificationPrefsUrl = (): string => routes.notifications.prefs.href();
export const cacheWatchUrl = (): string => routes.notifications.cacheWatch.href();
export const cacheWatchListUrl = (): string => routes.notifications.cacheWatchList.href();
export const cacheWatchForgetUrl = (): string => routes.notifications.cacheWatchForget.href();
export const snoozeUrl = (): string => routes.notifications.snooze.href();
export const subscribeUrl = (): string => routes.notifications.subscribe.href();

// ── Updates ──
export const updateCheckUrl = (): string => routes.update.status.href();
export const updateCheckRunUrl = (): string => routes.update.check.href();
