import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import { server } from "./msw";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { __resetPairing } from "@/lib/pairing";
import { __resetDraftPrune } from "@/lib/drafts";
import { __resetPins } from "@/lib/pins";
import { __resetPinHint } from "@/lib/pin-hint";
import { __resetHiddenMachines } from "@/lib/hidden-machines";

// One MSW server for all tests; tests add per-case overrides with `server.use(...)`. It LIVES in
// `./msw.ts`, which touches no document, so the pure-logic project can load it without this file
// (see that file's header). Re-exported here because 300-odd tests already import it from this path
// and the split is not about them.
export { server };

// The connection-health store is module-scoped and initialises its anchor to module-load time. Pin it
// to "now" before every test so a component rendered minutes after the file loaded never reads a stale
// anchor as an escalated outage. Fake-timer escalation suites re-pin AFTER vi.useFakeTimers() so the
// anchor equals the frozen clock exactly.
beforeEach(() => __resetConnectionHealth());
// The pairing refusal latch is module-scoped too: one test's 403 "device not paired" would otherwise
// leave every later test's composer read-only. (The token itself rides localStorage, cleared below.)
beforeEach(() => __resetPairing());
// Persisted state (composer drafts, prefs) must not leak between cases — a draft saved by one test
// would be restored into the next test's freshly-mounted composer.
// `localStorage.clear()` alone stopped being enough when the draft store grew a second, in-memory
// tier (lib/drafts.ts) for drafts too large to persist: that one lives in module scope, which a
// storage clear cannot reach and which outlives every unmount by design.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  __resetDraftPrune();
  // The pins store keeps its list in module scope (lib/pins.ts), which the storage clear above
  // cannot reach: one case's pin would otherwise lead the next case's dashboard.
  __resetPins();
  // And the pin hint's flag beside it (lib/pin-hint.ts): one case's pin or dismissal would otherwise
  // hide the next case's hint.
  __resetPinHint();
  // The hidden-machines store too (lib/hidden-machines.ts): one case's hidden peer would otherwise
  // leave the next case's crew dashboard short a machine.
  __resetHiddenMachines();
});
// `server.resetHandlers()` and the typed-draft reset went with the server to `./msw.ts`, so both
// projects get them. This one keeps the half that needs a document.
afterEach(() => cleanup());

// jsdom gaps that the terminal mirror / sheets touch.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!("matchMedia" in window)) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
