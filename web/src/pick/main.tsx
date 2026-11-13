// DEV-ONLY entry. Paired with `web/pick.html`, which is not a build input (see that file and
// `pick-page.test.tsx`). No `lib/pwa` import on purpose: this page must never register a service worker.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/index.css";
import "../playground/playground.css";
import { PickApp } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <PickApp />
  </StrictMode>,
);
