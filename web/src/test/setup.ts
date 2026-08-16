import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";

import { handlers, resetTypedDraft } from "./handlers";

// One MSW server for all tests; tests add per-case overrides with `server.use(...)`.
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
// Persisted state (composer drafts, prefs) must not leak between cases — a draft saved by one test
// would be restored into the next test's freshly-mounted composer.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
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
