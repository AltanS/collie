import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { compileCli, compileCliToLive, type CliCompileDeps, type CliCompileOptions } from "../cli/build.ts";
import { EXIT, realIo } from "../cli/io.ts";
import { realExec, realFiles } from "../cli/sys.ts";

/** Parse the narrow release-facing override surface; ordinary `bun run build:cli` uses defaults. */
export function parseCompileCliArgs(args: readonly string[]): CliCompileOptions {
  const options: CliCompileOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--bun" && flag !== "--target" && flag !== "--outfile") {
      throw new Error(`unknown argument: ${flag ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === "--bun") options.bun = value;
    if (flag === "--target") options.target = value;
    if (flag === "--outfile") options.outfile = value;
    index += 1;
  }
  return options;
}

/** Keep `build:cli` CLI-only while routing both output modes through the shared compiler. */
export function buildCli(deps: CliCompileDeps, options: CliCompileOptions): boolean {
  if (options.outfile !== undefined) return compileCli(deps, options);
  return compileCliToLive(deps, { bun: options.bun, target: options.target });
}

function main(args: readonly string[]): number {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const options = parseCompileCliArgs(args);
  // Keep `build:cli` a CLI-only recovery path. It deliberately skips the version gate, installs,
  // typechecks and Vite work owned by `collie build`, while sharing that command's compiler.
  return buildCli(
    { root, io: realIo, exec: realExec(process.env, homedir()), files: realFiles },
    { bun: process.execPath, ...options },
  )
    ? EXIT.OK
    : EXIT.FAIL;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    realIo.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = EXIT.FAIL;
  }
}
