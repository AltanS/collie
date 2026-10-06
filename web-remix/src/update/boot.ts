// Started once at boot (main.tsx): the service worker, the stale-app watch and the locale's push
// title table. Each is idempotent and each degrades to nothing where the browser lacks the feature.
import { startLocaleSync } from "../lib/i18n-store";
import { registerServiceWorker } from "./pwa";
import { startSelfUpdate } from "./self-update";

export function startUpdates(): void {
  registerServiceWorker();
  startSelfUpdate();
  startLocaleSync();
}
