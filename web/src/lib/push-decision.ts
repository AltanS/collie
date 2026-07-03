// Pure decision logic for the service worker's `push` handler, split out of sw.ts so it's
// unit-testable without service-worker globals (sw.ts itself can't run under Vitest-on-Node — it
// touches `self`, workbox, and `__WB_MANIFEST`). The SW keeps only the glue: parse the event, read
// client visibility, then perform the side effect this returns. Everything *decided* — suppress vs
// show vs clear, tag derivation, title/renotify defaults — is plain data in, plain data out.

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
  data?: { paneId?: string };
  /**
   * 0–3 short reply strings the bridge suggests as one-tap notification buttons. Absent on a
   * needs-you push means "use the default" (see buildNotificationActions). Only actionable when the
   * push also carries a concrete `data.paneId` to send the reply to.
   */
  quickReplies?: string[];
}

export type PushDecision =
  /** Close any notification on this tag (retraction) — runs regardless of client visibility. */
  | { kind: "clear"; tag: string }
  /** A Collie tab is already visible and showing this; don't raise a redundant system notification. */
  | { kind: "suppress" }
  /** Show (or replace) the notification on this tag. */
  | { kind: "show"; title: string; body: string; tag: string; paneId?: string; renotify: boolean };

// Notifications share a slot so a replacement updates rather than stacks. The bridge sets the tag
// explicitly ("collie:herd"); we only fall back to a per-pane tag for direct/manual pushes.
export const tagFor = (paneId?: string): string => (paneId ? `collie:${paneId}` : "collie");

/**
 * Decide what the SW should do with a push. `hasVisibleClient` = a Collie tab is open and visible
 * (the in-app status already surfaces the alert, so the redundant system notification is suppressed
 * — but a clear still runs, since a retraction must close regardless).
 */
export function decidePush(payload: PushPayload, hasVisibleClient: boolean): PushDecision {
  const paneId = payload.data?.paneId;
  const tag = payload.tag ?? tagFor(paneId);
  if (payload.type === "clear") return { kind: "clear", tag };
  if (hasVisibleClient) return { kind: "suppress" };
  return {
    kind: "show",
    title: payload.title ?? "Collie",
    body: payload.body ?? "",
    tag,
    paneId,
    renotify: payload.renotify ?? false,
  };
}

// ── Reply-from-notification action buttons ───────────────────────────────────────────────────────
// A needs-you notification can carry up to two one-tap reply buttons ("yes", "continue", …). The
// button ids stay short and index-based (`reply:0`) — the actual reply text is stashed in
// notification.data.quickReplies and looked up by index at click time (parseReplyAction). Kept pure
// here (data in, data out) so it's testable; the SW only maps the result onto NotificationOptions.

/** Most Android surfaces render at most two notification action buttons — cap to that. */
export const MAX_NOTIFICATION_ACTIONS = 2;

/** The reply buttons shown when a needs-you push doesn't specify its own `quickReplies`. */
export const DEFAULT_QUICK_REPLIES: readonly string[] = ["yes", "continue"];

/** One notification action button. `action` is the id echoed back to the SW in `notificationclick`. */
export interface PushAction {
  action: string;
  title: string;
}

export interface NotificationActions {
  /** Ready for NotificationOptions.actions (already capped at MAX_NOTIFICATION_ACTIONS). */
  actions: PushAction[];
  /** The resolved reply texts, stashed in notification.data for click-time lookup by index. */
  quickReplies: string[];
}

/**
 * Resolve a push's one-tap reply buttons plus the texts to stash in notification.data. Buttons are
 * only offered when there's a concrete reply target: a real `paneId` (not the "test" ping, and not a
 * herd-coalesced push with no single pane). The payload's `quickReplies` win when present; otherwise
 * we fall back to DEFAULT_QUICK_REPLIES. Blanks are trimmed out and the list is capped.
 */
export function buildNotificationActions(
  quickReplies: string[] | undefined,
  paneId: string | undefined,
): NotificationActions {
  if (!paneId || paneId === "test") return { actions: [], quickReplies: [] };
  const source =
    quickReplies && quickReplies.length > 0 ? quickReplies : DEFAULT_QUICK_REPLIES;
  const resolved = source
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_NOTIFICATION_ACTIONS);
  return {
    actions: resolved.map((title, i) => ({ action: `reply:${i}`, title })),
    quickReplies: resolved,
  };
}

/** Parse a `notificationclick` action id back to its reply index; null when it isn't a reply action. */
export function parseReplyAction(action: string): number | null {
  const m = /^reply:(\d+)$/.exec(action);
  return m ? Number.parseInt(m[1]!, 10) : null;
}
