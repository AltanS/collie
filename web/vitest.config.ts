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
// ── A LIST OF DIRECTORIES AND NO EXCEPTION LIST ─────────────────────────────
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
// The boundary is now a short list of directories with no exceptions: `src/lib/harness/**` and
// `src/lib/surface/**` are logic, everything else is DOM. A file that lands in the wrong project fails
// loudly rather than vanishing, because `logic` has no jsdom to borrow. The list is one constant that
// feeds both the `include` of `logic` and the `exclude` of `dom`, so the two cannot drift.
//
// `src/lib/surface/` joined on 2026-10-17. Its `fold.test.ts` (now split) held 1329 tests and ran 142 s of test
// time in one file on a loaded machine (60 s on a quiet one), the floor of the whole suite's wall
// clock, and it imports `node:fs` and the surface libraries only. It ran under jsdom and the full
// setup file only because the glob stopped at `harness`. It is now six `fold.<part>.test.ts` files
// that share `src/test/surface-fold.ts` (not a test file), so the workers can take them in parallel.
const LOGIC_DIRS = ["src/lib/harness", "src/lib/surface"];
const LOGIC = LOGIC_DIRS.map((dir) => `${dir}/**/*.{test,spec}.{ts,tsx}`);

// ── NODE 25+ SHADOWS JSDOM'S localStorage ───────────────────────────────────
// Node 25 turned its own experimental web storage on by default, and node 26.3.0 still has it. The
// global `localStorage` it defines is a getter that returns undefined until `--localstorage-file` is
// given, and it wins over the one jsdom installs on the test window, so every test that touches
// `localStorage` threw "Cannot read properties of undefined" and the pre-push hook failed hundreds
// of web tests. The flag has to reach the worker processes, where jsdom runs: the default `forks`
// pool spawns them with `test.execArgv`, and a flag on the launcher alone never gets there. Node 22
// and 24 accept the flag too (their web storage is off), so one config serves every node we run.
const shared = {
  globals: true,
  css: false,
  setupFiles: ["./src/test/msw.ts"],
  execArgv: ["--no-experimental-webstorage"],
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
        test: { ...shared, name: "logic", environment: "node", include: LOGIC },
      },
      // The browser leg's model stub (M67): node only, and no MSW, because its tests stand up real
      // 127.0.0.1 listeners (the stub and a fake OpenRouter) and MSW would answer their fetches.
      {
        extends: true,
        test: { globals: true, css: false, name: "rig", environment: "node", include: ["e2e/rig/**/*.test.ts"] },
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
          exclude: LOGIC,
        },
      },
    ],
  },
});
