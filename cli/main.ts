import { cmdBuild } from "./build.ts";
import { lifecycleDeps, updateDeps } from "./deps.ts";
import { EXIT, type Io, realIo } from "./io.ts";
import { takePlainFlag } from "./render.ts";
import { cmdApplyUpdate } from "./update.ts";

// The bootstrap. This module is the binary's entry point AND the entry point every from-source
// invocation goes through, and it exists as its own file for exactly one reason:
//
// ── THE BUILD PATH RUNS ON A BARE CHECKOUT ───────────────────────────────────
// `collie build` is what runs `bun install`. So the code that reaches it cannot itself need
// anything `bun install` would have put there. Two callers depend on that, and both are how Collie
// gets onto a machine in the first place:
//
//   * `scripts/collie-ctl.sh` builds the binary from source when the checkout has none — the shape
//     a fresh `herdr plugin install` leaves: no `bin/collie`, no `node_modules` (M6/01).
//   * `pack add` installs a peer by pushing a commit and running that same from-source build there
//     (`cli/remote.ts`'s install leg), on a checkout `git fetch` has JUST advanced — so its
//     `node_modules`, if it has one at all, predates the commit being built.
//     `cli/update.ts` re-execs `bun cli/main.ts _apply-update` for the same reason, on a checkout
//     whose dependency tree is likewise one commit behind.
//
// So: **nothing in this module's static import closure may resolve to a package.** Builtins
// (`node:*`, `bun:*`) and repo-relative files only, transitively — `cli/main.test.ts` walks the
// graph and fails the build if a bare specifier appears anywhere in it. A dependency that is loaded
// through a *dynamic* `import()` is fine, because it is only resolved if that branch runs: that is
// how `web-push` (bridge/push.ts), `qrcode-terminal` (scripts/qr.ts), ink/react (cli/ui/) and — as
// of this file — commander have always been reached.
//
// The verb table, the parser and everything else live in `cli/program.ts`, one dynamic `import()`
// away. The two verbs above are dispatched here instead, before it, by plain argv inspection.

/**
 * The verbs that must work with no dependencies installed, dispatched from this module rather than
 * from the table in `cli/program.ts`. They are still declared in that table — it is the single
 * declaration, and the usage line is built from it — but this is the path they actually take.
 */
export const BOOTSTRAP_VERBS = ["build", "_apply-update"] as const;

/**
 * The verb an argv names, for the pre-dispatch. `--plain` is stripped first, exactly as
 * {@link import("./program.ts").run} strips it, so `collie --plain build` is `build`; the flag is
 * left in the argv handed on to commander, which strips it again.
 */
export function bootstrapVerb(argv: readonly string[]): (typeof BOOTSTRAP_VERBS)[number] | null {
  const verb = takePlainFlag(argv).rest[0];
  return BOOTSTRAP_VERBS.find((v) => v === verb) ?? null;
}

/** The one-liner a missing dependency tree gets, instead of a module-resolution stack trace. */
export function loadFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return /Cannot find (package|module)/i.test(message)
    ? "error: dependencies are not installed — run `collie build` (or bun install) first"
    : `error: ${message}`;
}

export async function main(argv: readonly string[], io: Io, isTTY = false): Promise<number> {
  switch (bootstrapVerb(argv)) {
    case "build":
      return cmdBuild(lifecycleDeps(io));
    case "_apply-update":
      return await cmdApplyUpdate(updateDeps(io));
  }
  let program: typeof import("./program.ts");
  try {
    program = await import("./program.ts");
  } catch (err) {
    io.err(loadFailure(err));
    return EXIT.FAIL;
  }
  return await program.run(argv, io, program.COMMANDS, isTTY);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), realIo, process.stdout.isTTY === true);
}
