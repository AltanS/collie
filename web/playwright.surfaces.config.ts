import { defineConfig } from "@playwright/test";

// LAB, THROWAWAY (experiments/desktop-surfaces, agent A): only the shots spec, on its own port, so a
// second worktree's preview server on 4173 is never reused by mistake.
const PORT = 4281;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "surfaces-shots.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: "chromium", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  projects: [{ name: "app-tablet" }],
  webServer: [
    {
      command: `bunx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      env: { COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 60_000,
    },
  ],
});
