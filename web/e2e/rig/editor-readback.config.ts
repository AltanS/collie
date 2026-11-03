import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Opt-in real native-editor integration tests, against the existing isolated rig.
export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "../../src") } },
  test: { environment: "jsdom", include: ["e2e/rig/editor-*.test.ts"] },
});
