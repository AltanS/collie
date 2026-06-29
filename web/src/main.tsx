import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import "./index.css";

// Register the service worker (precaches the app shell, enables install). registerSW guards on
// `serviceWorker in navigator`, so over plain HTTP (insecure context) this no-ops silently.
registerSW({ immediate: true });

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
