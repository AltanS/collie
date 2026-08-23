import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

const TOML_VERSION_RE = /^\s*version\s*=\s*"([^"]+)"/m;
const PACKAGE_VERSION_RE = /"version"\s*:\s*"([^"]+)"/m;
const CHANGELOG_VERSION_RE = /^##\s*\[([0-9][^\]]*)\]/m;

function firstMatch(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}

async function readVersion(filePath: string, re: RegExp): Promise<string | undefined> {
  try {
    return firstMatch(await readFile(filePath, "utf8"), re);
  } catch {
    return undefined;
  }
}

function display(value: string | undefined): string {
  return value || "<missing>";
}

function note(label: string, value: string | undefined): string {
  return `  ${label.padEnd(18)} ${display(value)}`;
}

export async function checkVersion(rootDir: string = DEFAULT_ROOT): Promise<string> {
  const root = resolve(rootDir);

  const tomlVersion = await readVersion(join(root, "herdr-plugin.toml"), TOML_VERSION_RE);
  if (!tomlVersion) throw new Error("could not read version from herdr-plugin.toml");

  const packageVersion = await readVersion(join(root, "package.json"), PACKAGE_VERSION_RE);
  const webVersion = await readVersion(join(root, "web/package.json"), PACKAGE_VERSION_RE);
  const changelogVersion = await readVersion(join(root, "CHANGELOG.md"), CHANGELOG_VERSION_RE);

  if (packageVersion !== tomlVersion || webVersion !== tomlVersion || changelogVersion !== tomlVersion) {
    throw new Error(
      [
        "version mismatch — all four must equal the canonical herdr-plugin.toml version:",
        note("herdr-plugin.toml", `${tomlVersion}  (canonical)`),
        note("package.json", packageVersion),
        note("web/package.json", webVersion),
        note("CHANGELOG.md", changelogVersion),
        "  → bump all three files to the same version and add a matching CHANGELOG entry.",
      ].join("\n"),
    );
  }

  return tomlVersion;
}

async function run(rootDir: string): Promise<number> {
  try {
    const version = await checkVersion(rootDir);
    console.log(`✓ version ${version} consistent across manifest, package.json, web/package.json, CHANGELOG`);
    return 0;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? DEFAULT_ROOT));
}
