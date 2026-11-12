// The Morph skill an earlier Collie build installed (`collie skill install --skill morph`), before agent
// views replaced Morph. It tells an agent to obey a prompt that starts `[morph `, a head Collie no longer
// sends, and agent views refuse it on every door (review 9 R8). This build's skill code (skill-install.ts)
// no longer knows that skill, so it neither refreshes nor removes it: `collie doctor` finds each copy here,
// read-only, and names the steps to remove it by hand.
//
// Where it was written, by the same rows the WalkyTalky skill uses:
//   a file form (Claude)   <profile dir>/skills/collie-morph/SKILL.md, the WalkyTalky file's sibling folder
//   a block form (others)  the lines from `<!-- collie:morph v<N> begin -->` to `<!-- collie:morph v<N> end -->`
//                          inside the same instruction file (AGENTS.md, GEMINI.md)
// A file is Collie's only when it carries the stamp `<!-- collie-skill morph v`; a person's own file is never named.

import { dirname, join } from "node:path";

import type { CliContext } from "./context.ts";
import { skillFiles } from "./skill-install.ts";
import type { Files } from "./sys.ts";

/** The old skill's folder name, beside `collie-walky-talky`. */
export const OLD_MORPH_SKILL_NAME = "collie-morph";
/** The stamp an old build wrote into the file form. */
const OLD_MORPH_STAMP = "<!-- collie-skill morph v";
/** The begin marker an old build wrote into an instruction file, at any format version. */
const OLD_MORPH_BEGIN = /^<!-- collie:morph v\d+ begin -->[ \t]*$/mu;

/** One copy of the old skill: the harness row, the path, and whether it is a whole file or a block in one. */
export interface OldMorphCopy {
  readonly harness: string;
  readonly path: string;
  readonly form: "file" | "block";
}

/** Every copy of the old Morph skill on this machine, read-only. */
export function oldMorphSkillCopies(deps: { readonly ctx: Pick<CliContext, "home" | "env">; readonly files: Pick<Files, "read"> }): OldMorphCopy[] {
  const out: OldMorphCopy[] = [];
  const seen = new Set<string>();
  for (const file of skillFiles(deps.ctx)) {
    const form = file.target.form;
    // The file form keeps each skill in its own folder: the Morph folder sits beside the WalkyTalky one.
    const path = form === "file" ? join(dirname(dirname(file.path)), OLD_MORPH_SKILL_NAME, "SKILL.md") : file.path;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = deps.files.read(path);
    if (text === null) continue;
    if (form === "file" ? text.includes(OLD_MORPH_STAMP) : OLD_MORPH_BEGIN.test(text)) out.push({ harness: file.target.harness, path, form });
  }
  return out;
}

/** The steps an operator takes by hand, one per copy. */
export function oldMorphSteps(copies: readonly OldMorphCopy[]): string[] {
  return copies.map((copy) =>
    copy.form === "file"
      ? `delete the folder ${dirname(copy.path)}`
      : `in ${copy.path}, delete the lines from \`<!-- collie:morph v1 begin -->\` to \`<!-- collie:morph v1 end -->\`, both included`,
  );
}
