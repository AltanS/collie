// Pure decision logic for the service worker's `push` handler, split out of sw.ts so it's
// unit-testable without service-worker globals (sw.ts itself can't run under Vitest-on-Node — it
// touches `self`, workbox, and `__WB_MANIFEST`). The SW keeps only the glue: parse the event, read
// client visibility, then perform the side effect this returns. Everything *decided* — suppress vs
// show vs clear, tag derivation, title/renotify defaults, and the URL a tap opens — is plain data
// in, plain data out.

import { interpolate } from "./i18n/template";
import { machinePath, machinesPath } from "./machine-paths";
import { isPushTitleCode, type PushTitleDetail } from "./push-title-codes";
import type { PushTitleTemplates } from "./push-title-store";
import { scopeSearch } from "./scope";

// Payload shape is whatever bridge/push.ts sends: a render → { title, body, tag, renotify,
// data: { paneId } }; a retraction → { type: "clear", tag }.
export interface PushPayload {
  /**
   * `clear` retracts a slot. `machine` is a sustained-load alert for a crew member (ADR 0084) and
   * `update` is the update push; both are the bridge's own spellings (bridge/push.ts). Only `machine`
   * changes a decision here: it is never suppressed (see {@link decidePush}).
   */
  type?: "clear" | "update" | "machine";
  title?: string;
  /**
   * The catalogue code `title` was rendered from, and the values it was filled with
   * (bridge/push-titles.ts). Kept loose (`string`, not the code union) because it is read off the
   * wire: a code a newer bridge invented is a value this build must recognise as unknown, not a type
   * error — `localisedTitle` narrows it.
   */
  titleCode?: string;
  titleDetail?: PushTitleDetail;
  body?: string;
  /** Notification slot. The bridge sends one shared "collie:herd" tag so the herd coalesces. */
  tag?: string;
  /** Re-alert when replacing the slot (a new agent arrived) vs. update it silently (a retraction). */
  renotify?: boolean;
  /**
   * `session` is the registry name the pane lives in — carried so the click deep-links into it.
   * `host` is the crew member the pane lives ON, stamped by the bridge for a peer's pane only
   * (`bridge/push.ts` adds it to `data` exactly the way it adds `session`, so a solo/lead payload is
   * byte-identical to the pre-crew one). `target` names a non-pane destination for the tap (e.g.
   * "settings" for an update notification); absent = the default agent deep-link path.
   */
  data?: NotifData;
}

/**
 * What the bridge puts in `Notification.data`, and therefore what a tap has to work from. Declared
 * here rather than in sw.ts so the payload shape and the tap shape cannot drift — they are the same
 * object, written on one side of `showNotification` and read on the other.
 */
export interface NotifData {
  paneId?: string;
  /** Registry name of the pane's session (undefined = primary) — the deep-link scopes to it. */
  session?: string;
  /** Crew member the pane lives on (undefined = the lead) — the deep-link scopes to it. */
  host?: string;
  /** Non-pane tap destination (e.g. "settings"); absent = the default agent deep-link. */
  target?: string;
  /** The crew member a `target: "machine"` alert is about, as `/api/machines` names it. Not `host`. */
  machine?: string;
}

export type PushDecision =
  /** Close any notification on this tag (retraction) — runs regardless of client visibility. */
  | { kind: "clear"; tag: string }
  /** A Collie tab is already visible and showing this; don't raise a redundant system notification. */
  | { kind: "suppress" }
  /** Show (or replace) the notification on this tag. */
  | {
      kind: "show";
      title: string;
      body: string;
      tag: string;
      paneId?: string;
      /** Registry name of the pane's session (undefined = primary) — for the click deep-link. */
      session?: string;
      /** Crew member the pane lives on (undefined = the lead) — for the click deep-link. */
      host?: string;
      /** Non-pane tap destination (e.g. "settings"); undefined = the default agent deep-link. */
      target?: string;
      /** The crew member a machine alert is about; undefined for every other push. */
      machine?: string;
      renotify: boolean;
    };

/**
 * Separates a notification slot's base from the host that owns it — the frontend half of
 * `bridge/crew/tags.ts`'s `HOST_TAG_SEP`, which the bridge documents at length and this side must
 * reproduce exactly (the bridge writes the tag on a render, this file re-derives it on a fallback,
 * and a retraction has to close the slot the render opened).
 *
 * `@` and not `:` for the injectivity argument recorded there: a member id is
 * `[a-z0-9][a-z0-9-]{0,62}` and so contains neither separator, which makes the character right after
 * the base the discriminator — `@` ⇒ a peer's slot, `:` ⇒ a name on this machine.
 */
export const HOST_TAG_SEP = "@";

/**
 * Qualify a notification slot with the host that owns it. `host === undefined` (solo, or the lead's
 * own pane) returns the base UNTOUCHED — the lead's `collie:herd` must not move when it grows a
 * crew, or every alert outstanding on the phone at `collie join` time orphans into a slot nothing
 * will ever clear (`bridge/sessions.ts`'s reasoning, one dimension out).
 */
export const hostSlot = (base: string, host?: string): string =>
  host ? `${base}${HOST_TAG_SEP}${host}` : base;

// Notifications share a slot so a replacement updates rather than stacks. The bridge sets the tag
// explicitly ("collie:herd" / "collie:herd@<host>"); we only fall back to a per-pane tag for
// direct/manual pushes — host-qualified the same way, so two machines' identical pane ids can never
// coalesce into one slot and silently replace each other's alert.
export const tagFor = (paneId?: string, host?: string): string => {
  const base = hostSlot("collie", host);
  return paneId ? `${base}:${paneId}` : base;
};

/**
 * The title in this device's language, or `undefined` when there is none to give: no code on the push
 * (an older bridge, or a title the operator typed), a code this build does not know (a newer bridge),
 * or no template stored for it (the page has not run since the worker was installed, or storage was
 * refused). Every `undefined` falls through to the bridge's own English title.
 */
export function localisedTitle(payload: PushPayload, templates: PushTitleTemplates): string | undefined {
  const code = payload.titleCode;
  if (!isPushTitleCode(code)) return undefined;
  const template = templates[code];
  if (template === undefined) return undefined;
  return interpolate(template, payload.titleDetail);
}

/**
 * Decide what the SW should do with a push. `hasVisibleClient` = a Collie tab is open and visible
 * (the in-app status already surfaces the alert, so the redundant system notification is suppressed
 * — but a clear still runs, since a retraction must close regardless). `templates` is the device's
 * push title table (lib/push-title-store.ts); an empty one shows every title in the bridge's English.
 */
export function decidePush(
  payload: PushPayload,
  hasVisibleClient: boolean,
  templates: PushTitleTemplates = {},
): PushDecision {
  const paneId = payload.data?.paneId;
  const session = payload.data?.session;
  const host = payload.data?.host;
  const target = payload.data?.target;
  const machine = payload.data?.machine;
  // ONE derivation, both directions. A retraction that computed a different tag than its render did
  // would leave a dead notification on the lock screen forever, with nothing left that will ever
  // close it — so `clear` and `show` resolve the slot on this single line, before they diverge.
  const tag = payload.tag ?? tagFor(paneId, host);
  if (payload.type === "clear") return { kind: "clear", tag };
  // A machine alert is the one push a visible tab does not stand in for. The in-app status line speaks
  // for panes: it says an agent needs you, and says nothing about a machine running hot. Suppressing
  // it because a Collie tab happens to be open would swallow the only signal there is (1.17.0 review).
  if (hasVisibleClient && payload.type !== "machine") return { kind: "suppress" };
  return {
    kind: "show",
    title: localisedTitle(payload, templates) ?? payload.title ?? "Collie",
    body: payload.body ?? "",
    tag,
    paneId,
    session,
    host,
    target,
    machine,
    renotify: payload.renotify ?? false,
  };
}

/**
 * The URL a notification tap opens — `/settings/updates` for an update alert, otherwise the agent's
 * pane scoped to the machine and session it actually lives on.
 *
 * The WIRE spelling stays `"settings"` (bridge/push.ts) while the destination moves, and that is
 * deliberate: an old cached service worker holds its own copy of this function, sends the tap to
 * `/settings` and lands the operator on a real page one row away from the one they wanted. Renaming
 * the field would have sent it to `/` instead. Same graceful degradation `host` documents below.
 *
 * **This is the app's own URL builder, not a second one.** The query comes from `lib/scope`'s
 * {@link scopeSearch}, so the string the service worker constructs is by construction the string the
 * router already produced for that scope — which is what keeps sw.ts's `client.url !== url` check
 * from firing a redundant navigate on every tap of an already-open pane. It also lives here, rather
 * than in sw.ts, so it is testable at all: sw.ts cannot be imported under Vitest.
 *
 * A SW predating the host field ignores `data.host` and opens the bare pane path, landing on the
 * lead — a reachable screen, and the same graceful degradation `target` already documents. That is
 * why the LEAD is the no-param default and not "the host you last looked at": degrading onto the
 * wrong machine's pane id is exactly the failure the host dimension exists to prevent.
 */
export function notificationPath(data: NotifData = {}): string {
  if (data.target === "settings") return "/settings/updates";
  // A machine alert (ADR 0084) opens that machine's page. `machine` is the crew member id the bridge
  // stamped, which is the row id `/api/machines` answers with. `host` is NOT read for this target: it
  // names where a pane lives, and a machine alert has no pane. A push without a machine has nowhere
  // better to go than Machines itself. The paths are nav.ts's own (kept in machine-paths.ts for the worker), unscoped: the page is the lead's.
  if (data.target === "machine") return data.machine ? machinePath(data.machine) : machinesPath();
  const base = data.paneId && data.paneId !== "test" ? `/pane/${encodeURIComponent(data.paneId)}` : "/";
  return `${base}${scopeSearch({ host: data.host, session: data.session })}`;
}
