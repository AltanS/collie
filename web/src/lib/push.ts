import { fetchConfig } from "@/lib/api";
import type { BridgeConfig } from "@/lib/types";

// Client-side control of Web Push: the browser subscription plus a per-device preference. The bridge
// just stores whatever subscriptions it's told about and prunes dead ones on its own — a browser
// `unsubscribe()` makes the endpoint return 410 on the next send, so the server drops it (there's no
// unsubscribe endpoint to call). We persist the user's choice so we don't re-subscribe on next load.

const PREF_KEY = "collie:push-disabled";

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

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(cfg.vapidPublicKey),
    });
  }
  await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub),
  });
  setUserDisabled(false);
  return { ok: true };
}

// Unsubscribe this device and remember the choice. The bridge drops the now-dead endpoint on its
// next send attempt (410), so there's nothing to call server-side.
export async function disablePush(): Promise<void> {
  setUserDisabled(true);
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
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
