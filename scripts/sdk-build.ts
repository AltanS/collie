// `bun run sdk:build` (M55 spec 10, ADR 0105): the durable SDK, packages/durable-sdk/src, to ESM `.js` and `.d.ts` in
// packages/durable-sdk/dist/, by `tsc -p packages/durable-sdk`. Then it writes dist/core/version.js from the package's
// own package.json, so the SDK_VERSION a program reads is the version it was installed at. It never publishes.
//
// The `./pi` entry is built against the Pi packages of examples/durable-member, and `./durable-harness` against
// durable-harness and @workflow/world of examples/durable-harness (see packages/durable-sdk/tsconfig.json for why), so
// both installs come first.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SDK_DIR = join(ROOT, "packages", "durable-sdk");
const PI_PEERS = join(ROOT, "examples", "durable-member", "node_modules", "@earendil-works", "pi-durable");
const HARNESS_PEERS = [join(ROOT, "examples", "durable-harness", "node_modules", "durable-harness"), join(ROOT, "examples", "durable-harness", "node_modules", "@workflow", "world")];

/** A top-level string field of a package.json, read as text: the name and the version live there and nowhere else. */
export function packageField(packageJson: string, field: "name" | "version"): string {
  const value = new RegExp(`^ {2}"${field}": "([^"]+)"`, "m").exec(packageJson)?.[1];
  if (value === undefined) throw new Error(`packages/durable-sdk/package.json has no top-level "${field}"`);
  return value;
}

function main(): number {
  if (!existsSync(PI_PEERS)) {
    console.error("sdk build: the ./pi entry is built against the example's Pi install. Run: cd examples/durable-member && bun install --frozen-lockfile");
    return 1;
  }
  if (!HARNESS_PEERS.every((dir) => existsSync(dir))) {
    console.error("sdk build: the ./durable-harness entry is built against the example's durable-harness install. Run: cd examples/durable-harness && bun install --frozen-lockfile");
    return 1;
  }
  const dist = join(SDK_DIR, "dist");
  rmSync(dist, { recursive: true, force: true });
  const tsc = Bun.spawnSync([join(ROOT, "node_modules", ".bin", "tsc"), "-p", SDK_DIR], { stdout: "inherit", stderr: "inherit" });
  if (tsc.exitCode !== 0) return tsc.exitCode;
  const manifest = readFileSync(join(SDK_DIR, "package.json"), "utf8");
  const name = packageField(manifest, "name");
  const version = packageField(manifest, "version");
  writeFileSync(join(dist, "core", "version.js"), `// Written by scripts/sdk-build.ts from package.json.\nexport const SDK_VERSION = ${JSON.stringify(version)};\n`);
  console.log(`sdk build: ${name} ${version} in packages/durable-sdk/dist`);
  return 0;
}

if (import.meta.main) process.exit(main());
