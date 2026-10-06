/// <reference types="vite/client" />

// Build stamp baked in at build time (vite.config.ts → BUILD_INFO), as in web/src/vite-env.d.ts.
declare const __BUILD_INFO__: {
  version: string;
  sha: string;
  time: string;
  id: string;
  channel: "release" | "dev";
};
