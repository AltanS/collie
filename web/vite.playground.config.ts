import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// `bun run playground:build`: the states playground alone, as static files in `dist-playground/`.
// DEV-ONLY, like the page itself. It is a second config on purpose: vite.config.ts stays the app's
// build (its input is index.html alone, pinned by playground-entry.test.ts), and this one never
// touches `dist/`, so a playground build cannot overwrite the live dev lane.
//
// What it leaves out: the service worker, the PWA manifest, the build-info file, and `public/stt`
// (the speech engine, 1 MB the page never loads). What it keeps: one chunk per section (the lazy
// `import()`s in src/playground/app.tsx), minified. Serve it with any static server; `/api/*` then
// answers 404, which the page tolerates (it has no bridge either way).
const WEB = import.meta.dirname;
const OUT = resolve(WEB, "dist-playground");
// SAFETY: web/package.json is this repo's own manifest, and its `version` is a string (scripts/check-version.sh).
const pkgVersion = (JSON.parse(readFileSync(resolve(WEB, "package.json"), "utf8")) as { version: string }).version;

// src/lib/build.ts reads this define. A plain version, no prerelease tag: the header then draws no
// prerelease strip, the same as a release build of the app. The playground never shows a real stamp.
const BUILD_INFO = {
  version: pkgVersion,
  sha: "playground",
  time: new Date().toISOString(),
  id: `${pkgVersion}+playground`,
  channel: "release",
};

/** Drop what the page never loads from the copied `public/` folder, and leave an index.html that
 *  points at the page so the bare address works. */
const trimPublicPlugin: Plugin = {
  name: "collie-playground-trim",
  apply: "build",
  closeBundle() {
    rmSync(resolve(OUT, "stt"), { recursive: true, force: true });
    writeFileSync(
      resolve(OUT, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=playground.html"><a href="playground.html">playground</a>\n',
    );
  },
};

export default defineConfig({
  base: "/",
  experimental: {
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === "html" ? undefined : { relative: true };
    },
  },
  define: { __BUILD_INFO__: JSON.stringify(BUILD_INFO) },
  plugins: [react(), tailwindcss(), trimPublicPlugin],
  resolve: { alias: { "@": resolve(WEB, "src") } },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      input: resolve(WEB, "playground.html"),
    },
  },
});
