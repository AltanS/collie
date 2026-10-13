// The tests run inside workerd, the Workers runtime, through Cloudflare's Vitest plugin. They need Node and
// Vitest; `bun test` cannot load `cloudflare:workers`. Nothing here reaches the network or an account.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // One copy of each Pi package, also for the files shared with ../durable-member (see wrangler.jsonc).
  resolve: { dedupe: ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // A test value, not a secret. At least 32 bytes, as the Worker demands.
          COLLIE_TOKEN: "test-token-not-a-secret-0123456789abcdef",
          // The second token of a rotation, a test value too. Both are taken while it is set.
          COLLIE_TOKEN_NEXT: "test-next-token-not-a-secret-0123456789ab",
          DM_STEP_MS: "0",
          DM_SLOW_MS: "3000",
          DM_HELPER_MS: "0",
          // `npm run test:memory` keeps Pi's conversations in memory instead of the Durable Object's SQLite.
          DM_STORAGE: process.env.DM_STORAGE ?? "sqlite",
        },
      },
    }),
  ],
  test: { testTimeout: 20_000 },
});
