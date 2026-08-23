import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersion } from "./check-version.ts";

const VERSION = "1.2.3";

function makeFixture(args: { toml: string; pkg: string; web: string; changelog: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "collie-check-version-"));
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "herdr-plugin.toml"), `id = "herdr.collie"\nversion = "${args.toml}"\n`);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version: args.pkg }, null, 2)}\n`);
  writeFileSync(join(root, "web/package.json"), `${JSON.stringify({ version: args.web }, null, 2)}\n`);
  writeFileSync(
    join(root, "CHANGELOG.md"),
    `# Changelog\n\n${args.changelog.map((v) => `## [${v}] - 2026-08-22`).join("\n\n")}\n`,
  );
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe("checkVersion", () => {
  test("accepts matching versions across the manifest, package.json, web/package.json, and CHANGELOG", async () => {
    const root = makeFixture({ toml: VERSION, pkg: VERSION, web: VERSION, changelog: [VERSION, "1.2.2"] });
    try {
      await expect(checkVersion(root)).resolves.toBe(VERSION);
    } finally {
      cleanup(root);
    }
  });

  test("rejects when one artifact disagrees", async () => {
    const root = makeFixture({ toml: VERSION, pkg: VERSION, web: "1.2.4", changelog: [VERSION, "1.2.2"] });
    try {
      let error: Error | undefined;
      try {
        await checkVersion(root);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeDefined();
      expect(error?.message).toContain("version mismatch");
      expect(error?.message).toContain("web/package.json");
    } finally {
      cleanup(root);
    }
  });
});
