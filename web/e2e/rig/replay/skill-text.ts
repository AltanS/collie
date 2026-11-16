// The WalkyTalky skill as the rig's agents read it, and the key of the recordings made with it (M67).
//
// An agent in the rig gets exactly what a default install gives: the product's own render
// (cli/skill-render.ts, the function `renderWalkySkill` calls) with the Hill switch OFF, which is the
// default of every install. The rig states the switch itself and never reads a machine's switch file.
// The command is plain `collie` (the rig puts a shim of that name first on PATH) and the version is `rig`,
// so the text, and the hash of it, hold no machine path and no build version.
//
// THE KEY. The recording key is the hash of this text, because this text goes into the agent's prompt. A
// change to words that exist only in the Hill part moves nothing, because the agent never reads them.
// One function computes it; tier.ts (the tier rule), nightly.ts (the Claude replay check) and the tests use it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { renderSkillTemplate } from "../../../../cli/skill-render";
import { shortHash } from "./cassette";

/** This checkout: web/e2e/rig/replay/skill-text.ts is four levels below it. */
const WORKTREE = resolve(import.meta.dirname, "..", "..", "..", "..");

/** The walky talky skill's template. */
export const SKILL_TEMPLATE = join(WORKTREE, "cli", "skills", "walky-talky.md");

/** The command the skill's examples name in the rig: the shim on the agent's PATH. */
export const RIG_SKILL_BIN = "collie";
/** The version the skill's stamp names in the rig. */
export const RIG_SKILL_VERSION = "rig";

/**
 * The skill text for a template with the Hill switch as given. The rig passes `false`; the parameter is
 * for the tests, which prove the on and off renders differ. The template is read with LF line ends, as the
 * product embeds it (cli/docs-embed.ts).
 */
export function renderRigSkill(template: string, hillOn: boolean): string {
  return renderSkillTemplate(template.replaceAll("\r\n", "\n"), { binary: RIG_SKILL_BIN, version: RIG_SKILL_VERSION, hillOn });
}

/** What the rig writes for every harness: this checkout's template, Hill off. */
export function rigSkillText(): string {
  return renderRigSkill(readFileSync(SKILL_TEMPLATE, "utf8"), false);
}

/** The recording key of the skill: first 16 hex of the sha256 of {@link rigSkillText}. */
export function skillHash(text: string = rigSkillText()): string {
  return shortHash(text);
}
