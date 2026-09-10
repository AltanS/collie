import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  channelFor,
  includeAssetsFor,
  manifestFor,
  transformIndexIcons,
  type Channel,
  type ChannelEvidence,
} from "./vite-icons";

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

// `bun run playground` (COLLIE_PLAYGROUND=1) reuses this same Vite dev server on its own port
// (5199), but it must never resolve a real Collie instance: no root app, no bridge. This plugin
// only exists under that flag — normal `bun run dev` keeps the proxy above untouched — and it does
// two things: bounce `/` and `/index.html` to `/playground.html`, and answer every `/api/*` request
// itself (404, before the proxy above ever sees it) so nothing reaches a bridge.
const playgroundOnlyPlugin: Plugin | null =
  process.env.COLLIE_PLAYGROUND === "1"
    ? {
        name: "collie-playground-only",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url === "/" || req.url === "/index.html") {
              res.writeHead(302, { Location: "/playground.html" });
              res.end();
              return;
            }
            if (req.url?.startsWith("/api/")) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "playground has no bridge" }));
              return;
            }
            next();
          });
        },
      }
    : null;

// Build stamp. A unique id is baked into the bundle (shown in the UI footer via __BUILD_INFO__) AND
// emitted to dist/build-info.json, which the bridge reads for the `X-Collie-Build` header and
// `/api/config`. Comparing the two tells you instantly whether a browser is running a stale,
// service-worker-cached bundle (caches are per-origin) — see docs/troubleshooting.md. The id mixes
// version + git sha + build time so it changes on every rebuild, even between commits.
// Shared by gitSha() and isReleaseBuild() below.
const git = (cmd: string) =>
  execSync(cmd, { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();

function gitSha(): string {
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
// Clean-tree builds off a non-release commit (a preview branch, mid-development main) would
// otherwise stamp a version string identical to the real `vX.Y.Z` release, since `-dirty` only
// fires on an uncommitted tree. `-dev` covers that gap, but "does the version's tag exist and
// point at HEAD" alone is not enough: a checkout can legitimately hold no tags at all and still be
// a release. There are three shapes, and `channelFor` (vite-icons.ts) is the pure decision over
// them:
//
//   1. no git at all (a tarball or packaged build) -> release
//   2. git works, but the checkout holds NO tags at all -> release. This is the shallow, detached
//      checkout `herdr plugin install` leaves (cli/update.ts's header, around line 67): `git init`
//      + `fetch --depth 1` + `checkout --detach`, so it never fetched a tag either way. `collie
//      update` fetches tags properly later (cli/update.ts, ~700-735), but until then an empty tag
//      list here is normal for a genuine release install, not evidence of a dev tree.
//   3. git works and tags exist -> a real dev checkout, so the version's own tag decides: its
//      commit matching HEAD means release, anything else (including a missing tag for this
//      version) means dev. This is the case a dev lane on an untagged `chore(release):` commit
//      used to get wrong, building as release before its tag existed.
//
// Each git call below has its own try/catch, so one failure (e.g. no `.git`) doesn't discard
// evidence another call already gathered.
function gitEvidence(version: string): ChannelEvidence {
  let head: string | null;
  try {
    head = git("git rev-parse HEAD");
  } catch {
    head = null;
  }
  let tagCommit: string | null;
  try {
    tagCommit = git(`git rev-parse -q --verify "refs/tags/v${version}^{commit}"`);
  } catch {
    tagCommit = null;
  }
  let tagCount: number | null;
  try {
    const tags = git("git tag -l")
      .split("\n")
      .filter((line) => line.length > 0);
    tagCount = tags.length;
  } catch {
    tagCount = null;
  }
  return { head, tagCommit, tagCount };
}
// SAFETY: `web/package.json` is this repo's own manifest, sitting next to this config, and
// `scripts/check-version.sh` gates every build on its `version` agreeing with the other two files —
// so the field is both present and a string, or the build never gets here.
const pkgVersion = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const buildSha = gitSha();
const buildTime = new Date().toISOString();
// channelFor(pkgVersion's evidence) is computed ONCE and drives both the version stamp above and
// the icon/manifest channel below — never call it twice, the two must always agree.
const channel: Channel = channelFor(gitEvidence(pkgVersion));
const releaseBuild = channel === "release";
const stampedVersion = releaseBuild ? pkgVersion : `${pkgVersion}-dev`;
const BUILD_INFO = {
  version: stampedVersion,
  sha: buildSha,
  time: buildTime,
  id: `${stampedVersion}+${buildSha}.${Math.floor(Date.parse(buildTime) / 1000)}`,
  channel,
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

// A release build must ship index.html byte-for-byte unchanged, so this only rewrites the four
// icon <link> hrefs, and only for index.html — never playground.html, which carries its own
// -playground links statically instead (see playground.html itself). vite-icons.ts's
// transformIndexIcons is a no-op on the release channel, so the `if` here is belt-and-braces: it
// also means the hook never even inspects a file that isn't index.html.
const channelIconsPlugin: Plugin = {
  name: "collie-channel-icons",
  transformIndexHtml: {
    order: "pre",
    handler(html, ctx) {
      if (!ctx.filename.endsWith("/index.html")) return html;
      return transformIndexIcons(html, channel);
    },
  },
};

const channelManifest = manifestFor(channel);

export default defineConfig({
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  plugins: [
    react(),
    tailwindcss(),
    buildInfoPlugin,
    channelIconsPlugin,
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
      includeAssets: includeAssetsFor(channel),
      manifest: {
        name: channelManifest.name,
        short_name: channelManifest.short_name,
        description: "Monitor and reply to your terminal AI agents from your phone",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        // Not locked to portrait: the manifest was the only thing stopping an installed Collie from
        // rotating on a tablet. Every route lays out as a centred column rather than a fluid sheet —
        // 640px on the dashboard, space, Settings, Crew and Updates, 768px on the pane and history
        // screens above that breakpoint — so a wide viewport gets a real layout and not a stretched
        // phone. `"any"` defers to the device instead of overriding it, so a tablet held in
        // landscape with rotation lock on still stays portrait.
        orientation: "any",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: [
          // The 192/512 are safe-zone-padded, so they serve as both the regular ("any") install
          // icon and the Android adaptive ("maskable") icon, and they paint their own paper —
          // an app icon that lets the home screen through is a bug. (favicon.svg is intentionally
          // NOT a manifest icon: it is a different drawing — the head alone, on no background,
          // legible at 16px — so declaring it sizes:"any" would let an installer pick the wrong
          // artwork for the install icon.)
          //
          // THE TILES ARE THE DARK POLARITY BECAUSE THE MANIFEST IS DARK. Android paints the
          // install splash as this icon centred on `background_color`, and a manifest colour is a
          // single value — it cannot follow the OS the way index.html's paired `theme-color` metas
          // and index.css's `light-dark()` do. `background_color` and `theme_color` were already
          // both #0a0a0a, so the light tile that shipped first put a near-white square on black:
          // the one combination that is wrong under EVERY theme. Making the tile dark makes all
          // three manifest values agree, and it is the choice that costs least — flipping
          // `background_color` to the light paper instead would leave `theme_color` dark, i.e. a
          // light splash under dark system bars, and it would still be one fixed polarity.
          // The tile's own paper is #0f1113 against a #0a0a0a splash: a hair lighter, invisible in
          // practice, and `background_color` is left alone so the installed chrome keeps one value.
          // If these are ever re-copied, take the `collie-tile-dark-*` files, not the light ones.
          //
          // A dev build (channel !== "release") swaps this pair for the `-dev` tiles instead
          // (vite-icons.ts's manifestFor) — same dark polarity, same safe-zone padding, orange
          // paint, so a dev install is unmistakable next to a release install on the same home
          // screen without breaking either fact above.
          ...channelManifest.icons,
        ],
      },
      injectManifest: {
        // Files baked into the precache manifest (injected at src/sw.ts's `self.__WB_MANIFEST`).
        // The SPA navigation fallback + /api denylist now live in src/sw.ts (a NavigationRoute):
        // injectManifest hands routing to the custom SW rather than generating it here.
        // The bundled Nerd Font faces are deliberately excluded: they total ~1.1 MB and
        // `unicode-range` already makes them lazy (index.css), so precaching them would charge
        // every install for glyphs most herds never paint. src/sw.ts caches them on first use.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
      // Over plain HTTP (insecure context) the SW can't register; in dev we don't want it anyway.
      devOptions: { enabled: false },
    }),
    playgroundOnlyPlugin,
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
