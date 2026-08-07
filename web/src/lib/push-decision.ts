// Pure decision logic for the service worker's `push` handler, split out of sw.ts so it's
// unit-testable without service-worker globals (sw.ts itself can't run under Vitest-on-Node — it
// touches `self`, workbox, and `__WB_MANIFEST`). The SW keeps only the glue: parse the event, read
// client visibility, then perform the side effect this returns. Everything *decided* — suppress vs
// show vs clear, tag derivation, title/renotify defaults, and the URL a tap opens — is plain data
// in, plain data out.

import { scopeSearch } from "./scope";

// Payload shape is whatever bridge/push.ts sends: a render → { title, body, tag, renotify,
// data: { paneId } }; a retraction → { type: "clear", tag }.
export interface PushPayload {
  type?: "clear";
  title?: string;
  body?: string;
  /** Notification slot. The bridge sends one shared "collie:herd" tag so the herd coalesces. */
  tag?: string;
  /** Re-alert when replacing the slot (a new agent arrived) vs. update it silently (a retraction). */
  renotify?: boolean;
  /**
   * `session` is the registry name the pane lives in — carried so the click deep-links into it.
   * `host` is the pack member the pane lives ON, stamped by the bridge for a peer's pane only
   * (`bridge/push.ts` adds it to `data` exactly the way it adds `session`, so a solo/lead payload is
   * byte-identical to the pre-pack one). `target` names a non-pane destination for the tap (e.g.
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
  /** Pack member the pane lives on (undefined = the lead) — the deep-link scopes to it. */
  host?: string;
  /** Non-pane tap destination (e.g. "settings"); absent = the default agent deep-link. */
  target?: string;
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
      /** Pack member the pane lives on (undefined = the lead) — for the click deep-link. */
      host?: string;
      /** Non-pane tap destination (e.g. "settings"); undefined = the default agent deep-link. */
      target?: string;
      renotify: boolean;
    };

/**
 * Separates a notification slot's base from the host that owns it — the frontend half of
 * `bridge/pack/tags.ts`'s `HOST_TAG_SEP`, which the bridge documents at length and this side must
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
 * pack, or every alert outstanding on the phone at `collie join` time orphans into a slot nothing
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
 * Decide what the SW should do with a push. `hasVisibleClient` = a Collie tab is open and visible
 * (the in-app status already surfaces the alert, so the redundant system notification is suppressed
 * — but a clear still runs, since a retraction must close regardless).
 */
export function decidePush(payload: PushPayload, hasVisibleClient: boolean): PushDecision {
  const paneId = payload.data?.paneId;
  const session = payload.data?.session;
  const host = payload.data?.host;
  const target = payload.data?.target;
  // ONE derivation, both directions. A retraction that computed a different tag than its render did
  // would leave a dead notification on the lock screen forever, with nothing left that will ever
  // close it — so `clear` and `show` resolve the slot on this single line, before they diverge.
  const tag = payload.tag ?? tagFor(paneId, host);
  if (payload.type === "clear") return { kind: "clear", tag };
  if (hasVisibleClient) return { kind: "suppress" };
  return {
    kind: "show",
    title: payload.title ?? "Collie",
    body: payload.body ?? "",
    tag,
    paneId,
    session,
    host,
    target,
    renotify: payload.renotify ?? false,
  };
}

/**
 * The URL a notification tap opens — `/settings` for an update alert, otherwise the agent's pane
 * scoped to the machine and session it actually lives on.
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
  if (data.target === "settings") return "/settings";
  const base = data.paneId && data.paneId !== "test" ? `/pane/${encodeURIComponent(data.paneId)}` : "/";
  return `${base}${scopeSearch({ host: data.host, session: data.session })}`;
}
