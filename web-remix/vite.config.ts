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

// The Collie mark is GENERATED in the collie-brand repo and lands in web/ as a sealed React file
// (DESIGN.md §8; REMIX3.md, "The mark orbit"). This shell must not hand-port it, so its data (the
// stylesheet, the two bodies, the view boxes and the turn rates) is read out of that file here, at
// build time, and served as `virtual:collie-mark` (off Vite, tsconfig.json points it at src/shell/collie-mark-data.ts). A
// regenerated mark reaches this shell on the next build with no edit; a file whose constants change
// shape fails the build here instead of drawing nothing.
const COLLIE_MARK = resolve(WEB, "src/components/collie-mark.tsx");
const COLLIE_MARK_ID = "virtual:collie-mark";
const JS_STRING = /"(?:[^"\\]|\\.)*"/.source;

function readCollieMark(): string {
  const src = readFileSync(COLLIE_MARK, "utf8");
  const pick = (name: string, pattern: string): string => {
    const found = new RegExp(pattern, "m").exec(src)?.[1];
    if (found === undefined) throw new Error(`collie-mark-data: ${name} not found in ${COLLIE_MARK}`);
    return found;
  };
  // SAFETY: `pick` matched a double-quoted JS string literal with JSON-compatible escapes, and
  // JSON.parse of a JSON string literal is always a string.
  const text = (name: string, pattern: string): string => JSON.parse(pick(name, pattern)) as string;
  const data = {
    STYLE: text("STYLE", `^const STYLE = (${JS_STRING});$`),
    BODY: {
      full: text("BODY.full", `^const BODY = \\{\\s*full: (${JS_STRING}),`),
      header: text("BODY.header", `^\\s+header: (${JS_STRING}),?\\s*\\};`),
    },
    VIEW: {
      full: text("VIEW.full", `^const VIEW = \\{ full: (${JS_STRING}),`),
      header: text("VIEW.header", `^const VIEW = \\{ full: ${JS_STRING}, header: (${JS_STRING}) \\};`),
    },
    TURN: {
      rest: Number(pick("TURN.rest", `^const TURN = \\{ rest: ([\\d.]+), live: [\\d.]+ \\};`)),
      live: Number(pick("TURN.live", `^const TURN = \\{ rest: [\\d.]+, live: ([\\d.]+) \\};`)),
    },
  };
  // Both drawings are read, so a regenerated file whose shape changed still fails here; only the
  // header drawing is served. This shell draws no full mark (shell/collie-mark.tsx paints the header
  // one), and one module is one chunk: the unused 13 KB drawing rode along to every page (S3).
  const served = { ...data, BODY: { header: data.BODY.header }, VIEW: { header: data.VIEW.header } };
  return Object.entries(served)
    .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
    .join("\n");
}

const collieMarkPlugin: Plugin = {
  name: "collie-mark-data",
  resolveId(id) {
    return id === COLLIE_MARK_ID ? `\0${COLLIE_MARK_ID}` : undefined;
  },
  load(id) {
    if (id !== `\0${COLLIE_MARK_ID}`) return undefined;
    this.addWatchFile(COLLIE_MARK);
    return readCollieMark();
  },
};

const channelManifest = manifestFor(channel);

// THE START CHUNKS (S3). Left alone, the bundler cut the islands' start code into some 80 chunks of a
// few hundred bytes each; every one is a request with its own headers (about 300 bytes) and its own gzip
// window, which together were more than the code. This plugin reads the module graph once it is
// complete, and `codeSplitting` (below) makes one chunk of each set:
//   - `boot`: what the entry imports statically (every page loads it);
//   - `shared`: what the start islands (every islands page hydrates them) import statically that the
//     full client (spa-boot.tsx, for the static shell and the S1/S2 documents) imports too;
//   - `islands`: what the start islands import and the full client does not, so the static shell and
//     the S1/S2 documents load no island code;
//   - `pane` and `pane-islands`: the same split for what the pane's two islands (screen, composer) add;
//   - `spa`: the rest of the full client's static closure that no island ever loads, even later.
// Every `import()` behind a tap (a sheet, the switcher, a write, the text parse) stays its own chunk.
const START_ISLANDS = /[\\/]src[\\/]islands[\\/](live|gestures|sheets|header-actions|home-tail)\.tsx$/;
const PANE_ISLANDS = /[\\/]src[\\/]islands[\\/](screen|composer)\.tsx$/;
const SPA_BOOT = /[\\/]src[\\/]spa-boot\.tsx$/;
const MAIN = /[\\/]src[\\/]main\.tsx$/;
const startSets = {
  boot: new Set<string>(),
  shared: new Set<string>(),
  islands: new Set<string>(),
  pane: new Set<string>(),
  paneIslands: new Set<string>(),
  spa: new Set<string>(),
};

const startChunksPlugin: Plugin = {
  name: "collie-start-chunks",
  apply: "build",
  buildEnd() {
    for (const set of Object.values(startSets)) set.clear();
    const closure = (test: (id: string) => boolean, dynamic = false): Set<string> => {
      const seen = new Set<string>();
      const stack = [...this.getModuleIds()].filter(test);
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        const info = this.getModuleInfo(id);
        for (const next of info?.importedIds ?? []) stack.push(next);
        if (dynamic) for (const next of info?.dynamicallyImportedIds ?? []) stack.push(next);
      }
      return seen;
    };
    const roots = new Set([...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isEntry === true));
    const entry = closure((id) => roots.has(id));
    // The entry is index.html, and its script (src/main.tsx) must stay the entry chunk: a group that
    // takes it empties the entry, and the manifest then has no `isEntry` for the bridge to read.
    for (const id of entry) if (!roots.has(id) && !MAIN.test(id)) startSets.boot.add(id);
    const spa = closure((id) => SPA_BOOT.test(id));
    const start = closure((id) => START_ISLANDS.test(id));
    const pane = closure((id) => PANE_ISLANDS.test(id));
    for (const id of start) if (!entry.has(id)) (spa.has(id) ? startSets.shared : startSets.islands).add(id);
    for (const id of pane) if (!entry.has(id) && !start.has(id)) (spa.has(id) ? startSets.pane : startSets.paneIslands).add(id);
    // A module an island may load later (a sheet, the text parse) stays out of `spa`, or that one
    // `import()` on an islands page would fetch the whole full client.
    const islandsLater = closure((id) => START_ISLANDS.test(id) || PANE_ISLANDS.test(id), true);
    for (const id of spa) if (!entry.has(id) && !islandsLater.has(id)) startSets.spa.add(id);
  },
};

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
    // `remix/routes` is imported from here AND from ../shared/routes.ts, which sits under the repo
    // root's node_modules. One copy in the bundle.
    dedupe: ["remix"],
    alias: [
      { find: /^@shared\//, replacement: `${resolve(import.meta.dirname, "../shared")}/` },
      { find: /^@web\//, replacement: `${resolve(WEB, "src")}/` },
      { find: /^@\//, replacement: `${resolve(WEB, "src")}/` },
    ],
  },
  plugins: [
    startChunksPlugin,
    collieMarkPlugin,
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
    // The bridge reads `dist/.vite/manifest.json` to preload each island's chunk in an islands document
    // (S3, bridge/http/controllers/document.ts). Not precached: it is not a page asset.
    manifest: true,
    rolldownOptions: {
      output: {
        // A handful of start chunks, not 80 (`startChunksPlugin` above).
        codeSplitting: {
          groups: Object.entries(startSets).map(([name, set]) => ({
            name: name === "paneIslands" ? "pane-islands" : name,
            test: (id: string) => set.has(id),
            includeDependenciesRecursively: false,
          })),
        },
      },
    },
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
