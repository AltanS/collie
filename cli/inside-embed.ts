// The inside parts Collie ships, embedded in the binary at build time (M99 spec 02).
//
// Today one part: the Collie mod for Claude Code (`inside/claude/`). It is embedded the way the walky
// talky skill is (`cli/docs-embed.ts`): the binary carries the exact text, so a mod written out by
// this binary matches this binary's wire by construction, and an install with no checkout (a package,
// the tarball) can still write it. Its version is Collie's version.
//
// Writing it out is this module's only side effect, and only into a folder the caller names. Linking
// it into Claude Code (`claude plugin` at the user scope) is M99 spec 09's verb, not this module.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { CLAUDE_MOD_FILES } from "./inside-embed-files.js";

export { CLAUDE_MOD_FILES };

/** The mod's name, as `plugin.json` names it and Claude Code lists it. */
export const CLAUDE_MOD_NAME = "collie";

/** The version the embedded mod declares, read from its own manifest. */
export function claudeModVersion(): string | null {
  const manifest = CLAUDE_MOD_FILES.find((file) => file.path === ".claude-plugin/plugin.json");
  const match = manifest === undefined ? null : /"version"\s*:\s*"([^"]+)"/u.exec(manifest.text);
  return match?.[1] ?? null;
}

/**
 * Write the mod into `dir`, byte for byte: one folder per path, files 0644, folders 0755. A path that
 * would land outside `dir` is refused (none does; the list is fixed at build time). Returns the paths written.
 */
export function writeClaudeMod(dir: string): string[] {
  const root = resolve(dir);
  const written: string[] = [];
  for (const file of CLAUDE_MOD_FILES) {
    const target = resolve(root, file.path);
    const inside = relative(root, target);
    if (inside.startsWith("..") || inside === "") throw new Error(`refusing to write ${file.path} outside ${root}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, file.text, { mode: 0o644 });
    written.push(join(root, inside));
  }
  return written;
}
