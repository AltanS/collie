import { readFileSync } from "node:fs";

// THE HELPER AS TEXT (M94 review 4). `collie trick init` writes `trick.ts` into a new trick folder and
// `collie trick helper <id>` rewrites it, so the CLI carries the helper's source. `cli/trick.ts` imports
// this function `with { type: "macro" }`: Bun runs it when it transpiles the importer (the compiled
// binary's build, and a source run alike) and puts the string in its place, so the binary holds the
// text and never reads this folder at run time. The helper itself stays a real TypeScript file in the
// repo, held to the root typecheck and lint like any other.

/** The helper's source, `trick.ts`, as the trick folder gets it. */
export function trickHelperSource(): string {
  return readFileSync(new URL("./trick.ts", import.meta.url), "utf8");
}
