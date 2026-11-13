// DEV-ONLY entry of the design reference. Paired with `web/design.html` (and the old address
// `web/playground.html`, which forwards there), not a build input — see that file's header and
// `playground-entry.test.ts`. No `lib/pwa` import here on purpose: the page must
// never register a service worker, or it would start precaching a page that does not ship.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PlaygroundApp } from "./app";
import "@/index.css";
import "./playground.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <PlaygroundApp />
  </StrictMode>,
);
