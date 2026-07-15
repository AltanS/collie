import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The bridge (Bun server) serves the built app from `web/dist` and proxies nothing — the
// browser talks to the same origin for both static files and /api. In `vite dev`, proxy the
// bridge so the SPA can hit the real socket-backed API while you iterate on the UI.
const BRIDGE = process.env.COLLIE_DEV_TARGET ?? "http://127.0.0.1:8787";

// Dev-only: extra Host headers to accept besides localhost. Set COLLIE_DEV_HOSTS to a comma-separated
// list (or "*" for any) when viewing the dev server from another device — e.g. a tailnet MagicDNS
// name like "bluefin". Vite blocks unknown Hosts by default (a DNS-rebinding guard). No effect on the
// production bundle: the bridge, not Vite, serves prod.
const devHosts = (process.env.COLLIE_DEV_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);
// `COLLIE_DEV_HOSTS="*"` maps to Vite's `allowedHosts: true`, which turns OFF the dev server's
// DNS-rebinding protection (any Host header is accepted). Dev-server-only — the bridge, not Vite,
// serves prod — but still worth a loud warning: prefer listing explicit hostnames (e.g.
// COLLIE_DEV_HOSTS="bluefin,localhost") so a malicious page can't rebind to your dev server.
const wildcardDevHost = devHosts.includes("*");
if (wildcardDevHost) {
  console.warn(
    '\n\x1b[33m⚠ COLLIE_DEV_HOSTS="*" accepts ANY Host header on the Vite dev server, disabling its\n' +
      "  DNS-rebinding guard. This is DEV-ONLY (prod is served by the bridge), but prefer explicit\n" +
      '  hostnames instead, e.g. COLLIE_DEV_HOSTS="bluefin,localhost".\x1b[0m\n',
  );
}
const allowedHosts = wildcardDevHost ? true : devHosts.length > 0 ? devHosts : undefined;

// Build stamp. A unique id is baked into the bundle (shown in the UI footer via __BUILD_INFO__) AND
// emitted to dist/build-info.json, which the bridge reads for the `X-Collie-Build` header and
// `/api/config`. Comparing the two tells you instantly whether a browser is running a stale,
// service-worker-cached bundle (caches are per-origin) — see README → Troubleshooting. The id mixes
// version + git sha + build time so it changes on every rebuild, even between commits.
function gitSha(): string {
  const git = (cmd: string) =>
    execSync(cmd, { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  let sha: string;
  try {
    sha = git("git rev-parse --short HEAD") || "nogit";
  } catch {
    return "nogit";
  }
  // Mark a dirty working tree so the footer stamp doesn't silently claim HEAD when the build
  // actually contains uncommitted work — the common case while developing (the bridge serves the
  // rebuilt `dist` straight off disk, so most builds here are pre-commit). Mirrors `git describe
  // --dirty`. The `-dirty` also flows into the build `id`, so a dirty rebuild always reads as a
  // fresh, distinct build to the stale-cache check. Its OWN try/catch: a `git status` failure must
  // keep the good sha (just drop the dirty marker), not discard it back to "nogit".
  let dirty = false;
  try {
    dirty = git("git status --porcelain").length > 0;
  } catch {
    /* keep the sha, just no dirty marker */
  }
  return dirty ? `${sha}-dirty` : sha;
}
const pkgVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const buildSha = gitSha();
const buildTime = new Date().toISOString();
const BUILD_INFO = {
  version: pkgVersion,
  sha: buildSha,
  time: buildTime,
  id: `${pkgVersion}+${buildSha}.${Math.floor(Date.parse(buildTime) / 1000)}`,
};

// Emit dist/build-info.json so the bridge can read the current build id. Kept out of the SW precache
// (not in workbox globPatterns) so the server always reads it fresh from disk after a rebuild.
const buildInfoPlugin: Plugin = {
  name: "collie-build-info",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "build-info.json",
      source: JSON.stringify(BUILD_INFO, null, 2),
    });
  },
};

export default defineConfig({
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  plugins: [
    react(),
    tailwindcss(),
    buildInfoPlugin,
    VitePWA({
      // Build the manifest + service worker. We use `injectManifest` (not the default generateSW)
      // because we hand-write the SW in `src/sw.ts` to add `push` + `notificationclick` handlers a
      // generated SW can't give us — without a `push` listener the browser shows a generic "site
      // updated in the background" instead of the agent's notification. The SW still precaches the
      // app shell + SPA-falls-back navigations (see src/sw.ts); it compiles to dist/sw.js.
      // Registration is done manually in main.tsx via the `virtual:pwa-register` module (a bundled,
      // same-origin script) so we never inject an inline <script>, which the strict CSP blocks.
      injectRegister: false,
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts", // source; compiled to dist/sw.js (the bridge sets Service-Worker-Allowed: /)
      includeAssets: ["favicon.svg", "favicon.ico", "favicon-96x96.png", "apple-touch-icon.png"],
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
          // The 192/512 are safe-zone-padded, so they serve as both the regular ("any") install
          // icon and the Android adaptive ("maskable") icon. (favicon.svg is intentionally NOT a
          // manifest icon: it's a low-res raster-in-svg for the browser tab only — declaring it
          // sizes:"any" would let an installer pick it and render the install icon blurry.)
          { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      injectManifest: {
        // Files baked into the precache manifest (injected at src/sw.ts's `self.__WB_MANIFEST`).
        // The SPA navigation fallback + /api denylist now live in src/sw.ts (a NavigationRoute):
        // injectManifest hands routing to the custom SW rather than generating it here.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
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
    allowedHosts,
    proxy: {
      "/api": { target: BRIDGE, changeOrigin: true },
    },
  },
});
