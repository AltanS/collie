import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";

// Windows/Node ≥22 gap: the experimental global localStorage is absent unless the process was
// started with --localstorage-file, and jsdom's per-window storage isn't what vitest exposes as
// the environment global here. Provide a spec-shaped fallback so storage-backed tests run on
// every platform; where a real Storage already exists it is left untouched.
//
// The fallback is a CLASS whose methods live on its prototype, installed as `Storage` when the
// environment has none: tests that intercept persistence via vi.spyOn(Storage.prototype, …)
// (e.g. the Safari-private-mode quota test) must see the spy, so instance calls have to reach
// the prototype rather than shadow it with own properties.
class ShimStorage {
  #map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.#map.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  clear(): void {
    this.#map.clear();
  }
  key(index: number): string | null {
    return Array.from(this.#map.keys())[index] ?? null;
  }
  get length(): number {
    return this.#map.size;
  }
}
if (typeof globalThis.localStorage === "undefined") {
  // Replace any existing Storage too: the environment may expose jsdom's Storage constructor
  // without a working instance (exactly this gap), and a prototype spy against the REAL Storage
  // would never see our fallback instance. The env's own constructor cannot produce a usable
  // object here, so swapping it in the TEST environment loses nothing.
  try {
    (globalThis as any).Storage = ShimStorage;
  } catch {
    // non-configurable — proceed with the instance anyway; only prototype-spy tests would notice
  }
  globalThis.localStorage = new ShimStorage();
}

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
