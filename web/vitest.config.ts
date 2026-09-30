import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Vitest runs without the PWA/Tailwind plugins (tests don't need a service worker or compiled CSS).
// jsdom + Testing Library + MSW cover components and the /api fetch layer; no headless browser.
//
// ── TWO PROJECTS, BECAUSE MOST OF THE TESTS NEED NEITHER ────────────────────
// This was one flat config, so all 303 files paid for a jsdom document and `src/test/setup.ts` —
// which starts an MSW server, installs jest-dom and resets six module stores. `src/lib/harness/` is
// 46 of those files and carries 9,474 of the 13,600 tests, and it is pure logic: adapters over
// captured terminal text, with no DOM and no fetch anywhere in them.
//
// Measured on 2026-09-30, that folder alone:
//
//     jsdom + setup      25-27s wall      environment phase   109-115s CPU
//     node, no setup      5.8-6.0s wall   environment phase        7ms
//
// So the split is worth roughly a 4x on 70% of the suite, and it deletes nothing.
//
// ── ONE GLOB AND NO EXCEPTION LIST ──────────────────────────────────────────
// The first cut of this split carried two named exceptions, the only files under `src/lib/harness/`
// that could not run under node, and getting their two `exclude` globs wrong dropped both from BOTH
// projects: the run went green with 18 tests missing and nothing said so. An exception list is worth
// avoiding for that reason alone.
//
// It was avoided twice over. The MSW server moved to `src/test/msw.ts`, which touches no document, so
// loading it no longer drags in the jsdom patches. And the two files themselves moved to
// `src/lib/send/`, because what made them impure was never the server: they drive a real
// `sendGuardedReply`, which fetches, and a fetch needs an origin. A test that needs a network origin
// was never an adapter test.
//
// The boundary is now one path with no exceptions: `src/lib/harness/**` is logic, everything else is
// DOM. A file that lands in the wrong project fails loudly rather than vanishing, because `logic` has
// no jsdom to borrow.
const LOGIC = "src/lib/harness/**/*.{test,spec}.{ts,tsx}";

const shared = {
  globals: true,
  css: false,
  setupFiles: ["./src/test/msw.ts"],
} as const;

export default defineConfig({
  // Stub the build stamp (real values are injected by vite.config.ts at build time).
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: "0.0.0-test",
      sha: "test",
      time: "1970-01-01T00:00:00.000Z",
      id: "test",
      channel: "dev",
    }),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { ...shared, name: "logic", environment: "node", include: [LOGIC] },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: "dom",
          environment: "jsdom",
          // `msw.ts` first and then the document half, so `setup.ts` can re-export the server it
          // already stood up rather than standing up a second one.
          setupFiles: [...shared.setupFiles, "./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          exclude: [LOGIC],
        },
      },
    ],
  },
});
