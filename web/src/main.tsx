import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./index.css";
// Registers the service worker (precaches the app shell, enables install) and wires auto/manual
// updates. Guards on `serviceWorker in navigator`, so over plain HTTP (insecure context) it no-ops.
import "./lib/pwa";
import { installProxyAuthRedirectRecovery } from "./lib/proxy-auth-redirect";

// Install before the router mounts: the root loader can be the first request that discovers an
// expired forward-auth session, and that redirect must become a top-level sign-in rather than a
// fetch/CORS failure that looks like a dead bridge.
installProxyAuthRedirectRecovery();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
