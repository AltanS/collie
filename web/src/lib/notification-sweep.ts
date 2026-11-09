// ── AN OPEN PAGE CLOSES WHAT NO LONGER NEEDS YOU ─────────────────────────────────────────────────
//
// The bridge sends each phone at most a few clears a day (bridge/push.ts, rule 4): a clear shows
// nothing, and past a small budget of such pushes Chrome shows "This site has been updated in the
// background". A clear over that budget is skipped, so the notification it would have closed stays
// on the phone. Two things close it without a push. The slot's next render replaces it, because it
// carries the same tag. And this sweep: on the first live snapshot after the page becomes visible,
// and again whenever the snapshot changes what needs you, the page reads its own notifications and
// closes the ones the snapshot says nothing waits on any more, with their share of the icon count.
//
// It judges only what the snapshot can answer for, and leaves everything else alone:
//   · a pane's own notification closes when the snapshot holds that pane, on the notification's
//     machine and in its session, and the pane does not need you (lib/triage.ts `needsYou`);
//   · it also closes when the pane is gone from a snapshot that lists every pane of that session on
//     this machine (the addressed session, or every session of a widened view);
//   · a session's summary notification closes when that snapshot holds no pane of the session that
//     needs you;
//   · a notification of another kind (a machine or an update alert) or of a scope the snapshot does
//     not cover (a crew member's absent pane, a session the view does not show) stays.
// A snapshot that is not live (a saved copy, a failed read, a mux that is down) judges nothing.

import { recordSlots, showBadge, type BadgeCaches, type BadgeTarget } from "./app-badge";
import { paneScope } from "./hosts";
import { herdSlotTag, paneSlotTag } from "./pane-notifications";
import type { NotifData } from "./push-decision";
import { normalizeScope, type Scope } from "./scope";
import { needsYou } from "./triage";
import type { AgentView, ServerSummary, SessionSummary } from "./types";

/** What a sweep judges against: the snapshot's panes and the address and breadth they cover. */
export interface SweepView {
  agents: readonly AgentView[];
  scope: Scope;
  viewAll: boolean;
  servers: readonly ServerSummary[];
  sessions: readonly SessionSummary[];
}

/** A shown notification, as much of it as the sweep reads and acts on. */
export type ShownNotification = Pick<Notification, "data" | "close" | "tag">;

/** The slice of a service worker registration the sweep needs, so a test can hand in a fake. */
export interface SweepSource {
  getNotifications(): Promise<readonly ShownNotification[]>;
}

const sameScope = (a: Scope, b: Scope): boolean => a.host === b.host && a.session === b.session;

/** A pane's own address, normalised the way a notification's `data` is. */
function scopeOfPane(view: SweepView, pane: AgentView): Scope {
  return normalizeScope(paneScope(view.scope, pane, view.servers, view.sessions));
}

/**
 * Whether the snapshot lists every pane of `scope`, so a pane missing from it is gone. Only this
 * machine's own sessions: a crew member's panes are merged in by the lead and can be missing because
 * the member is out of reach.
 */
function covers(view: SweepView, scope: Scope): boolean {
  const addressed = normalizeScope(view.scope);
  if (scope.host !== undefined || addressed.host !== undefined) return false;
  return view.viewAll || scope.session === addressed.session;
}

/** Whether nothing in `view` still waits on the person for this notification. */
function handled(view: SweepView, tag: string, data: NotifData): boolean {
  if (data.target !== undefined) return false;
  const scope = normalizeScope({ host: data.host, session: data.session });
  const inScope = view.agents.filter((pane) => sameScope(scopeOfPane(view, pane), scope));
  if (tag === herdSlotTag(scope)) return covers(view, scope) && !inScope.some(needsYou);
  if (data.paneId === undefined || tag !== paneSlotTag(data.paneId, scope)) return false;
  const pane = inScope.find((p) => p.paneId === data.paneId);
  return pane === undefined ? covers(view, scope) : !needsYou(pane);
}

/** The shown notifications the snapshot says nothing waits on any more. Pure. */
export function staleNotifications<T extends ShownNotification>(shown: readonly T[], view: SweepView): T[] {
  // SAFETY: `Notification.data` is `any`, but every notification of this registration is one the
  // service worker built from a `NotifData` (web/src/sw.ts); every field is optional and checked.
  return shown.filter((n) => handled(view, n.tag, (n.data as NotifData | null) ?? {}));
}

/** Where the icon's count lives and is shown, so a test can hand in fakes. */
export interface SweepBadge {
  caches: BadgeCaches | null;
  origin: string;
  mount: string;
  target: BadgeTarget;
}

/**
 * Close every stale notification of `source` and zero its slot in the icon's count, which is what
 * the skipped clear would have done here. Answers how many it closed. Never throws.
 */
export async function sweepNotificationsIn(source: SweepSource, view: SweepView, badge: SweepBadge): Promise<number> {
  let stale: ShownNotification[];
  try {
    stale = staleNotifications(await source.getNotifications(), view);
  } catch {
    return 0; // The list refused: nothing of this page's can be judged.
  }
  for (const n of stale) n.close();
  if (stale.length === 0 || badge.caches === null) return stale.length;
  try {
    const zeros = stale.map((n): [string, number] => [n.tag, 0]);
    await showBadge(badge.target, await recordSlots(badge.caches, badge.origin, badge.mount, zeros));
  } catch {
    // Cache Storage refused: the count stays as the worker last left it.
  }
  return stale.length;
}
