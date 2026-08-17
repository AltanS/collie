import { fetchConfig, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";
import type { BridgeConfig } from "@/lib/types";

// Client-side control of Web Push: the browser subscription plus a per-device preference. We persist
// the user's choice so we don't re-subscribe on next load.
//
// ── WHY THIS DEVICE HAS TO NAME ITS OWN PREDECESSOR ──────────────────────────
// An explicit `unsubscribe()` does make the endpoint 410 on the next send, and the bridge drops it
// then (there is no unsubscribe endpoint to call). But that covers only the endpoints we retire on
// purpose. A service worker re-registration — a home-screen reinstall, a rejected push topic, a
// re-subscribe after the bridge restarts — mints a BRAND-NEW endpoint and abandons the old one
// without unsubscribing it, and the push service happily keeps accepting sends to that orphan
// forever. Nothing server-side can tell it apart from a live device, so twenty of them piled up in
// one single-user install (issue #104). This device is the only party that knows the new endpoint
// and the old one are the same phone, so it says so: `replaces` on the subscribe body, remembered
// here across reloads.

const PREF_KEY = "collie:push-disabled";
/** The endpoint this device last registered with the bridge, so the next one can supersede it. */
const ENDPOINT_KEY = "collie:push-endpoint";

export type PushAvailability =
  | "unsupported" // browser lacks service worker / Push API
  | "insecure" // not a secure context (plain HTTP) — Push can't run
  | "server-off" // the bridge has no VAPID keys configured
  | "denied" // notifications blocked at the OS/browser level
  | "ready"; // available to toggle

export interface PushState {
  availability: PushAvailability;
  /** A live PushManager subscription currently exists on this device. */
  subscribed: boolean;
  /** The user turned push off here (persisted), so we don't auto-resubscribe. */
  userDisabled: boolean;
}

export interface EnableResult {
  ok: boolean;
  reason?: Exclude<PushAvailability, "ready">;
}

export function isPushDisabledByUser(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function setUserDisabled(disabled: boolean): void {
  try {
    if (disabled) localStorage.setItem(PREF_KEY, "1");
    else localStorage.removeItem(PREF_KEY);
  } catch {
    /* private mode / storage blocked — the preference just won't persist */
  }
}

function rememberedEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

function rememberEndpoint(endpoint: string | null): void {
  try {
    if (endpoint === null) localStorage.removeItem(ENDPOINT_KEY);
    else localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    /* private mode / storage blocked — we just can't supersede next time */
  }
}

/** The body `/api/subscribe` receives, built field by field rather than by serialising the
 *  PushSubscription whole: the bridge stores what it is sent, so the shape is a contract. `replaces`
 *  is present only when this device held a DIFFERENT endpoint before — re-registering the same one
 *  supersedes nothing. Pure, and exported, because `enablePush` itself needs a real PushManager. */
export function subscribeBody(
  json: PushSubscriptionJSON,
  previous: string | null,
): { endpoint: string; keys: { p256dh: string; auth: string }; replaces?: string } {
  const endpoint = json.endpoint ?? "";
  const body = {
    endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
  if (previous === null || previous === "" || previous === endpoint) return body;
  return { ...body, replaces: previous };
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Does an existing subscription's applicationServerKey match the server's current VAPID key? A
// subscription is permanently bound to the key it was created with, so when the bridge rotates its
// VAPID keypair every push to the old subscription silently fails — we must detect the mismatch and
// re-subscribe. `existing` is the raw ArrayBuffer from `subscription.options.applicationServerKey`.
export function keysMatch(existing: ArrayBuffer | null | undefined, serverKey: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== serverKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== serverKey[i]) return false;
  return true;
}

// Subscribe this device to push and register it with the bridge; clears the user's "disabled"
// preference on success. Returns whether a live subscription now exists (with a reason if not).
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };

  const reg = await navigator.serviceWorker.register("/sw.js");
  const cfg = await fetchConfig();
  if (!cfg.push || !cfg.vapidPublicKey) return { ok: false, reason: "server-off" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };
  }

  const serverKey = urlB64ToUint8Array(cfg.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  // A stale subscription bound to a rotated (or otherwise different) VAPID key would keep receiving
  // nothing — drop it and re-subscribe fresh against the current key.
  if (sub && !keysMatch(sub.options.applicationServerKey, serverKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey,
    });
  }
  const body = subscribeBody(sub.toJSON(), rememberedEndpoint());
  const res = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", [XHR_HEADER]: XHR_HEADER_VALUE },
    body: JSON.stringify(body),
  });
  // Only a registration the bridge actually took supersedes the one we remembered — otherwise the
  // next attempt must still be able to name the endpoint that is on the server.
  if (res.ok) rememberEndpoint(body.endpoint);
  setUserDisabled(false);
  return { ok: true };
}

// Unsubscribe this device and remember the choice. This is the case the server-side prune DOES
// cover: an explicitly unsubscribed endpoint 410s on the next send and the bridge drops it, so
// there's nothing to call server-side. We forget it here too — the row it leaves behind is already
// doomed, and a later re-subscribe must not claim to supersede an endpoint it has no relation to.
export async function disablePush(): Promise<void> {
  setUserDisabled(true);
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
    rememberEndpoint(null);
  } catch {
    /* best-effort: the persisted preference still prevents re-subscription */
  }
}

// Snapshot the current push state for the settings UI.
export async function getPushState(): Promise<PushState> {
  const userDisabled = isPushDisabledByUser();
  if (!pushSupported()) return { availability: "unsupported", subscribed: false, userDisabled };
  if (!window.isSecureContext) return { availability: "insecure", subscribed: false, userDisabled };

  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    subscribed = Boolean(await reg?.pushManager.getSubscription());
  } catch {
    /* ignore — treat as not subscribed */
  }

  if (Notification.permission === "denied") {
    return { availability: "denied", subscribed, userDisabled };
  }

  let cfg: BridgeConfig;
  try {
    cfg = await fetchConfig();
  } catch {
    cfg = { push: false, vapidPublicKey: "" };
  }
  if (!cfg.push || !cfg.vapidPublicKey) {
    return { availability: "server-off", subscribed, userDisabled };
  }

  return { availability: "ready", subscribed, userDisabled };
}
