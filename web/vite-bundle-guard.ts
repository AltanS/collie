import { stripVTControlCharacters } from "node:util";

import type { Plugin } from "vite";

// A LAZY SCREEN MUST NOT SLIDE BACK INTO THE MAIN CHUNK UNSEEN (ADR 0169). Two checks fail the build.
//
// 1. Rolldown's INEFFECTIVE_DYNAMIC_IMPORT: a module that one file imports with `import()` and another
//    imports statically stays in the chunk of the static import, and the `import()` splits nothing. A new
//    static import of a lazy screen from an eager file does exactly that, with only a warning. Here it is
//    an error, except for the modules below, each with its reason.
// 2. A budget for the main chunk, well under the precache cap (vite-icons.ts PRECACHE_MAX_FILE_BYTES,
//    3 MiB), so growth shows as a failed build long before the service worker would drop the file.
//
// This file imports no package at run time (only `node:util`): `cli/build.test.ts` loads web/vite.config.ts with stubs only.

/** Modules that may be both lazy and static, with the reason each stays in the main chunk. */
export const INEFFECTIVE_IMPORT_ALLOWED = {
  "src/components/settings-shell.tsx":
    "the pairing door (routes/pair-approve.tsx, eager) shows its page in the settings frame (components/settings-page.tsx), which imports the shell, so the shell is in the main chunk anyway; the route keeps the lazyScreen form of the table",
} as const satisfies Readonly<Record<string, string>>;

/** The main chunk's budget in bytes. It was 1,870,785 after the split (ADR 0169). */
export const MAIN_CHUNK_BUDGET_BYTES = 2_200_000;

/** The log Rolldown hands to `onLog`, as far as this guard reads it. */
export interface BuildLog {
  readonly code?: string;
  readonly message: string;
}

/** The module an INEFFECTIVE_DYNAMIC_IMPORT log names, or null for any other log. */
export function ineffectiveImportOf(log: BuildLog): string | null {
  if (log.code !== "INEFFECTIVE_DYNAMIC_IMPORT") return null;
  // Rolldown's message starts with colour codes and the code in brackets: strip both.
  const plain = stripVTControlCharacters(log.message).replace(/^\[[A-Z_]+\]\s*/u, "");
  const match = /^(\S+) is dynamically imported by /u.exec(plain);
  if (match === null) return log.message;
  return match[1] ?? log.message;
}

/** Whether the log must fail the build: an ineffective import of a module not on the list. */
export function isForbiddenIneffectiveImport(log: BuildLog): boolean {
  const module = ineffectiveImportOf(log);
  if (module === null) return false;
  return !Object.hasOwn(INEFFECTIVE_IMPORT_ALLOWED, module);
}

/** The build's error for a forbidden ineffective import. */
export function ineffectiveImportError(log: BuildLog): string {
  return [
    `A lazy module slid back into the main chunk: ${stripVTControlCharacters(log.message)}`,
    "A static import of a lazy screen (or of a lazyChunk door) keeps it in the importer's chunk, so its `import()` splits nothing.",
    "Import it through its lazyScreen route or a lazyChunk door instead (web/src/lib/lazy-route.ts, ADR 0169).",
    "If it truly belongs in the main chunk, add it with its reason to INEFFECTIVE_IMPORT_ALLOWED in web/vite-bundle-guard.ts.",
  ].join("\n");
}

/** The build's error for a main chunk above the budget, or null within it. */
export function mainChunkBudgetError(fileName: string, bytes: number): string | null {
  if (bytes <= MAIN_CHUNK_BUDGET_BYTES) return null;
  return [
    `The main chunk ${fileName} is ${bytes.toLocaleString("en")} bytes, above its budget of ${MAIN_CHUNK_BUDGET_BYTES.toLocaleString("en")} (web/vite-bundle-guard.ts, ADR 0169).`,
    "Check first:",
    "  1. a screen that should be lazy, now imported statically from an eager file (router.tsx lists the eager ones);",
    "  2. a new dependency imported from the shell, the home screen or another eager file;",
    "  3. a development build of React or React Router (NODE_ENV, the react-router plugin in vite.config.ts).",
    "Attribute the bytes with a source map (`vite build --sourcemap`) before anything else.",
    "Raise the budget only with the reason in ADR 0169. The precache cap (3 MiB) stays.",
  ].join("\n");
}

/** The entry chunks of a bundle, as the plugin reads them. */
interface BundleChunk {
  readonly type: "chunk";
  readonly isEntry: boolean;
  readonly name: string;
  readonly fileName: string;
  readonly code: string;
}
interface BundleAsset {
  readonly type: "asset";
}

/** Fails the build when the main chunk is above its budget. */
export const mainChunkBudgetPlugin: Plugin = {
  name: "collie-main-chunk-budget",
  apply: "build",
  enforce: "post",
  writeBundle(_options, bundle: Readonly<Record<string, BundleChunk | BundleAsset>>) {
    const entries = Object.values(bundle).filter(
      (item): item is BundleChunk => item.type === "chunk" && item.isEntry && item.name === "index",
    );
    if (entries.length !== 1) {
      this.error(`The main-chunk budget found ${entries.length} entry chunks named "index", expected one (web/vite-bundle-guard.ts).`);
    }
    for (const entry of entries) {
      const error = mainChunkBudgetError(entry.fileName, Buffer.byteLength(entry.code));
      if (error !== null) this.error(error);
    }
  },
};
