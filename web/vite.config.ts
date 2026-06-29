import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "node:path";

// The bridge (Bun server) serves the built app from `web/dist` and proxies nothing — the
// browser talks to the same origin for both static files and /api. In `vite dev`, proxy the
// bridge so the SPA can hit the real socket-backed API while you iterate on the UI.
const BRIDGE = process.env.COLLIE_DEV_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Generate the service worker + manifest. Registration is done manually in main.tsx via the
      // `virtual:pwa-register` module (a bundled, same-origin script) so we never inject an inline
      // <script>, which the strict CSP (script-src 'self') would block.
      injectRegister: false,
      registerType: "autoUpdate",
      filename: "sw.js", // the bridge special-cases sw.js with Service-Worker-Allowed: /
      includeAssets: ["icon.svg", "favicon.ico", "apple-touch-icon.png"],
      manifest: {
        name: "Collie",
        short_name: "Collie",
        description: "Monitor and reply to your Herdr agent herd from your phone",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
        // SPA fallback so deep links (/pane/:id) resolve offline too.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      // Over plain HTTP (insecure context) the SW can't register; in dev we don't want it anyway.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": resolve(import.meta.dirname, "src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // A couple of small chunks beat one big one on a phone over the tailnet.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BRIDGE, changeOrigin: true },
    },
  },
});
