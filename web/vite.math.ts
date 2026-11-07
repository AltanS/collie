import { build, type InlineConfig, type Plugin, type ResolvedConfig } from "vite";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, relative, resolve } from "node:path";

import { MATH_ENGINE_NAMES, type MathEngineName } from "./src/lib/math/engine-files";

// ── THE MATH ENGINES' OWN BUILD (ADR 0132) ───────────────────────────────────────────────────────
//
// KaTeX and MathJax are NOT modules of the app. Each is a self-contained bundle, built here apart from
// the app's own build, into `<outDir>/math/<engine>/`: the entry `<engine>.js`, its stylesheet
// `<engine>.css`, its fonts, and (MathJax) its lazy font ranges, all without a hash in the name.
// Nothing under `math/` imports a file outside `math/<engine>/`, and the two engines share no file. So
// the one pack the release builds from one build fits every platform's app build, whatever the app's
// own chunks are called on that runner: the pack owes nothing to the app build. The app loads an
// engine by URL (src/lib/math/engine.ts); the contract is one function (src/lib/math/engine-files.ts).
//
// One build per engine, not one build with two entries: two entries would share a chunk (the hast
// parser both use), and a file one engine needs from the other's folder is the coupling this rules out.
//
// `mathEnginesPlugin()` runs it:
//   • after every app build (`vite build`, `bun run build`, `collie build`'s `--outDir dist-staging`),
//     into the same output folder, so `web/dist/math/` is there as before and the release job's
//     "Build the math pack" step tars it unchanged;
//   • in the dev server, on the first request under `/math/`, into `node_modules/.cache/collie-math/`,
//     and serves it from there. A dev server that never shows a formula never builds the engines, and
//     nothing is downloaded: the engines come from this checkout's node_modules.

const WEB = import.meta.dirname;

/** The source module of each engine's bundle. */
const ENTRIES = {
  katex: resolve(WEB, "src/lib/math/katex.ts"),
  mathjax: resolve(WEB, "src/lib/math/mathjax.ts"),
} satisfies Record<MathEngineName, string>;

// KaTeX's stylesheet offers each face as .woff2, then .woff and .ttf. Every browser Collie runs on
// takes the .woff2, so the other two are files no device ever fetches: about 0.8 MB in the pack.
// Dropping them from the `src` lists here, before Vite resolves the URLs, means they are never
// emitted at all. The bridge would also serve them as octet-stream, which the CSS loader refuses.
const KATEX_STYLESHEET = /[\\/]node_modules[\\/]katex[\\/]dist[\\/]katex(?:\.min)?\.css$/;
const katexWoff2OnlyPlugin: Plugin = {
  name: "collie-katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!KATEX_STYLESHEET.test(id)) return null;
    return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, "");
  },
};

function engineConfig(engine: MathEngineName, mathDir: string): InlineConfig {
  return {
    configFile: false,
    root: WEB,
    // Every URL inside the bundle is relative to the file that names it, so it works under any mount
    // (ADR 0052) and from the host's store as well as from `web/dist`.
    base: "./",
    mode: "production",
    logLevel: "warn",
    publicDir: false,
    resolve: { alias: { "@": resolve(WEB, "src") } },
    plugins: [katexWoff2OnlyPlugin],
    build: {
      outDir: join(mathDir, engine),
      emptyOutDir: true,
      // Fonts stay same-origin files: the CSP does not allow data fonts.
      assetsInlineLimit: 0,
      // No preload helper: the engine's only lazy imports are MathJax's font ranges, plain chunks.
      modulePreload: false,
      reportCompressedSize: false,
      // MathJax's entry carries its base font; it is fetched only by a device that chose MathJax.
      chunkSizeWarningLimit: 2000,
      rolldownOptions: {
        input: { [engine]: ENTRIES[engine] },
        // An app build drops an entry's exports; this entry IS its exports (`typeset`).
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          // No content hash: the pack is keyed by the release version (`<stateDir>/math/<version>/`),
          // and the loader names the entry by a fixed path (engine-files.ts).
          entryFileNames: "[name].js",
          chunkFileNames: "[name].js",
          assetFileNames: "[name][extname]",
        },
      },
    },
  };
}

/** Build both engines into `mathDir` (a `math/` folder), replacing what was there. */
export async function buildMathEngines(mathDir: string): Promise<void> {
  rmSync(mathDir, { recursive: true, force: true });
  for (const engine of MATH_ENGINE_NAMES) await build(engineConfig(engine, mathDir));
}

const CONTENT_TYPES = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

/** Builds the engines beside every app build, and serves them in the dev server (see above). */
export function mathEnginesPlugin(): Plugin {
  let config: ResolvedConfig | null = null;
  let built = false;
  let devBuild: Promise<void> | null = null;
  return {
    name: "collie-math-engines",
    configResolved(resolved) {
      config = resolved;
    },
    writeBundle: {
      sequential: true,
      async handler(options) {
        if (config?.command !== "build" || built) return;
        built = true;
        const outDir = options.dir ?? resolve(config.root, config.build.outDir);
        await buildMathEngines(join(outDir, "math"));
      },
    },
    configureServer(server) {
      const mathDir = resolve(WEB, "node_modules/.cache/collie-math/math");
      /** Answer one request under `/math/`, building the engines first if this server has not. */
      const serve = async (path: string, res: ServerResponse): Promise<void> => {
        devBuild ??= buildMathEngines(mathDir);
        try {
          await devBuild;
        } catch (error) {
          // The next request tries again, after an edit that fixed the build.
          devBuild = null;
          throw error;
        }
        const file = resolve(mathDir, `.${path.slice("/math".length)}`);
        if (relative(mathDir, file).startsWith("..") || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("content-type", CONTENT_TYPES.get(extname(file)) ?? "application/octet-stream");
        res.setHeader("cache-control", "no-cache");
        res.end(readFileSync(file));
      };
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split(/[?#]/, 1)[0] ?? "";
        if (!path.startsWith("/math/")) {
          next();
          return;
        }
        void (async () => {
          try {
            await serve(path, res);
          } catch (error) {
            res.statusCode = 500;
            res.end(`the math engines did not build: ${String(error)}`);
          }
        })();
      });
    },
  };
}
