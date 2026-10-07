// Client-side Web Push: the browser subscription plus the per-device "I turned it off" choice. Port of
// web/src/lib/push.ts, which cannot be imported (it reaches web/'s React-side api module). Same
// storage keys, same bridge calls, same rules, so a phone that pushed under one shell pushes under
// the other:
//
//   collie:push-disabled     "1" while the operator turned push off on this device
//   collie:push-endpoint     the endpoint last registered, so the next one can supersede it
//
// An explicit unsubscribe makes the endpoint 410 on the next send and the bridge drops it; but a
// re-registration mints a brand-new endpoint and abandons the old one, and nothing server-side can
// tell the orphan from a live device. This device is the only party that knows, so it says so:
// `replaces` on the subscribe body (issue #104).
import { basePath, mounted } from "@web/lib/base-path";
import { t } from "@web/lib/i18n";
import { asJsonString, type JsonObject } from "@web/lib/json";

import { bridgeSend, fetchConfig } from "../../lib/api";
import { createStore } from "../../lib/store";
import { subscribeUrl } from "../../lib/urls";

const PREF_KEY = "collie:push-disabled";
const ENDPOINT_KEY = "collie:push-endpoint";
const PUSH_OPERATION_TIMEOUT_MS = 30_000;

let volatileEndpoint: string | null | undefined;

export type PushAvailability =
  | "unsupported" // browser lacks service worker / Push API
  | "insecure" // not a secure context (plain HTTP): Push cannot run
  | "server-off" // the bridge has no VAPID keys configured
  | "unavailable" // configuration could not be checked; allow a retry
  | "denied" // notifications blocked at the OS or browser level
  | "ready"; // available to toggle

export interface PushState {
  availability: PushAvailability;
  /** This device has a subscription it successfully registered with the bridge. */
  subscribed: boolean;
  /** The operator turned push off here (persisted), so nothing re-subscribes. */
  userDisabled: boolean;
}

export interface EnableResult {
  ok: boolean;
  reason?: Exclude<PushAvailability, "ready">;
}

/** The last answer of `getPushState`, null until the first one lands. Alerts reads it to gate rows. */
export const pushState = createStore<PushState | null>(
  null,
  (a, b) => a?.availability === b?.availability && a?.subscribed === b?.subscribed && a?.userDisabled === b?.userDisabled,
);

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
    // private mode: the preference just will not persist
  }
}

function rememberedEndpoint(): string | null {
  if (volatileEndpoint !== undefined) return volatileEndpoint;
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
    volatileEndpoint = undefined;
  } catch {
    volatileEndpoint = endpoint;
  }
}

// PushManager operations cannot be aborted. Stop awaiting a stalled one so Settings can recover.
async function pushOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("settings.push.reason.timeout"))), PUSH_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The body `/api/subscribe` receives, built field by field: the bridge stores what it is sent, so the
 * shape is a contract. `replaces` is present only when this device held a DIFFERENT endpoint before.
 */
export function subscribeBody(json: PushSubscriptionJSON, previous: string | null): JsonObject {
  const endpoint = json.endpoint ?? "";
  const body: JsonObject = { endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } };
  if (previous !== null && previous !== "" && previous !== endpoint) body.replaces = previous;
  return body;
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

/**
 * Does an existing subscription's applicationServerKey match the server's current VAPID key? A
 * subscription is bound to the key it was made with, so a rotated keypair silently fails every push
 * to the old one: the mismatch must be seen and the device re-subscribed.
 */
export function keysMatch(existing: ArrayBuffer | null | undefined, serverKey: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== serverKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== serverKey[i]) return false;
  return true;
}

/** Subscribe this device and register it with the bridge; clears the "disabled" choice on success. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };

  // Under the mount, with the mount as scope (ADR 0052).
  await pushOperation(navigator.serviceWorker.register(mounted("/sw.js"), { scope: basePath() }));
  const reg = await pushOperation(navigator.serviceWorker.ready);
  const cfg = await fetchConfig();
  if (!cfg.push || !cfg.vapidPublicKey) return { ok: false, reason: "server-off" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  if (Notification.permission !== "granted") {
    const perm = await pushOperation(Notification.requestPermission());
    if (perm !== "granted") return { ok: false, reason: "denied" };
  }

  const serverKey = urlB64ToUint8Array(cfg.vapidPublicKey);
  let sub = await pushOperation(reg.pushManager.getSubscription());
  if (sub && !keysMatch(sub.options.applicationServerKey, serverKey)) {
    await pushOperation(sub.unsubscribe());
    sub = null;
  }
  if (!sub) {
    sub = await pushOperation(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey }));
  }
  const body = subscribeBody(sub.toJSON(), rememberedEndpoint());
  await bridgeSend<void>("POST", subscribeUrl(), body);
  // `bridgeSend` throws on any non-2xx, so this runs only after the bridge took the registration.
  rememberEndpoint(asJsonString(body.endpoint) ?? null);
  setUserDisabled(false);
  return { ok: true };
}

/** Unsubscribe this device and remember the choice. There is no server-side call: a 410 prunes it. */
export async function disablePush(): Promise<void> {
  setUserDisabled(true);
  if (!pushSupported()) return;
  try {
    const reg = await pushOperation(navigator.serviceWorker.getRegistration());
    const sub = reg ? await pushOperation(reg.pushManager.getSubscription()) : null;
    if (sub) await pushOperation(sub.unsubscribe());
    rememberEndpoint(null);
  } catch {
    // best-effort: the persisted choice still prevents re-subscription
  }
}

/** The current push state for the Settings UI, also written to `pushState`. */
export async function getPushState(): Promise<PushState> {
  const state = await readPushState();
  pushState.set(state);
  return state;
}

async function readPushState(): Promise<PushState> {
  const userDisabled = isPushDisabledByUser();
  if (!pushSupported()) return { availability: "unsupported", subscribed: false, userDisabled };
  if (!window.isSecureContext) return { availability: "insecure", subscribed: false, userDisabled };

  let subscribed = false;
  try {
    const reg = await pushOperation(navigator.serviceWorker.getRegistration());
    const sub = reg ? await pushOperation(reg.pushManager.getSubscription()) : null;
    subscribed = sub !== null && sub.endpoint === rememberedEndpoint();
  } catch {
    // treat as not subscribed
  }
  if (Notification.permission === "denied") return { availability: "denied", subscribed, userDisabled };

  try {
    const cfg = await fetchConfig();
    if (!cfg.push || !cfg.vapidPublicKey) return { availability: "server-off", subscribed, userDisabled };
  } catch {
    return { availability: "unavailable", subscribed, userDisabled };
  }
  return { availability: "ready", subscribed, userDisabled };
}
