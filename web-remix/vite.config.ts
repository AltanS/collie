import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// web/'s pure build helpers, read-only: the icon set, the manifest per channel and the precache
// ignores. One source, so the two shells cannot ship different icons for one channel.
import {
  channelFor,
  includeAssetsFor,
  manifestFor,
  precacheIgnoresFor,
  transformIndexIcons,
  type Channel,
  type ChannelEvidence,
} from "../web/vite-icons.ts";

// The Remix 3 phone shell. A Vite project of its own beside web/, so web/ keeps building exactly as
// it did. It reuses web/'s React-free modules through `@web/*` and web/public as its public dir.
// The output is web-remix/dist for now; which dist the bridge serves is a later task.

const WEB = resolve(import.meta.dirname, "../web");
const BRIDGE = process.env.COLLIE_DEV_TARGET ?? "http://127.0.0.1:8792";

const git = (cmd: string) =>
  execSync(cmd, { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();

// The build stamp, as web/vite.config.ts computes it: version + sha (+ `-dirty`) + time, baked in
// as __BUILD_INFO__ and emitted as dist/build-info.json for the bridge's X-Collie-Build header.
function gitSha(): string {
  let sha: string;
  try {
    sha = git("git rev-parse --short HEAD") || "nogit";
  } catch {
    return "nogit";
  }
  let dirty = false;
  try {
    dirty = git("git status --porcelain").length > 0;
  } catch {
    /* keep the sha, just no dirty marker */
  }
  return dirty ? `${sha}-dirty` : sha;
}

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
    tagCount = git("git tag -l")
      .split("\n")
      .filter((line) => line.length > 0).length;
  } catch {
    tagCount = null;
  }
  return { head, tagCommit, tagCount };
}

// SAFETY: web/package.json is this repo's own manifest; scripts/check-version.sh gates every build
// on its `version` being present and a string. web-remix follows web/'s version, not its own.
const pkgVersion = (JSON.parse(readFileSync(resolve(WEB, "package.json"), "utf8")) as { version: string }).version;
const buildSha = gitSha();
const buildTime = new Date().toISOString();
const channel: Channel = channelFor(gitEvidence(pkgVersion));
const stampedVersion = channel === "release" ? pkgVersion : `${pkgVersion}-dev`;
const BUILD_INFO = {
  version: stampedVersion,
  sha: buildSha,
  time: buildTime,
  id: `${stampedVersion}+${buildSha}.${Math.floor(Date.parse(buildTime) / 1000)}`,
  channel,
};

const buildInfoPlugin: Plugin = {
  name: "collie-build-info",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "build-info.json", source: JSON.stringify(BUILD_INFO, null, 2) });
  },
};

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

// ADR 0052: the shell is root-absolute and the bridge mounts it. A build whose index.html carries a
// reference that is not root-absolute fails here, as in web/vite.config.ts.
const mountReadyShellPlugin: Plugin = {
  name: "collie-mount-ready-shell",
  apply: "build",
  writeBundle(options) {
    const dir = options.dir ?? resolve(import.meta.dirname, "dist");
    const html = readFileSync(resolve(dir, "index.html"), "utf8");
    const refs = [...html.matchAll(/(?:href|src)="([^"]*)"|url\(["']?([^"')]*)["']?\)/g)].map(
      (m) => m[1] ?? m[2] ?? "",
    );
    const foreign = refs.filter(
      (ref) => ref !== "" && !/^\/(?!\/)/.test(ref) && !ref.startsWith("#") && !/^(?:https?:|data:|mailto:)/.test(ref),
    );
    if (foreign.length > 0) {
      throw new Error(
        `index.html carries ${String(foreign.length)} reference(s) that are not root-absolute: ${foreign.join(", ")}`,
      );
    }
  },
};

const channelManifest = manifestFor(channel);

export default defineConfig({
  base: "/",
  experimental: {
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === "html" ? undefined : { relative: true };
    },
  },
  publicDir: resolve(WEB, "public"),
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  oxc: {
    jsx: { runtime: "automatic", importSource: "remix/component" },
  },
  resolve: {
    alias: [
      { find: /^@web\//, replacement: `${resolve(WEB, "src")}/` },
      { find: /^@\//, replacement: `${resolve(WEB, "src")}/` },
    ],
  },
  plugins: [
    tailwindcss(),
    buildInfoPlugin,
    channelIconsPlugin,
    VitePWA({
      injectRegister: false,
      useCredentials: true,
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: includeAssetsFor(channel),
      manifest: {
        name: channelManifest.name,
        short_name: channelManifest.short_name,
        description: "Monitor and reply to your terminal AI agents from your phone",
        // Relative, no `id`: ADR 0052's invariant, word for word as web/ ships it.
        start_url: "./",
        scope: "./",
        display: "standalone",
        orientation: "any",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: channelManifest.icons.map((icon) => ({
          src: `./${icon.src.replace(/^\/+/, "")}`,
          sizes: icon.sizes,
          type: icon.type,
          purpose: icon.purpose,
        })),
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        globIgnores: precacheIgnoresFor(channel),
      },
      devOptions: { enabled: false },
    }),
    mountReadyShellPlugin,
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5190,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, "..")] },
    proxy: { "/api": { target: BRIDGE, changeOrigin: true } },
  },
  preview: { host: "127.0.0.1", port: 5191, strictPort: true },
});
