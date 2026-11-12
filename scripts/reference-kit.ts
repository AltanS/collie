// The small parts that the two reference generators share (`tricks-reference.ts`, `themes-reference.ts`):
// a table, a diff against the page on disk, and the `--write` command line.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** A table cell: a pipe is escaped and a line break is a space. */
export function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)];
}

export const word = (text: string): string => `\`${text}\``;

/** A unified diff of two texts, from the system `diff`; empty when equal. */
function unifiedDiff(page: string, current: string, wanted: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reference-page-"));
  try {
    writeFileSync(join(dir, "current"), current);
    writeFileSync(join(dir, "generated"), wanted);
    const run = spawnSync("diff", ["-u", "--label", page, "--label", "generated", join(dir, "current"), join(dir, "generated")], { encoding: "utf8" });
    if (run.status === 0) return "";
    return run.stdout === "" ? "the page differs from the generator output\n" : run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The page's text on disk, or "" when it does not exist yet. */
function readPage(page: string): string {
  try {
    return readFileSync(join(ROOT, page), "utf8");
  } catch {
    return "";
  }
}

/**
 * The command line of a generator: `--write` writes the page, and no flag prints a diff and exits 1 when
 * the page on disk is stale.
 */
export function runReferenceCli(argv: readonly string[], page: string, command: string, wanted: string): number {
  const write = argv.includes("--write");
  const unknown = argv.filter((arg) => arg !== "--write");
  if (unknown.length > 0) {
    console.error(`usage: ${command.replace(" --write", "")} [--write]`);
    return 2;
  }
  if (write) {
    writeFileSync(join(ROOT, page), wanted);
    console.log(`wrote ${page}`);
    return 0;
  }
  const diff = unifiedDiff(page, readPage(page), wanted);
  if (diff === "") return 0;
  process.stdout.write(diff);
  console.error(`${page} is stale. Run: ${command}`);
  return 1;
}
