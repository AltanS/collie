// FIRST, before anything reads storage: finish a half-done wipe and check the pairing's expiry.
import "./lib/wipe-resume";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { onPreloadError } from "./lib/chunk-reload";
import { initDesign } from "./lib/design";
import { initTheme } from "./lib/theme/store";
import { initOperatorFonts } from "./lib/operator-config";
import "./index.css";
// Registers the service worker (precaches the app shell, enables install) and wires auto/manual
// updates. Guards on `serviceWorker in navigator`, so over plain HTTP (insecure context) it no-ops.
import "./lib/pwa";
// Side-effect import: the install-offer listener must be attached before the browser fires
// `beforeinstallprompt`, which is long before any Settings component mounts (lib/install.ts).
import "./lib/install";
import { startPushTitleSync } from "./lib/push-titles";

// RECONCILES the typeface class, it does not apply it: public/theme-init.js has already put the
// right one on <html> before first paint for every shipped face. This call is what covers the two
// cases that script deliberately cannot — an operator-supplied face (no pre-paint path; it has no
// family name until /api/config answers) and Safari private mode, where the pre-paint read threw.
// Before createRoot, so the class is settled by the time anything measures a line box.
initDesign();
// The colour theme, the same way: public/theme-init.js painted it from storage, and this settles what
// that script leaves out (the theme-color metas, a token an imported theme sets in one half only).
// For the default theme it removes nothing and adds nothing.
initTheme();
// After it, and separately: this one injects the operator face design.ts mirrored into storage, so a
// device set to one paints in it from the first frame instead of swapping when /api/config lands.
initOperatorFonts();
// Leaves this device's push titles, in its own language, where the service worker can read them —
// a worker woken by a push cannot see the language setting itself (lib/push-titles.ts, ADR 0074).
startPushTitleSync();

// An old page asking for a chunk the new build dropped (the worker deletes the old precache at once):
// reload once onto the new build rather than leave a blank app. lib/chunk-reload.ts has the guards.
window.addEventListener("vite:preloadError", onPreloadError);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
