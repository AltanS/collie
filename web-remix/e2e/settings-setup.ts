// Builds bundle A and bundle B for the settings e2e, a second apart so their build ids differ (the id
// carries the build time in seconds, vite.config.ts). Two builds with no source edit between them
// are still two bundles: that is the premise the update-sheet case rests on, and it is asserted
// here, loudly, rather than discovered as a case that passes while proving nothing.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { BUILDS_DIR, buildDir, buildId, entryScript, serveBuild, type BuildName } from "./settings-builds";

function build(name: BuildName): void {
  execSync(`bun x vite build --outDir ${buildDir(name)} --emptyOutDir --logLevel error`, {
    cwd: join(import.meta.dirname, ".."),
    stdio: "inherit",
  });
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(BUILDS_DIR, { recursive: true });
  build("a");
  await new Promise((done) => setTimeout(done, 1_100));
  build("b");
  if (buildId("a") === buildId("b")) throw new Error("build A and build B share a build id");
  if (entryScript("a") === entryScript("b")) throw new Error("build A and build B share an entry chunk");
  serveBuild("a");
}
