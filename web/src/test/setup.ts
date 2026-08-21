import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";

import { handlers, resetTypedDraft } from "./handlers";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { __resetDraftPrune } from "@/lib/drafts";

// One MSW server for all tests; tests add per-case overrides with `server.use(...)`.
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
// The connection-health store is module-scoped and initialises its anchor to module-load time. Pin it
// to "now" before every test so a component rendered minutes after the file loaded never reads a stale
// anchor as an escalated outage. Fake-timer escalation suites re-pin AFTER vi.useFakeTimers() so the
// anchor equals the frozen clock exactly.
beforeEach(() => __resetConnectionHealth());
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
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetTypedDraft(); // the fake pane's input line, so a draft can't leak into the next test
});
afterAll(() => server.close());

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
