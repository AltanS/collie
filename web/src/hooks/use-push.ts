import { useEffect } from "react";

import { fetchConfig } from "@/lib/api";

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Registers the service worker and subscribes to Web Push — best-effort. Service workers and the
// Push API require a secure context, so over plain HTTP (Headscale .internal) this no-ops
// silently; it lights up automatically once the bridge is served over HTTPS.
export function usePushSetup() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (!window.isSecureContext) return;
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const cfg = await fetchConfig();
        if (cancelled || !cfg.push || !cfg.vapidPublicKey) return;
        if (Notification.permission === "denied") return;
        if (Notification.permission !== "granted") {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") return;
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
      } catch (e) {
        console.warn("[push] setup skipped:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
