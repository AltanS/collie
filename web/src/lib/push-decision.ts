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
