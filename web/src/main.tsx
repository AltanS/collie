import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initDesign } from "./lib/design";
import { initOperatorFonts } from "./lib/operator-config";
import "./index.css";
// Registers the service worker (precaches the app shell, enables install) and wires auto/manual
// updates. Guards on `serviceWorker in navigator`, so over plain HTTP (insecure context) it no-ops.
import "./lib/pwa";
// Side-effect import: the install-offer listener must be attached before the browser fires
// `beforeinstallprompt`, which is long before any Settings component mounts (lib/install.ts).
import "./lib/install";

// RECONCILES the typeface class, it does not apply it: public/theme-init.js has already put the
// right one on <html> before first paint for every shipped face. This call is what covers the two
// cases that script deliberately cannot — an operator-supplied face (no pre-paint path; it has no
// family name until /api/config answers) and Safari private mode, where the pre-paint read threw.
// Before createRoot, so the class is settled by the time anything measures a line box.
initDesign();
// After it, and separately: this one injects the operator face design.ts mirrored into storage, so a
// device set to one paints in it from the first frame instead of swapping when /api/config lands.
initOperatorFonts();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
