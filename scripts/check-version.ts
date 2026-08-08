import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const manifestVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(read("herdr-plugin.toml"))?.[1] ?? "";

if (!manifestVersion) {
  console.error("✗ could not read version from herdr-plugin.toml");
  process.exit(1);
}

const versions = {
  "herdr-plugin.toml": manifestVersion,
  "package.json": (JSON.parse(read("package.json")) as { version?: string }).version ?? "",
  "web/package.json": (JSON.parse(read("web/package.json")) as { version?: string }).version ?? "",
  "CHANGELOG.md": /^##\s*\[([^\]]+)\]/m.exec(read("CHANGELOG.md"))?.[1] ?? "",
};

if (Object.values(versions).some((version) => version !== manifestVersion)) {
  console.error(`✗ version mismatch - all four must equal herdr-plugin.toml (${manifestVersion}):`);
  for (const [file, version] of Object.entries(versions)) console.error(`  ${file}: ${version || "<missing>"}`);
  process.exit(1);
}

console.log(`✓ version ${manifestVersion} consistent across manifest, package.json, web/package.json, CHANGELOG`);
